/**
 * Phase 27: what the AI is sent about every template's fields. Read-only.
 *
 *   DATABASE_URL=<a copy of the database> pnpm tsx scripts/dump-sent-fields.ts <out.jsonl>
 *
 * One line per template, in id order: the field list exactly as the current prompt writes it (each
 * field's path, type, hint, note, choices, symbols, sequence and skip), and a fingerprint of the
 * whole instruction text. A migration that must not change what the AI is told is rehearsed by
 * running this before and after it on a copy and comparing the two files (docs/06, Phase 27). The
 * book's glossary and settings are left out: they are not field settings. Nothing is written to the
 * database.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { DEFAULT_MODEL_ID } from "@/lib/ai/models";
import { buildExtractionPrompt, PROMPT_VERSION } from "@/lib/ai/prompts";
import { buildTemplateSnapshot } from "@/lib/ai/snapshot";
import { loadDotEnv } from "@/lib/env";
import { MAX_FIELDS } from "@/lib/templates/schemas";
import { fieldSelect, toFieldView } from "@/lib/templates/views";

loadDotEnv();
const prisma = new PrismaClient();

const PAGE = 200;

/** The field list as it stands in the instruction text: the first fenced JSON block. */
function sentFieldList(system: string): unknown {
  const match = /```json\n([\s\S]*?)\n```/.exec(system);
  if (!match?.[1]) throw new Error("The prompt has no field list.");
  return JSON.parse(match[1]);
}

async function main(): Promise<void> {
  const outPath = process.argv[2];
  if (!outPath) throw new Error("Give the file to write: tsx scripts/dump-sent-fields.ts <out.jsonl>");
  const out = createWriteStream(outPath);

  const [current] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  const db = current?.db ?? "database";
  let templates = 0;
  let fields = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.template.findMany({
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, kind: true, languageHint: true, instructions: true, anchors: true },
    });
    if (page.length === 0) break;
    cursor = page.at(-1)?.id;

    for (const template of page) {
      const rows = await prisma.field.findMany({ where: { templateId: template.id, deletedAt: null }, select: fieldSelect, take: MAX_FIELDS });
      const snapshot = buildTemplateSnapshot(template, rows.map(toFieldView));
      const { system } = buildExtractionPrompt({
        images: [],
        template: snapshot,
        glossary: [],
        book: { numeralSystem: "AUTO", dateEra: "GREGORIAN" },
        model: DEFAULT_MODEL_ID,
      });
      templates++;
      fields += snapshot.fields.length;
      out.write(
        `${JSON.stringify({
          template: template.id,
          kind: template.kind,
          // Ids are written as f1, f2, … in the prompt, so the order of the list is the order sent.
          fieldIds: snapshot.fields.map((f) => f.id),
          sent: sentFieldList(system),
          instructions: createHash("sha256").update(system).digest("hex"),
        })}\n`,
      );
    }
  }

  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  console.log(`${db}: ${templates} templates, ${fields} fields sent, prompt ${PROMPT_VERSION}.`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
