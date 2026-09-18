# 06 — Build Plan

Ten phases. Each is independently shippable and has acceptance criteria. Do not start
a phase before the previous one's criteria pass. Phases 0–9 are v1. Phase 3.1 is an
inserted revision of the source layer and must pass before Phase 4.

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

## Post-v1, in the order I would build them

1. **Vocabulary autocomplete** — per-column value vocabulary built from existing
   entries, offered on edit, with near-miss typo flagging and optional controlled
   vocabulary. Biggest remaining win on typing cost.
2. **Column sweep review** — one column down all documents with cropped source regions
   side by side. Needs no new extraction; the bboxes are already stored.
3. **Batches** — upload sessions with metadata, feeding CONSTANT mappings and giving
   filter/retry granularity.
4. **Double extraction** — per-template toggle, two passes, disagreement flags.
5. **Book duplication** — structure only / + documents / full copy.
6. **Source-definition library with versioning** — portable source layers, books pin a
   version, opt-in updates with a diff.
7. **Edit reasons UI** — the column already exists.
8. **Team sharing** — ownership model change, roles, then concurrent editing.
9. **Perspective correction** — corner-drag four-point transform.
10. **Template rule overrides** — a nullable `ValidationRule.templateId` and the template editor's Validation tab,
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
