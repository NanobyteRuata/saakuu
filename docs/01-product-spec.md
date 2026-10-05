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

**Say the error rate out loud** (decision 61). "Reviewing beats typing" is
counterintuitive at 40–50%, and session one is where a new user decides whether to
believe it. Meeting that number unprepared reads as a broken product; being told it
first reads as an honest one. The Extract dialog states it before anyone's first run,
scoped to the paper — "on handwriting like this" — and never as a claim about the
product's accuracy.

**What "reviewing rather than transcribing" is measured by.** Seconds per reviewed
cell, and it is only measurable if the data records it. Until Phase 12 it did not:
marking a cell reviewed wrote no timestamp and no log row, so the product's stated
measure of success was not computable from its own database. From Phase 12 every cell
records `reviewedAt` and **how** it was reviewed — a per-cell confirm, a row-level
mark, or `I` for unreadable — because a row mark stamps every cell in the row at one
instant and an average that mixes the two is fiction (decisions 56, 57). The readouts
built on it are deliberately later; the collection is not, because data not gathered
at launch cannot be recovered.

The first readout shipped in Phase 19: `Pace` in the Review workspace gives seconds per
reviewed cell for the book, one figure per source. A row mark counts as one event spread over
the cells it stamped, and pauses over five minutes are breaks rather than slow reviews.

**Setup is subject to the same thesis as data.** The machine proposes, the human
disposes — applied to the output columns (`Create columns from this template`,
Phase 10) and later to the field tree itself (post-v1 item 1). Setup was the one place
the product asked an operator to author a schema from nothing, before they had read a
single document (decisions 52, 53).

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
- **Sign-up is by invitation** (Phase 21, decision 79). `SIGNUP_ALLOWED_EMAILS` lists who may create
  an account, by password or by a first Google sign-in, and who may read pages; an address that
  isn't on it is told plainly at either point. Signing in is never gated, so an account taken off
  the list keeps its books and its export. `*` opens it to anyone.
- Password reset via emailed single-use token, 1 hour expiry.
- Sessions: 30-day rolling, database-backed.
- **One AI key, the deployment's** (Phase 21, decision 79). Every reading runs on it, so an
  operator never makes, pastes or hears about a key, which matters because the audience is
  explicitly non-technical. The invitation list above is what bounds its spend; no quota is
  set until pricing is understood (decision 55, docs/09 §8), and the quota is what opening
  sign-up waits on. On this key the app shows pages and time, never money.
- **A personal key, dormant** (Phase 12, decision 54). Where a deployment sets
  `ENCRYPTION_KEY`, a user may save their own Gemini key; it wins over the server's, is stored
  encrypted and is never shown again beyond its last four characters. Only then do the
  dialogs name a key and state a cost.

## 5. Navigation shell

Top bar, persistent once signed in. The shell fills the viewport and **the page itself never
scrolls**; panes scroll internally (docs/05 §0, Phase 13).

- **Left:** `SaaKuu` wordmark, links to the book list.
- **Right:** nav items (v1: `Books`), then a user avatar.
- Avatar click opens a menu: user email, `Sign out`.
- `Sign out` opens a confirmation modal before signing out.

Inside a book the shell is a **workspace frame** rather than a tab strip: four workspaces in
working order — Templates, Documents, Review, Result Table — each carrying a live count, with
Settings as a gear. A workspace is a mode with its own layout, not a view of a record
(decision 67). Below 1280px the app is upload-only (decision 69).

## 6. Screens and behaviour

### 6.1 Books list
- Grid or list of the user's books: name, column count, document count, row count, last updated.
- **Review progress per book** (Phase 17): `312 of 900 cells reviewed` with a bar, and a `Resume review`
  button that opens the Review workspace at the first unreviewed cell — the list answers *which book has
  work left in it?* without opening each one. A finished book says `All reviewed`; a book with nothing
  read yet shows neither.
- **New book from this one** (Phase 17): copies templates, output columns, mappings, glossary and
  validation rules, plus the numeral system, era and export tokens, into a new empty book. Documents,
  photos and rows are never copied. A counted confirmation states what travels before anything is written.
- `Create Book` button.
- Select one or many books → `Delete`. Always a confirmation modal stating counts
  ("Delete 2 books, 47 documents and 1,203 rows?"). Soft delete.

### 6.2 Create Book
One step since Phase 14: a **name**. On save, navigate to the book's Templates workspace.

The model is not asked for — it has a sensible default and is overridden where the choice matters
(per template, and again in the Extract dialog). Columns are not asked for either: step 2 was schema
authoring demanded of an operator about data they had not read yet, and `Create columns from this
template` (§6.5) proposes them from the first template's fields.

