import { fieldAliases } from "../aliases";
import type { ExtractionRequest, SnapshotField, SnapshotGroup } from "../provider";
import type { ModelPrompt } from "../extract";

/**
 * Prompt v2 (Phase 23, decision 83). NEVER edit this file once runs have used it: any change is a
 * new version (v3.ts) so runs stay comparable. The block order follows docs/03 §3 items 1–12.
 *
 * It is v1 with a smaller answer, and nothing else changed. The first real register page under v1
 * (10 rows of 28 columns) wrote 23,722 tokens, about 85 a cell, most of them for blank cells:
 * - fields are named `f1`, `f2`, … (`lib/ai/aliases.ts`), not by their 24-letter ids;
 * - in a TABLE a blank cell is left out, and validation stores it as EMPTY;
 * - `isDitto` and `altValueText` are written only when they have something to say.
 * A FORM still reports every field it finds, blank ones included: there, a field left out means it
 * was not found on the page, which is not the same as blank.
 */

export const PROMPT_VERSION = "v2";

const NEVER_GUESS =
  'Never guess. If a value is not confidently readable, set "state": "ILLEGIBLE" and "valueText": null. An honest ILLEGIBLE is far more valuable than a plausible guess.';

const TYPE_HINTS: Record<SnapshotField["dataType"], string> = {
  TEXT: "text; transcribe as written",
  NUMBER: "a number; transcribe the digits and punctuation exactly as written",
  INTEGER: "a whole number; transcribe the digits exactly as written",
  DATE: "a date; transcribe exactly as written, keep the order, separators and era; do not reformat or convert",
  MARK: "a tick box or mark; put the mark you see in valueText (for example ✓, ✗, ○, a circled mark, or tally strokes as written); an unmarked box is EMPTY",
  CHOICE: "one of the listed choices, written or circled; put the text as written, or the printed choice that is circled",
  AGE: "an age; transcribe exactly as written, for example 1 1/2 or 4/12; do not convert",
  FRACTION: "a fraction; transcribe exactly as written; do not convert to a decimal",
};

function pathJson(path: SnapshotField["path"]) {
  return path.map((p) => (p.meaning ? { label: p.label, meaning: p.meaning } : { label: p.label }));
}

/** In a table an unmarked box is one more blank cell, and blank cells are left out. */
const TABLE_MARK_HINT = TYPE_HINTS.MARK.replace("an unmarked box is EMPTY", "an unmarked box is blank, so leave it out");

function fieldJson(f: SnapshotField, aliasOf: Map<string, string>, table: boolean) {
  return {
    fieldId: aliasOf.get(f.id) ?? f.id,
    path: pathJson(f.path),
    type: f.dataType,
    hint: table && f.dataType === "MARK" ? TABLE_MARK_HINT : TYPE_HINTS[f.dataType],
    ...(f.mode === "SKIP" ? { mode: "SKIP", instruction: "Ignore this column. Do not report values for it." } : {}),
    ...(f.note ? { note: f.note } : {}),
    ...(f.choices.length > 0 ? { choices: f.choices } : {}),
    ...(f.markSymbols && Object.keys(f.markSymbols).length > 0 ? { symbolsUsed: Object.keys(f.markSymbols) } : {}),
    ...(f.isSequence ? { sequence: true } : {}),
  };
}

function groupJson(g: SnapshotGroup, fields: Map<string, SnapshotField>, aliasOf: Map<string, string>) {
  const options = g.optionFieldIds.map((id) => ({ fieldId: aliasOf.get(id) ?? id, label: fields.get(id)?.path.at(-1)?.label ?? id }));
  return {
    path: pathJson(g.path),
    ...(g.note ? { note: g.note } : {}),
    ...(g.selection === "ONE_OF"
      ? {
          tickColumns: options,
          instruction:
            "Normally one of these is ticked per record, but report each option's mark exactly as seen, including none ticked or several ticked. Never choose between them and never add a tick that isn't there.",
        }
      : g.selection === "ANY_OF"
        ? {
            tickColumns: options,
            instruction:
              "Normally a few of these are ticked per record. Report each option's mark exactly as seen, including none ticked. Never add a tick that isn't there.",
          }
        : {}),
  };
}

function numeralNote(system: ExtractionRequest["book"]["numeralSystem"]): string {
  if (system === "MYANMAR") return " In this dataset numbers are usually written with Burmese digits.";
  if (system === "LATIN") return " In this dataset numbers are usually written with Latin digits.";
  return "";
}

