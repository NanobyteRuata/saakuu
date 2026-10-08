import { loadDotEnv } from "@/lib/env";

loadDotEnv();

import { createId } from "@paralleldrive/cuid2";
import { generateNKeysBetween } from "fractional-indexing";
import sharp from "sharp";

import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db/client";
import { log } from "@/lib/log";
import { closeQueues } from "@/lib/queue";
import { putObject } from "@/lib/storage/s3";
import { transformDocument } from "@/lib/transform/service";

/**
 * Dev only: a demo book whose output table has 3,000 rows with every cell state (docs/08), for checking the
 * table by hand (Phase 7 acceptance). Replaces the demo book on every run. Signs in as
 * `table-demo@example.com` / `demo-password-123`.
 *
 *   pnpm tsx scripts/seed-table.ts [documents=60] [rowsPerDocument=50]
 */

const EMAIL = "table-demo@example.com";
const PASSWORD = "demo-password-123";
const BOOK_NAME = "Clinic register demo";

const NAMES = ["မောင်မောင်", "အေးအေး", "ကျော်ကျော်", "သီတာ", "ဇော်ဝင်း", "Hla Hla", "Tun Tun", "နန္ဒာ", "မြင့်မြင့်", "Aung Min"];
const VILLAGES = ["ရွာသစ်", "ကန်ကြီး", "Myitkyina", "သာယာကုန်း"];