### 6.3 Book detail
Tabbed: **Table** | **Templates** | **Documents** | **Settings**.

**Settings** holds: book name (inline editable), default model, numeral system,
date era, the glossary, validation rules, and the edit-output-table action.

**Editing the output table** opens a modal that first shows the blast radius —
which templates' mappings break, which columns will be cleared, how many cells are
affected and how many of those carry human edits — and requires explicit
confirmation. See §8. A column that no template maps is not silently blank for ever:
the report and the confirmation name the templates that could fill it, and the table's
column header carries a `Not filled` chip until one does (Phase 10).

**The book opens where you left it** (Phase 10, decision 60), per user and per book. A
book nobody has opened yet, and which has no templates, opens on Templates — Table is the
tab that stays empty longest for a new user and the slowest to load for a returning one —
while a tab the operator picked themselves always wins over that default. A `Resume review`
button in the header goes straight to the first unreviewed cell, so coming back to a
book does not mean loading every row of a table you are about to leave.

### 6.4 Templates tab
List of templates. Each item shows:
- Name, type (Form/Table), field count
- **Config badge**: `Draft` / `Ready` / `Conflicted`
- **Run badge**: `Never run` / `Running (n/m)` / `Partial` / `Failed` / `Complete`
- Document count (a link to the Documents tab filtered to this template) and total photo count
- Actions (icon-only): `Edit`, `Duplicate`, `Delete`. Uploading and extracting live on the
  Documents tab, not here (Phase 9.1, docs/06)
- `Duplicate` can copy **into another book** the user owns (Phase 17, decision 74). The source layer
  travels — fields, groups, selection settings, notes, anchors, language hint, instructions — and the
  mappings do not, because they name this book's columns. The copy lands as `Draft` and the target
  book's `Create columns from this template` completes it in one click. The dialog counts the fields and
  groups that travel and the mappings that stay.

Expand/collapse reveals that template's documents inline; collapsed shows counts only.
For large templates the inline list caps at 20 with a "view all in Documents" link.

### 6.5 Template editor
Three sections.

**The paper is on screen** (Phase 15). The photo sits beside the field tree the whole time the
template is being authored: two panes at 1280 with the selected item's properties opening under its
row, three at 1600 with properties in their own. This is the screen where the operator types the
most — twenty labels transcribed off a page on the desk — and until Phase 15 it was the only one
with no image on it, while review, which types the least, had one. Properties are **autosaved**
(decision 72): moving to another field saves the one being left, and nothing asks to discard.

The page it is built from is a **specimen**: an ordinary Document carrying `isSpecimen` (decision
71), uploaded through the same intake as everything else. It **belongs to the template** (decision
78): it is shown and managed only in the template workspace, never in Documents. A multi-page form is
one specimen with several pages. `Test on this page` is offered on it once one field is set to
Extract, and reports what that paper actually produced; the reading is headed *Test reading · stays
with this template, not in your table*. See §6.7.

**The AI proposes the fields** (Phase 16, decision 73). `Propose fields` reads the specimen and lists
its fields: for a Form, every labelled place a value goes, in reading order; for a Table, the grid's
column headers, left to right. Labels come back as written, in their own script, with an English
meaning. The operator sees how long it will take before it runs (and, on a personal key, the cost in money and that the key is theirs). What comes back is a
**proposal, not a write**: every field has a toggle, the confirmation states the exact count
("Adds 11 fields … 1 is left out"), and only the ticked fields are created, flat, at the end of the
tree, where they are corrected like any other. Groups and tick groups stay manual.

**a. Source layer**
- Type: Form or Table (chosen at creation; switching later is blocked — offer
  "duplicate as new template" instead).
- Groups: the headers on the paper. Each has a label as written plus an optional English
  meaning, is collapsible, and can nest up to 3 levels (a spanning header over sub-headers).
  Groups and single fields are ordered **together** at every level, so the template follows the
  paper exactly (Phase 3.1).
- A group can declare a **selection** when its columns are tick boxes that together encode one
  answer: `Header only` (default), `One of` (e.g. Sex: M | F) or `Any of`. Per group, configure
  what "nothing ticked" means (normal blank / flag for review / error) and, for `One of`, what
  "several ticked" means (flag for review / error). See §11.7.
- Fields, ordered within their parent. Each field has:
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

**Which fields to add** (guidance shown in the editor, Phase 3.1):
- Every physical column or answer box you add becomes a field. Groups are only the headers above
  them, never a substitute for the columns themselves.
