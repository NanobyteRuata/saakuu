import { createHash } from "node:crypto";

import { createId } from "@paralleldrive/cuid2";
import { Prisma } from "@prisma/client";
import { generateNKeysBetween } from "fractional-indexing";

import { AI_MODELS, DEFAULT_MODEL_ID, estimateCostUsd, modelIdSchema, type AIModelId } from "@/lib/ai/models";
import { TEMPLATE_PROMPT_VERSION } from "@/lib/ai/prompts";
import type { ProposedFieldDTO } from "@/lib/ai/provider";
import { providerStatus } from "@/lib/ai/status";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { imageTokens, MAX_IMAGES_PER_REQUEST } from "@/lib/extraction/plan";
import { log } from "@/lib/log";
import { recomputeMappingStates } from "@/lib/mappings/state";
import { normalizeTransform, outputSize, transformHash, WORKING_MAX_EDGE } from "@/lib/photos/transform";
import { enqueueFieldProposal } from "@/lib/queue";
import { requestTemplateTransform } from "@/lib/transform/triggers";

import { lockTemplate, recomputeConfigState, requireTemplateAccess, type Db } from "./access";
import type {
  AcceptFieldProposalInput,
  FieldProposalEstimate,
  FieldProposalEstimateInput,
  FieldProposalView,
  ProposedFieldView,
  StartFieldProposalInput,
} from "./field-proposal-schemas";
import { fieldShapeProblem, FIELD_TYPES, MAX_FIELDS } from "./schemas";
import { loadSourceTree } from "./source-tree";
import { childrenOf, compareSiblings, toSibling } from "./tree";

/**
 * The AI proposes the template (Phase 16, decision 73). Nothing here calls the model: starting records a
 * QUEUED `FieldProposal` and enqueues it; the worker reads the page (`field-proposal-process.ts`).
 * Accepting is the only write to the template, and it writes only the items the operator ticked.
 */

/** The prompt without any fields in it: fixed text, far shorter than an extraction prompt. */
const PROMPT_BASE_TOKENS = 1500;
/** A field list is short: about sixty tokens a field, and forty fields is a large page. */
const OUTPUT_TOKENS_ALLOWANCE = 2500;
/** A proposal still QUEUED after this long with nothing running is enqueued again, as extraction does. */
const STUCK_QUEUED_MS = 60_000;
/** A RUNNING proposal older than this belongs to a worker that died; the worker may claim it again. */
export const STALE_RUNNING_MS = 15 * 60_000;
/** How long a proposal the operator walked away from is offered again when the dialog reopens. */
const RESUME_WITHIN_MS = 24 * 3600_000;

const NOT_FOUND = "That proposal doesn't exist or you don't have access to it.";

// ---------- the page ----------

async function loadSpecimen(templateId: string, documentId: string) {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, templateId, deletedAt: null },
    select: {
      id: true,
      isSpecimen: true,
      photos: {
        where: { deletedAt: null },
        orderBy: { pageIndex: "asc" },
        take: MAX_IMAGES_PER_REQUEST + 1,
        select: { id: true, status: true, width: true, height: true, transform: true },
      },
    },
  });
  if (!doc) throw new AppError("NOT_FOUND", "That page isn't in this template any more. Reload and try again.");
  return doc;
}

type Specimen = Awaited<ReturnType<typeof loadSpecimen>>;

function blockerFor(doc: Specimen): string | null {
  if (!doc.isSpecimen) return "Only a page uploaded to build this template can be read for fields.";
  if (doc.photos.length === 0) return "This page has no photos.";
  if (doc.photos.length > MAX_IMAGES_PER_REQUEST) return `A page can be read for fields with up to ${MAX_IMAGES_PER_REQUEST} photos. Split this one first.`;
  if (doc.photos.some((p) => p.status === "FAILED")) return "One of this page's photos couldn't be processed. Replace it first.";
  if (doc.photos.some((p) => p.status !== "DONE")) return "This page is still being processed. Try again in a moment.";
  return null;
}

