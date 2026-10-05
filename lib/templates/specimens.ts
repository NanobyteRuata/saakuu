import { Prisma } from "@prisma/client";

import { lockBook, requireDocumentAccess, type Db } from "@/lib/documents/access";
import {
  copyKeyFor,
  copyPageObjects,
  insertCopiedDocument,
  insertReading,
  loadReading,
  loadSourcePages,
  planReadingCopy,
  type ReadingCopy,
  type SourcePage,
} from "@/lib/documents/copy";
import type { PromoteSpecimenInput } from "@/lib/documents/schemas";
import { isStale } from "@/lib/documents/staleness";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { estimateExtraction, startExtraction, type ExtractionEstimate } from "@/lib/extraction/service";
import { impactHash } from "@/lib/impact";
import { log } from "@/lib/log";
import { photoSelect, toPhotoView, type PhotoView } from "@/lib/photos/views";
import { requestDocumentTransform } from "@/lib/transform/triggers";

import { requireTemplateAccess } from "./access";
import type { SpecimenFromDocumentInput } from "./schemas";

/**
 * The pages a template is built against (Phase 15, decisions 71 and 78).
 *
 * A specimen is an ordinary Document carrying `isSpecimen`, because extraction, `Test on this page` and
 * the reading pane all depend on it being one. What changed in decision 78 is where it lives: a specimen
 * belongs to its template. It is out of everything in Documents — the list, its search and filters, the
 * run drawer, the nav count — and out of the book's work (the table, review, the export: `lib/db/scope.ts`).
 * It is managed only in the template workspace.
 *
 * Pages move between the two by copy, never by flipping the flag: an uploaded page becomes a specimen
 * as a copy (the document is untouched), and a specimen is added to the documents as a copy (the
 * template keeps its reference page). A copy is independent all the way down; see `lib/documents/copy.ts`.
 *
 * The list is its own endpoint rather than a field on `TemplateDetail` because the photo URLs are
 * presigned and short-lived: the pane refetches them after an upload, after the crop/rotate editor
 * saves, and while a page is still being processed, none of which should reload the whole template.
 */
export const MAX_SPECIMENS = 20;

export type SpecimenDocument = {
  id: string;
  label: string | null;
  createdAt: string;
  photos: PhotoView[];
};

export async function listSpecimens(userId: string, templateId: string): Promise<{ documents: SpecimenDocument[] }> {
  await requireTemplateAccess(userId, templateId);
  const docs = await prisma.document.findMany({
    where: { templateId, deletedAt: null, isSpecimen: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_SPECIMENS,
    select: {
      id: true,
      label: true,
      createdAt: true,
      photos: { where: { deletedAt: null }, orderBy: { pageIndex: "asc" }, take: 50, select: photoSelect },
    },
  });
  return {
    documents: await Promise.all(
      docs.map(async (d) => ({
        id: d.id,
        label: d.label,
        createdAt: d.createdAt.toISOString(),
        photos: await Promise.all(d.photos.map(toPhotoView)),
      })),
    ),
  };
}

// ---------- is the test current? ----------

export type TestReadingState = "current" | "fields-changed" | "pages-changed" | "none" | "running";

/**
 * Whether a specimen's test reading still says what the template reads now (decision 78). One rule, on
 * the server: the pane's `Read before your latest field changes` note and the promote confirmation both
 * come from the same two columns, `lastExtractedAt` against `contentChangedAt` and `fieldsChangedAt`.
 */
export function testReadingState(
  doc: { runState: string; lastExtractedAt: Date | null; contentChangedAt: Date | null },
  template: { fieldsChangedAt: Date },
): TestReadingState {
  if (doc.runState === "QUEUED" || doc.runState === "RUNNING") return "running";
  if (doc.lastExtractedAt === null || doc.runState !== "COMPLETE") return "none";
  if (isStale(doc)) return "pages-changed";
  if (doc.lastExtractedAt < template.fieldsChangedAt) return "fields-changed";
  return "current";
}

async function requireSpecimen(userId: string, documentId: string, db: Db = prisma) {
  const access = await requireDocumentAccess(userId, documentId, db);
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: {
      isSpecimen: true,
      label: true,
      manualValues: true,
      runState: true,
      lastExtractedAt: true,
      contentChangedAt: true,
      template: { select: { fieldsChangedAt: true } },
    },
  });
  if (!doc.isSpecimen) throw new AppError("VALIDATION", "That page is already one of your documents.");
  return { ...access, ...doc };
}