function eraNote(era: ExtractionRequest["book"]["dateEra"]): string {
  if (era === "BUDDHIST") return " Years are usually Buddhist era (for example 2569). Transcribe the year as written; do not convert it.";
  if (era === "MYANMAR") return " Dates may use the Myanmar calendar. Transcribe them as written; do not convert them.";
  return "";
}

function kindRules(req: ExtractionRequest, aliasOf: Map<string, string>): string {
  const t = req.template;
  if (t.kind === "FORM") {
    return [
      "FORM RULES",
      "- This document is a form. Produce exactly one record with recordIndex 0.",
      '- If the pages contain content but none of the listed fields can be located, return "contentState": "NO_ROWS_FOUND" with an empty records array. Never invent a record of nulls.',
      "- All pages of the form are sent together, in page order. Fields may appear on any page. Set the record's pageIndex to the page where most of its values are.",
      "- Each field appears at most once in the record. Leave out fields you cannot find on the page rather than inventing them.",
    ].join("\n");
  }
  const sequence = t.fields.find((f) => f.isSequence);
  return [
    "TABLE RULES",
    "- This document is a table. The listed fields are its columns, in paper order from left to right: f1 is the leftmost column. Each source row becomes one record.",
    "- Leave blank cells out. A record's values list only the cells that have something written in them; every column you do not list is taken to be blank. Never write a value with state EMPTY in a table.",
    "- A cell with anything at all in it must be listed: a dash, a ditto mark, N/A, a tick, or writing you cannot read (state ILLEGIBLE). Leaving out a cell says it is blank, so never leave out a cell because it is hard to read.",
    "- A row with nothing written in any listed column is still a record, with an empty values array.",
    "- Read the table row by row. Use the column headers to decide which field a value belongs to, not its exact horizontal position: handwriting drifts across ruled lines.",
    "- Columns marked SKIP are listed so you know where the column boundaries are. Do not report values for them.",
    '- Header rows repeated on later pages must be reported as "rowType": "HEADER", not dropped.',
    '- Total and subtotal rows look like data rows but are not. Report them as "rowType": "TOTAL" or "SUBTOTAL", never as "DATA". Use "NOTE" for rows that are remarks, not data.',
    ...(sequence
      ? [
          `- The column with fieldId "${aliasOf.get(sequence.id) ?? sequence.id}" is a running number. Transcribe it exactly as written on every row, including gaps, repeats and corrections.`,
        ]
      : []),
    "- Consecutive pages may overlap and show the same rows. Report every row you see on each page; duplicates are removed later. Do not remove duplicates yourself.",
    "- Rows written in the margin or squeezed between lines are reported where they appear to belong. recordIndex counts records in reading order starting at 0 across all pages sent, and each record's pageIndex is the page it is on.",
    '- If a page has content but no data rows, return "contentState": "NO_ROWS_FOUND" with an empty records array.',
  ].join("\n");
}