// ---------- estimate ----------

export async function estimateFieldProposal(userId: string, templateId: string, input: FieldProposalEstimateInput): Promise<FieldProposalEstimate> {
  await requireTemplateAccess(userId, templateId);
  const template = await prisma.template.findUniqueOrThrow({ where: { id: templateId }, select: { modelOverride: true } });
  const model: AIModelId = input.model ?? modelIdSchema.catch(DEFAULT_MODEL_ID).parse(template.modelOverride ?? DEFAULT_MODEL_ID);
  const modelInfo = AI_MODELS.find((m) => m.id === model) ?? AI_MODELS[0];
  const doc = await loadSpecimen(templateId, input.documentId);

  let inputTokens = PROMPT_BASE_TOKENS;
  for (const p of doc.photos) {
    const out = outputSize({ width: p.width, height: p.height }, normalizeTransform(p.transform));
    const scale = Math.min(1, WORKING_MAX_EDGE / Math.max(out.width, out.height, 1));
    inputTokens += imageTokens(Math.round(out.width * scale), Math.round(out.height * scale));
  }
  const provider = await providerStatus(userId);
  return {
    providerProblem: provider.ready ? null : provider.message,
    keySource: provider.ready ? provider.keySource : null,
    keyHint: provider.ready ? provider.hint : null,
    blocker: blockerFor(doc),
    pages: doc.photos.length,
    estCostUsd: estimateCostUsd({ model, inputTokens, outputTokens: OUTPUT_TOKENS_ALLOWANCE }),
    estSeconds: Math.max(1, doc.photos.length) * modelInfo.secondsPerPage,
    model,
  };
}

// ---------- start ----------

function proposalKey(parts: { templateId: string; documentId: string; model: string; pages: { id: string; transform: unknown }[]; nonce: string }): string {
  const pages = parts.pages.map((p) => `${p.id}:${transformHash(normalizeTransform(p.transform))}`).join(",");
  return createHash("sha256")
    .update([parts.templateId, parts.documentId, parts.model, TEMPLATE_PROMPT_VERSION, pages, parts.nonce].join("|"))
    .digest("hex");
}

async function enqueue(proposalId: string): Promise<void> {
  // If Redis is unreachable the proposal stays QUEUED and the dialog's poll enqueues it again.
  await enqueueFieldProposal({ proposalId }).catch((err: unknown) => log.error("field proposal enqueue failed", err, { proposalId }));
}

/**
 * Records a QUEUED proposal and hands it to the worker. The nonce is minted per dialog opening, so a
 * double click (or a network retry) returns the same proposal instead of paying twice.
 */
export async function startFieldProposal(userId: string, templateId: string, input: StartFieldProposalInput): Promise<{ id: string }> {
  await requireTemplateAccess(userId, templateId);
  const provider = await providerStatus(userId);
  if (!provider.ready) throw new AppError("PROVIDER_ERROR", provider.message);
  const doc = await loadSpecimen(templateId, input.documentId);
  const blocker = blockerFor(doc);
  if (blocker) throw new AppError("VALIDATION", blocker);

  const idempotencyKey = proposalKey({ templateId, documentId: doc.id, model: input.model, pages: doc.photos, nonce: input.nonce });
  const existing = await prisma.fieldProposal.findUnique({ where: { idempotencyKey }, select: { id: true } });
  if (existing) return existing;
  let id: string;
  try {
    ({ id } = await prisma.fieldProposal.create({
      data: {
        templateId,
        documentId: doc.id,
        photoIds: doc.photos.map((p) => p.id),
        model: input.model,
        promptVersion: TEMPLATE_PROMPT_VERSION,
        idempotencyKey,
      },
      select: { id: true },
    }));
  } catch (err) {
    // The same submission raced itself; the other request created it.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return prisma.fieldProposal.findUniqueOrThrow({ where: { idempotencyKey }, select: { id: true } });
    }
    throw err;
  }
  await enqueue(id);
  return { id };
}

