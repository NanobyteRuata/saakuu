# 03 — Extraction Pipeline & Prompt Design

## 1. Provider interface

`lib/ai/provider.ts` — Gemini is one implementation; no Gemini types escape this file.

```ts
export interface ExtractionRequest {
  images: { data: Buffer; mimeType: string; pageIndex: number }[];
  template: TemplateSnapshot;   // fields, groups, notes, kind, anchors, instructions
  glossary: { term: string; meaning: string }[];
  book: { numeralSystem: NumeralSystem; dateEra: DateEra };
  model: string;
}

export interface ExtractionResult {
  contentState: "HAS_CONTENT" | "EMPTY" | "NO_ROWS_FOUND";
  anchorsFound: string[];
  records: RawRecordDTO[];
  usage: { inputTokens: number; outputTokens: number };
  rawResponse: unknown;
}

export interface AIProvider {
  listModels(): Promise<ModelInfo[]>;
  extract(req: ExtractionRequest): Promise<ExtractionResult>;
}
```

Models exposed in v1 (Gemini): `gemini-3.5-flash` (default), `gemini-3.7-flash`. The 2.5 models this list started
with are closed to new API keys; a migration moved stored book and template choices (2.5 Flash → 3.5 Flash,
2.5 Pro → 3.7 Flash). `gemini-3.1-pro-preview` needs a paid plan and is not listed yet. A retry of a run whose
model was retired uses the template or book model.
`ModelInfo` carries id, display name, and a rough relative cost tier so the extract
modal can show an estimate.

## 2. Structured output

Use Gemini's `responseMimeType: "application/json"` with a `responseSchema` derived
from the template. Do **not** parse free text. Validate the parsed JSON with Zod
before it touches the DB; on schema failure, retry once with a repair instruction,
then fail the run with the raw response stored for debugging.

Response schema (generated per template):

```jsonc
{
  "contentState": "HAS_CONTENT" | "EMPTY" | "NO_ROWS_FOUND",
  "anchorsFound": ["string"],
  "records": [{
    "recordIndex": 0,
    "rowType": "DATA" | "HEADER" | "SUBTOTAL" | "TOTAL" | "NOTE",
    "struckThrough": false,
    "pageIndex": 0,
    "values": [{
      "fieldId": "abc123",
      "valueText": "string|null",   // EXACTLY as written
      "altValueText": "string|null",// visible correction, if any
      "state": "OK"|"ILLEGIBLE"|"EMPTY"|"DASH"|"NOT_APPLICABLE",
      "isDitto": false,
      "confidence": 0.0,
      "bbox": { "x":0, "y":0, "w":0, "h":0 }  // normalised 0..1
    }]
  }]
}
```

`fieldId` is echoed back so results bind to fields by ID, not by label. Include the
ID list in the prompt and instruct the model to use exactly those IDs.

## 3. Prompt structure

Prompts live in `lib/ai/prompts/` and are versioned (`v1`, `v2`, …). Every run
records its `promptVersion`.

**System / instruction block, in this order:**

1. **Role.** Transcriber of handwritten documents. The single most important rule:
   *transcribe exactly what is written; never interpret, convert, correct or
   normalise. If you cannot read something, say so.*
2. **Never guess.** If a value is not confidently readable, set
   `state: "ILLEGIBLE"` and leave `valueText` null. An honest ILLEGIBLE is more
   valuable than a plausible guess. This is repeated at the end of the prompt too.
3. **Script and numerals.** The document may contain Burmese script and Burmese
   digits `၀၁၂၃၄၅၆၇၈၉`, possibly mixed with Latin digits on the same page.
   Transcribe digits **in the script they are written in**. Do not convert.
   Warn about confusable glyphs (`၀` vs `0`/`○`, `၁` vs `1`/`I`).
4. **Distinguish empty from nothing from unreadable.** Explicit definitions of the
   five `state` values, with examples (`-` → DASH, `N/A` → NOT_APPLICABLE, blank →
   EMPTY, scrawl → ILLEGIBLE).
5. **Ditto marks.** If a cell contains `"`, `〃`, `do.`, a vertical continuation line
   or a brace meaning "same as above", set `isDitto: true` and put **the literal
   token** in `valueText`. Do **not** copy the value from the row above.
