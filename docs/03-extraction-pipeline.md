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
  proposeFields(req: FieldProposalRequest): Promise<FieldProposalResult>;   // Phase 16, §12
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

### As built (Phase 9): stale runs

- A worker killed mid-job leaves its runs `RUNNING`. BullMQ may restart the job, but the restarted job can't claim a run
  younger than 15 minutes, finishes idle, and the document would stay `Running`. The **stale-run reaper**
  (`lib/extraction/reaper.ts`, `system.reap-stale` every minute) handles it: a run `RUNNING` for over 2 minutes whose
  document has no extraction job active or waiting goes back to `QUEUED` and the document's job is enqueued. A run put
  back 3 times is failed instead ("The worker stopped while reading these pages. Retry them."), so a page that crashes
  the worker can't loop. It also re-ingests photos stuck `PROCESSING` for 10 minutes (also at most 3 times, then the
  photo is `FAILED`) and recomputes documents whose run state says running with no active run. A run is only ever
  updated with its `startedAt` in the guard.
- **Fencing:** a claim sets `startedAt` to the claim time, and every later write of that run (complete, fail, put back)
  requires `state = RUNNING` *and* that `startedAt`. A worker that lost its claim (the reaper re-queued the run and
  another job took it) can't write over the newer attempt.
- Checked by hand: a worker killed with `kill -9` during a run (`AI_FAKE_BEHAVIOUR=slow`) left the run `RUNNING`; the
  restarted worker's reaper re-queued it on its first tick past 2 minutes and the document finished `COMPLETE`.
- `AI_PROVIDER=gemini` without `GEMINI_API_KEY`: the estimate returns `providerProblem` and `start` refuses with
  `PROVIDER_ERROR`, so nothing is queued that can only fail.

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
`number(s)`, `text(n)`, `default(a, b)`, `floor(n)`, `ceil(n)`, `round(n)`.

Forbidden: property access, function definitions, loops, anything not in the list.
Evaluation is time-boxed and any error yields an empty value plus a cell-level
validation error. Validate expressions at save time, not at run time.

### As built (Phase 6)

Code: `lib/transform/` — `run.ts` (steps 1–8, pure), `merge.ts` (step 9, pure), `normalise.ts`, `numerals.ts`,
`decimal.ts`, `coerce.ts`, `expression.ts`, `mappings.ts` (save-time checks and broken detection), `service.ts`
(load, lock, write), `triggers.ts`. Golden files: `lib/transform/golden/*.json`, run by `golden.test.ts`.

- **When it runs.** The extraction worker transforms the document right after its runs complete (§7 step 8); a failure
  there is logged and queued as a rebuild, never an extraction failure. Everything else goes through the `transform`
  queue: `transform.template` (every document of the template with raw records or rows, with progress) and
  `transform.document`. Both are deduplicated per target with BullMQ `keepLastIfActive`: one waiting job absorbs repeat
  requests, and a change saved during a run gets one more run after it. Rebuilds are requested after mapping writes;
  field update, delete and restore; group update and delete; Manual value edits (that document); and a book numeral
  system or date era change (every template). Saving only a field's or group's note (AI-only text) doesn't rebuild.
  Jobs are added on fail-fast Redis connections (a few reconnect attempts, no offline queue), and a request gives up
  after 5 s, so an unreachable Redis never hangs a save or fails the change that caused the rebuild.
- **Outcome.** A template rebuild counts documents that failed (logged, skipped) and records the result for a week; the
  retransform status reports it when idle. A rebuild in which every document failed is retried, then recorded as failed.
  The template context is read once per run: a change saved mid-run is picked up by the follow-up run.
- **Limits.** A document with more than 5,000 raw records or rows is refused with a plain message rather than built
  from a partial list (which would delete or duplicate the rows left out). A document whose rows can't be built keeps
  the rows it has and is flagged `rows not rebuilt` with the reason; the extraction worker records such a problem
  instead of queueing a rebuild that would fail the same way.