- **Table templates: add every column visible on the paper, in paper order, and set the ones you
  don't need to `Skip`.** Tables are read row by row, matching values to the listed headers. An
  unlisted column between two listed ones gives the model nowhere to put its values, and
  handwriting that drifts across ruled lines lands them in a neighbouring field: a plausible wrong
  value that neither validation nor confidence catches. A listed `Skip` column anchors the column
  boundaries for a few prompt tokens and no output. The numbered `No.` column must be a field to
  be the sequence field.
- **Form templates:** labels sit next to their values, so unrelated fields can be left out. Add
  look-alikes of the fields you want as `Skip` (mother's vs father's name, date of birth vs date
  of vaccination, two phone numbers) so the model can tell them apart.
- `Skip` = on the paper, the AI ignores it, the cell stays empty. `Manual` = on the paper, never
  sent to the AI, typed once per document. Not listed = the model doesn't know it exists.
- This is prompt-design reasoning, not yet measured. Validate it in Phase 5 (docs/07 Part C).

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

**c. Validation & review hints** — per-template overrides of book validation rules. *Post-v1* (docs/06, decision 40).

### 6.6 Documents tab
A virtualised, filterable table of every document in the book.
Filters: template, status, needs-review, has-edits, date range, free text on label.
Columns: label, template, page count, run state, content state, row count,
unreviewed cell count, validation error count, last run, model.
Bulk actions: `Extract`, `Re-extract`, `Move to another template`, `Delete`.

### 6.7 Document editor / uploader
**One intake, four modes** (Phase 15): the batch upload, the specimen a template is built against,
`Try one document`, and replacing or adding a page. They were three components that looked nothing
alike, two of which a first-time operator met within ten minutes, over three different upload
implementations. What differs between them is only what an uploaded file becomes.

**Specimens.** A page uploaded to build a template against is a real Document with `isSpecimen` set
(decision 71) — same upload, same processing, same extraction, same raw layer. It belongs to its
template (decision 78): it is out of the output table, the export, review progress, the template's
document count and `Extract all`, and out of the Documents list, its filters, the run drawer and the
nav count. It is managed only in the template workspace.

Pages cross between a template's specimens and the book's documents **by copy, never by a flag**:
- **Choose an uploaded page** copies a document of this template into a new specimen. The document
  is untouched; the specimen is unread, and Test reads it on its own.
- **Add to documents** copies a specimen into the documents; the template keeps its reference page.
  If the test is current (nothing about the fields or pages changed since), the reading is copied
  too and nothing is read again. Otherwise the copy is queued for extraction, or added unread when
  it can't be read now (no field set to Extract, no AI key). The confirmation says which, with counts,
  and warns when the same specimen was already added before.

Every file is copied, not shared, so a crop, a replace or a deletion on one side never touches the
other.

- Drag-drop or file picker. Accepts JPEG, PNG, HEIC, WebP, PDF (each PDF page
  becomes one photo).
- Uploaded images are grouped into documents. Default grouping: **one document per
  photo**. The user can multi-select photos and `Group into one document`, or split
  a document apart. Page order is drag-reorderable within a document.
- Per photo: edit (crop / rotate / deskew, §15), delete, replace, status badge,
  file size, dimensions.
- Photo grid has small and medium size options.

### 6.8 Extract flow
1. On the Documents tab the user selects documents and presses `Extract`, or — with a template
   filter active and nothing selected — presses `Extract all in <template>` for the whole template.
2. Modal: choose model (pre-filled from template override, else book default),
   shows document count, page count and an estimated time (plus the cost, on a personal key). Warns if any
   selected documents already have human-edited cells.
3. Confirm → one job enqueued per document, with an **idempotency key** so a
   double-click cannot double-charge.
   The dialog also **warns, without blocking, when the template has no mappings yet**
   (Phase 10). Extracting before mapping is the *correct* order — the mapping preview
   needs real values to be worth anything — so the wording teaches that order rather
   than forbidding it. Without the warning a first-time user can pay for four hundred
   documents and land on an empty table.
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
- **Column sweep** (Phase 20): one output column at a time, down all documents. Each value shown
  with its cropped source region beside it, so the eye stays calibrated on one kind of
  handwriting. Built from the per-field bounding boxes captured since v1, with no
  re-extraction. Same keys and the same review record as row review: `Enter` is a per-cell
  confirm and `I` marks unreadable, so progress, resume and Pace can't tell the two apart.

Every cell carries a `isReviewed` flag. A document is `reviewed` when all its cells are.

Review resumes in the document it stopped in (Phase 19): the one holding the most recently
reviewed cell. Reopening a half-reviewed book offers it.

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

Registers often encode one answer as a row of tick columns under a spanning header, sometimes
nested (Phase 3.1):

