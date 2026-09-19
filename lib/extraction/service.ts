import { Prisma } from "@prisma/client";

import { AI_MODELS, DEFAULT_MODEL_ID, modelIdSchema, type AIModelId } from "@/lib/ai/models";
import { PROMPT_VERSION } from "@/lib/ai/prompts";
import { providerStatus } from "@/lib/ai/status";
import { requireUserId } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import { requireDocumentsAccess, type Db } from "@/lib/documents/access";
import { isStale } from "@/lib/documents/staleness";
import { ACTIVE_RUN_STATES, MAX_DOCUMENT_PAGES, type ContentState, type RunState } from "@/lib/documents/schemas";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/log";
import { normalizeTransform, outputSize, transformHash, WORKING_MAX_EDGE } from "@/lib/photos/transform";
import { enqueueExtraction } from "@/lib/queue";
import { requireTemplateAccess } from "@/lib/templates/access";
import { parseDocumentFlags } from "@/lib/transform/flags";

import {
  anchorScore,
  chunkPages,
  currentRuns,
  extractionKey,
  extractionNeedsReview,
  imageTokens,
  MAX_IMAGES_PER_REQUEST,
  parseRunSummary,
  rollupContent,
  rollupRunState,
} from "./plan";
import { MAX_TEMPLATE_EXTRACT_DOCUMENTS, MISMATCH_THRESHOLD, type EstimateInput, type RetryInput, type StartInput } from "./schemas";

/**
 * Extraction actions (docs/04 → Extraction). Nothing here calls the model: starting creates
 * `ExtractionRun` rows and enqueues one job per document; the worker does the rest.
 */

const PROMPT_BASE_TOKENS = 2500;
const PROMPT_TOKENS_PER_FIELD = 120;
const ACTIVE = ACTIVE_RUN_STATES;

// ---------- targets ----------

async function loadTargets(db: Db, documentIds: string[]) {
  const docs = await db.document.findMany({
    where: { id: { in: documentIds }, deletedAt: null },
    select: {
      id: true,
      label: true,
      runState: true,
      templateMatchScore: true,
      contentChangedAt: true,
      lastExtractedAt: true,
      template: { select: { id: true, name: true, kind: true, configState: true, modelOverride: true } },
      book: { select: { id: true, defaultModel: true } },
      photos: {
        where: { deletedAt: null },
        orderBy: [{ pageIndex: "asc" }, { id: "asc" }],
        take: MAX_DOCUMENT_PAGES,
        select: { id: true, pageIndex: true, status: true, transform: true, workingKey: true, width: true, height: true },
      },
      _count: { select: { records: true } },
    },
    take: documentIds.length,
  });
  const templateIds = [...new Set(docs.map((d) => d.template.id))];
  const extractFields = await db.field.groupBy({
    by: ["templateId"],
    where: { templateId: { in: templateIds }, deletedAt: null, mode: "EXTRACT" },
    _count: { _all: true },
  });
  const fieldCounts = new Map(extractFields.map((f) => [f.templateId, f._count._all]));
  const byId = new Map(docs.map((d) => [d.id, { ...d, extractFieldCount: fieldCounts.get(d.template.id) ?? 0 }]));
  return documentIds.flatMap((id) => {
    const d = byId.get(id);
    return d ? [d] : [];
  });
}

type Target = Awaited<ReturnType<typeof loadTargets>>[number];

/** Why a document can't be extracted right now, in plain language; null when it can. */
function blockerFor(t: Target): string | null {
  if (ACTIVE.includes(t.runState)) return "It is already being extracted.";
  if (t.photos.length === 0) return "It has no pages.";
  const failed = t.photos.filter((p) => p.status === "FAILED").length;
  if (failed > 0) return `${failed === 1 ? "1 page" : `${failed} pages`} couldn't be processed. Delete or replace them first.`;
  if (t.photos.some((p) => p.status !== "DONE")) return "Its pages are still being processed.";
  if (t.photos.some((p) => p.workingKey === null)) return "An edited page is still updating.";
  if (t.extractFieldCount === 0) return `The template “${t.template.name}” has no fields set to Extract.`;
  if (t.template.kind === "FORM" && t.photos.length > MAX_IMAGES_PER_REQUEST) {
    return `A form can be extracted with at most ${MAX_IMAGES_PER_REQUEST} pages, and this one has ${t.photos.length}. Split it into separate documents.`;
  }
  return null;
}

