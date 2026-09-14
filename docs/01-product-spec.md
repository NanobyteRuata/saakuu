# 01 — Product Spec

## 1. Purpose

SaaKuu turns photographs of handwritten physical forms and tables into structured
tabular data. It targets data-entry operators who today read a paper form and type
its contents into a spreadsheet.

The AI does the first pass. The human reviews and corrects. The product succeeds if
the operator spends their energy on **reviewing** rather than on **transcribing**,
and therefore catches more errors than they would after a day of manual typing.

Primary document language: Burmese handwriting, with mixed Latin/Burmese numerals.
Expected raw extraction error rate: 40–50% on handwritten non-Latin script. The
system is designed around that reality rather than against it.

## 2. Core concepts

| Concept | Definition |
|---|---|
| **Book** | A project. Owns one output table schema, its templates, documents and rows. Personal to one user in v1. |
| **Output table** | The book's target schema: an ordered list of Output Columns. The thing you export. |
| **Template** | A description of one kind of source document. Two layers: a **source layer** (fields, groups, notes, language hints) and a **mapping layer** (how fields become output columns). Type is FORM or TABLE. |
| **Field** | One thing to read from the document. Has a source label (as written on the paper, any language) and an optional meaning label (English). |
| **Document** | An ordered set of photos that together make **one source record**. A 3-page form is one document. A ledger shot in 3 overlapping photos is one document. |
| **Photo** | One image, one page of a document. Has an immutable original plus a non-destructive transform. |
| **Extraction run** | One execution of a template against one document with a chosen model. |
| **Raw layer** | What the AI literally read, verbatim, per field. Never normalised. |
| **Row / Cell** | The output table's data, computed deterministically from the raw layer via the mapping layer. |

**Cardinality rule:**
- FORM template → 1 document produces **1 row**
- TABLE template → 1 document produces **N rows** (0 is legal, see §7)

## 3. Terminology decision

What the user originally called "extraction logic" is a **Template**. An execution is
an **Extraction** or **Run**. Use these terms consistently in code and UI.

## 4. Authentication

- Sign in with Google OAuth, or email + password.
- **Account linking:** if a user signs up with email/password and later signs in with
  Google using the same verified email address, link the accounts rather than
  creating a duplicate. If the password account's email is *not* yet verified, do not
  auto-link — require verification first (prevents account takeover by pre-registration).
- Email verification required for credentials sign-up.
- Password reset via emailed single-use token, 1 hour expiry.
- Sessions: 30-day rolling, database-backed.

## 5. Navigation shell

Top bar, persistent once signed in.

- **Left:** `SaaKuu` wordmark, links to the book list.
- **Right:** nav items (v1: `Books`), then a user avatar.
- Avatar click opens a menu: user email, `Sign out`.
- `Sign out` opens a confirmation modal before signing out.

Body renders the current route.

## 6. Screens and behaviour

### 6.1 Books list
- Grid or list of the user's books: name, column count, document count, row count, last updated.
- `Create Book` button.
- Select one or many books → `Delete`. Always a confirmation modal stating counts
  ("Delete 2 books, 47 documents and 1,203 rows?"). Soft delete.

### 6.2 Create Book
A two-step flow:
1. **Name** and **default AI model**.
2. **Define output table columns**: ordered list, each with key, label, data type.

On save, navigate to the book detail page.

### 6.3 Book detail
Tabbed: **Table** | **Templates** | **Documents** | **Settings**.

**Settings** holds: book name (inline editable), default model, numeral system,
date era, the glossary, validation rules, and the edit-output-table action.

**Editing the output table** opens a modal that first shows the blast radius —
which templates' mappings break, which columns will be cleared, how many cells are
affected and how many of those carry human edits — and requires explicit
confirmation. See §8.

### 6.4 Templates tab
List of templates. Each item shows:
- Name, type (Form/Table), field count
- **Config badge**: `Draft` / `Ready` / `Conflicted`
- **Run badge**: `Never run` / `Running (n/m)` / `Partial` / `Failed` / `Complete`
- Document count and total photo count
- Primary actions: `Upload documents`, `Extract`
- Secondary (visually separated, icon-only): `Edit`, `Duplicate`, `Delete`

Expand/collapse reveals that template's documents inline; collapsed shows counts only.
For large templates the inline list caps at 20 with a "view all in Documents" link.

### 6.5 Template editor
Three sections.