function pick<T>(items: T[], n: number): T {
  const item = items[n % items.length];
  if (item === undefined) throw new Error("empty list");
  return item;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("seed-table is for development only");
  const documents = Number(process.argv[2] ?? 60);
  const rowsPerDocument = Number(process.argv[3] ?? 50);

  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: { email: EMAIL, name: "Table demo", emailVerified: new Date(), passwordHash: await hashPassword(PASSWORD) },
  });
  await prisma.book.deleteMany({ where: { userId: user.id, name: BOOK_NAME } });

  const columnDefs = [
    { key: "no", label: "No.", dataType: "INTEGER", isRequired: true },
    { key: "name", label: "Name", dataType: "TEXT" },
    { key: "sex", label: "Sex", dataType: "ENUM", enumValues: ["M", "F"] },
    { key: "age_months", label: "Age (months)", dataType: "INTEGER" },
    { key: "visit_date", label: "Visit date", dataType: "DATE" },
    { key: "village", label: "Village", dataType: "TEXT" },
    { key: "fever", label: "Fever", dataType: "BOOLEAN" },
    { key: "remarks", label: "Remarks", dataType: "TEXT" },
  ] as const;
  const columnPositions = generateNKeysBetween(null, null, columnDefs.length);
  const book = await prisma.book.create({
    data: {
      userId: user.id,
      name: BOOK_NAME,
      columns: { create: columnDefs.map((c, i) => ({ ...c, enumValues: "enumValues" in c ? [...c.enumValues] : [], position: columnPositions[i] ?? "" })) },
    },
    include: { columns: true },
  });
  const column = (key: string) => {
    const c = book.columns.find((x) => x.key === key);
    if (!c) throw new Error(key);
    return c.id;
  };

  const fieldDefs = [
    { key: "no", labelSource: "စဉ်", labelMeaning: "No.", dataType: "INTEGER", mode: "EXTRACT" },
    { key: "name", labelSource: "အမည်", labelMeaning: "Name", dataType: "TEXT", mode: "EXTRACT" },
    { key: "sex", labelSource: "ကျား/မ", labelMeaning: "Sex", dataType: "TEXT", mode: "EXTRACT" },
    { key: "age_months", labelSource: "အသက်", labelMeaning: "Age", dataType: "AGE", mode: "EXTRACT" },
    { key: "visit_date", labelSource: "ရက်စွဲ", labelMeaning: "Date", dataType: "DATE", mode: "EXTRACT" },
    { key: "village", labelSource: "ရွာ", labelMeaning: "Village", dataType: "TEXT", mode: "MANUAL" },
    { key: "fever", labelSource: "ဖျား", labelMeaning: "Fever", dataType: "MARK", mode: "EXTRACT" },
    { key: "remarks", labelSource: "မှတ်ချက်", labelMeaning: "Remarks", dataType: "TEXT", mode: "SKIP" },
  ] as const;
  const fieldPositions = generateNKeysBetween(null, null, fieldDefs.length);
  const templateId = createId();
  const fieldIds = Object.fromEntries(fieldDefs.map((f) => [f.key, createId()])) as Record<(typeof fieldDefs)[number]["key"], string>;
  await prisma.template.create({
    data: {
      id: templateId,
      bookId: book.id,
      name: "Clinic register",
      kind: "TABLE",
      configState: "READY",
      position: "a0",
      sequenceFieldId: fieldIds.no,
      fields: {
        create: fieldDefs.map((f, i) => ({
          id: fieldIds[f.key],
          labelSource: f.labelSource,
          labelMeaning: f.labelMeaning,
          dataType: f.dataType,
          mode: f.mode,
          isSequence: f.key === "no",
          position: fieldPositions[i] ?? "",
          ...(f.dataType === "MARK" ? { markSymbols: { "✓": true, "✗": false } } : {}),
          ...(f.dataType === "AGE" ? { typeOptions: { age: { unit: "MONTHS" } } } : {}),
        })),
      },
      mappings: {
        create: fieldDefs.map((f, i) => ({
          outputColumnId: column(f.key),
          kind: "COPY",
          position: fieldPositions[i] ?? "",
          inputs: { create: [{ fieldId: fieldIds[f.key], position: 0 }] },
        })),
      },
    },
  });

  // One ruled-page image shared by every page: enough to see the record box in the photo viewer.
  const width = 1200;
  const height = 1700;
  const lines = Array.from({ length: rowsPerDocument + 2 }, (_, i) => {
    const y = Math.round(((i + 1) / (rowsPerDocument + 2)) * height);
    return `<line x1="40" y1="${y}" x2="${width - 40}" y2="${y}" stroke="#9aa" stroke-width="2"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fbfaf5"/>${lines}</svg>`;
  const image = await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
  const imageKey = `books/${book.id}/photos/seed/working-seed.jpg`;
  await putObject(imageKey, image, "image/jpeg");

  const docPositions = generateNKeysBetween(null, null, documents);
  for (let d = 0; d < documents; d++) {
    const documentId = createId();
    const photoId = createId();
    const runId = createId();
    await prisma.document.create({
      data: {
        id: documentId,
        bookId: book.id,
        templateId,
        label: `register-page-${String(d + 1).padStart(3, "0")}.jpg`,
        position: docPositions[d] ?? "",
        runState: "COMPLETE",
        contentState: "HAS_CONTENT",
        lastRunAt: new Date(),
        lastModel: "gemini-3.5-flash",
        manualValues: { [fieldIds.village]: pick(VILLAGES, d) },
        photos: {
          create: { id: photoId, pageIndex: 0, originalKey: imageKey, workingKey: imageKey, thumbKey: imageKey, mimeType: "image/jpeg", width, height, byteSize: image.length, status: "DONE" },
        },
        runs: {
          create: { id: runId, model: "gemini-3.5-flash", promptVersion: "seed", idempotencyKey: `seed-${documentId}`, state: "COMPLETE", photoIds: [photoId], finishedAt: new Date() },
        },
      },
    });

    const records = [];
    for (let r = 0; r < rowsPerDocument + 1; r++) {
      const n = d * rowsPerDocument + r;
      const isTotal = r === rowsPerDocument;
      const bbox = { x: 0.03, y: (r + 1) / (rowsPerDocument + 2), w: 0.94, h: 1 / (rowsPerDocument + 2) };
      const v = (key: keyof typeof fieldIds, valueText: string | null, extra: { state?: "OK" | "ILLEGIBLE" | "EMPTY" | "DASH" | "NOT_APPLICABLE"; confidence?: number; isDitto?: boolean } = {}) => ({
        fieldId: fieldIds[key],
        valueText,
        state: extra.state ?? (valueText === null ? "EMPTY" : "OK"),
        confidence: extra.confidence ?? 0.92,
        isDitto: extra.isDitto ?? false,
        photoId,
        bbox,
      });
      const values = isTotal
        ? [v("no", null), v("name", "စုစုပေါင်း"), v("age_months", String(rowsPerDocument))]
        : [
            v("no", n % 97 === 5 ? "၁၂" : String(r + 1)),
            n % 23 === 7 ? v("name", null, { state: "ILLEGIBLE" }) : n % 11 === 3 && r > 0 ? v("name", '"', { isDitto: true }) : v("name", pick(NAMES, n), { confidence: n % 7 === 0 ? 0.41 : 0.9 }),
            v("sex", n % 13 === 4 ? "X" : n % 2 === 0 ? "M" : "F"),
            n % 17 === 2 ? v("age_months", null, { state: "DASH" }) : v("age_months", n % 5 === 0 ? "1 1/2" : String((n % 9) + 1)),
            v("visit_date", n % 41 === 9 ? `3.${(n % 12) + 1}.2031` : `${(n % 28) + 1}.${(n % 12) + 1}.2024`, { confidence: n % 19 === 0 ? 0.5 : 0.95 }),
            n % 29 === 1 ? v("fever", null, { state: "NOT_APPLICABLE" }) : v("fever", n % 3 === 0 ? "✓" : "✗"),
          ];
      records.push({ recordIndex: r, rowType: isTotal ? ("TOTAL" as const) : ("DATA" as const), photoId, bbox, values });
    }
    for (const rec of records) {
      await prisma.rawRecord.create({
        data: {
          documentId,
          runId,
          recordIndex: rec.recordIndex,
          rowType: rec.rowType,
          photoId: rec.photoId,
          bbox: rec.bbox,
          values: { create: rec.values },
        },
      });
    }
    await transformDocument(documentId);
    if ((d + 1) % 10 === 0) log.info("seeded documents", { done: d + 1, of: documents });
  }
  const rows = await prisma.row.count({ where: { bookId: book.id } });
  log.info("seeded table demo", { bookId: book.id, rows, email: EMAIL, password: PASSWORD });
}

main()
  .then(() => closeQueues())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    log.error("seed-table failed", err);
    process.exit(1);
  });