// ---------- read ----------

const proposalSelect = {
  id: true,
  templateId: true,
  documentId: true,
  state: true,
  model: true,
  promptVersion: true,
  error: true,
  items: true,
  acceptedAt: true,
  acceptedFieldIds: true,
  createdAt: true,
  startedAt: true,
} satisfies Prisma.FieldProposalSelect;

type ProposalRow = Prisma.FieldProposalGetPayload<{ select: typeof proposalSelect }>;

/**
 * The stored items, re-checked on the way out: they were validated before they were written, but they
 * are JSON, and a malformed item must never reach a write.
 */
export function parseProposalItems(json: Prisma.JsonValue | null): ProposedFieldDTO[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((raw): ProposedFieldDTO[] => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const { labelSource, labelMeaning, dataType, choices, note } = raw;
    if (typeof labelSource !== "string" || labelSource.trim() === "") return [];
    if (typeof dataType !== "string" || !(FIELD_TYPES as readonly string[]).includes(dataType)) return [];
    return [
      {
        labelSource,
        labelMeaning: typeof labelMeaning === "string" ? labelMeaning : null,
        dataType: dataType as ProposedFieldDTO["dataType"],
        choices: Array.isArray(choices) ? choices.filter((c): c is string => typeof c === "string") : [],
        note: typeof note === "string" ? note : null,
      },
    ];
  });
}

const labelKey = (label: string) => label.trim().normalize("NFC").toLowerCase();

