import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Copying across books is a cross-tenant path (docs/06 Phase 17): a mapping that follows a template into
 * another book would name the first book's columns, and a row written anywhere but the target book would
 * land in someone else's data.
 */

const { db, guards } = vi.hoisted(() => ({
  db: {
    book: { findUniqueOrThrow: vi.fn(), create: vi.fn() },
    template: { findUniqueOrThrow: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    field: { findMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
    mapping: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    mappingInput: { createMany: vi.fn() },
    outputColumn: { findMany: vi.fn(), createMany: vi.fn() },
    glossaryEntry: { findMany: vi.fn(), createMany: vi.fn() },
    validationRule: { findMany: vi.fn(), createMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  guards: { requireBookAccess: vi.fn(), requireTemplateAccess: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/auth/guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guards")>()),
  requireBookAccess: guards.requireBookAccess,
}));
vi.mock("./access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./access")>()),
  requireTemplateAccess: guards.requireTemplateAccess,
}));
vi.mock("@/lib/mappings/state", () => ({ recomputeMappingStates: vi.fn().mockResolvedValue({ broken: 0, repaired: 0 }) }));

import { copyBook } from "@/lib/books/copy";
import { AppError } from "@/lib/errors";

import { duplicateTemplate } from "./service";

const field = (id: string, position: string) => ({
  id,
  labelSource: `ကလေး › ${id}`,
  labelMeaning: `Child › ${id}`,
  dataType: "TEXT",
  mode: "EXTRACT",
  note: null,
  choices: [],
  markSymbols: null,
  typeOptions: null,
  isSequence: false,
  position,
});
const fields = [field("f_name", "a0"), field("f_m", "a1"), field("f_f", "a2")];
const mapping = (id: string, outputColumnId: string) => ({
  id,
  outputColumnId,
  kind: "COPY",
  separator: null,
  splitBy: null,
  splitIndex: null,
  splitRegex: null,
  constantValue: null,
  expression: null,
  tickSelection: null,
  noneMarked: null,
  multipleMarked: null,
  noneValue: null,
  tickLabel: null,
  fillDown: true,
  position: "a0",
  inputs: [{ fieldId: "f_name", position: 0, tickValue: null }],
  outputColumn: { deletedAt: null },
});

/** Every row a create call wrote, flattened across `create` and `createMany`. */
function written(fn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fn.mock.calls.flatMap(([arg]) => {
    const data = (arg as { data: Record<string, unknown> | Record<string, unknown>[] }).data;
    return Array.isArray(data) ? data : [data];
  });
}

describe("copying across books", () => {
  beforeEach(() => {
    for (const group of Object.values(db)) {
      if (typeof group === "function") group.mockReset();
      else for (const fn of Object.values(group)) fn.mockReset();
    }
    guards.requireBookAccess.mockReset().mockResolvedValue({ id: "book_b", userId: "u1" });
    guards.requireTemplateAccess.mockReset().mockResolvedValue({ id: "t1", bookId: "book_a" });
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
    db.$queryRaw.mockResolvedValue([{ id: "book_b" }]); // the target book, locked and live
    db.template.count.mockResolvedValue(0);
    db.template.findUniqueOrThrow.mockResolvedValue({
      name: "Malaria register",
      kind: "FORM",
      modelOverride: null,
      anchors: ["ဆေးရုံ"],
      languageHint: "my",
      instructions: "Read carefully",
      sequenceFieldId: null,
    });
    db.field.findMany.mockResolvedValue(fields);
    db.field.count.mockResolvedValue(fields.length);
    db.mapping.count.mockResolvedValue(2);
    db.mapping.findMany.mockResolvedValue([mapping("m1", "c_a1"), mapping("m2", "c_gone")]);
  });

  it("copies a template into another book with its structure and no mapping", async () => {
    db.template.findMany.mockResolvedValue([]);
    const result = await duplicateTemplate("u1", "t1", { includeMappings: true, targetBookId: "book_b" });

    expect(guards.requireBookAccess).toHaveBeenCalledWith("u1", "book_b");
    expect(db.mapping.findMany).not.toHaveBeenCalled();
    expect(db.mapping.create).not.toHaveBeenCalled();
    expect(db.mappingInput.createMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ bookId: "book_b", fields: 3, mappings: 0, mappingsLeftBehind: 2 });

    const [template] = written(db.template.create);
    expect(template).toMatchObject({ id: result.id, bookId: "book_b", name: "Malaria register", anchors: ["ဆေးရုံ"], languageHint: "my" });
    const copiedFields = written(db.field.createMany);
    for (const row of copiedFields) expect(row.templateId).toBe(result.id);
    // Names keep the header in front, and the copies have ids of their own.
    expect(copiedFields.map((f) => f.labelSource)).toEqual(["ကလေး › f_name", "ကလေး › f_m", "ကလေး › f_f"]);
    expect(copiedFields.map((r) => r.id)).not.toContain("f_name");
  });

  it("refuses a book the user does not own, and writes nothing", async () => {
    guards.requireBookAccess.mockRejectedValue(new AppError("NOT_FOUND", "That book doesn't exist or you don't have access to it."));
    await expect(duplicateTemplate("u1", "t1", { includeMappings: false, targetBookId: "book_other" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.template.create).not.toHaveBeenCalled();
    expect(db.field.createMany).not.toHaveBeenCalled();
  });

  it("a new book from a book points every mapping and rule at its own columns", async () => {
    guards.requireBookAccess.mockResolvedValue({ id: "book_a", userId: "u1" });
    db.book.findUniqueOrThrow.mockResolvedValue({ defaultModel: "m", numeralSystem: "AUTO", dateEra: "GREGORIAN", blankToken: "", illegibleToken: "?" });
    db.book.create.mockResolvedValue({ id: "book_new" });
    db.outputColumn.findMany.mockResolvedValue([
      { id: "c_a1", key: "name", label: "Name", dataType: "TEXT", enumValues: [], position: "a0", isRequired: false },
      { id: "c_a2", key: "age", label: "Age", dataType: "INTEGER", enumValues: [], position: "a1", isRequired: false },
    ]);
    db.glossaryEntry.findMany.mockResolvedValue([{ term: "ဒီ", meaning: "ditto", position: "a0" }]);
    db.validationRule.findMany.mockResolvedValue([
      { outputColumnId: "c_a2", kind: "CROSS_COLUMN", params: { otherColumnId: "c_a1", operator: "LT" }, message: null, severity: "WARNING", enabled: true },
      { outputColumnId: "c_gone", kind: "REQUIRED", params: {}, message: null, severity: "WARNING", enabled: true },
    ]);
    db.template.findMany.mockImplementation(async (args: { where: { bookId: string } }) =>
      args.where.bookId === "book_a" ? [{ id: "t1", name: "Malaria register" }] : [],
    );

    const result = await copyBook("u1", "book_a", { name: "Q2" });

    const columns = written(db.outputColumn.createMany);
    const newColumnIds = new Set(columns.map((c) => c.id));
    expect(columns.every((c) => c.bookId === "book_new")).toBe(true);
    expect(newColumnIds.has("c_a1")).toBe(false);

    const mappings = written(db.mapping.create);
    expect(mappings).toHaveLength(1);
    expect(newColumnIds.has(mappings[0]?.outputColumnId as string)).toBe(true);
    expect(result).toMatchObject({ id: "book_new", templates: 1, columns: 2, mappings: 1, skippedMappings: 1, glossary: 1, rules: 1 });

    const [rule] = written(db.validationRule.createMany);
    expect(rule?.bookId).toBe("book_new");
    expect(newColumnIds.has(rule?.outputColumnId as string)).toBe(true);
    expect(newColumnIds.has((rule?.params as { otherColumnId: string }).otherColumnId)).toBe(true);
    for (const t of written(db.template.create)) expect(t.bookId).toBe("book_new");
  });
});
