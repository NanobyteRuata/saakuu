# 06 — Build Plan

Ten phases. Each is independently shippable and has acceptance criteria. Do not start
a phase before the previous one's criteria pass. Phases 0–9 are v1.

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