export function buildExtractionPrompt(req: ExtractionRequest): ModelPrompt {
  const t = req.template;
  const { aliasOf } = fieldAliases(t);
  const byId = new Map(t.fields.map((f) => [f.id, f]));
  const extract = t.fields.filter((f) => f.mode === "EXTRACT");
  const skip = t.fields.filter((f) => f.mode === "SKIP");
  const fieldList =
    t.kind === "TABLE"
      ? { columns: t.fields.map((f) => fieldJson(f, aliasOf, true)) }
      : { fields: extract.map((f) => fieldJson(f, aliasOf, false)), ignoreTheseFieldsEntirely: skip.map((f) => ({ path: pathJson(f.path), note: f.note ?? undefined })) };
  const headers = t.groups.map((g) => groupJson(g, byId, aliasOf));

  const blocks = [
    // 1. Role
    "ROLE\nYou are a careful transcriber of handwritten documents. The single most important rule: transcribe exactly what is written. Never interpret, convert, correct or normalise anything. If you cannot read something, say so.",
    // 2. Never guess
    `NEVER GUESS\n${NEVER_GUESS}`,
    // 3. Script and numerals
    `SCRIPT AND NUMERALS\nThe document may contain Burmese script and Burmese digits ၀၁၂၃၄၅၆၇၈၉, possibly mixed with Latin digits on the same page. Transcribe every digit in the script it is written in. Do not convert Burmese digits to Latin digits or the other way round. Watch for confusable glyphs: ၀ (Burmese zero) versus 0 or ○, and ၁ (Burmese one) versus 1 or I.${numeralNote(req.book.numeralSystem)}${eraNote(req.book.dateEra)}${t.languageHint ? ` Language of the document: ${t.languageHint}.` : ""}`,
    // 4. Value states
    [
      "EMPTY, DASH, N/A AND UNREADABLE ARE DIFFERENT",
      'Every value has a "state":',
      '- "OK": something readable is written. valueText is exactly what is written.',
      t.kind === "TABLE"
        ? '- "EMPTY": the cell is blank. In a table you do not write these: leave the cell out.'
        : '- "EMPTY": the cell or box is blank. valueText is null.',
      '- "DASH": only a dash or line such as - or — or / is written. valueText is the mark as written.',
      '- "NOT_APPLICABLE": N/A, n/a or a similar "not applicable" note is written. valueText is the note as written.',
      '- "ILLEGIBLE": something is written but you cannot read it confidently. valueText is null.',
      '"confidence" is your own estimate from 0 to 1 that valueText is exactly right. "bbox" is the value\'s region on its page as fractions 0..1 of the page width and height ({x, y} is the top-left corner), or null.',
    ].join("\n"),
    // 5. Ditto
    'DITTO MARKS\nIf a cell contains a ditto mark (", 〃, do., a vertical continuation line or a brace meaning "same as above"), set "isDitto": true and put the literal mark in valueText. Do NOT copy the value from the row above. Leave "isDitto" out when the cell is not a ditto.',
    // 6. Corrections
    'CORRECTIONS AND STRIKETHROUGH\nSet "struckThrough": true on a record whose whole row is crossed out, and still report its values. If a value is visibly corrected (overwritten, or crossed out with a new value written nearby), put the final value in valueText and the original value in altValueText. Otherwise leave altValueText out.',
    // 7. Glossary
    req.glossary.length > 0
      ? `CONVENTIONS USED IN THIS DATASET\nThese explain what people wrote. They do not change how you transcribe: still report exactly what is written.\n${req.glossary.map((g) => `- "${g.term}": ${g.meaning}`).join("\n")}`
      : null,
    // 8. Template instructions
    t.instructions ? `INSTRUCTIONS FOR THIS KIND OF DOCUMENT\n${t.instructions}` : null,
    // 9. Field list
    [
      "FIELDS",
      'Report values only for these fields, using exactly these fieldId values. "path" is the header text on the paper from the top header down to the field; "meaning" is its English meaning where known.',
      "```json",
      JSON.stringify(fieldList, null, 2),
      "```",
      ...(headers.length > 0
        ? [
            "Headers with notes or tick columns. A header is not a field and never has a value of its own:",
            "```json",
            JSON.stringify(headers, null, 2),
            "```",
          ]
        : []),
    ].join("\n"),
    // 10. Kind-specific rules
    kindRules(req, aliasOf),
    // 11. Anchors
    t.anchors.length > 0
      ? `PRINTED TEXT\nReport in "anchorsFound" which of these printed strings you can see on the pages, copied exactly from this list:\n${t.anchors.map((a) => `- ${a}`).join("\n")}`
      : 'PRINTED TEXT\nReturn "anchorsFound" as an empty array.',
    // Content state
    'CONTENT\n"contentState" is "EMPTY" when the pages are blank (no records), "NO_ROWS_FOUND" when there is content but none of the fields or rows can be found (no records), otherwise "HAS_CONTENT".',
    // 12. Restate
    `REMEMBER\nTranscribe exactly what is written, in the script it is written in. ${NEVER_GUESS}`,
  ];

  const parts: ModelPrompt["parts"] = [];
  for (const image of req.images) {
    parts.push({ kind: "text", text: `Page ${image.pageIndex + 1} (pageIndex ${image.pageIndex}):` });
    parts.push({ kind: "image", data: image.data, mimeType: image.mimeType });
  }
  parts.push({ kind: "text", text: "Transcribe these pages following the instructions. Respond with JSON only." });

  return { system: blocks.filter((b): b is string => b !== null).join("\n\n"), parts };
}

export function buildRepairInstruction(previousText: string | null, issues: string[]): string {
  return [
    "Your previous response could not be used because it did not follow the required structure:",
    ...issues.map((i) => `- ${i}`),
    "",
    "Your previous response was:",
    previousText ?? "(empty)",
    "",
    "Transcribe the pages again and respond with corrected JSON only. Keep the transcription rules: exactly as written, never guess.",
  ].join("\n");
}
