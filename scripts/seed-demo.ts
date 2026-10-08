import { loadDotEnv } from "@/lib/env";

loadDotEnv();

import { createId } from "@paralleldrive/cuid2";
import { generateNKeysBetween } from "fractional-indexing";
import sharp from "sharp";

import { hashPassword } from "@/lib/auth/password";
import { createGlossaryEntry } from "@/lib/books/glossary-service";
import { prisma } from "@/lib/db/client";
import { log } from "@/lib/log";
import { normalizeTransform, transformHash } from "@/lib/photos/transform";
import { closeQueues } from "@/lib/queue";
import { baseKey, thumbKey, workingKey } from "@/lib/storage/keys";
import { putObject } from "@/lib/storage/s3";
import { editCell, setCellsReviewed } from "@/lib/table/service";
import { transformDocument } from "@/lib/transform/service";
import { createRule } from "@/lib/validation/rules-service";

/**
 * Dev only: a realistic demo book for walking through the product (Phase 9). A township clinic's malaria
 * register (a TABLE with tick-column groups, the docs/06 §3.1 example) and household vaccination cards
 * (a FORM), already extracted, with Burmese values, Myanmar numerals, ditto marks, an unreadable cell,
 * a total row, a few edits and reviewed rows, a failed extraction and a blank page.
 *
 * Replaces the demo book on every run. Sign in as `demo@example.com` / `demo-password-123`.
 *
 *   pnpm db:seed-demo
 */

const EMAIL = "demo@example.com";
const PASSWORD = "demo-password-123";
const BOOK_NAME = "Demo — Township clinic";
const MODEL = "gemini-3.5-flash";

const NAMES = ["မောင်မောင်", "အေးအေးမြင့်", "ကျော်ဇင်", "သီတာဝင်း", "ဇော်ဝင်းနိုင်", "နန္ဒာစိုး", "မြင့်မြင့်ချို", "ထွန်းထွန်းအောင်", "ခင်မာလာ", "စိုးမိုး", "ဝင်းဝင်း", "လှလှ"];
const VILLAGES = ["ရွာသစ်", "ကန်ကြီး", "သာယာကုန်း", "မြို့ပိုင်"];
const MYANMAR_DIGITS = "၀၁၂၃၄၅၆၇၈၉";

/** Writes a number the way it is written on these pages: Myanmar digits. */
function my(n: number): string {
  return String(n).replace(/\d/g, (d) => MYANMAR_DIGITS[Number(d)] ?? d);
}

function pick<T>(items: readonly T[], n: number): T {
  const item = items[n % items.length];
  if (item === undefined) throw new Error("empty list");
  return item;
}

type Bbox = { x: number; y: number; w: number; h: number };
type RawValueSeed = {
  fieldId: string;
  valueText: string | null;
  state: "OK" | "ILLEGIBLE" | "EMPTY" | "DASH" | "NOT_APPLICABLE";
  confidence: number;
  isDitto: boolean;
  photoId: string;
  bbox: Bbox;
};