**a. Source layer**
- Type: Form or Table (chosen at creation; switching later is blocked — offer
  "duplicate as new template" instead).
- Groups: named, ordered, collapsible containers for fields.
- Fields, ordered within groups. Each field has:
  - `labelSource` — how it is written on the paper, any script (required)
  - `labelMeaning` — what it means, English (optional)
  - `dataType` — see §9
  - `mode` — `EXTRACT` | `SKIP` | `MANUAL` (see §10)
  - `note` — free text instruction to the AI ("people write 1 1/2 to mean 1 year 6 months")
  - symbol semantics, for MARK type fields
- Table templates additionally designate one field as the **sequence field** (§11.4).
- Optional **anchor strings**: printed text expected on the page, used for template
  mismatch detection (§12).
- Toggle: **double extraction** (§13).

**b. Mapping layer**
Maps fields to output columns. Supported mapping kinds:

| Kind | Shape | Notes |
|---|---|---|
| `COPY` | 1 field → 1 column | |
| `CONCAT` | N fields → 1 column | ordered inputs, configurable separator, default `, ` |
| `SPLIT` | 1 field → 1 column | takes a part of the field: by delimiter+index, or by regex capture group |
| `CONSTANT` | none → 1 column | fixed value per template |
| `EXPRESSION` | N fields → 1 column | small safe expression language (§14) |

One-to-many is expressed as multiple `SPLIT` mappings from the same field to
different columns. Unmapped columns are legal and stay empty.

**c. Validation & review hints** — per-template overrides of book validation rules.

### 6.6 Documents tab
A virtualised, filterable table of every document in the book.
Filters: template, status, needs-review, has-edits, date range, free text on label.
Columns: label, template, page count, run state, content state, row count,
unreviewed cell count, validation error count, last run, model.
Bulk actions: `Extract`, `Re-extract`, `Move to another template`, `Delete`.

### 6.7 Document editor / uploader
- Drag-drop or file picker. Accepts JPEG, PNG, HEIC, WebP, PDF (each PDF page
  becomes one photo).
- Uploaded images are grouped into documents. Default grouping: **one document per
  photo**. The user can multi-select photos and `Group into one document`, or split
  a document apart. Page order is drag-reorderable within a document.
- Per photo: edit (crop / rotate / deskew, §15), delete, replace, status badge,
  file size, dimensions.
- Photo grid has small and medium size options.

### 6.8 Extract flow
1. User selects documents (or a whole template) and presses `Extract`.
2. Modal: choose model (pre-filled from template override, else book default),
   shows document count, page count and an estimated cost/time. Warns if any
   selected documents already have human-edited cells.
3. Confirm → one job enqueued per document, with an **idempotency key** so a
   double-click cannot double-charge.
4. UI shows live per-document progress; failures are per-photo and retryable
   individually.

### 6.9 Output table
- Virtualised grid, all cells editable inline.
- Visual states per cell: extracted (default), **edited** (subtle tint), **reviewed**
  (subtle marker), **low confidence / illegible** (warning tint), **validation error**
  (error tint), **inherited** (from a ditto mark — distinct marker).
- Row drag-reorder using a fractional index; manual order is canonical, column
  sorting is a view-only state that does not write.
- Hovering a row highlights the row, its source template, and its source photo
  thumbnail. Clicking the provenance indicator opens the photo at the relevant region.
- Row-level actions: mark void, revert to extracted, jump to review, delete.
- Column header shows validation error count and unreviewed count for that column.

### 6.10 Review modes
Both operate on the same data; the user chooses the layout.

- **Row review** (default): one row at a time, source photo beside it. The active
  cell is highlighted and its region is boxed on the photo. Keyboard: Tab/Enter to
  advance, a key to mark reviewed, a key to mark illegible.
- **Column sweep**: one output column at a time, down all documents. Each value shown
  with its cropped source region beside it, so the eye stays calibrated on one kind of
  handwriting. Deferred past v1 but the data (per-field bounding boxes) is captured
  from v1 so it can be built without re-extraction.

Every cell carries a `isReviewed` flag. A document is `reviewed` when all its cells are.

### 6.11 Export
- CSV, UTF-8 **with BOM** (so Burmese text opens correctly in Excel).
- Respects manual row order.
- Options: include/exclude void rows, include provenance columns
  (`_document`, `_template`, `_photo`, `_model`, `_reviewed`).
- Blank/illegible/N-A states export as configurable tokens (default: empty string
  for blank, `?` for illegible).

