# 06 — Build Plan

Each phase is independently shippable and has acceptance criteria. Do not start a phase
before the previous one's criteria pass. Phases 0–9.1 built v1; Phases 10–12 make it
survive its first hour and its first strangers, and the launch gate sits after Phase 12.

Phases 3.1, 9.1 and 10–12 were inserted after their predecessors shipped, from looking at
the real thing: 3.1 from modelling real registers, 9.1 from reviewing the book detail
screen, 10–12 from walking a new operator through the product end to end. Reasoning for
10–12 and the decisions behind them: docs/07 Part B, decisions 51–65.

## Testing policy (until launch)

Tests stay minimal until after launch. Acceptance criteria are checked by hand unless listed
here. Only write automated tests for code where a silent bug loses or corrupts data:

- **Unit:** pure logic that decides what gets written: output-column op simulation and
  diff (Phase 2), the transform pipeline golden files (Phase 6), and the rule that re-runs
  never overwrite an edited cell. Auth security tests from Phase 1 stay.
- **E2E:** one happy-path spec per phase at most: smoke (Phase 0), auth (Phase 1), the
  books acceptance flow (Phase 2), and the full stubbed flow in Phase 9.
- No tests for UI copy, schemas, formatting helpers, or CRUD that the E2E path already covers.

---

## Phase 0 — Foundation

- Next.js 15 + TypeScript strict, Tailwind, shadcn/ui
- Postgres via Docker Compose; Redis via Docker Compose; MinIO for object storage
- Prisma with the full schema from `docs/02-data-model.md` (all models, including the
  ones used only by deferred features — no later migration needed)
- `lib/db`, `lib/auth/guards.ts`, error codes, Zod conventions
- BullMQ queue + a worker entrypoint that runs a no-op job end to end
- Vitest + Playwright configured

**Done when:** `docker compose up` gives a running app, a migrated DB, and a worker
that picks up and completes a test job.

---

## Phase 1 — Auth & shell

- Auth.js with Google OAuth and credentials
- Registration, email verification, password reset
- Account linking on verified-email match; blocked when the existing password account
  is unverified
- Top bar, avatar menu, sign-out confirmation modal
- Route protection

**Done when:** a user can register both ways, verify, reset a password, sign in with
Google using the same verified email and land on the same account, and sign out
through the confirmation modal.

---

## Phase 2 — Books & output table schema

- Books CRUD, soft delete, batch delete with counted confirmation
- Create Book two-step flow
- Output column editor: add/update/delete/move as a diff of ops
- Impact preview endpoint + impact modal, with `impactHash` enforced server-side
- Book settings: model, numeral system, date era, export prefs
- Glossary CRUD

**Done when:** creating a book with 5 columns, renaming a column, and deleting a
column all behave correctly, and the delete path shows an accurate impact report
(zero counts at this stage, but wired end to end).

---

## Phase 3 — Templates: source layer

- Template CRUD within a book, FORM/TABLE at creation, switching blocked
- Groups and fields, drag-reorder, soft delete + restore
- Field properties: source label, meaning label, type, mode, note, choices, marks
- Sequence field designation for TABLE
- Anchors, language hint, template instructions
- Config state computed (`DRAFT` until at least one field and one mapping exist)

**Done when:** a 12-field Burmese vaccination-card template can be built, grouped,
reordered, and a field soft-deleted and restored without data loss.

---

## Phase 3.1 — Source layer: paper structure

Inserted after Phase 3 shipped, from modelling real registers. The template must mirror the
paper's header structure exactly: groups and single fields interleaved in paper order, spanning
headers nested over sub-headers, and rows of tick columns that encode one answer. Reasoning and
decisions: docs/01 §6.5 and §11.7, docs/02 invariants 9–12, docs/07 decisions 28–32.

Example it must represent (a TABLE register):

```
| No. | Name | Sex   | Age | RDT Test              | Remarks |
|     |      | M | F |     | Positive     | Neg.   |         |
|     |      |   |   |     | A | B | C    |        |         |
```

```
No.                         field  (INTEGER, sequence)
Name                        field  (TEXT, Manual)
▾ Sex                       group  selection: One of · nothing ticked: Normal blank
    M                       field  (MARK)
    F                       field  (MARK)
Age                         field  (AGE)
▾ RDT Test                  group  selection: One of · nothing ticked: Flag for review
    ▾ Positive              group  selection: Header only
        A                   field  (MARK)
        B                   field  (MARK)
        C                   field  (MARK)
    Neg.                    field  (MARK)
Remarks                     field  (TEXT, Skip)
```

