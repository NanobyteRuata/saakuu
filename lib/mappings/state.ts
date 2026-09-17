import type { Db } from "@/lib/templates/access";
import { loadSourceTree } from "@/lib/templates/source-tree";
import { mappingProblem } from "@/lib/transform/mappings";

import { MAX_MAPPINGS } from "./schemas";
import { mappingSelect, rowToTransformMapping } from "./views";

/**
 * Broken-mapping detection (docs/02 invariant 8). Works out each mapping's state from the current
 * source layer and columns, and stores the ones that changed: a deleted field, group or column breaks a
 * mapping; restoring it, or fixing a tick group, repairs it. Call in the same transaction as the change,
 * before `recomputeConfigState`.
 */
export async function recomputeMappingStates(tx: Db, templateId: string): Promise<{ broken: number; repaired: number }> {
  const rows = await tx.mapping.findMany({
    where: { templateId },
    select: { ...mappingSelect, outputColumn: { select: { deletedAt: true } } },
    take: MAX_MAPPINGS,
  });
  if (rows.length === 0) return { broken: 0, repaired: 0 };
  const { tree } = await loadSourceTree(tx, templateId);
  const liveColumnIds = new Set(rows.filter((r) => r.outputColumn.deletedAt === null).map((r) => r.outputColumnId));
  const toBroken: string[] = [];
  const toOk: string[] = [];
  for (const row of rows) {
    const broken = mappingProblem(rowToTransformMapping(row), { tree, liveColumnIds }) !== null;
    if (broken && row.state !== "BROKEN") toBroken.push(row.id);
    if (!broken && row.state !== "OK") toOk.push(row.id);
  }
  if (toBroken.length > 0) await tx.mapping.updateMany({ where: { id: { in: toBroken } }, data: { state: "BROKEN" } });
  if (toOk.length > 0) await tx.mapping.updateMany({ where: { id: { in: toOk } }, data: { state: "OK" } });
  return { broken: toBroken.length, repaired: toOk.length };
}