6. **Corrections and strikethrough.** Report `struckThrough` per record. If a value
   is visibly corrected, put the final value in `valueText` and the original in
   `altValueText`.
7. **Book glossary.** Injected verbatim as "conventions used in this dataset".
8. **Template instructions.** Free text from the template.
9. **Field list.** For each field: `fieldId`, source label (as written), meaning,
   data type, note. Fields with mode `SKIP` are listed under an explicit
   "ignore these fields entirely" heading; `MANUAL` fields are omitted entirely.
   **Phase 3.1 structure:**
   - Fields are listed in paper order (the template's merged group/field order) with their
     header path, e.g. `"path": [{ "label": "RDT Test" }, { "label": "Positive" }, { "label": "A" }]`
     with meanings where set. Group notes are attached to the group.
   - For TABLE templates, `SKIP` columns stay **in their paper position**, marked
     `"mode": "SKIP"` with an ignore instruction, instead of being moved to a separate heading, so
     the header list still anchors every column boundary.
   - For selection groups, say that normally one option (`One of`) or a few (`Any of`) are ticked
     per record, but the model must **report each option's tick exactly as seen, including none or
     several**, and must never choose between them. Wording that implies "exactly one" invites
     invented ticks.
10. **Kind-specific rules** — see §4 and §5.
11. **Anchors.** "Report which of these printed strings you can see on the page."
12. **Restate the never-guess rule.**

Keep the field list machine-readable (a JSON block) rather than prose. Models follow
structured field lists more reliably than paragraphs.

## 4. FORM templates

- Produce exactly one record, `recordIndex: 0`.
- If the page contains content but none of the listed fields can be located, return
  `contentState: "NO_ROWS_FOUND"` with an empty `records` array. Never invent a record
  of nulls.
- Multi-page forms: all pages are sent together in one request, in page order, each
  labelled. Fields may appear on any page; report `pageIndex` per value.

## 5. TABLE templates

- Fields are columns. Each source row becomes one record.
- **Row-wise, not position-wise.** Instruct the model to read the table row by row and
  to use the column headers to decide which field a value belongs to. Handwriting
  drifts across ruled lines; header matching is more reliable than x-position.
- **Repeated headers** on pages 2+ must be reported as `rowType: "HEADER"`, not
  dropped silently — the transform layer drops them, so the model's job is only to
  classify.
- **Totals and subtotals** must be classified `TOTAL`/`SUBTOTAL`. Explicitly warn that
  these look like data rows and must not be reported as `DATA`.
- **Sequence field.** If the template designates one, tell the model that this column
  is a running number and to transcribe it exactly, including any gaps or repeats.
- **Overlapping photos.** Tell the model that consecutive pages may overlap and to
  report every row it sees on each page; dedupe happens downstream. Do not ask the
  model to dedupe.
- **Insertions.** Rows written in margins or squeezed between lines are reported in
  the position they appear to belong, with `recordIndex` reflecting reading order.

## 6. Chunking

A single request carries all pages of a document, up to these limits:
- max 8 images per request
- max ~15 MB total payload
- working copies are max 2048px on the long edge, JPEG q85

If a document exceeds the limits, split by page into multiple requests and merge the
records, offsetting `recordIndex`. Record each request as a separate `ExtractionRun`
only if it was a genuinely separate model call; otherwise keep one run and sum usage.

## 7. Job pipeline

BullMQ queue `extraction`, one job per document.

```
enqueue(documentId, model, idempotencyKey)
  → worker:
      1. Load document, photos, template snapshot, glossary, book settings
      2. Set Document.runState = RUNNING; Photo.status = PROCESSING
      3. Render working copies (apply crop/rotate/deskew transform)
      4. Build prompt + response schema
      5. Call provider (retry 3× on 429/5xx with exponential backoff + jitter)
      6. Validate response with Zod (1 repair retry on schema failure)
      7. Write ExtractionRun + RawRecord + RawValue in one transaction
      8. Run the transform pipeline (docs/03 §8) to build Rows and Cells
      9. Set Document.runState = COMPLETE | PARTIAL | FAILED; contentState; needsReview
```

**Idempotency:** `ExtractionRun.idempotencyKey` is unique. The key is
`hash(documentId, model, promptVersion, photoIds, transformHash, passIndex, nonce)`
where `nonce` is generated once per user-initiated extract action and reused across
the whole selection. A double-click submits the same key and the second insert is a
no-op.

**Concurrency:** worker concurrency configurable (default 3) with a per-provider rate
limiter. Gemini free tier has low RPM limits — make the limiter configuration a single
env var and back off hard on 429.

**Failure granularity:** a run failure marks the document `FAILED` with the error
message. When a document was split across multiple requests, a partial success marks
it `PARTIAL` and only the failed pages are retryable.

**Progress:** the client polls a lightweight status endpoint (2s interval while any
document in view is QUEUED/RUNNING). No websockets in v1.

### As built (Phase 5)

- Code: `lib/ai/` (provider interface, `gemini.ts`, `fake.ts`, `prompts/v1.ts`, `response-schema.ts`, `validate.ts`,
  `extract.ts` for the shared call → validate → repair loop) and `lib/extraction/` (`plan.ts` pure, `service.ts`
  for requests, `process.ts` for the worker).
- `AI_PROVIDER=fake` is a deterministic stub (near-white page → `EMPTY`, otherwise sample values) used without an
  API key and in CI. `AI_FAKE_BEHAVIOUR=error|rate-limited` forces failures.
- Gemini gets the JSON schema as `responseJsonSchema`. Validation rejects unknown field ids, a field twice in one
  record, more than one FORM record, pages that weren't sent, and records alongside `EMPTY`/`NO_ROWS_FOUND`; it
  drops values for `SKIP` fields and keeps everything else verbatim. One repair request lists the problems.
- Step 2: `Photo.status` is **not** set to `PROCESSING`. It is the ingest state and the photo editor relies on it.
- Step 3: the worker uses the working copy already rendered for the page's current transform. A page edited
  after Extract fails its run with a plain message; extracting again picks up the new copy.
- Step 5: the provider call retries 3× on rate limits and outages. Beyond that the job retries (4 attempts,
  exponential backoff from 15 s) with the runs put back in the queue; a rate limit also pauses the whole
  `extraction` queue for a minute. The last attempt fails the runs.
- Step 8 (transform) is Phase 6. Phase 5 writes the raw layer only.
- Runs are claimed with an atomic `UPDATE … RETURNING`, so two jobs for one document never call the model twice
  for the same run. A run left `RUNNING` for 15 minutes can be claimed again (the Phase 9 reaper still applies).
- Rate limiting: `EXTRACTION_CONCURRENCY` documents at once, BullMQ limiter of `EXTRACTION_RPM` jobs per minute.
  A job is one document, which is one model call unless it has more than 8 pages or needs a repair.
- Anchor score = share of the template's anchors reported (case- and space-insensitive), counted only over
  requests that weren't blank; null without anchors or when every page was blank.
  Below 0.5 the document is flagged `needsReview` as a possible template mismatch. `NO_ROWS_FOUND`, or content
  with no records, also sets `needsReview`.

## 8. Transform pipeline

Pure function. `lib/transform/run.ts`. No AI, no network, idempotent, cheap enough to
re-run on every mapping change.

```
transform(document, rawRecords, template, mappings, book, existingCells) -> Row[]
```

**Steps, in order:**

1. **Filter records.** Drop `HEADER`. Keep `SUBTOTAL`/`TOTAL`/`NOTE` as rows flagged
   `isVoid = true` by default (visible, not counted, not silently deleted).
2. **Resolve ditto.** For each field, walking records in order: if `isDitto`, take the
   last non-ditto resolved value for that field; set `inherited = true` on the
   resulting cell. Ditto at the top of a page continues from the previous page. If
   there is no previous value, leave empty and flag for review.
3. **Dedupe overlaps.** If the template has a sequence field: group records by
   normalised sequence value; when two records from different pages share a sequence
   value and their other values are equal or one is a strict subset, keep the more
   complete one and set `duplicateOf` on the other. Never dedupe without a sequence
   field — flag suspected duplicates for review instead.
4. **Sequence check.** Verify monotonic increase. Report gaps ("rows 14–16 missing")
   and repeats as document-level review flags.
5. **Normalise per field type.** Deterministic, inspectable:
   - Numeral conversion (Myanmar → Latin digits) per book `numeralSystem`
   - Era conversion (BE → CE, Myanmar calendar → CE) per book `dateEra`
   - `AGE`: parse `1 1/2` → configurable output (years+months, or total months);
     `4/12` → 4 months. Driven by the glossary and the field note.
   - `FRACTION`: parse to a decimal or keep as a fraction string
   - `MARK`: apply `markSymbols` semantics
   - `CHOICE`: fuzzy-match to the declared choice list; no match → flag
   - Whitespace collapse, Unicode NFC normalisation
   - **Burmese-specific:** normalise the well-known Zawgyi/Unicode confusions and
     apply NFC. Consider `rabbit-node` or a small hand-written digit map; a digit map
     is sufficient for v1 since numerals are the main case.
5a. **Resolve selection groups** (defined in Phase 3.1, implemented with the transform).
   For each `ONE_OF` / `ANY_OF` group, read its option fields' normalised `MARK` values for the
   record:
   - `ONE_OF` with one tick → the ticked option's path relative to the group, using meaning
     labels where set, else source labels (`Positive › A`).
   - `ANY_OF` → the ticked options in paper order.
   - Nothing ticked → apply `noneMarked`: `BLANK` = empty value, no flag; `REVIEW` = empty value
     plus a warning; `ERROR` = empty value plus an error.
   - Several ticked in `ONE_OF` → apply `multipleMarked` (`REVIEW` or `ERROR`) and leave the
     value empty; never pick one.
   - Any option `ILLEGIBLE` → review flag, regardless of the settings above.
   - Raw values are never modified. How a mapping references a group (a new mapping kind, an
     `EXPRESSION` helper, or a group reference on `MappingInput`) is decided in Phase 6, along
     with per-option output values and the value exported when nothing is ticked.
6. **Apply mappings.** COPY / CONCAT / SPLIT / CONSTANT / EXPRESSION, per §9.
7. **Coerce to column type.** On failure set `validationState = ERROR` with a message
   and keep the raw string in `currentValue` — never discard data to satisfy a type.
8. **Run validation rules.** Populate `validationState` and `validationMsgs`.
9. **Merge with existing cells.**
   - Cell does not exist → create with `extractedValue = currentValue = computed`.
   - Cell exists, `isEdited = false` → overwrite both.
   - Cell exists, `isEdited = true` → **write `extractedValue` only**; if it differs
     from `currentValue`, set `disagreement = true`. Never touch `currentValue`.
   - Reviewed cells keep `isReviewed = true` unless `disagreement` was just raised, in
     which case clear it so the cell resurfaces for review.

## 9. Expression language

Tiny and safe. Parse with `jsep`, evaluate with a hand-written walker. No `eval`.

Allowed: field references `{fieldId}`, string literals, number literals,
`+ - * /`, `concat(a, b, …)`, `substring(s, start, len)`, `replace(s, find, repl)`,
`trim(s)`, `upper(s)`, `lower(s)`, `if(cond, a, b)`, comparisons, `and`/`or`/`not`,
`number(s)`, `text(n)`, `default(a, b)`.

Forbidden: property access, function definitions, loops, anything not in the list.
Evaluation is time-boxed and any error yields an empty value plus a cell-level
validation error. Validate expressions at save time, not at run time.

## 10. Cost and estimation

Before extraction the modal shows: document count, page count, model, and an estimated
input-token count based on image dimensions plus prompt size. Store actual usage per
run so the estimate can be calibrated against history later.

## 11. Testing the pipeline

- Golden-file tests for the transform layer: fixture `RawRecord[]` in, expected
  `Row[]` out. This is the highest-value test suite in the project — it is pure and
  covers ditto resolution, dedupe, normalisation and merge semantics.
- Provider tests use a recorded-response fake. Do not call Gemini in CI.
- One E2E test: upload a fixture image → extract with a stubbed provider → assert the
  output table contents.