## 7. Document content states

The model reports two independent things, so a blank page is never mistaken for a
failure:

| State | Meaning | Treatment |
|---|---|---|
| `HAS_CONTENT` | normal | proceed |
| `EMPTY` | page is blank | 0 rows, **not** a failure |
| `NO_ROWS_FOUND` | page has content but no data rows were found | 0 rows, **flagged for review** |

For FORM templates the analogue of `NO_ROWS_FOUND` is "no fields found", which must
produce a `needs review` flag, never a silent empty row.

## 8. Change management — what breaks what

Every entity has a stable ID; mappings reference IDs. Classify each edit:

**Safe — apply silently.** Rename a field or column, edit meaning, edit note,
reorder, regroup, rename a group.

**Additive — apply, then notify.** New field appears unmapped; new column appears
unfilled. Template stays `Ready` with an "N unmapped fields" hint.

**Destructive — prompt with exact damage.** Deleting a mapped field or column, or an
incompatible data type change. The modal must state: which mappings break, which
columns empty, how many rows and cells are affected, and **how many of those cells
carry human edits**.

**Structural — refuse.** Switching FORM ↔ TABLE. Offer duplicate-as-new instead.

Two supporting rules make destruction survivable:
- Deleting a field **keeps its raw values** as orphaned data (soft delete), so undo is
  real and re-mapping is instant.
- A broken mapping marks only that mapping `BROKEN`. The other mappings keep working.
  The template is `Conflicted` while any mapping is broken.

## 9. Data types

**Output column types:** `TEXT`, `NUMBER`, `INTEGER`, `DATE`, `BOOLEAN`, `ENUM`.

**Field types:** `TEXT`, `NUMBER`, `INTEGER`, `DATE`, `MARK` (checkbox/tick/cross/
circle/tally), `CHOICE` (one of a declared set), `AGE` (the `1 1/2`, `4/12` case),
`FRACTION`.

Field type drives the prompt fragment for that field and the available normalisers.
A field type mismatching its mapped column type is a warning, not an error — the
transform layer attempts coercion and flags the cell if it fails.

## 10. Field modes

| Mode | Meaning |
|---|---|
| `EXTRACT` | The AI reads it. |
| `SKIP` | The AI is explicitly instructed to ignore it. Cell stays blank for manual entry or stays permanently empty. |
| `MANUAL` | Never sent to the AI. The operator types it once per document (not per cell). Intended for names, addresses, and anything the model reliably fails at. |

This matters at 40–50% error rates: the best strategy is usually the AI doing numbers,
dates and marks while humans do names. `SKIP` and `MANUAL` make that explicit.

## 11. Handwritten-table realities (must be modelled, not patched later)

### 11.1 Repetition / inheritance
Ditto marks (`"`, `〃`, `do.`), vertical continuation lines and braces all mean
"same as above". The raw layer stores **the literal token**. A fill-down rule at
transform time resolves it and marks the resulting cell `inherited`. The copy must
never happen invisibly inside the model.

### 11.2 Corrections and voids
Struck-through rows, overwritten digits, values scratched and rewritten above the
line. The model reports `struckThrough` per row and per cell and keeps both readings
when a correction is visible (`valueText` + `altValueText`). Rows carry an
active/void state so voided rows neither vanish silently nor count silently.

### 11.3 Insertions and reading order
Rows squeezed between ruled lines, carets, marginal additions. Capture as-seen order
plus any positional hint; the human repairs with drag-reorder.

### 11.4 Page structure
A ledger shot across several photos yields: repeated headers on later pages, a row
split across the seam, overlapping regions duplicating rows, "carried forward" lines,
and subtotal/total rows. Totals rows are the most dangerous because they look like
data and will corrupt an average.

Handling:
- Explicit page order within the document
- Directive to drop repeated headers
- Per-row `rowType`: `DATA` | `HEADER` | `SUBTOTAL` | `TOTAL` | `NOTE`
- Overlap dedupe using the sequence field

### 11.5 Sequence column
A table template designates one field as the sequence (the numbered first column
most handwritten tables have). A monotonicity check then catches skipped rows,
duplicates from overlapping photos, and rows lost to a fold. This is the cheapest
quality check available — implement it in v1.

### 11.6 Empty vs nothing vs unreadable
Empty cell, `-`, `/`, `x`, `N/A`, and an illegible scrawl are **five different
meanings**. Model them as distinct `valueState`s. The book glossary defines what a
dash means in this dataset.