- **Locks.** One transaction per document: book row, then document row (the order document restructuring uses).
- **Step 1.** `HEADER` records are dropped. `SUBTOTAL`/`TOTAL`/`NOTE` and struck-through rows become void rows.
- **Step 2.** A ditto is `isDitto` or a literal token (`"`, `〃`, `do.`, …). It copies the last non-blank reading of that
  field in a non-void data row above, across pages, and is marked inherited. With nothing above it, the cell is empty
  with a warning and the document is flagged. A mapping with `fillDown` off leaves ditto cells empty with a warning.
- **Step 3.** Only data rows that aren't struck through, on different known pages, with equal sequence numbers are
  compared; the sequence field itself is left out of the comparison, and a row with no other reading is never deduped
  (it is left to the repeat flag). Without a sequence field nothing is deduped; rows
  identical to a row on the page before are counted in a `SUSPECTED_DUPLICATES` flag.
- **Step 4.** Document flags `SEQUENCE_GAP`, `SEQUENCE_REPEAT`, `SEQUENCE_ORDER`, `SEQUENCE_UNREADABLE` (Part C
  question 3: a document flag in v1).
- **Step 5.** Digits always come out Latin. The book's numeral system decides which look-alikes are read as digits when
  that makes the value a number: Myanmar `ဝ` → 0 (identical glyphs, no note); Latin `O` → 0 and `l`/`I` → 1 (with a
  warning); Auto uses the script of the digits already in the value. Numbers stay text (no floats).
  - `DATE`: day/month/year or year-month-day. Buddhist era: CE = BE − 543. Myanmar era: CE = ME + 638, with a warning
    (dates before Thingyan belong to the next year; day and month aren't converted). A Gregorian year ≥ 2400 is kept
    with a warning to check the era setting.
  - **Two-digit years** are refused with a warning unless the field says otherwise (`Field.typeOptions.date`, docs/07
    decision 36): `CENTURY` reads them in the book era's own century, `PIVOT` splits at a year so those at or above it
    belong to the century before. The century is a fixed constant per era (2000 / 2500 / 1300), never today's date, so
    rebuilding the same document years later gives the same date. A `TEXT` field mapped to a `DATE` column has no
    field options, so its two-digit years stay refused.
  - `AGE`: total months. Numbers are years (`1 1/2` → 18, `4/12` → 4, `2` → 24); `1y 6m` and `1 နှစ် 6 လ` are read by
    their units. Not driven by the glossary or field notes: the transform is deterministic, so those stay prompt text.
  - `FRACTION`: exact decimal (`1 1/2` → `1.5`), or the tidy fraction when it doesn't terminate (`1/3`).
  - `CHOICE`: exact match ignoring case, spaces and numeral script; a single-character difference matches with a
    warning; otherwise the text is kept with a warning.
  - `MARK`: the field's symbols; without symbols anything written is ticked. `count` symbols count repeats; the symbol
    `tally` counts strokes. An undeclared mark is kept as text with a warning and counts as an unreadable tick.
- **Step 5a.** As specified. An unreadable tick makes the answer `ILLEGIBLE` with a warning, never "nothing ticked".
  `ANY_OF` options are joined with `, `. Option values and the nothing-ticked value come from the mapping input.
- **Step 6.** `CONCAT` leaves empty inputs out. `SPLIT` reads a field (not a tick group) and keeps a 0-based part after
  splitting on a separator (the editor shows it 1-based), or the first capture group of a pattern. Patterns that repeat
  an already-repeating group (`(\d+)+`) are refused at save; patterns are compiled once per build and values over
  2,000 characters aren't matched (a cell of a form or table is far shorter). A mapped cell is `OK` when it has text; otherwise
  `ILLEGIBLE` if any input was, `DASH`/`NOT_APPLICABLE` when every input agrees, else `EMPTY`. Confidence is the lowest
  of its inputs; inherited if any input was.
- **Step 7.** `BOOLEAN` becomes `true`/`false`; `ENUM` takes the declared value's spelling; `INTEGER` drops `.0`. A
  `DATE` column passes an ISO date through unless its year is still in the book's era (≥ 2400 for Buddhist era, < 1800
  for Myanmar era): then it is converted once. A `DATE` field has already converted its year, so nothing converts twice.
- **Step 8.** Phase 6 validates what the transform knows: its own warnings and errors, and `OutputColumn.isRequired`.
  `ValidationRule` kinds arrive with their CRUD and the revalidate job in Phase 7. Void rows carry no flags.
