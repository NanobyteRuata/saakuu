import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({
  db: {
    field: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), updateMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    fieldGroup: { findMany: vi.fn(), update: vi.fn() },
    template: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    mapping: { findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    mappingInput: { deleteMany: vi.fn() },
    rawValue: { count: vi.fn(), deleteMany: vi.fn() },
    cell: { count: vi.fn() },
    row: { count: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("./access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./access")>()),
  requireFieldAccess: vi.fn().mockResolvedValue({ id: "f_seq", templateId: "t1" }),
}));

import { deleteFields, fieldsDeleteImpact, restoreField } from "./fields-service";

const seqField = {
  id: "f_seq",
  groupId: "g1",
  labelSource: "စဉ်",
  labelMeaning: "No.",
  dataType: "INTEGER",
  mode: "EXTRACT",
  note: null,
  choices: [],
  markSymbols: null,
  isSequence: true,
  position: "a0",
};

describe("field soft delete and restore", () => {
  beforeEach(() => {
    for (const group of Object.values(db)) {
      if (typeof group === "function") group.mockReset();
      else for (const fn of Object.values(group)) fn.mockReset();
    }
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
    db.$queryRaw.mockResolvedValue([{ id: "t1" }]);
    db.field.findMany.mockResolvedValue([{ id: "f_seq", templateId: "t1", labelSource: "စဉ်" }]);
    db.template.findUniqueOrThrow.mockResolvedValue({ name: "Ledger", sequenceFieldId: "f_seq", kind: "TABLE" });
    // First call: mappings that break. Second: other working mappings for the same columns.
    db.mapping.findMany
      .mockResolvedValueOnce([{ outputColumnId: "c_no", outputColumn: { label: "Row no.", deletedAt: null } }])
      .mockResolvedValueOnce([]);
    db.mapping.count.mockResolvedValue(0);
    db.cell.count.mockResolvedValue(0);
    db.row.count.mockResolvedValue(0);
    db.rawValue.count.mockResolvedValue(7);
    db.field.count.mockResolvedValue(3);
    db.field.updateMany.mockResolvedValue({ count: 1 });
  });

  it("refuses a delete whose impact changed since the preview, and writes nothing", async () => {
    const { impactHash } = await fieldsDeleteImpact("u1", ["f_seq"]);
    db.mapping.findMany
      .mockResolvedValueOnce([{ outputColumnId: "c_no", outputColumn: { label: "Row no.", deletedAt: null } }])
      .mockResolvedValueOnce([]);
    db.rawValue.count.mockResolvedValue(8); // another value was read in the meantime

    await expect(deleteFields("u1", { ids: ["f_seq"], impactHash, confirm: true })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.field.updateMany).not.toHaveBeenCalled();
    expect(db.mapping.updateMany).not.toHaveBeenCalled();
  });

  it("soft-deletes without touching raw values, breaks mappings, and remembers the sequence field", async () => {
    const impact = await fieldsDeleteImpact("u1", ["f_seq"]);
    expect(impact).toMatchObject({ rawValues: 7, clearsSequence: true, clearedColumns: ["c_no"], severity: "DESTRUCTIVE" });
    db.mapping.findMany
      .mockResolvedValueOnce([{ outputColumnId: "c_no", outputColumn: { label: "Row no.", deletedAt: null } }])
      .mockResolvedValueOnce([]);

    await deleteFields("u1", { ids: ["f_seq"], impactHash: impact.impactHash, confirm: true });

    expect(db.field.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["f_seq"] }, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(db.field.delete).not.toHaveBeenCalled();
    expect(db.rawValue.deleteMany).not.toHaveBeenCalled();
    expect(db.mappingInput.deleteMany).not.toHaveBeenCalled();
    expect(db.mapping.updateMany).toHaveBeenCalledWith({
      where: { templateId: "t1", inputs: { some: { fieldId: { in: ["f_seq"] } } } },
      data: { state: "BROKEN" },
    });
    expect(db.template.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { sequenceFieldId: null } });
  });

  it("restores the same field in place, reinstates the sequence field and repairs its mappings", async () => {
    db.field.findFirst.mockResolvedValue(seqField);
    db.fieldGroup.findMany.mockResolvedValue([
      { id: "g1", parentGroupId: null, labelSource: "Child", labelMeaning: null, position: "a1", selection: "NONE" },
    ]);
    db.field.findMany.mockReset().mockResolvedValue([{ ...seqField, id: "f_other", isSequence: false, position: "a1" }]);
    db.template.findUniqueOrThrow.mockResolvedValue({ kind: "TABLE", sequenceFieldId: null });
    db.field.update.mockResolvedValue({ ...seqField });
    db.mapping.findMany
      .mockReset()
      .mockResolvedValue([{ id: "m1", outputColumn: { deletedAt: null }, inputs: [{ field: { deletedAt: null } }] }]);

    const result = await restoreField("u1", "f_seq");

    expect(db.field.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "f_seq" }, data: { deletedAt: null, groupId: "g1", position: "a0", isSequence: true } }),
    );
    expect(db.template.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { sequenceFieldId: "f_seq" } });
    expect(db.mapping.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["m1"] } }, data: { state: "OK" } });
    expect(result).toMatchObject({ sequenceRestored: true, mappingsRepaired: 1 });
  });
});
