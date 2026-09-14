/**
 * Phase 3.1 one-off: re-space each template's top-level positions.
 *
 * Phase 3 ordered top-level fields and groups in separate key spaces and always showed ungrouped
 * fields first, then groups. From Phase 3.1 they share one order (docs/02 invariant 9), so their
 * keys are rewritten to keep that visual order: top-level fields (live and soft-deleted, by key),
 * then top-level groups (by key). Nothing below the top level changes.
 *
 * Idempotent: a template whose top level already reads fields-then-groups is skipped, so running it
 * again right after is a no-op. Run it once after the Phase 3.1 migration: `pnpm db:respace`.
 * Don't run it after people have started interleaving groups and fields, or it will undo that.
 */
import { PrismaClient } from "@prisma/client";
import { generateNKeysBetween } from "fractional-indexing";

type Item = { kind: "field" | "group"; id: string; position: string };

const PAGE = 200;
const prisma = new PrismaClient();

function compare(a: Item, b: Item): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function respaceTemplate(templateId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Template" WHERE id = ${templateId} FOR UPDATE`;
    const fields = await tx.field.findMany({
      where: { templateId, groupId: null },
      select: { id: true, position: true },
      take: 10_000,
    });
    const groups = await tx.fieldGroup.findMany({
      where: { templateId, parentGroupId: null },
      select: { id: true, position: true },
      take: 1_000,
    });
    const target: Item[] = [
      ...fields.map((f) => ({ kind: "field" as const, ...f })).sort(compare),
      ...groups.map((g) => ({ kind: "group" as const, ...g })).sort(compare),
    ];
    const current = [...target].sort(compare);
    if (current.every((item, i) => item === target[i])) return 0;

    const keys = generateNKeysBetween(null, null, target.length);
    let written = 0;
    for (const [i, item] of target.entries()) {
      const position = keys[i];
      if (position === undefined || position === item.position) continue;
      if (item.kind === "field") await tx.field.update({ where: { id: item.id }, data: { position } });
      else await tx.fieldGroup.update({ where: { id: item.id }, data: { position } });
      written++;
    }
    return written;
  });
}

async function main() {
  let cursor: string | undefined;
  let templates = 0;
  let respaced = 0;
  let rows = 0;
  for (;;) {
    const page = await prisma.template.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const { id } of page) {
      const written = await respaceTemplate(id);
      templates++;
      if (written > 0) {
        respaced++;
        rows += written;
      }
    }
    const last = page.at(-1);
    if (page.length < PAGE || !last) break;
    cursor = last.id;
  }
  console.log(`Checked ${templates} templates: re-spaced ${respaced} (${rows} rows), ${templates - respaced} already in order.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