- **Step 8, Phase 7.** The build stores what it found as `Cell.buildIssues`; the stored `validationState` is worked out
  after the merge, in the same transaction, by `revalidate` (`lib/validation/`), which adds the required flag and the
  book's rules. An edited cell is checked against its column type instead of its build issues. See docs/02 → Output table.
- **Step 9.** If an edit is saved to a row the plan was about to delete, the delete skips it and the row is kept as
  `ORPHANED`, like any edited row that no longer matches (keeping a void state someone set by hand). One refinement: an edited cell's `disagreement` is raised only when the new reading differs from the
  previous reading *and* from your value, and cleared when the reading equals your value. Re-running with an unchanged
  reading doesn't raise it again after you chose to keep yours. An unedited cell stays reviewed only if its value and
  state are unchanged. The SQL updates repeat the rule as guards (`NOT "isEdited"` / `"isEdited"`), so an edit saved
  while a build runs is never overwritten.
- **Expressions (§9).** `+` adds only when both sides are numbers (number literals or `number()`); field text
  concatenates, so two digit fields never sum by accident. Arithmetic is exact decimal; division rounds to 12 places.
  Evaluation has a step and length budget. `?:`, property access and unknown names are refused at save time. The editor
  shows `{Label}`; the API stores `{id}`.

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

## 12. Template proposal (Phase 16)

The one other model call in the product: read a **specimen** and propose the template's fields, so the operator
checks a list against the paper instead of typing twenty labels. It is extraction's shape turned on the
template itself, and it follows the same rules. Nothing runs in a request handler. The prompt is versioned. A
proposal costs money, so it is estimated first and records its usage.

```ts
export type FieldProposalRequest = { images; kind: "FORM" | "TABLE"; languageHint; instructions; glossary; model };
export type ProposedFieldDTO = { labelSource; labelMeaning: string | null; dataType: FieldType; choices: string[]; note: string | null };
export type FieldProposalResult = { fields: ProposedFieldDTO[]; usage; rawResponse: { responses: ResponseLog[] } };
```

- **Prompt:** `lib/ai/prompts/template-v1.ts`, `TEMPLATE_PROMPT_VERSION = "template-v1"`. It follows the same
  never-edit-in-place rule as `v1.ts`, and every `FieldProposal` row records the version it used. Labels are
  transcribed as written, in their own script. `labelMeaning` is a short English gloss, which is template
  metadata the operator reads, not a data value, so it doesn't break "the AI transcribes, it does not normalise".
- **The kind changes the question:**
  - A **FORM** is every labelled place a value goes, in reading order. A printed circle-one question is one
    `CHOICE` with its options, and a lone tick box is `MARK`. A small grid inside a form becomes one field per
    cell, `row / column`, including cells empty on this copy.
  - A **TABLE** is the ruled grid's column headers, left to right. Blanks filled once above the grid are
    left out, and nested headers flatten to the lowest one with the parent in `note`.
  - On a page with labelled blanks and a grid, the two kinds give visibly different lists. A page with no
    grid reads much the same either way.
- **Flat fields only** (decision 73). Groups and selection groups stay manual.
- **Schema and validation** (`lib/ai/propose.ts`): a fixed JSON schema `{ fields: [...] }`, the same
  repair-once loop as extraction, and at most 100 fields. Small problems are tidied rather than paid for
  twice: labels are trimmed, duplicate choices dropped, a `CHOICE` without choices becomes `TEXT`, and choices
  on other types are dropped. Labels are never rewritten.
- **Job:** `template.propose` on the `extraction` queue, so it shares the key, concurrency and the rate-limit
  pause. The worker (`lib/templates/field-proposal-process.ts`) claims it with a `startedAt` fencing token,
  as runs do. The book owner's key pays. Transient errors go back to `QUEUED` and retry.
- **Estimate:** 1,500 prompt tokens plus image tokens per page (§10's formula), and a fixed 2,500-token output
  allowance. Real proposals on a twelve-field card measured about 1,450 output tokens including thinking,
  about $0.004 on 3.5 Flash.
- **Nothing is written until accepted** (docs/04 → Field proposals). The fake provider proposes twelve form
  fields or six table columns, so the E2E can tell the kinds apart.