/** A ruled page with handwriting-coloured text lines, stored as base, working and thumbnail copies. */
async function storePage(bookId: string, photoId: string, title: string, lines: string[]): Promise<{ width: number; height: number; byteSize: number; keys: { original: string; working: string; thumb: string } }> {
  const width = 1200;
  const height = 1600;
  const rowH = (height - 200) / Math.max(lines.length, 12);
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body = lines
    .map((text, i) => {
      const y = 160 + (i + 1) * rowH;
      return `<line x1="40" y1="${y}" x2="${width - 40}" y2="${y}" stroke="#9aa" stroke-width="2"/><text x="60" y="${y - rowH * 0.3}" font-size="30" font-family="Noto Sans Myanmar, sans-serif" fill="#1f2d7a">${escape(text)}</text>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f7f3e8"/><text x="60" y="100" font-size="40" font-family="Noto Sans Myanmar, sans-serif" fill="#222">${escape(title)}</text>${body}</svg>`;
  const image = await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
  const thumb = await sharp(image).resize({ width: 320 }).jpeg({ quality: 75 }).toBuffer();
  const hash = transformHash(normalizeTransform(null));
  const keys = { original: baseKey(bookId, photoId), working: workingKey(bookId, photoId, hash), thumb: thumbKey(bookId, photoId, hash) };
  await putObject(keys.original, image, "image/jpeg");
  await putObject(keys.working, image, "image/jpeg");
  await putObject(keys.thumb, thumb, "image/jpeg");
  return { width, height, byteSize: image.length, keys };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("seed-demo is for development only");

  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: { email: EMAIL, name: "Demo operator", emailVerified: new Date(), passwordHash: await hashPassword(PASSWORD) },
  });
  await prisma.book.deleteMany({ where: { userId: user.id, name: BOOK_NAME } });

  // ---------- book and output table ----------
  const columnDefs = [
    { key: "no", label: "No.", dataType: "INTEGER", isRequired: true },
    { key: "name", label: "Name", dataType: "TEXT", isRequired: true },
    { key: "sex", label: "Sex", dataType: "ENUM", enumValues: ["M", "F"] },
    { key: "age_months", label: "Age (months)", dataType: "INTEGER" },
    { key: "rdt_result", label: "RDT result", dataType: "TEXT" },
    { key: "test_date", label: "Test date", dataType: "DATE" },
    { key: "village", label: "Village", dataType: "TEXT" },
  ] as const;
  const columnPositions = generateNKeysBetween(null, null, columnDefs.length);
  const book = await prisma.book.create({
    data: {
      userId: user.id,
      name: BOOK_NAME,
      numeralSystem: "MYANMAR",
      blankToken: "",
      illegibleToken: "?",
      columns: { create: columnDefs.map((c, i) => ({ ...c, enumValues: "enumValues" in c ? [...c.enumValues] : [], position: columnPositions[i] ?? "" })) },
    },
    include: { columns: true },
  });
  const column = (key: (typeof columnDefs)[number]["key"]) => {
    const c = book.columns.find((x) => x.key === key);
    if (!c) throw new Error(`missing column ${key}`);
    return c.id;
  };

  for (const entry of [
    { term: "〃", meaning: "Ditto: same as the row above." },
    { term: "၁ နှစ် ၆ လ", meaning: "1 year and 6 months (an age)." },
    { term: "ပိုး", meaning: "Positive (malaria parasite found)." },
  ]) {
    await createGlossaryEntry(user.id, book.id, entry);
  }

  // ---------- register template (TABLE, docs/06 §3.1) ----------
  const registerId = createId();
  const f = {
    no: createId(),
    name: createId(),
    m: createId(),
    fe: createId(),
    age: createId(),
    a: createId(),
    b: createId(),
    c: createId(),
    neg: createId(),
    date: createId(),
    village: createId(),
    remarks: createId(),
  };
  const order = generateNKeysBetween(null, null, 12);
  const marks = { "✓": true, "✗": false };
  await prisma.template.create({
    data: {
      id: registerId,
      bookId: book.id,
      name: "Malaria register",
      kind: "TABLE",
      configState: "READY",
      position: "a0",
      languageHint: "my",
      instructions: "One row per patient. The last row of a page may be a total.",
      sequenceFieldId: f.no,
    },
  });
  const field = (id: string, labelSource: string, labelMeaning: string, dataType: "TEXT" | "INTEGER" | "AGE" | "DATE" | "MARK", position: string, extra: Record<string, unknown> = {}) => ({
    id,
    templateId: registerId,
    labelSource,
    labelMeaning,
    dataType,
    position,
    ...(dataType === "MARK" ? { markSymbols: marks } : {}),
    ...extra,
  });
  await prisma.field.createMany({
    data: [
      field(f.no, "စဉ်", "No.", "INTEGER", order[0] ?? "", { isSequence: true }),
      field(f.name, "အမည်", "Name", "TEXT", order[1] ?? ""),
      field(f.m, "ကျား/မ › ကျား", "Sex › M", "MARK", order[2] ?? ""),
      field(f.fe, "ကျား/မ › မ", "Sex › F", "MARK", order[3] ?? ""),
      field(f.age, "အသက်", "Age", "AGE", order[4] ?? "", { typeOptions: { age: { unit: "MONTHS" } } }),
      field(f.a, "RDT Test › Positive › A", "Rapid test › Positive, by species › P. falciparum", "MARK", order[5] ?? ""),
      field(f.b, "RDT Test › Positive › B", "Rapid test › Positive, by species › P. vivax", "MARK", order[6] ?? ""),
      field(f.c, "RDT Test › Positive › C", "Rapid test › Positive, by species › Mixed", "MARK", order[7] ?? ""),
      field(f.neg, "RDT Test › Neg.", "Rapid test › Negative", "MARK", order[8] ?? ""),
      field(f.date, "ရက်စွဲ", "Test date", "DATE", order[9] ?? ""),
      field(f.village, "ရွာ", "Village", "TEXT", order[10] ?? "", { mode: "MANUAL" }),
      field(f.remarks, "မှတ်ချက်", "Remarks", "TEXT", order[11] ?? "", { mode: "SKIP" }),
    ],
  });
  const mappingPositions = generateNKeysBetween(null, null, 7);
  const mapping = (i: number, key: (typeof columnDefs)[number]["key"], input: { fieldId: string }) => ({
    templateId: registerId,
    outputColumnId: column(key),
    kind: "COPY" as const,
    position: mappingPositions[i] ?? "",
    inputs: { create: [{ position: 0, ...input }] },
  });
  /** From ticks: several tick fields become one answer, each writing its own value. */
  const ticks = (
    i: number,
    key: (typeof columnDefs)[number]["key"],
    rules: { tickLabel: string; noneMarked: "BLANK" | "REVIEW"; noneValue?: string },
    values: [fieldId: string, tickValue: string][],
  ) => ({
    templateId: registerId,
    outputColumnId: column(key),
    kind: "TICKS" as const,
    tickSelection: "ONE_OF" as const,
    multipleMarked: "ERROR" as const,
    ...rules,
    position: mappingPositions[i] ?? "",
    inputs: { create: values.map(([fieldId, tickValue], position) => ({ fieldId, tickValue, position })) },
  });
  for (const m of [
    mapping(0, "no", { fieldId: f.no }),
    mapping(1, "name", { fieldId: f.name }),
    ticks(2, "sex", { tickLabel: "ကျား/မ", noneMarked: "REVIEW" }, [[f.m, "M"], [f.fe, "F"]]),
    mapping(3, "age_months", { fieldId: f.age }),
    ticks(4, "rdt_result", { tickLabel: "RDT Test", noneMarked: "BLANK", noneValue: "Not tested" }, [[f.a, "Positive (Pf)"], [f.b, "Positive (Pv)"], [f.c, "Positive (mixed)"], [f.neg, "Negative"]]),
    mapping(5, "test_date", { fieldId: f.date }),
    mapping(6, "village", { fieldId: f.village }),
  ]) {
    await prisma.mapping.create({ data: m });
  }

  // ---------- vaccination card template (FORM) ----------
  const cardId = createId();
  const cf = { name: createId(), age: createId(), village: createId(), date: createId() };
  const cardPositions = generateNKeysBetween(null, null, 4);
  await prisma.template.create({
    data: {
      id: cardId,
      bookId: book.id,
      name: "Vaccination card",
      kind: "FORM",
      configState: "READY",
      position: "a1",
      languageHint: "my",
      anchors: ["ကာကွယ်ဆေး မှတ်တမ်း"],
      fields: {
        create: [
          { id: cf.name, labelSource: "ကလေးအမည်", labelMeaning: "Child's name", dataType: "TEXT", position: cardPositions[0] ?? "" },
          { id: cf.age, labelSource: "အသက်", labelMeaning: "Age", dataType: "AGE", typeOptions: { age: { unit: "MONTHS" } }, position: cardPositions[1] ?? "" },
          { id: cf.village, labelSource: "ရွာ", labelMeaning: "Village", dataType: "TEXT", position: cardPositions[2] ?? "" },
          { id: cf.date, labelSource: "ထိုးသည့်ရက်", labelMeaning: "Vaccination date", dataType: "DATE", position: cardPositions[3] ?? "" },
        ],
      },
    },
  });
  const cardMappings = [
    ["name", cf.name],
    ["age_months", cf.age],
    ["village", cf.village],
    ["test_date", cf.date],
  ] as const;
  for (const [i, [key, fieldId]] of cardMappings.entries()) {
    await prisma.mapping.create({
      data: { templateId: cardId, outputColumnId: column(key), kind: "COPY", position: mappingPositions[i] ?? "", inputs: { create: [{ position: 0, fieldId }] } },
    });
  }

  // ---------- documents ----------
  const REGISTER_PAGES = 8;
  const ROWS = 12;
  const CARDS = 4;
  const docPositions = generateNKeysBetween(null, null, REGISTER_PAGES + CARDS + 2);
  let docIndex = 0;
  const registerDocs: string[] = [];

  async function createDocument(templateId: string, label: string, lines: string[], run: { state: "COMPLETE" | "FAILED"; error?: string; contentState?: "HAS_CONTENT" | "EMPTY" }, manualValues?: Record<string, string>) {
    const documentId = createId();
    const photoId = createId();
    const runId = createId();
    const stored = await storePage(book.id, photoId, label, lines);
    await prisma.document.create({
      data: {
        id: documentId,
        bookId: book.id,
        templateId,
        label,
        position: docPositions[docIndex++] ?? "",
        runState: run.state,
        contentState: run.state === "FAILED" ? "UNKNOWN" : (run.contentState ?? "HAS_CONTENT"),
        lastRunAt: new Date(),
        lastModel: MODEL,
        ...(manualValues ? { manualValues } : {}),
        photos: {
          create: {
            id: photoId,
            pageIndex: 0,
            originalKey: stored.keys.original,
            workingKey: stored.keys.working,
            thumbKey: stored.keys.thumb,
            mimeType: "image/jpeg",
            width: stored.width,
            height: stored.height,
            byteSize: stored.byteSize,
            status: "DONE",
          },
        },
        runs: {
          create: {
            id: runId,
            model: MODEL,
            promptVersion: "seed",
            idempotencyKey: `seed-demo-${documentId}`,
            state: run.state,
            error: run.error ?? null,
            photoIds: [photoId],
            startedAt: new Date(),
            finishedAt: new Date(),
            inputTokens: 3100,
            outputTokens: run.state === "FAILED" ? null : 900,
          },
        },
      },
    });
    return { documentId, photoId, runId };
  }

  for (let d = 0; d < REGISTER_PAGES; d++) {
    const village = pick(VILLAGES, d);
    const lines = Array.from({ length: ROWS }, (_, r) => `${my(d * ROWS + r + 1)}   ${pick(NAMES, d * 3 + r)}   ${my((r % 9) + 1)}`);
    const { documentId, photoId, runId } = await createDocument(registerId, `register-${village}-p${d + 1}.jpg`, [...lines, "စုစုပေါင်း"], { state: "COMPLETE" }, { [f.village]: village });
    registerDocs.push(documentId);
    for (let r = 0; r <= ROWS; r++) {
      const n = d * ROWS + r;
      const bbox = { x: 0.03, y: (160 + (r + 0.5) * ((1600 - 200) / ROWS)) / 1600, w: 0.94, h: (1400 / ROWS) / 1600 };
      const v = (fieldId: string, valueText: string | null, extra: Partial<Omit<RawValueSeed, "fieldId" | "valueText">> = {}): RawValueSeed => ({
        fieldId,
        valueText,
        state: extra.state ?? (valueText === null ? "EMPTY" : "OK"),
        confidence: extra.confidence ?? 0.9,
        isDitto: extra.isDitto ?? false,
        photoId,
        bbox,
      });
      const isTotal = r === ROWS;
      const sexMale = n % 2 === 0;
      const rdt = n % 5;
      const values: RawValueSeed[] = isTotal
        ? [v(f.no, null), v(f.name, "စုစုပေါင်း"), v(f.age, my(ROWS))]
        : [
            v(f.no, my(n + 1)),
            n % 23 === 7 ? v(f.name, null, { state: "ILLEGIBLE", confidence: 0.2 }) : v(f.name, pick(NAMES, d * 3 + r), { confidence: n % 7 === 0 ? 0.45 : 0.9 }),
            v(f.m, sexMale ? "✓" : null),
            // Now and then both boxes are ticked: the Sex group flags it.
            v(f.fe, !sexMale || n % 31 === 4 ? "✓" : null),
            n % 6 === 0 ? v(f.age, "၁ ၁/၂") : v(f.age, my((n % 60) + 6), { confidence: n % 11 === 0 ? 0.5 : 0.92 }),
            v(f.a, rdt === 0 ? "✓" : null),
            v(f.b, rdt === 1 ? "✓" : null),
            v(f.neg, rdt === 2 || rdt === 3 ? "✓" : null),
            r > 0 && n % 4 !== 0 ? v(f.date, "〃", { isDitto: true }) : v(f.date, `${my((d % 27) + 1)}.${my((d % 12) + 1)}.${my(2024)}`),
          ];
      await prisma.rawRecord.create({
        data: { documentId, runId, recordIndex: r, rowType: isTotal ? "TOTAL" : "DATA", photoId, bbox, values: { create: values } },
      });
    }
    await transformDocument(documentId);
  }

  for (let d = 0; d < CARDS; d++) {
    const name = pick(NAMES, d + 5);
    const village = pick(VILLAGES, d + 1);
    const { documentId, photoId, runId } = await createDocument(cardId, `card-${d + 1}.jpg`, ["ကာကွယ်ဆေး မှတ်တမ်း", `ကလေးအမည်  ${name}`, `အသက်  ${my(d + 1)} နှစ်`, `ရွာ  ${village}`], { state: "COMPLETE" });
    const bbox = { x: 0.05, y: 0.15, w: 0.9, h: 0.4 };
    await prisma.rawRecord.create({
      data: {
        documentId,
        runId,
        recordIndex: 0,
        rowType: "DATA",
        photoId,
        bbox,
        values: {
          create: [
            { fieldId: cf.name, valueText: name, state: "OK", confidence: 0.88, photoId, bbox },
            { fieldId: cf.age, valueText: `${my(d + 1)} နှစ်`, state: "OK", confidence: 0.8, photoId, bbox },
            { fieldId: cf.village, valueText: village, state: "OK", confidence: 0.93, photoId, bbox },
            { fieldId: cf.date, valueText: d === 2 ? `${my(3)}.${my(4)}.${my(2031)}` : `${my(10 + d)}.${my(6)}.${my(2024)}`, state: "OK", confidence: 0.85, photoId, bbox },
          ],
        },
      },
    });
    await transformDocument(documentId);
  }

  // A blank page (EMPTY, no rows) and a failed extraction, as they appear after a real batch.
  const blank = await createDocument(registerId, "register-blank-back-page.jpg", [], { state: "COMPLETE", contentState: "EMPTY" });
  await transformDocument(blank.documentId);
  await createDocument(registerId, "register-blurred.jpg", ["(photo too blurred)"], {
    state: "FAILED",
    error: "The AI service is busy right now (rate limited). Retry these pages in a minute.",
  });

  // ---------- rules, edits and review ----------
  await createRule(user.id, book.id, { outputColumnId: column("age_months"), kind: "RANGE", params: { min: "0", max: "1200" }, severity: "WARNING", message: "Age over 100 years: check the months.", enabled: true });
  await createRule(user.id, book.id, { outputColumnId: column("test_date"), kind: "RANGE", params: { min: "2020-01-01", max: "2026-12-31" }, severity: "ERROR", message: "Test date is outside the register's years.", enabled: true });

  const firstRows = await prisma.row.findMany({
    where: { documentId: { in: registerDocs.slice(0, 2) }, isVoid: false },
    select: { id: true, documentId: true, cells: { select: { id: true, outputColumnId: true, state: true } } },
    orderBy: { position: "asc" },
    take: 200,
  });
  const nameColumn = column("name");
  let edits = 0;
  for (const row of firstRows) {
    const unreadable = row.cells.find((c) => c.outputColumnId === nameColumn && c.state === "ILLEGIBLE");
    if (unreadable) {
      await editCell(user.id, unreadable.id, { value: "ဒေါ်ခင်စန်း" });
      edits++;
    }
  }
  const secondRow = firstRows[1]?.cells.find((c) => c.outputColumnId === nameColumn);
  if (secondRow) {
    await editCell(user.id, secondRow.id, { value: "အေးအေးမြင့် (ခ) မအေး" });
    edits++;
  }
  const firstDocRows = firstRows.filter((r) => r.documentId === registerDocs[0]).map((r) => r.id);
  if (firstDocRows.length > 0) await setCellsReviewed(user.id, { rowIds: firstDocRows, isReviewed: true, via: "ROW" });

  const rows = await prisma.row.count({ where: { bookId: book.id } });
  log.info("seeded demo book", { bookId: book.id, rows, edits, reviewedRows: firstDocRows.length, email: EMAIL, password: PASSWORD });
}

main()
  .then(() => closeQueues())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    log.error("seed-demo failed", err);
    process.exit(1);
  });
