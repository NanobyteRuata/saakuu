import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({
  db: {
    outputColumn: { findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    mapping: { findMany: vi.fn(), updateMany: vi.fn() },
    template: { updateMany: vi.fn() },
    cell: { count: vi.fn(), createMany: vi.fn() },
    row: { count: vi.fn(), findMany: vi.fn() },
    book: { update: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/auth/guards", () => ({ requireBookAccess: vi.fn().mockResolvedValue({ id: "book1", userId: "u1" }) }));

import { applyColumnOps, previewColumnOps } from "./columns-service";
import type { ColumnOp } from "./schemas";

const deleteB: ColumnOp[] = [{ kind: "delete", id: "c_b" }];

describe("columns service", () => {
  beforeEach(() => {
    for (const group of Object.values(db)) {
      if (typeof group === "function") group.mockReset();
      else for (const fn of Object.values(group)) fn.mockReset();
    }
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
    db.outputColumn.findMany.mockResolvedValue([
      { id: "c_a", key: "a", label: "Name", dataType: "TEXT", enumValues: [], isRequired: false, position: "a0" },
      { id: "c_b", key: "b", label: "Age", dataType: "TEXT", enumValues: [], isRequired: false, position: "a1" },
    ]);
    db.mapping.findMany.mockResolvedValue([{ templateId: "t1", outputColumnId: "c_b", template: { name: "Card" } }]);
    db.cell.count.mockResolvedValue(0);
    db.row.count.mockResolvedValue(0);
  });

  it("refuses an apply whose impact changed since the preview, and writes nothing", async () => {
    const { impactHash } = await previewColumnOps("u1", "book1", deleteB);
    db.cell.count.mockResolvedValueOnce(5); // a cell was edited in the meantime

    await expect(applyColumnOps("u1", "book1", { ops: deleteB, impactHash, confirm: true })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(db.outputColumn.update).not.toHaveBeenCalled();
    expect(db.mapping.updateMany).not.toHaveBeenCalled();
  });

  it("soft-deletes a column, parks its key, and breaks the mappings that used it", async () => {
    const { impactHash } = await previewColumnOps("u1", "book1", deleteB);
    await applyColumnOps("u1", "book1", { ops: deleteB, impactHash, confirm: true });

    const update = db.outputColumn.update.mock.calls[0]?.[0];
    expect(update.data).toMatchObject({ key: "b~del~c_b", deletedAt: expect.any(Date) });
    expect(db.mapping.updateMany).toHaveBeenCalledWith({ where: { outputColumnId: { in: ["c_b"] } }, data: { state: "BROKEN" } });
    expect(db.template.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["t1"] } }, data: { configState: "CONFLICTED" } });
  });
});