async function resolveDocumentIds(userId: string, input: { documentIds?: string[]; templateId?: string }): Promise<string[]> {
  if (input.documentIds) {
    await requireDocumentsAccess(userId, input.documentIds);
    return [...new Set(input.documentIds)];
  }
  if (!input.templateId) throw new AppError("VALIDATION", "Choose documents or a template to extract.");
  await requireTemplateAccess(userId, input.templateId);
  const docs = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Document" WHERE "templateId" = ${input.templateId} AND "deletedAt" IS NULL
    ORDER BY position COLLATE "C", id LIMIT ${MAX_TEMPLATE_EXTRACT_DOCUMENTS}`;
  if (docs.length === 0) throw new AppError("VALIDATION", "This template has no documents yet. Upload some first.");
  return docs.map((d) => d.id);
}

function suggestedModel(targets: Target[]): AIModelId {
  const overrides = new Set(targets.map((t) => t.template.modelOverride));
  const override = overrides.size === 1 ? [...overrides][0] : null;
  const candidate = override ?? targets[0]?.book.defaultModel ?? DEFAULT_MODEL_ID;
  const parsed = modelIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : DEFAULT_MODEL_ID;
}

// ---------- estimate ----------

export type ExtractionBlocker = { documentId: string; label: string | null; reason: string };

export type ExtractionEstimate = {
  /** Why nothing can be extracted on this server (no API key), or null. */
  providerProblem: string | null;
  documentIds: string[];
  documents: number;
  extractable: number;
  pages: number;
  requests: number;
  estInputTokens: number;
  estSeconds: number;
  model: AIModelId;
  suggestedModel: AIModelId;
  warnings: string[];
  blockers: ExtractionBlocker[];
  /** Nothing in this book has been read yet: the dialog says what a first reading looks like (decision 61). */
  firstExtraction: boolean;
};

const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

export async function estimateExtraction(userId: string, input: EstimateInput): Promise<ExtractionEstimate> {
  const documentIds = await resolveDocumentIds(userId, input);
  const targets = await loadTargets(prisma, documentIds);
  const suggested = suggestedModel(targets);
  const model = input.model ?? suggested;
  const modelInfo = AI_MODELS.find((m) => m.id === model) ?? AI_MODELS[0];

  const blockers: ExtractionBlocker[] = [];
  let pages = 0;
  let requests = 0;
  let tokens = 0;
  const ready: Target[] = [];
  for (const t of targets) {
    const reason = blockerFor(t);
    if (reason) {
      blockers.push({ documentId: t.id, label: t.label, reason });
      continue;
    }
    ready.push(t);
    const chunks = chunkPages(t.photos);
    requests += chunks.length;
    pages += t.photos.length;
    tokens += chunks.length * (PROMPT_BASE_TOKENS + PROMPT_TOKENS_PER_FIELD * t.extractFieldCount);
    for (const p of t.photos) {
      const out = outputSize({ width: p.width, height: p.height }, normalizeTransform(p.transform));
      const scale = Math.min(1, WORKING_MAX_EDGE / Math.max(out.width, out.height, 1));
      tokens += imageTokens(Math.round(out.width * scale), Math.round(out.height * scale));
    }
  }

  const warnings: string[] = [];
  const readyIds = ready.map((t) => t.id);
  if (readyIds.length > 0) {
    const [edited] = await prisma.$queryRaw<{ documents: number; cells: number }[]>`
      SELECT count(DISTINCT r."documentId")::int AS documents, count(c.id)::int AS cells
      FROM "Cell" c JOIN "Row" r ON r.id = c."rowId"
      WHERE r."documentId" IN (${Prisma.join(readyIds)}) AND r."deletedAt" IS NULL AND c."isEdited"`;
    if (edited && edited.cells > 0) {
      warnings.push(
        `${n(edited.documents, "document")} ${edited.documents === 1 ? "has" : "have"} ${n(edited.cells, "cell")} you edited. Your edits are kept; new readings that differ are flagged for you instead of replacing them.`,
      );
    }
  }
  const extracted = ready.filter((t) => t._count.records > 0).length;
  if (extracted > 0) {
    warnings.push(`${n(extracted, "document was", "documents were")} extracted before. The new reading replaces the old one page by page as it finishes.`);
  }
  const mismatched = ready.filter((t) => t.templateMatchScore !== null && t.templateMatchScore < MISMATCH_THRESHOLD).length;
  if (mismatched > 0) {
    warnings.push(`${n(mismatched, "document")} looked like a different kind of paper last time (possible template mismatch). Check the template before extracting again.`);
  }
  const conflicted = [...new Set(ready.filter((t) => t.template.configState === "CONFLICTED").map((t) => t.template.name))];
  if (conflicted.length > 0) {
    warnings.push(`${conflicted.map((name) => `“${name}”`).join(", ")} ${conflicted.length === 1 ? "has" : "have"} broken mappings. Extraction still works, but some columns won't fill until they are fixed.`);
  }
  // Phase 11: a page was transformed, replaced or added since these were last read, so their rows no
  // longer match their pages. Reading them again is exactly the fix, so this states the count rather
  // than cautioning against it.
  const stale = ready.filter(isStale).length;
  if (stale > 0) {
    warnings.push(
      `${n(stale, "document")} changed since ${stale === 1 ? "it was" : "they were"} last read. Reading ${stale === 1 ? "it" : "them"} again updates ${stale === 1 ? "its" : "their"} rows, and every cell you edited is kept.`,
    );
  }
  // Never a blocker: extracting before mapping is the correct order, because the preview needs real
  // values (docs/06 Phase 10). The wording teaches that order rather than forbidding it.
  const draft = [...new Set(ready.filter((t) => t.template.configState === "DRAFT").map((t) => t.template.name))];
  for (const name of draft) {
    warnings.push(
      `“${name}” has no mappings yet, so no rows will appear until you add them. Extracting one document first is the normal way to set one up — the preview needs real values.`,
    );
  }

  // From any document of the selection, live or not: an empty selection is not a first reading.
  const bookId = targets[0]?.book.id ?? (await prisma.document.findFirst({ where: { id: { in: documentIds } }, select: { bookId: true } }))?.bookId ?? null;
  const previousRun = bookId === null ? null : await prisma.extractionRun.findFirst({ where: { state: "COMPLETE", document: { bookId } }, select: { id: true } });

  const provider = providerStatus();
  return {
    providerProblem: provider.ready ? null : provider.message,
    documentIds,
    documents: targets.length,
    extractable: ready.length,
    pages,
    requests,
    estInputTokens: tokens,
    estSeconds: pages * modelInfo.secondsPerPage,
    model,
    suggestedModel: suggested,
    warnings,
    blockers,
    firstExtraction: bookId !== null && previousRun === null,
  };
}

