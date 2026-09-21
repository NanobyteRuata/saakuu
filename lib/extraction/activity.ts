import { Prisma } from "@prisma/client";
import { z } from "zod";

import { requireBookAccess } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import type { Page } from "@/lib/db/pagination";
import { requireDocumentAccess } from "@/lib/documents/access";
import { PG_TIMESTAMPTZ } from "@/lib/documents/service";
import { ACTIVE_RUN_STATES, MAX_DOCUMENT_PAGES, type RunState } from "@/lib/documents/schemas";
import { AppError } from "@/lib/errors";
import { idSchema } from "@/lib/validation";

import { currentRunByPage, currentRuns, isRetryable } from "./plan";
import type { RunActivityInput } from "./schemas";

/**
 * What the machine is doing (Phase 18, decision 75): the run drawer on Documents. Per document and
 * per page, derived exactly as the document drawer derives it — a page's state is its newest covering
 * run — so the two drawers can never tell different stories about one page.
 */

/** A finished run stays in the drawer this long; running and failed ones stay until they change. */
const RECENT_MS = 24 * 60 * 60 * 1000;
/** Runs scanned per document to work out each page's current run; the same bound as the document drawer. */
const RUN_SCAN_LIMIT = 500;

export type PageRunState = "NOT_READ" | "QUEUED" | "RUNNING" | "COMPLETE" | "FAILED";

export type PageActivity = {
  photoId: string;
  /** 1-based. */
  page: number;
  state: PageRunState;
  /** The plain-language reason a failed page failed. */
  error: string | null;
  retryable: boolean;
};

export type RunActivityItem = {
  documentId: string;
  label: string | null;
  templateName: string;
  runState: RunState;
  /** When the newest run of this document was started. */
  lastRunAt: string;
  pages: PageActivity[];
};

export type RunActivityPage = Page<RunActivityItem> & {
  /** Documents of the whole book, not just this page: being read, and with failed pages. */
  summary: { active: number; failed: number };
};

type Ranked = { id: string; rank: number; at: string };

const cursorSchema = z.object({ r: z.number().int().min(0).max(2), at: z.string().min(1).max(64), id: idSchema });

function encodeCursor(row: Ranked): string {
  return Buffer.from(JSON.stringify({ r: row.rank, at: row.at, id: row.id })).toString("base64url");
}

function decodeCursor(cursor: string): Ranked {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    parsed = null;
  }
  const c = cursorSchema.safeParse(parsed);
  if (!c.success || !PG_TIMESTAMPTZ.test(c.data.at)) {
    throw new AppError("VALIDATION", "That list of runs is out of date. Reopen it.");
  }
  return { rank: c.data.r, at: c.data.at, id: c.data.id };
}

/**
 * Being read first, then failed or partly read, then finished; newest run first within each. Rank
 * and time are computed per document, so the keyset runs over the derived columns.
 */
async function rankedDocuments(bookId: string, input: RunActivityInput): Promise<Page<{ id: string }>> {
  const since = new Date(Date.now() - RECENT_MS);
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await prisma.$queryRaw<Ranked[]>`
    SELECT id, rank, at FROM (
      SELECT d.id,
             CASE WHEN d."runState" IN ('QUEUED', 'RUNNING') THEN 0
                  WHEN d."runState" IN ('FAILED', 'PARTIAL') THEN 1
                  ELSE 2 END AS rank,
             l.at AS at_ts,
             l.at::text AS at
      FROM "Document" d
      JOIN "Template" t ON t.id = d."templateId"
      JOIN (SELECT r."documentId", max(r."createdAt") AS at FROM "ExtractionRun" r
            JOIN "Document" rd ON rd.id = r."documentId"
            WHERE rd."bookId" = ${bookId} AND rd."deletedAt" IS NULL
            GROUP BY r."documentId") l ON l."documentId" = d.id
      WHERE d."bookId" = ${bookId} AND d."deletedAt" IS NULL AND t."deletedAt" IS NULL
    ) x
    WHERE (rank < 2 OR at_ts > ${since.toISOString()}::timestamptz)
      ${
        after
          ? Prisma.sql`AND (rank > ${after.rank} OR (rank = ${after.rank} AND (at_ts < ${after.at}::timestamptz OR (at_ts = ${after.at}::timestamptz AND id < ${after.id}))))`
          : Prisma.empty
      }
    ORDER BY rank, at_ts DESC, id DESC
    LIMIT ${input.limit + 1}`;
  const items = rows.slice(0, input.limit);
  const last = items.at(-1);
  return { items: items.map(({ id }) => ({ id })), nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null };
}