**Schema (first change since Phase 0, additive):**
- `FieldGroup`: `label` renamed to `labelSource`; add `labelMeaning`, `parentGroupId`
  (self-relation, `onDelete: Restrict`), `selection` (`NONE | ONE_OF | ANY_OF`, default `NONE`),
  `noneMarked` (`BLANK | REVIEW | ERROR`, default `REVIEW`), `multipleMarked`
  (`REVIEW | ERROR`, default `ERROR`), `note`; index on `parentGroupId`. See docs/02.
- One-off, idempotent script that re-spaces each template's top-level positions so existing
  templates keep their current visual order (ungrouped fields first, then groups) in the new
  shared order. Run it once after the migration.

**Ordering and nesting:**
- Under one parent (the template root or a group), child groups and fields share one fractional
  position space. A move names its new parent and the sibling it goes after
  (`after: { kind: "field" | "group", id } | null`) and still writes one row, under the template
  row lock.
- Groups nest. `MAX_GROUP_DEPTH = 3` is a code constant, not a schema limit; raising it later
  needs no migration. Refuse moves that exceed it (counting the moved group's own subtree height)
  and moves of a group under itself or a descendant.
- A pure tree helper (`lib/templates/tree.ts`) builds the ordered tree and header paths from the
  flat rows; the editor, the Phase 5 prompt builder and review labels all use it.

**Group configuration:**
- Label on the paper, English meaning, note for the AI.
- Selection: `Header only` / `One of` / `Any of`. A selection group's options are its descendant
  `MARK` fields in `Extract` or `Manual` mode (Skip fields are not options).
- When nothing is ticked: `Normal blank` (e.g. blank means "not tested") / `Flag for review` /
  `Error`. When several are ticked (`One of` only): `Flag for review` / `Error`.
- Refused: a selection group containing a non-`MARK` field or another selection group; changing a
  field under a selection group away from `MARK`; `One of`/`Any of` with fewer than 2 options.
- Stored only in this phase. The prompt uses it in Phase 5; the transform resolves it in Phase 6.

**Deletes and restores:**
- Deleting a group (hard delete, as today) moves its child groups and live fields up one level
  into the group's slot, keeping their order, and re-parents soft-deleted fields to the group's
  parent. Counted confirmation: "2 fields and 1 group move up into RDT Test. No fields are deleted."
- A restored field returns to its group, or to the nearest surviving ancestor, at its old
  position unless a sibling of either kind now holds that key.

**Editor:**
- One tree with mixed order at every level. Drag vertically to reorder; drag right to nest into
  the group above, left to move out a level (dnd-kit's sortable tree pattern with depth
  projection). Keyboard: Space to lift, ↑/↓ move, →/← nest/un-nest, Space to drop.
- Group properties panel (selection settings explain their effect in one line and list the
  options); a `Group` select in field and group properties as the non-drag alternative.
- Quick-add creates the field or group at the end of the chosen parent: one pinned add bar whose
  parent follows the selection, and a `+` on each group for adding fields inline at its end.
  Group rows are bordered with guide lines per nesting level (docs/05).
- Guidance copy in the empty state and Mode help: for Table templates, add every column in paper
  order and set unwanted ones to Skip; for forms, add look-alike fields as Skip (docs/01 §6.5).

**Tests (per the testing policy):** unit tests for group-delete re-parenting (no field lost or
orphaned, order kept) and for depth/cycle refusal. Acceptance is checked by hand.

**Out of scope, recorded for later phases:** rendering header paths and selection hints in the
prompt (Phase 5); resolving selection groups in the transform, and the mapping that turns a
selection group into an output column, including the value exported when nothing is ticked and
per-option output values (Phase 6).

**Done when:**
- The register above can be built as a TABLE template in exactly that paper order, and the order
  and every group setting survive a reload.
- A 4th nesting level, moving a group into its own descendant, and a `One of` group containing a
  non-mark field are each refused with a plain message.
- Nesting and un-nesting work with the keyboard alone.
- Deleting `RDT Test` moves `Positive` and `Neg.` up into its slot, in order, and deletes no
  field; a field soft-deleted from `Positive` before `Positive` itself is deleted restores into
  `Positive`'s parent.
- Templates built in Phase 3 keep their visual order after the re-space script, and the Phase 3
  acceptance flow still passes.

---

## Phase 4 — Documents & photos

- Presigned upload, EXIF orientation, HEIC → JPEG, PDF page split
- Working copy (max 2048px) + thumbnail generation
- Document grouping UI: one-per-photo default, group/split, page reorder
- Documents tab with filters and virtualised list
- Photo editor: crop, rotate, deskew, reset — non-destructive transform JSON
- Document detail drawer with MANUAL field inputs
- Move documents to another template, with impact preview

**Done when:** 30 photos upload, 3 are grouped into one document, a photo is cropped
and deskewed, the transform survives a reload, and the original is untouched in
storage.

---

## Phase 5 — Extraction

- `AIProvider` interface + Gemini implementation
- Per-template response schema generation; Zod validation with one repair retry
- Prompt v1 in `lib/ai/prompts/` covering every rule in `docs/03 §3–§5`
- BullMQ job per document, idempotency key, retries with backoff, rate limiter
- Raw layer persistence (`ExtractionRun`, `RawRecord`, `RawValue`)
- Extract modal with estimate and warnings; status polling; per-photo retry
- Content states (`EMPTY` / `NO_ROWS_FOUND`) and anchor-based mismatch score

**Done when:** a real Burmese form photo produces raw values bound to field IDs, a
blank page yields `EMPTY` with zero rows and no failure, a double-click on Extract
produces exactly one run, and a forced provider error marks the document `FAILED`
with a retryable state.

---

## Phase 6 — Mapping & transform

- Mapping CRUD: COPY, CONCAT, SPLIT, CONSTANT, EXPRESSION
- Expression parser + evaluator (jsep + safe walker), validated at save time
- Transform pipeline: filter → ditto → dedupe → sequence check → normalise → map →
  coerce → validate → merge
- Normalisers: Myanmar numerals, era conversion, AGE, FRACTION, MARK, CHOICE, NFC
- Row/Cell persistence with fractional index positions
- `retransform` endpoint as a queued job
- Mapping preview panel using the latest document's raw values
- Broken-mapping detection → template `CONFLICTED`

**Done when:** the golden-file test suite passes, including: ditto fill-down across a
page boundary, duplicate rows deduped via the sequence field, `1 1/2` → 18 months,
`၇` → 7, a TOTAL row marked void, and a re-run that does not overwrite an edited cell.

---

## Phase 7 — Output table

- Virtualised grid, inline editing, debounced saves, CellEdit log, undo
- All cell states rendered with colour + non-colour cue
- Row drag-reorder via fractional index; column sort as view-only state
- Hover provenance chip → photo viewer at the record's region
- Row actions: review, revert, void, delete
- Column header counts and filters
- Validation rules CRUD + revalidate job

**Done when:** 3,000 rows scroll smoothly, an edit persists and is visually distinct
from extracted values, revert restores the extracted value, reordering 1 row writes
exactly 1 row, and a range rule flags an out-of-range date immediately.

---

## Phase 8 — Review mode & export

- Row review split view with photo region highlighting
- Full keyboard map from `docs/05 §13`
- `isReviewed` per cell, document-level completion, review queue endpoint
- CSV export: streaming, UTF-8 with BOM, void/provenance options, token config
- Export warnings for unreviewed cells and validation errors

**Done when:** a 40-document book can be reviewed end to end using only the keyboard,
progress is accurately reported, and the exported CSV opens in Excel with Burmese
text intact and rows in the manual order.

---

## Phase 9 — Hardening

- Rate limiting on auth and extraction endpoints
- Structured logging with a request/job correlation ID
- Error boundaries and real empty states everywhere (`docs/05 §15`)
- Storage lifecycle: orphan cleanup, grace-period photo deletion
- Backup/restore procedure documented
- Seed script producing a realistic demo book
- Playwright E2E: sign in → create book → template → upload → extract (stubbed) →
  review → export

**Done when:** the E2E test passes in CI without touching Gemini, and a killed worker
mid-job leaves no document stuck in `RUNNING` (stale-run reaper).

---

## Phase 9.1 — Ingestion lives on the Documents tab

Inserted after Phase 9, from reviewing the book detail screen. Upload and Extract existed in two
places: on each template card and on the Documents tab. No schema change; UI and routing only.

**Why:**
- The Templates tab describes the shape of the paper; the Documents tab feeds paper in and watches
  it run. Ingestion buttons on a template card blur the two jobs.
- Feedback belongs where the polling is. Documents polls run state every 2 s and offers per-photo
  retry in the drawer; a template card only refreshes a coarse run badge, so an operator who started
  a long run there saw almost nothing.
- Two `UploadDialog` and two `ExtractDialog` mounts meant every change to estimates, warnings or
  rate-limit copy had to land twice.

**Moved:**
- Template cards lose `Upload documents` and `Extract`. The document count becomes a link to
  `/books/[bookId]/documents?templateId=<id>`. The run badge and its 2 s refresh stay, read-only.

**Added, so template-wide extract is not lost:** `{ templateId }` extraction already existed in the
API, but the template card was its only caller, and the Documents tab could only extract the loaded
page of a cursor-paginated selection. The Documents header now shows `Extract all in <template>`
when the template filter is the only one narrowing the list and nothing is selected — it covers the whole
template, so it must not sit next to a run-state or search filter that shows a smaller set. The label carries no count — the list has
no total — and `ExtractDialog` states the exact document, extractable and blocker counts before the
operator confirms. A template-wide extract does re-read documents that already completed; the
dialog's counts and estimate are what the operator decides on, and edited cells are never
overwritten (Phase 6 rule).

**Also added:** an empty state for "this template has no documents yet", leading with
`Upload documents` — otherwise arriving from a fresh template dead-ends on "No documents match
these filters".

**Docs updated:** docs/01 §6.4 and §6.8, docs/05 §6, §9 and §11.

**Tests (per the testing policy):** no new tests. The Phase 9 E2E is repointed at the Documents tab
and now waits out photo processing before extracting the selection.

**Done when:**
- No template card shows an Upload or Extract button, and its document count opens the Documents
  tab filtered to that template.
- A template with no documents lands on `No documents in <name>` and its `Upload documents` opens
  the uploader with that template already chosen.
- With a template filter active and nothing selected, `Extract all in <name>` covers every document
  of the template, and the run shows live per-document progress in the list.
- Selecting rows hides that button and restores `Extract` / `Re-extract`.
- The Phase 9 E2E passes unchanged in meaning.

---

## Phase 10 — The first hour

Inserted after Phase 9.1, from walking a new operator through the whole product rather than one screen.
v1 works well **once you are set up**. Getting set up is the weakest hour in the product, and one mistake
inside it costs real money. No schema change; UI, copy and service-level checks only, so this phase ships
and reverts on its own.

**What the walkthrough found**, in the order a new user meets it:

1. Create Book demands output columns at step 2, before the user has read a single document. That is
   schema authoring, asked of an operator, about data they have not seen.
2. Creating a book lands on the Table tab — the tab that stays empty longest. Its empty state offers two
   links and no order between them.
3. The Mapping tab's "The book has no output columns" state names Settings but does not link there, and
   cannot add a column in place.
4. The mapping preview — "the single highest-value affordance in the editor" (docs/05 §7) — reads
   `No extracted documents yet` on every first visit. Nothing anywhere teaches the working order:
   fields → upload → **extract one** → map against its real values → extract the rest.
5. Extraction is never warned on a template with no mappings. The Extract dialog warns for `CONFLICTED`
   but not `DRAFT`, and `blockerFor` does not look at mappings at all. A first-time user can extract 400
   documents, pay for every one, and land on an empty table.
6. An output column added later is silently unfilled: it appears in the table, stays blank forever, and
   nothing points at the templates that would need a mapping for it.
7. Returning to a book lands on the Table tab again and loads every row before the operator can reach
   review — the one thing they came back to do.

**Added:**
- **`Create columns from this template`**, in the Mapping tab. For every `Extract`-mode field with no
  mapping, it creates an Output Column (label from `labelMeaning` ?? `labelSource`, key auto-slugged,
  type from the field's data type) and a `COPY` mapping to it. Counted confirmation first
  ("Creates 11 columns and 11 mappings"). A first book is almost always 1:1 field → column, so this
  replaces the hardest part of setup with one click and a round of renaming. It is the cheap half of
  "let the app propose, the human dispose"; the expensive half is post-v1 (AI proposes the template).
- **`Edit output columns` in the Mapping tab** — the existing column editor modal, mounted where the
  operator discovers they need a column, instead of only in Settings.
- **`Try one document`** as a first-class action, from the template editor and the Documents empty state:
  upload or pick one document, extract only it, show the result beside the photo. It is the trust moment
  *and* it fills the mapping preview, so the two problems have one fix.
- **A Draft-template warning in the Extract dialog** — never a blocker, because extracting before mapping
  is the correct order. The wording teaches that order rather than forbidding it:
  *"«Name» has no mappings yet, so no rows will appear until you add them. Extracting one document first
  is the normal way to set one up — the preview needs real values."*
- **The expected error rate, stated before the first extraction** (decision 61), scoped to the paper and
  not to the product: *"On handwriting like this, expect to correct roughly half the cells. Correcting is
  still much faster than typing."* Discovering a 50% error rate unprepared reads as a broken product;
  being told first reads as an honest one, and it is the moment a first-time user decides to stay.
- **An unfilled-column signal**: a column-header chip when no template maps that column, and a line in
  the column editor's impact report after one is added, naming the templates that could fill it.

**Moved:**
- **Mapping gets its own route**, `/books/[bookId]/templates/[templateId]/mapping`; Fields stays at the
  template root. It stops being `useState` in `template-editor.tsx`, so it is deep-linkable, code-split
  and survives the back button. The template editor opts out of the book layout's `max-w-6xl` and the
  book header collapses to one breadcrumb line while inside a template, so the preview gets real width.
  Mapping stays **inside the template**, not a book tab (decision 62).
- **Creating a book lands on Templates**, not Table.

**Landing tab (decision 60).** The book remembers the tab you were last on, per user and per book, in
`localStorage`; a book with no templates always opens on Templates. Storage can be empty or throw
(private windows, cleared site data), so every read is wrapped and the computed default renders on its
own. A **`Resume review`** button appears in the book header whenever unreviewed cells exist, going
straight to the first of them — the returning operator no longer loads the whole table to leave it.
Opening a book never drops the operator into full-screen review by itself.

**Tests (per the testing policy):** none new. The Phase 9 E2E gains the column-creation step in place of
hand-built columns.

**Done when:**
- A new book, a 12-field template and a full set of mapped columns can be reached without ever opening
  Settings, and `Create columns from this template` produces one column and one `COPY` mapping per
  unmapped Extract field after a counted confirmation.
- Extracting with a `DRAFT` template shows the warning, and still proceeds.
- `Try one document` extracts exactly one document and leaves the mapping preview showing its values.
- Mapping is reachable by URL, survives a reload and a back button, and the preview is wider than it is
  on the Fields route.
- A column no template fills is marked as such in the table header.
- Reopening a book returns to the tab last used, and `Resume review` appears exactly when unreviewed
  cells exist.

---

## Phase 11 — Re-shooting a page

Inserted from the same walkthrough. A page that turns out to be unreadable **during review** is a dead
end today, and review is where unreadable pages are found.

**Why:**
- `completeUpload` takes a `templateId` and nothing else (`lib/photos/schemas.ts`, `lib/photos/service.ts`),
  so every upload creates a **new document**. No endpoint adds a page to an existing one.
- `assertNoExtractionOutput` refuses to delete a page of a document that has extraction output
  (`lib/photos/service.ts`), so the bad page cannot be removed either.
- The only remaining path is deleting the whole document and starting over, which throws away its rows,
  its human edits and its review state — exactly the work the product exists to protect.
- Separately, editing a photo's crop already makes the last reading wrong and **nothing records it**. The
  warning is shown once, at save time, and then the document looks identical to a correct one. Across 400
  documents that is silent bad data.

**Schema (additive, no backfill):**
- `Photo.transformedAt DateTime?` — set whenever the transform changes. Null means untouched since upload.
- `Document.contentChangedAt DateTime?` — set when any page of the document is transformed, replaced or
  added. Denormalised on purpose: the Documents list is virtualised and cursor-paginated, and per-row
  "max over photos, compared to the latest run" would be a join per row.
- `Photo.replacedAt DateTime?` + `Photo.deletedAt DateTime?` — a replaced page is soft-deleted, not
  removed, so provenance from existing rows keeps resolving until the document is read again.

**Staleness means "the document changed since it was last read"** (decision 58), not "a crop changed".
A page replaced or added makes the previous reading wrong in exactly the same way a crop does, and a
marker that catches only two thirds of staleness is worse than none, because it would be trusted.
A document is stale when `contentChangedAt` is later than the `finishedAt` of the latest successful run.

**Added:**
- **Replace page.** Upload a new file into an existing `documentId` at an existing `pageIndex`. The old
  photo is soft-deleted and keeps its storage until the grace period; the document is marked changed.
  Rows, cells, edits and review state are untouched, because they hang off Document and Row, never Photo.
  `assertNoExtractionOutput` is relaxed for replace and add.
- **Add page**, for a multi-page form that was photographed incompletely. Same marking.
- **A `Changed since last read` chip** on the Documents list row and in the drawer, a
  **`Needs re-extraction`** filter, and the count carried into the Extract dialog.

Deleting or reordering a page of an already-extracted document stays blocked; those are recorded as an
open question in docs/07 Part C rather than guessed at here.

This composes with what already exists: replace → the document is marked stale → re-extract → the
Phase 6 rule keeps every edited cell. Three pieces, no new merge logic.

**Tests (per the testing policy):** unit test that replacing a page keeps the document's rows, cells and
`isEdited` flags — it is a data-loss path, so it qualifies under the policy.

**Done when:**
- A page of an extracted document can be replaced, and the document's rows, edits and reviewed marks are
  all still there afterwards.
- That document shows `Changed since last read`, the `Needs re-extraction` filter finds it, and
  re-extracting clears the chip without overwriting an edited cell.
- Cropping a page of an extracted document marks it the same way.
- A row's provenance chip still opens a photo between the replace and the re-extraction.

---

## Phase 12 — Before strangers

Launch exposes two things that are unbounded today: the AI bill and the database. Neither is visible to
anyone, including the operator.

**Why:**
- `ExtractionRun.inputTokens` / `outputTokens` have been recorded since Phase 5 and are **surfaced
  nowhere**. There is no quota, no per-user cap and no cost readout. One server API key means every
  user's extraction lands on the owner's bill.
- `ExtractionRun.rawResponse` stores the full model response for every run, for ever. The Phase 9
  storage lifecycle covers photo objects, not this JSON, so it grows in Postgres without limit.
- Marking a cell reviewed writes **no timestamp and no log row** — `CellEditKind` is `EDIT | REVERT | UNDO`
  and `Cell.updatedAt` is bumped by anything. The product's stated measure of success, seconds per
  reviewed cell (docs/01 §1), is therefore not computable from the data it stores.

**Schema (additive):**
- `User.aiApiKeyCipher String?`, `User.aiApiKeyHint String?` — a user's own Gemini key, encrypted at rest,
  plus the last four characters for display. New `lib/crypto` with an `ENCRYPTION_KEY` env var.
- `Cell.reviewedAt DateTime?` and `Cell.reviewedVia ReviewSource?` (`CELL | ROW | ILLEGIBLE`).

**Added:**
- **Both key sources (decision 54).** A user can paste their own Gemini key; the server key remains as the
  fallback for people the owner invites directly. `providerStatus()` becomes per-user, and the Extract
  dialog says which key a run will use. BYO removes the owner's cost exposure for self-serve signups;
  the server key keeps friction at zero for invited users, which matters because the audience is
  explicitly non-technical and Phase 10 exists to remove exactly this kind of friction.
- **Cost in the Extract dialog, in money rather than tokens.** Tokens mean nothing to an operator.
  Per-book and per-user totals come from the token columns already recorded.
- **`rawResponse` retention (decision 63):** kept for ever on `FAILED` runs, which is when it is wanted;
  stripped from successful runs older than 30 days by the existing daily `storage.cleanup` job.
- **A review timestamp, collected from launch (decision 56).** `reviewedAt` is written whenever a cell
  becomes reviewed, together with **how** it happened (decision 57): a per-cell confirm, a row-level
  `⌘Enter`, or `I` for illegible. Without the source a single row-mark stamps N cells at one instant and
  every later "seconds per cell" figure is fiction. **Readouts are deferred** — this phase only collects,
  because data not collected at launch cannot be recovered afterwards.

**Not built: quota.** Recorded in docs/09 §8 with the condition that triggers building it — hosted
extraction becoming a real cost line, and per-document pricing being known well enough to set a number.
Guessing a limit before either is true prices the product blind.

**Tests (per the testing policy):** unit test that an encrypted key round-trips and is never logged. No
others.

**Done when:**
- A user can save their own key, see its last four characters, and extract with it; removing it falls
  back to the server key where one is configured, and the dialog says which is in use.
- The Extract dialog states an estimated cost in money.
- A failed run keeps its `rawResponse`; a successful run older than 30 days has lost it and nothing else.
- Reviewing a cell by keystroke, by row and by `I` each writes a timestamp and the right source.

---

## Launch gate

Launch after **Phase 12**. Earlier is possible and deliberate:

- **After Phase 10** you can invite people you already know, on the server key, and watch the bill by hand.
- **Phase 11 and 12 are what make strangers safe** — data that cannot be silently wrong, and a bill that
  cannot silently grow.

Do not start post-v1 before launching. The post-v1 order below is a guess made before anyone used the
product, and launching is the only thing that replaces the guess with evidence (decision 64).

## Post-v1

**This order is provisional** (decision 64). It was written before anyone used the product,
and the ranking of the first three items in particular is a guess about where an operator's
time actually goes. Re-rank it from real usage after launch rather than building down it.

1. **AI proposes the template** — upload one photo, the model returns the field list, it
   lands in the existing tree editor, the human corrects it. The product's own thesis
   ("the AI does the first pass, the human reviews") applied to setup, which is otherwise
   the one place the user must author from nothing. The provider interface, the versioned
   prompts and the tree editor all already exist; the output is just a tree. Propose flat
   fields first — groups and selection groups (Phase 3.1 structure) are much harder to
   infer and stay manual. Phase 10's `Create columns from this template` is the cheap half
   of the same idea and ships before launch.
2. **Vocabulary autocomplete** — per-column value vocabulary built from existing
   entries, offered on edit, with near-miss typo flagging and optional controlled
   vocabulary. Biggest remaining win on typing cost.
3. **Column sweep review** — one column down all documents with cropped source regions
   side by side. Needs no new extraction; the bboxes are already stored.
4. **Batches** — upload sessions with metadata, feeding CONSTANT mappings and giving
   filter/retry granularity.
5. **Double extraction** — per-template toggle, two passes, disagreement flags.
6. **Book duplication** — structure only / + documents / full copy.
7. **Source-definition library with versioning** — portable source layers, books pin a
   version, opt-in updates with a diff.
8. **Edit reasons UI** — the column already exists.
9. **Team sharing** — ownership model change, roles, then concurrent editing. **Move this up**
   if the first paying conversations need seats (decision 65): operators do the work, but a
   clinic, NGO or research manager is who buys.
10. **Perspective correction** — corner-drag four-point transform.
11. **Template rule overrides** — a nullable `ValidationRule.templateId` and the template editor's Validation tab,
    overriding book rules for documents read with that template (docs/01 §16, decision 40). Build when a real
    form needs a rule the book-level one gets wrong.

---

## Risks to watch

- **Gemini free-tier limits** will throttle real batches. Make concurrency and RPM
  single env vars and surface `RATE_LIMITED` clearly rather than as a generic failure.
- **Prompt drift.** Any prompt change invalidates comparisons between runs. Always bump
  `promptVersion` and never edit an existing version in place.
- **Table extraction is much harder than form extraction.** If time is short, ship FORM
  first and TABLE in a follow-up — the schema supports both from day one.
- **The transform layer is the product's spine.** Keep it pure and heavily tested; if
  it is correct, mapping mistakes cost zero AI spend to fix.
- **The first hour is where users are lost, not the tenth.** Review — the part that works
  best — is only reached by surviving setup. Any future work that speeds up review while
  setup is still confusing is optimising a stage people never get to (decision 64).
- **Extraction is the only thing that costs money per use**, and nothing capped or displayed
  it before Phase 12. Watch the per-user spend query in docs/09 §8 from the first week; build
  the quota when the number is real rather than guessed (decision 55).
- **Trust is spent in session one.** At a 40–50% raw error rate, a user who meets the errors
  before they meet the explanation concludes the product is broken and leaves. `Try one
  document` and the stated error rate exist for that minute (decision 61).
