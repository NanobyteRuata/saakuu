import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Replacing a page is a data-loss path: the whole point of Phase 11 is that it keeps the rows, human
 * edits and reviewed marks that deleting the document would have thrown away (decision 59). The test
 * therefore asserts what `replacePhoto` must *not* touch as directly as what it writes.
 */

const { db, enqueuePhotoIngest } = vi.hoisted(() => ({
  enqueuePhotoIngest: vi.fn().mockResolvedValue(undefined),
  db: {
    photo: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    document: { update: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
    row: { count: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
    cell: { count: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
    cellEdit: { deleteMany: vi.fn(), createMany: vi.fn() },
    rawRecord: { deleteMany: vi.fn(), createMany: vi.fn() },
    rawValue: { deleteMany: vi.fn(), createMany: vi.fn() },
    extractionRun: { count: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/documents/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/access")>()),
  requirePhotoAccess: vi.fn().mockResolvedValue({ id: "old", documentId: "doc1", bookId: "book1" }),
  lockBook: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/storage/s3", () => ({
  headObject: vi.fn().mockResolvedValue({ byteSize: 1234 }),
  presignGet: vi.fn().mockResolvedValue("https://example.test/signed"),
  presignPut: vi.fn(),
  getObjectBuffer: vi.fn(),
}));
vi.mock("@/lib/queue", () => ({ enqueuePhotoIngest, enqueuePhotoRender: vi.fn() }));

import { replacePhoto } from "./service";

const UPLOAD_ID = "abcdefghijklmnopqrstuvwx";
const KEY = `books/book1/uploads/${UPLOAD_ID}/original.jpg`;

const newPhotoRow = {
  id: "new",
  documentId: "doc1",
  pageIndex: 2,
  mimeType: "image/jpeg",
  width: 0,
  height: 0,
  byteSize: 1234,
  transform: null,
  transformedAt: null,
  replacedAt: null,
  deletedAt: null,
  createdAt: new Date("2026-09-19T00:00:00Z"),
  status: "QUEUED" as const,
  errorMessage: null,
  workingKey: null,
  thumbKey: null,
  document: { bookId: "book1" },
};

describe("replacePhoto", () => {
  beforeEach(() => {
    for (const group of Object.values(db)) {
      if (typeof group === "function") group.mockReset();
      else for (const fn of Object.values(group)) fn.mockReset();
    }
    enqueuePhotoIngest.mockClear();
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
    // The document has already been extracted and reviewed: this is exactly the case replace exists for.
    db.row.count.mockResolvedValue(12);
    db.cell.count.mockResolvedValue(48);
    db.extractionRun.count.mockResolvedValue(3);
    db.document.findUnique.mockResolvedValue({ runState: "COMPLETE" });
    db.photo.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      "originalKey" in args.where ? null : { id: "old", pageIndex: 2 },
    );
    db.photo.create.mockResolvedValue(newPhotoRow);
    db.photo.update.mockResolvedValue(newPhotoRow);
  });

  it("puts the new page at the old one's page number and soft-deletes the old one", async () => {
    await replacePhoto("u1", "old", { key: KEY, filename: "page-3.jpg" });

    const created = db.photo.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(created.data).toMatchObject({ documentId: "doc1", pageIndex: 2, originalKey: KEY, status: "QUEUED", replacesPhotoId: "old" });

    const updated = db.photo.update.mock.calls[0]?.[0] as { where: { id: string }; data: Record<string, unknown> };
    expect(updated.where.id).toBe("old");
    expect(updated.data.replacedAt).toBeInstanceOf(Date);
    expect(updated.data.deletedAt).toBeInstanceOf(Date);

    const marked = db.document.update.mock.calls[0]?.[0] as { where: { id: string }; data: Record<string, unknown> };
    expect(marked.where.id).toBe("doc1");
    expect(marked.data.contentChangedAt).toBeInstanceOf(Date);

    expect(enqueuePhotoIngest).toHaveBeenCalledWith({ photoId: "new" });
  });

  it("keeps the document's rows, cells and edits: it never reads or writes them", async () => {
    await replacePhoto("u1", "old", { key: KEY, filename: "page-3.jpg" });

    // `assertNoExtractionOutput` is deliberately left unmocked, so were it ever called again here its
    // row and run counts would trip this.
    for (const model of ["row", "cell", "cellEdit", "rawRecord", "rawValue", "extractionRun"] as const) {
      for (const [name, fn] of Object.entries(db[model])) {
        expect(fn, `${model}.${name} must not be called`).not.toHaveBeenCalled();
      }
    }
    // The old page's row survives too, so provenance still resolves until the re-extraction lands.
    expect(db.photo.delete).not.toHaveBeenCalled();
    expect(db.photo.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses a PDF, which would be an import of several pages rather than one replacement", async () => {
    await expect(replacePhoto("u1", "old", { key: `books/book1/uploads/${UPLOAD_ID}/original.pdf`, filename: "scan.pdf" })).rejects.toThrow(
      /single photo/,
    );
    expect(db.photo.create).not.toHaveBeenCalled();
  });

  it("completing the same upload twice replaces once", async () => {
    db.photo.findFirst.mockResolvedValueOnce({ ...newPhotoRow, id: "already", replacesPhotoId: "old" });
    await replacePhoto("u1", "old", { key: KEY, filename: "page-3.jpg" });
    expect(db.photo.create).not.toHaveBeenCalled();
    expect(db.photo.update).not.toHaveBeenCalled();
    expect(db.document.update).not.toHaveBeenCalled();
  });

  // Without this the call reports success having changed nothing, because the key was consumed elsewhere.
  it("refuses an upload key already used for a different page", async () => {
    db.photo.findFirst.mockResolvedValueOnce({ ...newPhotoRow, id: "other", replacesPhotoId: "a-different-page" });
    await expect(replacePhoto("u1", "old", { key: KEY, filename: "page-3.jpg" })).rejects.toThrow(/already used for another page/);
    expect(db.photo.create).not.toHaveBeenCalled();
  });

  // An in-flight run still holds the old page id, so it would finish reading the page being swapped out
  // and stamp the document as freshly read.
  it.each(["QUEUED", "RUNNING"])("refuses while a run is %s", async (runState) => {
    db.document.findUnique.mockResolvedValue({ runState });
    await expect(replacePhoto("u1", "old", { key: KEY, filename: "page-3.jpg" })).rejects.toThrow(/being extracted right now/);
    expect(db.photo.create).not.toHaveBeenCalled();
    expect(db.document.update).not.toHaveBeenCalled();
  });

  it("allows a replace once the run has finished", async () => {
    for (const runState of ["COMPLETE", "FAILED", "PARTIAL", "NEVER_RUN"]) {
      db.photo.create.mockClear();
      db.document.findUnique.mockResolvedValue({ runState });
      await replacePhoto("u1", "old", { key: KEY, filename: "page-3.jpg" });
      expect(db.photo.create, runState).toHaveBeenCalled();
    }
  });

  it("refuses a page that was already replaced, rather than stacking two replacements on it", async () => {
    db.photo.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      "originalKey" in args.where ? null : null,
    );
    await expect(replacePhoto("u1", "old", { key: KEY, filename: "page-3.jpg" })).rejects.toThrow(/already replaced or deleted/);
    expect(db.document.update).not.toHaveBeenCalled();
  });
});