async function toView(row: ProposalRow): Promise<FieldProposalView> {
  const items = parseProposalItems(row.items);
  const live =
    items.length === 0
      ? new Set<string>()
      : new Set(
          (await prisma.field.findMany({ where: { templateId: row.templateId, deletedAt: null }, select: { labelSource: true }, take: MAX_FIELDS })).map(
            (f) => labelKey(f.labelSource),
          ),
        );
  const view: ProposedFieldView[] = items.map((f, index) => ({ index, ...f, alreadyInTree: live.has(labelKey(f.labelSource)) }));
  return {
    id: row.id,
    documentId: row.documentId,
    state: row.state === "COMPLETE" || row.state === "FAILED" || row.state === "RUNNING" ? row.state : "QUEUED",
    model: row.model,
    promptVersion: row.promptVersion,
    error: row.error,
    items: view,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    acceptedCount: row.acceptedFieldIds.length,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A proposal whose job was lost (Redis down at start, a worker that died) is handed to the worker again. */
async function nudge(row: ProposalRow): Promise<void> {
  const now = Date.now();
  const stuckQueued = row.state === "QUEUED" && now - row.createdAt.getTime() > STUCK_QUEUED_MS;
  const staleRunning = row.state === "RUNNING" && row.startedAt !== null && now - row.startedAt.getTime() > STALE_RUNNING_MS;
  if (stuckQueued || staleRunning) await enqueue(row.id);
}

/** Poll target for the dialog. */
export async function getFieldProposal(userId: string, templateId: string, proposalId: string): Promise<FieldProposalView> {
  await requireTemplateAccess(userId, templateId);
  const row = await prisma.fieldProposal.findFirst({ where: { id: proposalId, templateId }, select: proposalSelect });
  if (!row) throw new AppError("NOT_FOUND", NOT_FOUND);
  await nudge(row);
  return toView(row);
}

/**
 * The proposal the dialog should resume, if any: the newest one of this page, from the last day, not yet
 * accepted and not failed. A proposal has already been paid for, so closing the dialog while it runs, or
 * before confirming, must not throw it away.
 */
export async function latestFieldProposal(userId: string, templateId: string, documentId: string): Promise<{ proposal: FieldProposalView | null }> {
  await requireTemplateAccess(userId, templateId);
  const row = await prisma.fieldProposal.findFirst({
    where: { templateId, documentId, createdAt: { gt: new Date(Date.now() - RESUME_WITHIN_MS) } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: proposalSelect,
  });
  // A finished proposal that found nothing has nothing to resume: the dialog opens on the estimate instead.
  const empty = row?.state === "COMPLETE" && parseProposalItems(row.items).length === 0;
  if (!row || row.state === "FAILED" || row.acceptedAt !== null || empty) return { proposal: null };
  await nudge(row);
  return { proposal: await toView(row) };
}

// ---------- accept ----------

export type AcceptResult = { created: number; left: number; alreadyAccepted: boolean };

async function lockProposal(tx: Db, proposalId: string, templateId: string): Promise<ProposalRow> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "FieldProposal" WHERE id = ${proposalId} AND "templateId" = ${templateId} FOR UPDATE`;
  if (rows.length === 0) throw new AppError("NOT_FOUND", NOT_FOUND);
  return tx.fieldProposal.findUniqueOrThrow({ where: { id: proposalId }, select: proposalSelect });
}

/**
 * Creates the ticked items as top-level fields, after everything already in the tree, in paper order
 * (the proposal's order, whatever order the indexes arrive in). The items come from the stored proposal,
 * never from the request: the client sends indexes only. Accepting twice creates nothing the second time.
 */
export async function acceptFieldProposal(userId: string, templateId: string, proposalId: string, input: AcceptFieldProposalInput): Promise<AcceptResult> {
  await requireTemplateAccess(userId, templateId);
  const { result, repaired } = await prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const proposal = await lockProposal(tx, proposalId, templateId);
    if (proposal.acceptedAt !== null) {
      return { result: { created: proposal.acceptedFieldIds.length, left: 0, alreadyAccepted: true }, repaired: 0 };
    }
    if (proposal.state !== "COMPLETE") throw new AppError("CONFLICT", "The AI hasn't finished reading this page yet.");
    // Deliberately not re-checked: that the page is still a live specimen. The proposal describes the
    // paper, not the document row — promoting the page, or deleting it after reading, changes nothing
    // about which labels are printed on it, and the operator is looking at the list they confirm.
    const items = parseProposalItems(proposal.items);
    const include = new Set(input.include);
    if ([...include].some((i) => i >= items.length)) throw new AppError("VALIDATION", "The proposal changed. Reload and try again.");
    const chosen = items.filter((_, i) => include.has(i));

    const { fields, tree } = await loadSourceTree(tx, templateId);
    if (fields.length + chosen.length > MAX_FIELDS) {
      throw new AppError("VALIDATION", `A template can have up to ${MAX_FIELDS} fields; this would make ${fields.length + chosen.length}.`);
    }
    for (const f of chosen) {
      const shape = fieldShapeProblem({ dataType: f.dataType, choices: f.choices, markSymbols: null, typeOptions: null });
      if (shape) throw new AppError("VALIDATION", `“${f.labelSource}”: ${shape}`);
    }

    const last = childrenOf(tree, null).map(toSibling).sort(compareSiblings).at(-1)?.position ?? null;
    const positions = generateNKeysBetween(last, null, chosen.length);
    const data = chosen.map((f, i) => ({
      id: createId(),
      templateId,
      groupId: null,
      labelSource: f.labelSource,
      labelMeaning: f.labelMeaning,
      dataType: f.dataType,
      mode: "EXTRACT" as const,
      note: f.note,
      choices: f.choices,
      markSymbols: Prisma.DbNull,
      typeOptions: Prisma.DbNull,
      position: positions[i] ?? "",
    }));
    await tx.field.createMany({ data });
    await tx.fieldProposal.update({ where: { id: proposalId }, data: { acceptedAt: new Date(), acceptedFieldIds: data.map((d) => d.id) } });
    const { repaired } = await recomputeMappingStates(tx, templateId);
    await recomputeConfigState(tx, templateId);
    return { result: { created: data.length, left: items.length - data.length, alreadyAccepted: false }, repaired };
  });
  if (repaired > 0) await requestTemplateTransform(templateId);
  return result;
}