```
|  Sex  |         RDT Test          |
| M | F |   Positive    |   Neg.    |
|   |   | A | B | C |               |
---------------------------------------
| ✓ |   | ✓ |   |   |               |
|   | ✓ |   |   |   |      ✓        |
```

- Each tick column is a `MARK` field; each header is a group (`RDT Test` › `Positive` › `A`).
- The group that carries the answer is set to `One of` (or `Any of`). `Positive` is a
  `Header only` group inside `RDT Test`.
- The AI still reports each column's tick verbatim. The transform turns the ticked option into a
  value (`Sex = F`, `RDT Test = Positive › A`) and applies the group's rules:
  - nothing ticked → normal blank, review flag or error, as configured (blank often means
    "not tested");
  - several ticked in a `One of` group → review flag or error, as configured; the raw ticks are
    kept and no option is picked;
  - any option `ILLEGIBLE` → always flagged for review, never treated as "nothing ticked".
- A selection group's options are its descendant `MARK` fields in `Extract` or `Manual` mode. It
  can't contain non-mark fields or another selection group.
- The value exported when nothing is ticked (empty, `Not tested`, `0`) and per-option output
  values (M → `1`, F → `2`) are mapping options (Phase 6), because they depend on the output
  table, not the paper. Separate yes/no columns per option remain possible with plain `COPY`
  mappings from each field.

### 11.8 Script and numerals
Burmese digits `၀–၉` collide visually with Latin and punctuation (`၀` vs `0`/`○`,
`၁` vs `I`/`1`). Documents mix numeral systems on one page. Dates may be Buddhist era
(2569 BE) or Myanmar calendar. Fractions carry the `1 1/2` and `4/12` conventions.

**Rule: the model transcribes glyphs as written. Normalisation happens
deterministically in the transform layer**, where it is inspectable and re-runnable.
Numeral system and era are book-level values, but they are never *configured*: they default to
`AUTO` / `GREGORIAN` and are offered on the column whose values did not convert, with the fix in
place (Phase 14, decision 76). They describe the paper, and the evidence that answers the question
only exists once a page has been read.

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

**Editing a page invalidates its last reading, and that must be recorded, not just
warned about** (decision 58). From Phase 11 a document is marked
`Changed since last read` whenever one of its pages is transformed, replaced or added,
and stays marked until it is read again. A one-off warning at save time is forgotten
across four hundred documents; a chip and a `Needs re-extraction` filter are not.

**A page can be re-shot without destroying the document** (decision 59). `Replace page`
puts a new photo at the same page index of the same document: rows, cells, human edits
and reviewed marks all survive, because they hang off the Document and Row, never the
Photo. Before this the only way to fix an unreadable page was deleting the whole
document — throwing away exactly the reviewed work the product exists to protect.

## 16. Validation rules

Deterministic, free, and they catch the failure mode confidence scores miss: a
plausible-looking wrong number. Defined per output column at book level, optionally
overridden per template.

Kinds: `REQUIRED`, `TYPE`, `RANGE` (min/max), `LENGTH`, `REGEX`, `ENUM`,
`UNIQUE` (within book), `CROSS_COLUMN` (e.g. dateB ≥ dateA), `MONOTONIC` (sequence).

*As built (Phase 14):* the editor offers **`REQUIRED`, `RANGE` and `UNIQUE`**, which is what a
data-entry operator uses, and keeps `LENGTH`, `REGEX`, `ENUM`, `CROSS_COLUMN` and `MONOTONIC` behind
**Advanced** — developer features that were sitting at the same altitude. `TYPE` is never offered:
every value is always checked against its column's type. The split is presentation only. Every kind
is still evaluated, still rendered in the saved list, and an existing rule of any kind opens for
editing with Advanced already expanded.

Severity: `ERROR` or `WARNING`. Neither blocks export; both surface in the UI and in
per-column counts.

## 17. Book glossary

Book-level list of conventions in human language, injected into every prompt for that
book. One of the three things Settings still holds (Phase 14); it reaches every prompt and earns its
place. Examples: "1 1/2 means 1 year 6 months"; "4/12 means 4 months old";
"a dash means not applicable, not zero". This belongs at book level because the
convention applies to every template, not one field.

It is *discovered* mid-review, so it can be added from there too (Phase 19): `G`, or
selecting part of a value, offers the value as a term, and the next extraction reads it.

## 18. Non-goals for v1

Team sharing, concurrent editing, real-time collaboration, mobile capture app,
OCR of printed documents as a distinct path, versioned source-definition library,
book duplication, batches, column sweep, double extraction, vocabulary autocomplete,
edit reasons UI, perspective correction. See `docs/07-deferred.md` — all of these
have schema affordances reserved so they need no migration later.