// ---------- document → specimen ----------

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function samePages(a: SourcePage[], b: SourcePage[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => p.id === b[i]?.id && p.originalKey === b[i]?.originalKey && p.workingKey === b[i]?.workingKey && p.thumbKey === b[i]?.thumbKey)
  );
}

/**
 * Copies an uploaded page of this template into a new specimen, so a page already photographed can be
 * the reference without photographing it again (decision 78). The document itself is untouched, and its
 * reading is not copied: the specimen is unread, and `Test on this page` reads it on its own.
 *
 * Same template only. A specimen is read with its template's fields, and a page of another template is a
 * different form, which is an upload.
 */
export async function specimenFromDocument(userId: string, templateId: string, input: SpecimenFromDocumentInput): Promise<{ documentId: string }> {
  const template = await requireTemplateAccess(userId, templateId);
  const source = await requireDocumentAccess(userId, input.documentId);
  if (source.bookId !== template.bookId || source.templateId !== template.id) {
    throw new AppError("VALIDATION", "Choose a page of this template.");
  }
  const copyKey = copyKeyFor("specimen", input.documentId, input.nonce);
  const done = await prisma.document.findUnique({ where: { copyKey }, select: { id: true } });
  if (done) return { documentId: done.id };

  const sourceDoc = await prisma.document.findUniqueOrThrow({
    where: { id: input.documentId },
    select: { isSpecimen: true, label: true, manualValues: true },
  });
  if (sourceDoc.isSpecimen) throw new AppError("VALIDATION", "That page is already a specimen of this template.");
  const pages = await loadSourcePages(prisma, input.documentId);
  const copied = await copyPageObjects(template.bookId, pages);

  try {
    const documentId = await prisma.$transaction(async (tx) => {
      await lockBook(tx, template.bookId);
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${input.documentId} FOR UPDATE`;
      if (!samePages(pages, await loadSourcePages(tx, input.documentId))) {
        throw new AppError("CONFLICT", "That document's pages changed while it was being copied. Choose it again.");
      }
      const specimens = await tx.document.count({ where: { templateId, deletedAt: null, isSpecimen: true } });
      if (specimens >= MAX_SPECIMENS) {
        throw new AppError("VALIDATION", `A template can keep up to ${MAX_SPECIMENS} specimens. Remove one first.`);
      }
      return insertCopiedDocument(tx, {
        bookId: template.bookId,
        templateId,
        label: sourceDoc.label,
        manualValues: sourceDoc.manualValues,
        isSpecimen: true,
        copyKey,
        copiedFromDocumentId: input.documentId,
        pages: copied,
      });
    });
    return { documentId };
  } catch (err) {
    // A concurrent retry of the same click won; its copy is the answer, and ours is left for the sweep.
    if (!isUniqueViolation(err)) throw err;
    const winner = await prisma.document.findUniqueOrThrow({ where: { copyKey }, select: { id: true } });
    return { documentId: winner.id };
  }
}

// ---------- specimen → document ----------

export type PromoteMode = "with-reading" | "read-again" | "unread";

export type PromoteImpact = {
  impactHash: string;
  mode: PromoteMode;
  pages: number;
  /** Values of the test reading that travel with the copy; 0 unless `with-reading`. */
  values: number;
  /**
   * `read-again`: why, as a phrase that follows "because" ("your fields changed since this test").
   * `unread`: why it can't be read now, as a sentence of its own (the extraction blocker or key problem).
   */
  reason: string | null;
  /** `read-again` only: what reading it costs and whose key pays, as the Extract dialog shows it. */
  estimate: Pick<ExtractionEstimate, "estCostUsd" | "estSeconds" | "keySource" | "keyHint" | "model"> | null;
  /** Earlier copies of this specimen still in the documents: repeating one puts its rows in twice. */
  earlierCopies: { count: number; lastAt: string } | null;
};

const REASONS: Record<Exclude<TestReadingState, "current" | "running">, string> = {
  "fields-changed": "your fields changed since this test",
  "pages-changed": "its pages changed since this test",
  none: "this page hasn't been tested yet",
};

/** Whether a copy that needs reading can be read now, and what it costs. Reads the key and token history. */
const CHANGED = "This page or your fields changed since you reviewed this. Review it again.";

type ProviderCheck = { ready: true; estimate: NonNullable<PromoteImpact["estimate"]> } | { ready: false; reason: string | null };

async function checkProvider(userId: string, specimenId: string): Promise<ProviderCheck> {
  const e = await estimateExtraction(userId, { documentIds: [specimenId] });
  const blocker = e.blockers[0]?.reason ?? null;
  if (e.providerProblem !== null || blocker !== null) return { ready: false, reason: e.providerProblem ?? blocker };
  return {
    ready: true,
    estimate: { estCostUsd: e.estCostUsd, estSeconds: e.estSeconds, keySource: e.keySource, keyHint: e.keySource === "user" ? e.keyHint : null, model: e.model },
  };
}

type ImpactContext = { impact: PromoteImpact; pages: SourcePage[]; plan: ReadingCopy | null; provider: ProviderCheck | null };

/**
 * The impact from the database, plus the provider check when the copy would need reading. Inside the
 * promote transaction the provider check from the preview is passed in (`known`), so the book and
 * specimen locks are never held across a key lookup and a token-history query; a case that needed no
 * provider check then and needs one now has changed, and is refused as such.
 */
async function computePromoteImpact(
  userId: string,
  specimenId: string,
  db: Db,
  known?: { provider: ProviderCheck | null },
): Promise<ImpactContext> {
  const specimen = await requireSpecimen(userId, specimenId, db);
  const state = testReadingState(specimen, specimen.template);
  if (state === "running") throw new AppError("CONFLICT", "Wait for the test to finish, then add the page.");
  const pages = await loadSourcePages(db, specimenId);
  const photoIdMap = new Map(pages.map((p) => [p.id, p.id]));

  let plan: ReadingCopy | null = null;
  let reason: string | null = null;
  if (state === "current") {
    const reading = await loadReading(db, specimenId);
    plan = planReadingCopy(reading.runs, reading.records, photoIdMap);
    if (plan === null) reason = "this test didn't read every page";
  } else {
    reason = REASONS[state];
  }

  let mode: PromoteMode = "with-reading";
  let estimate: PromoteImpact["estimate"] = null;
  let provider: ProviderCheck | null = null;
  if (plan === null) {
    if (known && known.provider === null) throw new AppError("CONFLICT", CHANGED);
    provider = known?.provider ?? (await checkProvider(userId, specimenId));
    if (provider.ready) {
      mode = "read-again";
      estimate = provider.estimate;
    } else {
      mode = "unread";
      reason = provider.reason ?? reason;
    }
  }

  const copies = await db.document.aggregate({
    where: { copiedFromDocumentId: specimenId, isSpecimen: false, deletedAt: null },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const earlierCopies =
    copies._count._all > 0 && copies._max.createdAt ? { count: copies._count._all, lastAt: copies._max.createdAt.toISOString() } : null;
  const counts = { mode, pages: pages.length, values: plan?.values.length ?? 0, reason, earlierCopies: earlierCopies?.count ?? 0 };
  const hash = impactHash({
    action: "specimen.promote",
    specimenId,
    ...counts,
    pageIds: pages.map((p) => p.id),
    lastExtractedAt: specimen.lastExtractedAt?.toISOString() ?? null,
    contentChangedAt: specimen.contentChangedAt?.toISOString() ?? null,
    fieldsChangedAt: specimen.template.fieldsChangedAt.toISOString(),
  });
  return { impact: { impactHash: hash, mode, pages: pages.length, values: counts.values, reason, estimate, earlierCopies }, pages, plan, provider };
}

/** What adding a specimen to the documents does, for the counted confirmation. */
export async function promoteImpact(userId: string, specimenId: string): Promise<PromoteImpact> {
  return (await computePromoteImpact(userId, specimenId, prisma)).impact;
}

/**
 * Adds a copy of a specimen to the documents (decision 78). The specimen stays with its template.
 * - `with-reading`: the test is current, so the reading is copied with it — no model call — and the
 *   transform builds its rows.
 * - `read-again`: the fields or pages changed since the test, so the copy is queued for extraction.
 * - `unread`: it can't be read right now (no field to extract, or no key); it is added unread.
 */
export async function promoteSpecimen(
  userId: string,
  specimenId: string,
  input: PromoteSpecimenInput,
): Promise<{ documentId: string; mode: PromoteMode }> {
  const specimen = await requireSpecimen(userId, specimenId);
  const copyKey = copyKeyFor("promote", specimenId, input.nonce);
  const done = await findCopy(copyKey);
  if (done) return done;

  const before = await computePromoteImpact(userId, specimenId, prisma);
  if (before.impact.impactHash !== input.impactHash) throw new AppError("CONFLICT", CHANGED);
  const copied = await copyPageObjects(specimen.bookId, before.pages);
  const photoIdMap = new Map(copied.map((p) => [p.id, p.newId]));

  let result: { documentId: string; mode: PromoteMode };
  try {
    result = await prisma.$transaction(
      async (tx) => {
        await lockBook(tx, specimen.bookId);
        // Ordered against a Test starting on it and against a page being added or replaced.
        await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${specimenId} FOR UPDATE`;
        const now = await computePromoteImpact(userId, specimenId, tx, { provider: before.provider });
        if (now.impact.impactHash !== input.impactHash || !samePages(before.pages, now.pages)) throw new AppError("CONFLICT", CHANGED);
        const documentId = await insertCopiedDocument(tx, {
          bookId: specimen.bookId,
          templateId: specimen.templateId,
          label: specimen.label,
          manualValues: specimen.manualValues,
          isSpecimen: false,
          copyKey,
          copiedFromDocumentId: specimenId,
          pages: copied,
        });
        if (now.impact.mode === "with-reading") {
          const reading = await loadReading(tx, specimenId);
          const plan = planReadingCopy(reading.runs, reading.records, photoIdMap);
          if (plan === null) throw new AppError("CONFLICT", CHANGED);
          await insertReading(tx, documentId, plan);
        }
        return { documentId, mode: now.impact.mode };
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await findCopy(copyKey);
    if (!winner) throw err;
    return winner;
  }

  if (result.mode === "with-reading") {
    await requestDocumentTransform(result.documentId);
  } else if (result.mode === "read-again" && before.impact.estimate) {
    // Enqueued only, never read here: the worker does the reading (CLAUDE.md). The copy is already
    // committed, so a start that fails or is skipped leaves it unread, and the answer says so rather
    // than an error that invites a retry (which would find the copy and report it unread anyway).
    const queued = await startExtraction(userId, { documentIds: [result.documentId], model: before.impact.estimate.model, nonce: input.nonce })
      .then((r) => r.queued + r.alreadyStarted > 0)
      .catch((err: unknown) => {
        log.error("promoted copy could not be queued for reading", err, { documentId: result.documentId });
        return false;
      });
    if (!queued) return { documentId: result.documentId, mode: "unread" };
  }
  return result;
}

/** A copy this exact action already made, and what it was. */
async function findCopy(copyKey: string): Promise<{ documentId: string; mode: PromoteMode } | null> {
  const doc = await prisma.document.findUnique({
    where: { copyKey },
    select: { id: true, runState: true, runs: { where: { idempotencyKey: { startsWith: "copy:" } }, select: { id: true }, take: 1 } },
  });
  if (!doc) return null;
  const mode: PromoteMode = doc.runs.length > 0 ? "with-reading" : doc.runState === "NEVER_RUN" ? "unread" : "read-again";
  return { documentId: doc.id, mode };
}
