import { requireBookAccess } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import { COUNTING_DOC_TEMPLATE_SQL } from "@/lib/db/scope";
import { REVIEW_SOURCES, type ReviewSource } from "@/lib/table/schemas";

import type { ReviewPace } from "./types";

/**
 * The first readout of `reviewedAt` / `reviewedVia` (docs/06 Phase 19, decisions 56 and 57): seconds per reviewed
 * cell, the product's stated measure (docs/01 §1), per book and per review source.
 *
 * A review **event** is every cell stamped at one instant by one source: a per-cell confirm is an event of one cell,
 * a row mark (or a batch of row marks sent together) is one event of N cells. An event's time is the gap since the
 * book's previous event, whatever its source — the time spent reading and typing before that mark. So a `⌘Enter` over
 * twelve cells after forty seconds reads as 3.3 s per cell, not twelve instant reviews.
 *
 * A gap longer than `BREAK_SECONDS` is a break, not a review: that event's cells are counted but not timed, as is the
 * first event of the book. Sources are never blended — the whole point of recording them.
 *
 * One known skew, small and towards *slower*: a cell reviewed and then un-reviewed leaves no event, so the next event's
 * gap takes in its time too. An event sharing its instant with another source's gets a gap of zero, which is not a
 * review taking no time, so it is counted but not timed rather than pulling its source's average down.
 *
 * The `events` scan sorts every reviewed cell of the book and there is no index on `Cell.reviewedAt`. That is fine at
 * a few thousand rows; when it isn't, the index is `(isReviewed, reviewedAt)`, and `resumePoint` wants the same one.
 */

export const BREAK_SECONDS = 300;

type PaceRecord = { via: ReviewSource; cells: number; timedCells: number; seconds: number };

export async function reviewPace(userId: string, bookId: string): Promise<ReviewPace> {
  await requireBookAccess(userId, bookId);
  const found = await prisma.$queryRaw<PaceRecord[]>`
    WITH events AS (
      SELECT c."reviewedAt" AS at, c."reviewedVia" AS via, count(*) AS cells
      FROM "Cell" c
      JOIN "Row" r ON r.id = c."rowId"
      JOIN "Document" d ON d.id = r."documentId"
      JOIN "Template" t ON t.id = d."templateId"
      JOIN "OutputColumn" oc ON oc.id = c."outputColumnId" AND oc."deletedAt" IS NULL
      WHERE r."bookId" = ${bookId} AND r."deletedAt" IS NULL AND NOT r."isVoid" AND ${COUNTING_DOC_TEMPLATE_SQL}
        AND c."isReviewed" AND c."reviewedAt" IS NOT NULL AND c."reviewedVia" IS NOT NULL
      GROUP BY c."reviewedAt", c."reviewedVia"
    ), gaps AS (
      SELECT via, cells, extract(epoch FROM at - lag(at) OVER (ORDER BY at, via)) AS gap FROM events
    )
    SELECT via::text AS via,
           sum(cells)::int AS cells,
           coalesce(sum(cells) FILTER (WHERE gap > 0 AND gap <= ${BREAK_SECONDS}), 0)::int AS "timedCells",
           coalesce(sum(gap) FILTER (WHERE gap > 0 AND gap <= ${BREAK_SECONDS}), 0)::float8 AS seconds
    FROM gaps
    GROUP BY via`;
  const byVia = new Map(found.map((r) => [r.via, r]));
  return {
    // Always all three, in a fixed order, so the readout's lines don't move as sources appear.
    sources: REVIEW_SOURCES.map((via) => byVia.get(via) ?? { via, cells: 0, timedCells: 0, seconds: 0 }),
    breakSeconds: BREAK_SECONDS,
  };
}