async function loadActivity(ids: string[]): Promise<RunActivityItem[]> {
  if (ids.length === 0) return [];
  const [docs, runs] = await Promise.all([
    prisma.document.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        label: true,
        runState: true,
        template: { select: { name: true } },
        photos: {
          where: { deletedAt: null },
          orderBy: [{ pageIndex: "asc" }, { id: "asc" }],
          select: { id: true },
          take: MAX_DOCUMENT_PAGES,
        },
      },
    }),
    prisma.$queryRaw<{ id: string; documentId: string; state: RunState; photoIds: string[]; createdAt: Date; error: string | null }[]>`
      SELECT id, "documentId", state, "photoIds", "createdAt", error FROM (
        SELECT r.id, r."documentId", r.state::text AS state, r."photoIds", r."createdAt", r.error,
               row_number() OVER (PARTITION BY r."documentId" ORDER BY r."createdAt" DESC, r.id DESC) AS n
        FROM "ExtractionRun" r WHERE r."documentId" IN (${Prisma.join(ids)})
      ) x WHERE n <= ${RUN_SCAN_LIMIT}`,
  ]);
  const runsOf = new Map<string, typeof runs>();
  for (const r of runs) runsOf.set(r.documentId, [...(runsOf.get(r.documentId) ?? []), r]);
  const byId = new Map(docs.map((d) => [d.id, d]));
  return ids.flatMap((id) => {
    const d = byId.get(id);
    const docRuns = runsOf.get(id) ?? [];
    const newest = docRuns.reduce<Date | null>((at, r) => (at && at > r.createdAt ? at : r.createdAt), null);
    if (!d || !newest) return [];
    const photoIds = d.photos.map((p) => p.id);
    const byPage = currentRunByPage(photoIds, docRuns);
    const current = new Set(currentRuns(photoIds, docRuns).map((r) => r.id));
    const active = ACTIVE_RUN_STATES.includes(d.runState);
    return [
      {
        documentId: d.id,
        label: d.label,
        templateName: d.template.name,
        runState: d.runState,
        lastRunAt: newest.toISOString(),
        pages: photoIds.map((photoId, i) => {
          const run = byPage.get(photoId);
          const state: PageRunState = !run ? "NOT_READ" : run.state === "PARTIAL" || run.state === "NEVER_RUN" ? "FAILED" : run.state;
          return {
            photoId,
            page: i + 1,
            state,
            error: run?.state === "FAILED" ? run.error : null,
            retryable: run ? isRetryable(run, current.has(run.id), active) : false,
          };
        }),
      },
    ];
  });
}

export async function listRunActivity(userId: string, bookId: string, input: RunActivityInput): Promise<RunActivityPage> {
  await requireBookAccess(userId, bookId);
  const [ranked, counts] = await Promise.all([
    input.documentId ? focusedDocument(userId, bookId, input.documentId) : rankedDocuments(bookId, input),
    prisma.document.groupBy({
      by: ["runState"],
      where: { bookId, deletedAt: null, template: { deletedAt: null }, runState: { in: ["QUEUED", "RUNNING", "FAILED", "PARTIAL"] } },
      _count: { _all: true },
    }),
  ]);
  const count = (states: RunState[]) => counts.filter((c) => states.includes(c.runState)).reduce((n, c) => n + c._count._all, 0);
  return {
    items: await loadActivity(ranked.items.map((r) => r.id)),
    nextCursor: ranked.nextCursor,
    summary: { active: count(ACTIVE_RUN_STATES), failed: count(["FAILED", "PARTIAL"]) },
  };
}

/** A row's own `Running 3/12` opens the drawer on that document, however far down the list it would sort. */
async function focusedDocument(userId: string, bookId: string, documentId: string): Promise<Page<{ id: string }>> {
  const doc = await requireDocumentAccess(userId, documentId);
  if (doc.bookId !== bookId) throw new AppError("NOT_FOUND", "That document doesn't exist or was deleted.");
  return { items: [{ id: documentId }], nextCursor: null };
}
