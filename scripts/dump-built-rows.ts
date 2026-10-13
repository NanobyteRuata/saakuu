/**
 * Phase 26: every row the transform builds, for every document that has a reading. Read-only.
 *
 *   DATABASE_URL=<a copy of the database> pnpm tsx scripts/dump-built-rows.ts <out.jsonl>
 *
 * One line per document, in id order: each row's key and void reason and each cell's value, state,
 * flag level and messages, plus the document's flags and dropped duplicates. A migration that must
 * not change any book's output is rehearsed by running this before and after it on a copy and
 * comparing the two files (docs/06, Phases 24 and 26). Nothing is written to the database.
 */
import { createWriteStream } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { loadDotEnv } from "@/lib/env";
import { runTransform } from "@/lib/transform/run";
import { loadDocumentRecords, loadTemplateContext, parseManualValues, type TemplateContext } from "@/lib/transform/service";

loadDotEnv();
const prisma = new PrismaClient();

const PAGE = 200;

async function main(): Promise<void> {
  const outPath = process.argv[2];
  if (!outPath) throw new Error("Give the file to write: tsx scripts/dump-built-rows.ts <out.jsonl>");
  const out = createWriteStream(outPath);

  const [current] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  const db = current?.db ?? "database";
  const contexts = new Map<string, TemplateContext | null>();
  let documents = 0;
  let rows = 0;
  let cells = 0;
  let flagged = 0;
  let skipped = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.document.findMany({
      where: { records: { some: {} } },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, templateId: true, manualValues: true },
    });
    if (page.length === 0) break;
    cursor = page.at(-1)?.id;

    for (const doc of page) {
      if (!contexts.has(doc.templateId)) contexts.set(doc.templateId, await loadTemplateContext(prisma, doc.templateId));
      const context = contexts.get(doc.templateId);
      // A deleted template builds nothing.
      if (!context) {
        skipped++;
        continue;
      }
      const records = await loadDocumentRecords(prisma, doc.id);
      const result = runTransform({ ...context, manualValues: parseManualValues(doc.manualValues), records });
      documents++;
      rows += result.rows.length;
      for (const row of result.rows) {
        cells += row.cells.length;
        flagged += row.cells.filter((c) => c.validationState !== "NONE").length;
      }
      out.write(
        `${JSON.stringify({
          document: doc.id,
          template: doc.templateId,
          rows: result.rows.map((r) => ({
            record: r.rawRecordId,
            key: r.recordKey,
            void: r.voidReason,
            cells: r.cells.map((c) => ({
              column: c.outputColumnId,
              value: c.value,
              state: c.state,
              inherited: c.inherited,
              confidence: c.confidence,
              level: c.validationState,
              messages: c.validationMsgs,
              issues: c.buildIssues,
            })),
          })),
          duplicates: result.duplicates,
          flags: result.flags,
        })}\n`,
      );
    }
  }

  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  console.log(
    `${db}: ${documents} documents, ${rows} rows, ${cells} cells (${flagged} flagged) in ${contexts.size} templates; ${skipped} documents of deleted templates skipped.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