### 11.7 Marks and tallies
`MARK` field type with configurable symbol semantics (e.g. `✓` → true, `✗` → false,
circled → true, tally strokes → count).

### 11.8 Script and numerals
Burmese digits `၀–၉` collide visually with Latin and punctuation (`၀` vs `0`/`○`,
`၁` vs `I`/`1`). Documents mix numeral systems on one page. Dates may be Buddhist era
(2569 BE) or Myanmar calendar. Fractions carry the `1 1/2` and `4/12` conventions.

**Rule: the model transcribes glyphs as written. Normalisation happens
deterministically in the transform layer**, where it is inspectable and re-runnable.
Numeral system and era are book-level settings.

### 11.9 Geometry
Handwriting drifting across column lines, values landing between columns, fold lines
and staple shadows, carbon-copy bleed-through. Deskew helps; echoing the column
headers in the prompt and requesting row-wise (not position-wise) results helps more.

## 12. Template mismatch detection

A template may declare anchor strings — printed text expected on the page (a title,
a header word). The model reports which anchors it saw. A document scoring below a
threshold is flagged `possible template mismatch` before a human wastes time
reviewing garbage.

## 13. Confidence and double extraction

Self-reported model confidence is cheap but poorly calibrated. Treat it as a **sort
order, not a truth**.

Two better signals:
1. An explicit `ILLEGIBLE` value state with a hard instruction to never guess. An
   honest "can't read this" beats a confident wrong answer.
2. **Double extraction** (per-template toggle): run the same document twice and flag
   every disagreement. Costs 2× tokens but disagreement is genuinely calibrated
   uncertainty. Deferred past v1; the schema supports it from day one
   (`passIndex`, `altValueText`, `disagreement`).

## 14. Transform layer

Pure, deterministic, re-runnable at zero AI cost. Input: raw values + mappings +
book settings. Output: rows and cells.

Pipeline per raw record:
1. Resolve inheritance (ditto fill-down)
2. Drop `HEADER` rows; classify `SUBTOTAL`/`TOTAL`/`NOTE` rows as non-data
3. Dedupe overlapping rows by sequence value
4. Apply per-field normalisers (numeral conversion, era conversion, fraction parsing,
   mark semantics, whitespace)
5. Apply mappings (copy / concat / split / constant / expression)
6. Coerce to column data type; flag failures
7. Run validation rules
8. Merge with existing cells: **never overwrite `isEdited` cells** — store the new
   extracted value and raise `disagreement` instead

Expression language: a small safe subset only — field references, string concat,
`substring`, `replace`, `trim`, arithmetic, `if`. No eval, no network, no loops.
Evaluate with a sandboxed parser (e.g. `jsep` + a hand-written evaluator).

## 15. Photo editing

Non-destructive. The original is immutable in storage; the transform is JSON on the
Photo row and applied at render/extract time.

v1 operations: **crop** (rectangular), **rotate** (90° steps + free angle),
**deskew** (auto-detect angle + manual slider), **reset**.
Full corner-drag perspective correction is deferred.

Handle EXIF orientation on upload. Convert HEIC to JPEG on upload. Generate a
thumbnail and a max-2048px working copy; send the working copy to the model.

## 16. Validation rules

Deterministic, free, and they catch the failure mode confidence scores miss: a
plausible-looking wrong number. Defined per output column at book level, optionally
overridden per template.

Kinds: `REQUIRED`, `TYPE`, `RANGE` (min/max), `LENGTH`, `REGEX`, `ENUM`,
`UNIQUE` (within book), `CROSS_COLUMN` (e.g. dateB ≥ dateA), `MONOTONIC` (sequence).

Severity: `ERROR` or `WARNING`. Neither blocks export; both surface in the UI and in
per-column counts.

## 17. Book glossary

Book-level list of conventions in human language, injected into every prompt for that
book. Examples: "1 1/2 means 1 year 6 months"; "4/12 means 4 months old";
"a dash means not applicable, not zero". This belongs at book level because the
convention applies to every template, not one field.

## 18. Non-goals for v1

Team sharing, concurrent editing, real-time collaboration, mobile capture app,
OCR of printed documents as a distinct path, versioned source-definition library,
book duplication, batches, column sweep, double extraction, vocabulary autocomplete,
edit reasons UI, perspective correction. See `docs/07-deferred.md` — all of these
have schema affordances reserved so they need no migration later.