// ---------- document state ----------

/**
 * Recomputes a document's run state from the current run of each page (docs/03 §7 step 9). Content
 * state, template match score and the review flag change only once no run is active, so a document
 * being re-extracted keeps its last results on screen until the new ones are in.
 */
export async function recomputeDocumentRun(tx: Db, documentId: string): Promise<void> {
  const doc = await tx.document.findUnique({
    where: { id: documentId },
    select: {
      transformFlags: true,
      lastExtractedAt: true,
      template: { select: { anchors: true } },
      photos: { where: { deletedAt: null }, select: { id: true }, orderBy: { pageIndex: "asc" }, take: MAX_DOCUMENT_PAGES },
    },
  });
  if (!doc) return;
  const runs = await tx.extractionRun.findMany({
    where: { documentId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 500,
    select: { id: true, state: true, photoIds: true, createdAt: true, finishedAt: true, model: true, rawResponse: true },
  });
  const current = currentRuns(doc.photos.map((p) => p.id), runs);
  if (current.length === 0) return;
  const runState = rollupRunState(current.map((r) => r.state));
  const data: Prisma.DocumentUpdateInput = { runState };
  if (!current.some((r) => ACTIVE.includes(r.state))) {
    const summaries = current.flatMap((r) => {
      const s = r.state === "COMPLETE" ? parseRunSummary(r.rawResponse) : null;
      return s ? [s] : [];
    });
    const contentState: ContentState = rollupContent(summaries);
    // A blank page shows no printed text either, so it says nothing about the template: score only pages with content.
    const withContent = summaries.filter((s) => s.contentState !== "EMPTY");
    const score = withContent.length > 0 ? anchorScore(doc.template.anchors, withContent.flatMap((s) => s.anchorsFound)) : null;
    const finished = current.flatMap((r) => (r.finishedAt ? [r.finishedAt.getTime()] : []));
    data.contentState = contentState;
    data.templateMatchScore = score;
    data.needsReview = extractionNeedsReview(contentState, score) || parseDocumentFlags(doc.transformFlags).length > 0;
    data.lastRunAt = finished.length > 0 ? new Date(Math.max(...finished)) : null;
    data.lastModel = current[0]?.model ?? null;
    // When the document was last *successfully* read, which is what staleness compares against
    // (decision 58). Only COMPLETE runs count and it only ever moves forward: a failed re-extraction
    // must not clear the `Changed since last read` chip while the old reading is still on screen.
    const read = current.flatMap((r) => (r.state === "COMPLETE" && r.finishedAt ? [r.finishedAt.getTime()] : []));
    if (read.length > 0) {
      const latest = new Date(Math.max(...read));
      if (doc.lastExtractedAt === null || latest > doc.lastExtractedAt) data.lastExtractedAt = latest;
    }
  }
  await tx.document.update({ where: { id: documentId }, data });
}

// ---------- start / retry ----------

export type StartResult = { queued: number; alreadyStarted: number; skipped: ExtractionBlocker[] };

async function lockDocument(tx: Db, documentId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Document" WHERE id = ${documentId} AND "deletedAt" IS NULL FOR UPDATE`;
  return rows.length > 0;
}

type PlannedRun = { photoIds: string[]; idempotencyKey: string };

function planRuns(documentId: string, model: string, pages: Target["photos"], nonce: string): PlannedRun[] {
  return chunkPages(pages).map((chunk) => ({
    photoIds: chunk.map((p) => p.id),
    idempotencyKey: extractionKey({
      documentId,
      model,
      promptVersion: PROMPT_VERSION,
      pages: chunk.map((p) => ({ photoId: p.id, transformHash: transformHash(normalizeTransform(p.transform)) })),
      passIndex: 0,
      nonce,
    }),
  }));
}

type Outcome = { kind: "queued" } | { kind: "duplicate" } | { kind: "skipped"; reason: string };

function runRows(documentId: string, model: string, planned: PlannedRun[]) {
  return planned.map((p) => ({ documentId, model, promptVersion: PROMPT_VERSION, idempotencyKey: p.idempotencyKey, photoIds: p.photoIds, state: "QUEUED" as const }));
}

/** Inserts the planned runs unless this exact action was already submitted. Call under the document lock. */
async function insertRuns(tx: Db, documentId: string, model: string, planned: PlannedRun[]): Promise<Outcome> {
  const existing = await tx.extractionRun.count({ where: { idempotencyKey: { in: planned.map((p) => p.idempotencyKey) } } });
  if (existing > 0) return { kind: "duplicate" };
  await tx.extractionRun.createMany({ data: runRows(documentId, model, planned), skipDuplicates: true });
  await recomputeDocumentRun(tx, documentId);
  return { kind: "queued" };
}

async function enqueue(documentId: string): Promise<void> {
  // If Redis is unreachable the runs stay QUEUED and status polling enqueues them again.
  await enqueueExtraction({ documentId }).catch((err: unknown) => log.error("extraction enqueue failed", err, { documentId }));
}

/** Documents locked and started per transaction; keeps a template-wide start to a few dozen short transactions. */
const START_BATCH = 100;

function collect(result: StartResult, target: { id: string; label: string | null }, outcome: Outcome) {
  if (outcome.kind === "queued") result.queued++;
  else if (outcome.kind === "duplicate") result.alreadyStarted++;
  else result.skipped.push({ documentId: target.id, label: target.label, reason: outcome.reason });
}

/**
 * Starts extraction: one run per request chunk, one job per document. The nonce makes the action
 * idempotent: submitting it twice (a double click, a network retry) creates nothing the second time.
 */
export async function startExtraction(userId: string, input: StartInput): Promise<StartResult> {
  const provider = providerStatus();
  if (!provider.ready) throw new AppError("PROVIDER_ERROR", provider.message);
  const documentIds = await resolveDocumentIds(userId, input);
  const result: StartResult = { queued: 0, alreadyStarted: 0, skipped: [] };
  for (let i = 0; i < documentIds.length; i += START_BATCH) {
    const batch = documentIds.slice(i, i + START_BATCH);
    const outcomes = await prisma.$transaction(
      async (tx) => {
        // Locked in id order, so starts over overlapping selections can't deadlock.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Document" WHERE id IN (${Prisma.join(batch)}) AND "deletedAt" IS NULL ORDER BY id FOR UPDATE`;
        const targets = new Map((await loadTargets(tx, locked.map((r) => r.id))).map((t) => [t.id, t]));
        const planned = new Map([...targets.values()].map((t) => [t.id, planRuns(t.id, input.model, t.photos, input.nonce)]));
        const keys = [...planned.values()].flat().map((p) => p.idempotencyKey);
        const submitted = new Set(
          (await tx.extractionRun.findMany({ where: { idempotencyKey: { in: keys } }, select: { documentId: true } })).map((r) => r.documentId),
        );
        const decided = batch.map((id): { id: string; label: string | null; outcome: Outcome } => {
          const t = targets.get(id);
          if (!t) return { id, label: null, outcome: { kind: "skipped", reason: "It was deleted." } };
          if (submitted.has(id)) return { id, label: t.label, outcome: { kind: "duplicate" } };
          const reason = blockerFor(t);
          return { id, label: t.label, outcome: reason ? { kind: "skipped", reason } : { kind: "queued" } };
        });
        const queued = decided.filter((d) => d.outcome.kind === "queued").map((d) => d.id);
        if (queued.length > 0) {
          await tx.extractionRun.createMany({
            data: queued.flatMap((id) => runRows(id, input.model, planned.get(id) ?? [])),
            skipDuplicates: true,
          });
          // The new runs cover every page, so they are each page's current run and the document is simply QUEUED.
          await tx.document.updateMany({ where: { id: { in: queued } }, data: { runState: "QUEUED" } });
        }
        return decided;
      },
      { timeout: 30_000 },
    );
    for (const d of outcomes) collect(result, d, d.outcome);
    await Promise.all(outcomes.filter((d) => d.outcome.kind === "queued").map((d) => enqueue(d.id)));
  }
  return result;
}

/**
 * Retries the pages whose current run failed: all of them for `documentIds`, or only the listed
 * pages for `photoIds`. The key is derived from the failed runs, so retrying twice creates one run.
 */
export async function retryExtraction(userId: string, input: RetryInput): Promise<StartResult> {
  const provider = providerStatus();
  if (!provider.ready) throw new AppError("PROVIDER_ERROR", provider.message);
  const uid = requireUserId(userId);
  let requested: Map<string, Set<string> | null>;
  if (input.documentIds) {
    await requireDocumentsAccess(uid, input.documentIds);
    requested = new Map(input.documentIds.map((id) => [id, null]));
  } else {
    const photoIds = [...new Set(input.photoIds ?? [])];
    const photos = await prisma.photo.findMany({
      where: { id: { in: photoIds }, deletedAt: null, document: { deletedAt: null, template: { deletedAt: null }, book: { userId: uid, deletedAt: null } } },
      select: { id: true, documentId: true },
      take: photoIds.length,
    });
    if (photos.length !== photoIds.length) throw new AppError("NOT_FOUND", "Some of these pages were deleted. Reload and try again.");
    requested = new Map();
    for (const p of photos) {
      const set = requested.get(p.documentId) ?? new Set<string>();
      set.add(p.id);
      requested.set(p.documentId, set);
    }
  }

  const result: StartResult = { queued: 0, alreadyStarted: 0, skipped: [] };
  for (const [documentId, pages] of requested) {
    const { outcome, label } = await prisma.$transaction(async (tx) => {
      if (!(await lockDocument(tx, documentId))) return { outcome: { kind: "skipped", reason: "It was deleted." } as Outcome, label: null };
      const [target] = await loadTargets(tx, [documentId]);
      if (!target) return { outcome: { kind: "skipped", reason: "It was deleted." } as Outcome, label: null };
      const runs = await tx.extractionRun.findMany({
        where: { documentId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 500,
        select: { id: true, state: true, photoIds: true, createdAt: true, model: true },
      });
      const failed = currentRuns(target.photos.map((p) => p.id), runs).filter((r) => r.state === "FAILED");
      const failedPages = new Set(failed.flatMap((r) => r.photoIds));
      const retryPages = target.photos.filter((p) => failedPages.has(p.id) && (pages === null || pages.has(p.id)));
      // Retry with the same model, unless that model has been retired: then use the template or book model.
      const previous = modelIdSchema.safeParse(failed[0]?.model);
      const model = previous.success ? previous.data : suggestedModel([target]);
      const planned = planRuns(documentId, model, retryPages, `retry-${failed.map((r) => r.id).sort().join("-")}`);
      if (planned.length > 0) {
        const dup = await tx.extractionRun.count({ where: { idempotencyKey: { in: planned.map((p) => p.idempotencyKey) } } });
        if (dup > 0) return { outcome: { kind: "duplicate" } as Outcome, label: target.label };
      }
      const reason = blockerFor(target);
      if (reason) return { outcome: { kind: "skipped", reason } as Outcome, label: target.label };
      if (retryPages.length === 0) return { outcome: { kind: "skipped", reason: "None of its pages failed." } as Outcome, label: target.label };
      return { outcome: await insertRuns(tx, documentId, model, planned), label: target.label };
    });
    collect(result, { id: documentId, label }, outcome);
    if (outcome.kind === "queued") await enqueue(documentId);
  }
  return result;
}

// ---------- status ----------

export type ExtractionStatus = {
  id: string;
  runState: RunState;
  contentState: ContentState;
  needsReview: boolean;
  templateMatchScore: number | null;
  lastRunAt: string | null;
  lastModel: string | null;
  /** Phase 11: so the `Changed since last read` chip clears on the poll after a re-extraction. */
  changedSinceLastRead: boolean;
  lastExtractedAt: string | null;
  pages: { total: number; done: number; failed: number };
};

const STUCK_QUEUED_MS = 60_000;

/**
 * Poll target (docs/03 §7 → Progress). A document with runs queued for over a minute and nothing
 * running is enqueued again in case its job was lost; enqueueing is a no-op while its job is waiting,
 * backing off or running, so polling never skips a retry backoff or resets the attempt count.
 */
export async function getExtractionStatus(userId: string, documentIds: string[]): Promise<ExtractionStatus[]> {
  const uid = requireUserId(userId);
  const docs = await prisma.document.findMany({
    where: { id: { in: documentIds }, deletedAt: null, book: { userId: uid, deletedAt: null } },
    select: {
      id: true,
      runState: true,
      contentState: true,
      needsReview: true,
      templateMatchScore: true,
      contentChangedAt: true,
      lastExtractedAt: true,
      lastRunAt: true,
      lastModel: true,
      photos: { where: { deletedAt: null }, select: { id: true }, take: MAX_DOCUMENT_PAGES },
      runs: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { id: true, state: true, photoIds: true, createdAt: true } },
    },
    take: documentIds.length,
  });
  const out: ExtractionStatus[] = [];
  for (const d of docs) {
    const current = currentRuns(d.photos.map((p) => p.id), d.runs);
    const pagesIn = (state: RunState) => current.filter((r) => r.state === state).reduce((sum, r) => sum + r.photoIds.length, 0);
    const queued = current.filter((r) => r.state === "QUEUED");
    const stuck =
      queued.length > 0 &&
      !current.some((r) => r.state === "RUNNING") &&
      queued.every((r) => Date.now() - r.createdAt.getTime() > STUCK_QUEUED_MS);
    if (stuck) await enqueue(d.id);
    out.push({
      id: d.id,
      runState: d.runState,
      contentState: d.contentState,
      needsReview: d.needsReview,
      templateMatchScore: d.templateMatchScore,
      lastRunAt: d.lastRunAt?.toISOString() ?? null,
      lastModel: d.lastModel,
      changedSinceLastRead: isStale(d),
      lastExtractedAt: d.lastExtractedAt?.toISOString() ?? null,
      pages: { total: d.photos.length, done: pagesIn("COMPLETE"), failed: pagesIn("FAILED") },
    });
  }
  return out;
}

// ---------- run detail ----------

export type RunDetail = {
  id: string;
  documentId: string;
  model: string;
  promptVersion: string;
  passIndex: number;
  state: RunState;
  photoIds: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  rawResponse: Prisma.JsonValue | null;
  records: number;
};

export async function getRun(userId: string, runId: string): Promise<RunDetail> {
  const uid = requireUserId(userId);
  const run = await prisma.extractionRun.findFirst({
    where: { id: runId, document: { deletedAt: null, book: { userId: uid, deletedAt: null } } },
    include: { _count: { select: { records: true } } },
  });
  if (!run) throw new AppError("NOT_FOUND", "That extraction run doesn't exist.");
  return {
    id: run.id,
    documentId: run.documentId,
    model: run.model,
    promptVersion: run.promptVersion,
    passIndex: run.passIndex,
    state: run.state,
    photoIds: run.photoIds,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    error: run.error,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    rawResponse: run.rawResponse,
    records: run._count.records,
  };
}
