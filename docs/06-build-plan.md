# 06 — Build Plan

Phases 0–17 are **shipped**; the launch gate after Phase 12 has passed. They are kept below in one
line each, because 63 code comments, 167 lines across docs/01–09 and 91 `decision N` references
point at them by number. **Phases are never renumbered** (decision 66); new work continues at
Phase 18.

Phases 13–20 came from walking the whole product as a first-time operator and then as a returning one
(see the analysis behind decisions 66–77). v1's parts each work; what it lacks is a **spine** — nothing
on screen carries the working order, and the operator holds it in their head. Phase 13 built that
spine and the phases after it fill it.

Each phase is independently shippable and has acceptance criteria. Do not start a phase before the
previous one's criteria pass.

---

## Shipped — Phases 0–17

| Phase | What shipped |
|---|---|
| **0** | Foundation: Next.js 15 + TS strict, Postgres/Redis/MinIO via Compose, full Prisma schema, BullMQ worker, Vitest + Playwright. |
| **1** | Auth & shell: Auth.js with Google + credentials, verification, reset, account linking, route protection. |
| **2** | Books & output table schema: books CRUD, output-column editor as a diff of ops, impact preview with `impactHash`, glossary. |
| **3** | Templates, source layer: FORM/TABLE templates, groups and fields, drag-reorder, soft delete + restore, anchors, config state. |
| **3.1** | Paper structure: nested groups, selection groups (`One of` / `Any of`), one shared order per parent, `lib/templates/tree.ts`. |
| **4** | Documents & photos: presigned upload, HEIC/PDF handling, working copies, grouping, photo editor as non-destructive transform JSON. |
| **5** | Extraction: `AIProvider` + Gemini, per-template response schema, versioned prompts, BullMQ job per document, raw layer. |
| **6** | Mapping & transform: mapping CRUD, expression evaluator, the transform pipeline, normalisers, row/cell persistence, `retransform`. |
| **7** | Output table: virtualised grid, inline editing, cell states, row reorder, provenance chips, validation rules. |
| **8** | Review mode & export: row review split view, full keyboard map, `isReviewed`, streaming CSV export with BOM. |
| **9** | Hardening: rate limiting, structured logging, storage lifecycle, stale-run reaper, seed script, the stubbed E2E flow. |
| **9.1** | Ingestion moved to the Documents tab: template cards lost Upload/Extract, `Extract all in <template>` added. |
| **10** | The first hour: `Create columns from this template`, `Try one document`, Draft-template warning, stated error rate, Mapping on its own route. |
| **11** | Re-shooting a page: replace page, add page, `Changed since last read`, `Needs re-extraction`, staleness as `contentChangedAt` vs `lastExtractedAt`. |
| **12** | Before strangers: per-user Gemini keys encrypted at rest, cost in money in the Extract dialog, `rawResponse` retention, `reviewedAt` + `reviewedVia`. |
| **13** | The shell: four workspaces with live counts replacing the four tabs, Settings as a gear, a resizable `Pane` primitive, no page scroll and no viewport arithmetic, upload-only below 1280px. |
| **14** | Cutting what nobody needs: `Book.confidenceThreshold` dropped, Settings down to glossary + rules + danger zone, the column editor moved to the Result Table, export tokens owned by the export dialog, era and numerals asked by exception, three rule kinds offered, Create Book one step. |
| **15** | The paper on screen: `Document.isSpecimen`, the template workspace paned with the photo beside the tree, autosave instead of save-and-discard, one photo intake in four modes, `Try one document` moved to the front as `Read this page`. |
| **16** | The AI proposes the template: `Propose fields` reads a specimen into a flat field list, priced in money with the key named first, confirmed with per-field toggles and a count; `FieldProposal` records `template-v1`. |
| **17** | The second book: `Duplicate` copies a template into another book (source layer, never mappings), `New book from this one` copies a book's whole setup and none of its work, and the books list shows review progress with its own `Resume review`. |

Detailed acceptance criteria for phases 0–12 are in git history (`docs/06-build-plan.md` before
Phase 13) and their reasoning is in docs/07 Part B, decisions 1–65. Phase 13's to 17's are
below; their reasoning is decisions 66–74 and 76–77.

---

## Testing policy (unchanged)

Tests stay minimal. Acceptance criteria are checked by hand unless listed here. Only write automated
tests for code where a silent bug loses or corrupts data:

- **Unit:** pure logic that decides what gets written — output-column op simulation and diff (Phase 2),
  the transform pipeline golden files (Phase 6), the rule that re-runs never overwrite an edited cell,
  page replacement keeping rows and edits (Phase 11), key encryption round-trip (Phase 12). Auth
  security tests from Phase 1 stay.
- **E2E:** one happy-path spec per phase at most.
- No tests for UI copy, schemas, formatting helpers, or CRUD that the E2E path already covers.

The E2E flow is repointed as the shell changes, but its meaning stays: sign in → create book →
template → upload → extract (stubbed) → review → export.

---

## What Phases 13–20 are fixing

Stated once here so each phase does not restate it.

1. **Flat tabs carry no order and no state.** Four peer tabs, with Table — the tab that is empty
   longest and slowest to load — first. The working order (fields → upload → extract one → map →
   extract the rest → review → export) exists only in this document.
2. **Six differently-worded empty states** each teach a fragment of that order, and one still points
   at Settings for a column editor that Phase 10 moved.
3. **The template editor never shows the paper.** The screen where the operator types the most —
   twenty Burmese labels transcribed from a page on the desk — has no image on it, while the review
   screen, which types the least, does. This contradicts the product's own measure (docs/01 §1).
4. **`Try one document` is gated behind having already authored the template**, so the trust moment
   arrives after the hardest unaided task rather than before it.
5. **Settings asks an operator to configure things they have not seen**, including a confidence
   percentage over an unreliable signal, and duplicates two controls that already exist where they
   are used.
6. **Nothing is reusable across books.** `duplicateTemplate` resolves the target book from the source
   template, so the second book — the one a quarterly register actually needs — is a full re-authoring.
7. **The books list cannot answer "which book has work left in it?"**, though `hasUnreviewedCells` is
   already computed for the book header.

---

## Phase 13 — The shell ✅ shipped

**As built.** The frame, the four workspaces and the counts landed as written. Two notes for the
phases that build on this:

- Only **Review** is a two-pane workspace so far, at 1280 and at 1600 alike — `docs/05 §0` allows
  "two with more density" at the wider target, and Review has no third pane until Phase 19. The
  other three workspaces are single panes inside the frame, exactly as the risk note below
  requires: internals moved in unchanged and are redone in Phases 15, 18 and 19.
- The `max-w-[1800px]` cap survives, but **inside the template workspace's own scroll container**
  rather than on the shell. It is content width, not shell width: the field tree and the properties
  form stop being readable side by side much past it. Phase 15 replaces it with real panes.

The spine. A **workspace** is a mode with its own layout, not a view of a record (decision 67) — the
same reason a video editor has pages rather than tabs. Screen internals move inside the new frame
unchanged, so this phase ships and reverts on its own.

**No schema change.**

**The frame:**
- The app shell fills the viewport. **The page itself never scrolls; panes scroll internally.** Review
  already does this (`row-review.tsx`); the table fakes it with `h-[calc(100vh-19rem)]`, a magic number
  that breaks whenever the header changes; the book shell is `max-w-6xl` while the template editor opts
  out to `max-w-[1800px]`. Three approaches to one problem. All three go.
- A `Pane` primitive: resizable by drag, collapsible, with sizes remembered per workspace per user in
  `localStorage`. Storage can be empty or throw, so every read is wrapped and the computed default
  renders on its own — the same rule as the Phase 10 landing tab.
- **Panes are layout; routes are navigation** (decision 68). A pane's size and collapsed state never
  enter the URL. Deep links and the back button keep working, which is why Phase 10 moved Mapping to a
  route in the first place.

**The four workspaces**, in working order, replacing the four tabs:

```
Templates    Documents 60    Review 412 left    Result Table 900 rows    ⚙
```

- Settings becomes a **gear**, not a peer (decision 68). Phase 14 is what makes it small enough.
- **The counts are the spine.** They turn a flat bar into a sequence at almost no cost: an operator who
  sees `Review 412 left` does not need to be told where to go next. One aggregate endpoint serves all
  of them; it is polled only while a run is active, and otherwise refreshed on navigation.
- Mapping stays inside the template (decision 62, unchanged). Extraction stays on Documents (Phase 9.1,
  unchanged) — Phase 18 gives it a drawer, not a workspace.
- The Phase 10 landing memory stays, and now remembers a workspace. A book with no templates still
  always opens on Templates.

**Layout targets (decision 69).** Not responsive in the fluid sense — three targeted layouts, because
breakpoint-switched layouts are far cheaper than fluid ones and honest about what each device can do:

| Width | Layout |
|---|---|
| `< 1280px` | **Upload only.** One screen: choose a template, shoot or pick photos. Everything else says, in plain language, that reviewing needs a wider screen. Standing at the filing cabinet with a phone is a real use; reviewing handwriting on one is not. |
| `1280–1599px` | Two panes. |
| `≥ 1600px` | Three panes, or two with more density. |

**The rule that decides every layout: the pane holding the photo never shrinks below readable.**
Burmese handwriting at 400px is guesswork. Everything else yields to it. For the same reason the app
stays **light-first** (decision 70) — a video editor is dark to stop a bright surround biasing colour
judgement; here the job is reading pencil on white paper, and contrast is the whole task.

**Docs to update:** docs/01 §5, docs/05 §4 and a new §0 for the pane and layout rules.

**Tests:** none new. The Phase 9 E2E is repointed at the workspace nav.

**Done when (all met):**
- No workspace scrolls the page; every scroll happens inside a pane, and no layout uses a hard-coded
  viewport calculation.
- Panes resize by drag, collapse, and come back the same size after a reload, in a private window too.
- The nav shows live counts, and they are correct after an extraction finishes without a manual refresh.
- At 1279px the app shows the upload-only screen; at 1280px the two-pane workspaces render with no
  horizontal page scroll.
- Settings is reachable only from the gear, and every route that worked before still works by URL.

---

## Phase 14 — Cutting what nobody needs ✅ shipped

Pure subtraction, no dependencies, the cheapest win in the plan. **Every setting is a question asked of
the operator instead of answered for them** — the opposite of the product's own thesis that the machine
does the first pass. Each one has to beat "pick a good default and let them fix it where it is wrong."

**Schema (one destructive drop; safe, nothing is launched):**
- `Book.confidenceThreshold` — **dropped** (decision 77). It asked a non-technical operator for a
  percentage controlling a dotted underline, over the model's *self-reported* confidence — the prompt
  literally asks for "your own estimate from 0 to 1", and the settings help text already conceded it is
  "only a hint". A tuning knob with no feedback loop over an uncalibrated signal. It becomes a constant
  in `lib/table/cellState.ts`; nobody will notice.
- `Book.defaultModel`, `numeralSystem`, `dateEra`, `blankToken`, `illegibleToken` — **columns kept**,
  settings UI removed. They are still read by the prompt, the transform and the export.

**Deleted from the UI:**
- **Export preferences.** A pure duplicate: `blankToken` and `illegibleToken` are already editable in
  the export dialog at the moment of export. Two places to set one thing, and Settings is the one you
  forget you touched. The dialog now **writes its choice back to the book**, so the preference is set
  where it is used and remembered — one control, no hidden state.
- **Confidence threshold.** As above.
- **Book name.** Already edited inline in the header.
- **Default AI model.** Chosen in the create wizard, overridden per template, overridden again in the
  Extract dialog: three places to pick something operators do not pick. The column keeps a constant
  default; the template override and the per-extraction override stay, which is where it is actually
  useful.
- **The Output table section.** A read-only table plus the shared `EditColumnsDialog` — a third
  rendering of column state, and the one Phase 10 superseded. The dialog itself is one component and
  stays mounted where the operator meets the need: in Mapping, and now also on the Result Table header.

**Asked by exception instead of configured (decision 76):**
- **Numeral system and date era** are real — they reach the prompt and the transform, and changing them
  rebuilds rows. But an operator does not know what "Myanmar era" does to their data, and these describe
  *the paper*, not the book. They default to `AUTO` / `GREGORIAN` and are surfaced at the point of
  failure instead: when dates or numbers in a column fail to parse, the flag on that column offers
  *"Dates in this column aren't parsing. Is this paper using the Myanmar era?"* with the fix in place.

**Reduced:**
- **Validation rules: three offered, six behind Advanced.** `REQUIRED`, `RANGE` and `UNIQUE` are what a
  data-entry operator uses; `LENGTH`, `REGEX`, `ENUM`, `CROSS_COLUMN` and `MONOTONIC` are developer
  features sitting at the same altitude. `RULE_KINDS` is untouched, so existing rules keep working and
  keep rendering.
- **Create Book becomes one step.** Name, then Templates. Step 2 was schema authoring asked of an
  operator about data they had not seen; Phase 10 softened its copy to "you can leave this empty" and
  left the primary button reading `Create book without columns` — a button named after an absence.
  Columns come from the template, where the app already proposes them.

**Kept, unchanged:** the glossary (it reaches every prompt and earns its place) and the danger zone.
Phase 19 gives the glossary the entry point it actually needs.

**Docs to update:** docs/01 §16 and §17, docs/05 §3 and §5.

**Tests:** none new.

**Done when:**
- Settings is the glossary, validation rules and the danger zone, and nothing else.
- Changing the blank token in the export dialog is still there at the next export of that book.
- A column whose dates fail to parse offers the era question inline, and accepting it rebuilds the rows.
- The rules editor offers three kinds; an existing `REGEX` rule still shows and still edits under Advanced.
- Creating a book takes one step and lands on Templates.

**As built.** The subtraction landed as written. Four notes for the phases after it:

- **The column editor had to become reachable from the empty table, not just the toolbar.** Both of
  the Result Table's empty states return before the toolbar renders, and a book with no columns is
  exactly when the editor is needed. It is now mounted in all three states. The `This book has no
  columns yet` state also stopped pointing at Settings for an editor that is no longer there — it
  was the sixth of the six empty states named at the top of this document.
- **Parse failures are detected structurally, not by matching an error message.** `coerceToColumn`
  keeps the raw text when a value will not convert, so a flagged cell still holding text its column's
  type would not accept *is* a parse failure (`isUnparsed`, `lib/table/view.ts`). Rewording a
  coercion error can therefore never silently turn a column's era offer off. **Edited cells are
  excluded**: the offer asks a question about the paper, and one operator mistyping a date is not
  evidence about the paper.
- **Accepting the offer waits on the rebuild's own signal.** The setting change enqueues one
  transform job per template before the PATCH answers, so the table polls each template's existing
  `GET /api/templates/:id/retransform` until every one is `idle`, then refreshes once and reports
  what actually happened — how many values now parse, or that the rebuild finished and these values
  are still wrong, which is the likeliest outcome of a wrong guess. Waiting on the unparsed count
  instead would have reported that second case as "still rebuilding" for the full budget. Bounded at
  20 tries, one watch at a time. Phase 18's run drawer is where a real progress surface belongs.
- **Five kinds went behind Advanced, not six.** The sixth is `TYPE`, which has never been offered:
  every value is always checked against its column's type. `OFFERED_RULE_KINDS` is now derived from
  `BASIC_RULE_KINDS ++ ADVANCED_RULE_KINDS` so the two cannot drift.

Two things the phase touched that were not in its own list: the Buddhist-era warning in
`lib/transform/normalise.ts` told the operator to "change its date era in Settings", which no longer
exists, and `createBookSchema` now takes `defaultModel` and `columns` as optional so the one-step
wizard can send a name alone while the seed script and API keep working.

---

## Phase 15 — The paper on screen ✅ shipped

The biggest fix in the plan. Today an operator authors a description of a document they are holding,
into a tree-and-properties screen with no image on it, and only afterwards may read a page to see
whether any of it was right.

**Schema (additive):**
- `Document.isSpecimen Boolean @default(false)` — a page uploaded to build a template against.
  A specimen is a **real Document** (decision 71), not a separate object: same upload, same processing,
  same extraction, same raw layer. It is excluded from the output table, from export and from the
  template's document count, and it is the natural target of `Try one document`. Clearing the flag
  promotes it to an ordinary document in one click, because the page an operator reached for to build
  the template is usually a real page with real data on it.

A separate "sample, never extracted" object was rejected: it makes the operator upload the same page
twice for reasons they cannot be told, and it would have been a **fourth** photo-intake UI.

**The workspace:**
- Two panes at 1280: **the photo, large and zoomable, beside the field tree.** Three at 1600+, the
  third being properties; below that, properties expand **inline under the selected row**. Config was
  not given a permanent narrow third column: it is the densest form in the app (source label, meaning,
  type, mode, note, choices, marks), and a permanent third pane both starves it and puts the photo and
  the config at opposite edges of the screen — the worst possible pairing for transcribing.
- Photo and fields side by side is also what the review screen already does, which is the screen that
  works best.
- The photo pane carries the existing crop/rotate/deskew editor. Its transform is per-photo and
  non-destructive, exactly as today.

**Autosave replaces save-and-discard (decision 72).** The properties pane is dirty-tracked, so switching
fields while dirty raises `Discard unsaved changes?` — a modal an operator meets once per field while
building a twenty-field template, because quick-add only sets label and type. A template is owned by one
user with no concurrent editing, so the modal protects against nothing. Fields save on blur, with the
existing toast-plus-undo for anything destructive.

**One photo intake.** `Try one document`, the batch `UploadDialog`, the specimen upload and replace/add
page become one component in four modes. Three of them exist today and look nothing alike, and a
first-time operator meets two within ten minutes.

**`Try one document` moves to the front.** It no longer requires fields to exist: with a specimen on
screen and no fields yet, it is the first thing offered. The stated error-rate line stays, but once a
reading exists it is joined by **that page's actual result** — values read, illegible, blank. A real
number from the operator's own paper is what the line is for.

**Docs to update:** docs/01 §6.5, docs/05 §7, §9 and §10.

**Tests:** none new. The Phase 9 E2E uploads its first page as a specimen.

**Done when:**
- A template can be built with the page visible beside the tree the whole time, at 1280 and at 1600.
- Editing a field's properties and clicking another field saves the first and raises no modal.
- A specimen document does not appear in the output table, the export or the template's document count,
  and clearing its flag makes it appear in all three without re-extraction.
- All four photo-intake entry points render the same component.
- `Try one document` is offered on a template with zero fields, and its result reports what that page
  actually produced.

**As built.** All five landed as written. Notes for the phases after it:

- **The specimen rule needed a home before it could be applied.** "Live rows of live documents" was
  spelled out independently in five raw queries and two Prisma ones, so adding a sixth condition to
  each was the wrong shape. They now share `lib/db/scope.ts` (`COUNTING_DOC_SQL`,
  `countingRowWhere`), and the rule is stated once: a specimen is out of the numbers that mean
  *work to do* and in the numbers that mean *files I have*. The template card gained a separate
  `1 specimen` so its document count stays the number of pages with work left in them, and its
  document-count link stays truthful.
- **Promotion revalidates the book.** Rows enter duplicate detection at that moment, and `UNIQUE` is
  the one rule that reads across rows, so a value that was unique while the specimen was out of
  scope may not be once it is in. Nothing is rebuilt — the rows already exist — so it is a re-check,
  not a re-extraction.
- **A remembered pane layout could take the workspace down.** Two panes and three are different
  shapes, and `useLayoutTarget` only knows which one it is *after* hydration, so a stored three-pane
  layout was being applied to a group that still had two panes: `Invalid 2 panel layout`, caught by
  the workspace error boundary, on every reload after a drag. The splits are now keyed per shape
  (`template-2`, `template-3`), and `PaneGroup` throws a layout it cannot apply away rather than
  throwing — the same rule the storage reads already followed. Any workspace that changes its pane
  count by breakpoint needs both halves of this.
- **Autosave has two triggers and must make one request.** Clicking another field blurs the form
  *and* asks the parent to flush it, which produced two identical PATCHes a tick apart; a field save
  recomputes mapping states and can queue a rebuild, so the second is not free. They coalesce on one
  in-flight promise. The other thing autosave adds is a save in the air during a document unload,
  which now asks first — client-side navigation is safe, because the request outlives the unmount.
- **Template settings had to become a disclosure.** They were a header, which is survivable while a
  page scrolls and fatal once it does not: language, model, anchors, instructions and double
  extraction are six hundred pixels of form touched once per template, and leaving them open gave
  the panes 235px of a 900px viewport — the photo unreadable, the reading pane at zero height and
  its values overflowing off-screen. Collapsed, the line still carries the name and both badges.
  The general rule for the phases still to come: **inside the frame, anything permanently on screen
  is spending the photo's pixels**, and has to earn them at the rate it is actually used.
- **Finishing is not the same as leaving.** The shared dialog had one close path, guarded by
  "are uploads still running?", and both ways of finishing went through it. That guard reads a count
  the intake reports one render late, so a single-file mode asked *"Stop uploading? 1 file hasn't
  finished"* about the upload that had just succeeded, and the batch dialog's `Done` — routed around
  the guard to avoid that — stopped running `onClosed`, so the documents list no longer reloaded
  after an upload. They are two paths now: leaving by the X or Escape asks, finishing does not.
  Phase 18 rebuilds this screen and should keep the distinction.
- **Properties render outside the sortable list** when they open under their row. Inside it, the
  drag projection counted the panel as another item to reorder.
- **`Read this page` needs no gate of its own.** The estimate call costs nothing and the server
  already refuses a template with no fields set to Extract, in words an operator can act on, so the
  button is offered from the first specimen and the refusal is shown in place. Nothing is hidden and
  nothing is spent.
- **The E2E's batch upload became the specimen upload**, as this phase's line asked. The batch
  dialog is no longer exercised end to end by name, but it renders the same `PhotoIntake` over the
  same upload hook that the specimen path covers. Phase 18 rebuilds that screen and should take the
  coverage back.

---

## Phase 16 — The AI proposes the template ✅ shipped

The product's own thesis — the machine does the first pass, the human reviews — applied to the one place
the operator still authors from nothing. The provider interface, the versioned prompts and the tree
editor all exist; the output is a tree.

**No schema change** beyond recording the prompt version on the proposal, as every run already does.

**Added:**
- `AIProvider.proposeFields(...)`, with `lib/ai/prompts/template-v1.ts`. Versioned under the same rule
  as every other prompt: never edited in place.
- The template kind (FORM / TABLE) is required first — it changes the shape of what is asked for.
- **Flat fields only** (decision 73). Groups, nested headers and selection groups (the Phase 3.1
  structure) are much harder to infer, and a wrong group is more expensive to undo than a missing one.
  They stay manual.
- The result is a **proposal, not a write**: a list with per-field include toggles and a counted
  confirmation, the same shape as `Create columns from this template`. Accepting creates the fields in
  the tree, where the human corrects them.
- It costs money, so it gets the same treatment as extraction: an estimate in money before it runs, and
  it says which key it will spend.

**Docs updated:** docs/01 §6.5, docs/03 §1 and a new §12, docs/04 → Field proposals, docs/05 §7,
docs/07 decision 73 (and 53 and Part A marked superseded), docs/09 §8.

**Tests:** none new under the unit policy (nothing here can lose data: the only write is a confirmed
create). One E2E, `e2e/propose-fields.spec.ts`: propose on a form, untick one, confirm `Adds 11 fields`,
eleven in paper order, then the same page as a table proposes its columns instead.

**Done when (all met):**
- A photo of a twelve-field Burmese card proposes a field list, and accepting it lands those fields in
  the tree in paper order.
- Nothing is written until the proposal is confirmed, and deselected fields are not created.
- The estimate names a cost in money and the key it will use before anything runs.
- A TABLE template and a FORM template produce visibly different proposals from the same page.
- The run records its `promptVersion`.

**As built.** Notes for the phases after it:

- **The proposal is its own record, `FieldProposal`, not an `ExtractionRun` with a kind.** "No schema
  change beyond recording the prompt version on the proposal" needed somewhere to record it. Every run
  of a document is read as an extraction: `recomputeDocumentRun` rolls runs up into the document's run
  state, and `currentRuns` decides which reading of each page is current. A proposal run on a specimen
  would have shown as that page's latest reading with no raw layer. The new table also stores the
  validated items, which is what lets `accept` take **indexes** rather than labels. The client can't
  write anything the model didn't propose.
- **It runs in the worker, on the extraction queue** (`template.propose`), so it shares the key's
  concurrency and the queue-wide 60-second pause on rate limits. Recovery doesn't touch the reaper: the
  claim accepts a `RUNNING` proposal older than fifteen minutes, and the dialog's poll re-enqueues one
  stuck `QUEUED` for a minute. The job id is per proposal, so re-enqueueing is a no-op while it lives.
- **A paid proposal survives closing the dialog.** Reopening on the same page resumes the newest
  unaccepted proposal from the last day, whether still reading or waiting for confirmation, instead of
  charging again. `Read again` is the explicit way to pay for a fresh one.
- **"Visibly different" needed a page where the kinds should disagree.** Real Gemini proposals, tried on
  a synthetic twelve-field Burmese card:
  - As a Form, it gave all twelve fields, verbatim and in order, with sensible types: the `ကျား / မ`
    question came back as one `CHOICE` with both options, and the lone tick box as `MARK`.
  - On a card with no grid, a Table read gives the same labels, because there are no column headers to
    prefer.
  - On a card with labelled blanks above a vaccination grid, the kinds split cleanly: 13 fields as a
    Form (five blanks plus one field per grid cell, `BCG / ထိုးသည့်ရက်`) against 3 as a Table (the grid's
    columns only).
  - The first draft of `template-v1` got this wrong twice. The Form skipped grid rows that were empty on
    this copy, and the Table kept the blanks above the grid. Both were fixed before the version was
    used for anything but tests. From here, any change is `template-v2`.
- **Estimate constants:** 1,500 prompt tokens, image tokens per page, and a fixed 2,500-token output
  allowance. Measured output, including thinking, ran 700 to 1,700 tokens, about $0.002 to $0.006 per
  proposal on 3.5 Flash.
- **`labelMeaning` is template metadata, not data.** The English gloss is for the operator reading
  the tree, so it doesn't break "the AI transcribes, it does not normalise". `labelSource` is
  never rewritten beyond trimming.
- **Proposals already in the tree start unticked.** Labels are compared after NFC normalisation, so
  proposing twice, or after typing a few fields by hand, doesn't duplicate them unless the operator
  asks for it.

---

## Phase 17 — The second book ✅ shipped

The single worst defect for a returning operator, and the one v1 never addressed: `duplicateTemplate`
resolves the target book from the source template, so it can only copy within a book. An operator doing
the same malaria register for the next quarter re-authors twenty fields, their groups, selection rules,
notes, mappings and the column set **by hand, again**. For clinics, NGOs and research teams working from
recurring registers, the second book is where the product actually lives.

**No schema change.** Decision 3 already made this possible: the source layer is portable and knows
nothing about output columns; the mapping layer is book-bound.

**Added:**
- **Copy a template into another book.** The source layer travels — fields, groups, selection settings,
  notes, anchors, language hint, instructions. Mappings do not, because they name output columns that
  belong to the other book. The copy lands as `DRAFT` and the target book's `Create columns from this
  template` finishes the job in one click. This is not a limitation to apologise for; it is the layering
  working as designed, and the counted confirmation says exactly what travelled and what did not.
- **New book from an existing book.** Templates (source layers), output columns, mappings, glossary and
  validation rules. Not documents, photos or rows. Because the columns come along, the mappings can too,
  so a repeat book arrives fully configured and empty — which is the whole point.
- A **versioned portable library** (post-v1) stays deferred (decision 74). Plain copies answer the real
  need; pinning and diffing a shared definition answers a need nobody has expressed yet.

**The books list stops being a filing cabinet.** It is a name, three counts and a date, and cannot
answer the returning operator's first question — *which book has work left in it?* — although
`hasUnreviewedCells` is already computed for the book header. Each row gains reviewed-of-total and its
own **`Resume review`**, so resuming no longer costs a book open plus a full table load. That was the
cost Phase 10 set out to remove and only half removed.

**Docs to update:** docs/01 §6.1 and §6.4, docs/05 §2 and §6.

**Tests:** unit test that copying a template across books writes no `Mapping` row and no row outside the
target book — it is a cross-tenant path, so it qualifies under the testing policy.

**Done when (all met):**
- A twenty-field template with nested and selection groups copies into another book with its structure
  and every group setting intact, and no mapping.
- `Create columns from this template` then completes the copy in one click.
- A new book from an existing book opens with its templates, columns, mappings, glossary and rules, and
  zero documents and rows.
- The books list shows review progress per book, and `Resume review` on a row goes straight to the first
  unreviewed cell without loading the table.

**As built.** Notes for the phases after it:

- **One copier, three answers to "where do the mappings go?"** `duplicateTemplate`'s body moved to
  `copyTemplateInto` (`lib/templates/copy.ts`), which takes a column map: `"same"` (a copy inside its own
  book keeps each mapping's column), a map of old column id to new (a new book from a book, where the
  columns travelled too) or `null` (another book, where no mapping is read at all). The cross-book path
  refuses mappings *structurally*, not by a flag the caller could get wrong: with `null` the mapping table
  is never queried, which is exactly what the unit test pins.
- **A new book from a book also takes the paper's settings** — numeral system, era, export tokens and the
  default model. The phase text listed templates, columns, mappings, glossary and rules; these five are
  not in that list, but they describe the same paper and the same spreadsheet, and leaving them behind
  would have re-asked the era question (decision 76) of an operator who already answered it last quarter.
- **A `CROSS_COLUMN` rule names a second column in its params**, so it follows that column to the copy
  like its own. A rule on a deleted column, or comparing against one, has nothing to check and is left
  behind, as is a mapping to a deleted column or a deleted input. The confirmation's counts come from the
  same predicates the copy uses (`copyableMapping`, `copiedRule`), so it never promises more than arrives.
- **Copies made in one transaction share a `createdAt`**, because the column default is the transaction's
  start time, and templates list in creation order. The book copy stamps each template a millisecond
  apart, in the source's own order; without that the new book listed its templates in id order.
- **Pickers ask for names only.** `GET /api/books?view=names` skips the counts and the review aggregate
  that the books list now computes, which the `Copy into` picker has no use for.
- **Review progress is one query for every book on the page.** `reviewProgressForBooks` groups the
  review-progress aggregate by book; `reviewProgress` (the nav and the review screen) now calls it with
  one id, so the list, the nav's `Review N left` and the progress bar cannot disagree.
- **`Resume review` needed no new route.** The Review workspace already starts at the head of the review
  queue and its first unreviewed column, which is what the book header's `Resume review` did before
  Phase 13 folded it into the nav. The list links there directly: no book landing, no Result Table.
- **The copy's `Ready` line can still say some fields aren't mapped** after `Create columns from this
  template`, when the template has selection groups. Their tick-option fields are answered through the
  group's mapping, and `unmappedFieldCount` counts fields without a mapping input of their own. The column
  proposal itself is empty after the click, which is the real test of "complete"; the counter predates
  this phase and is the same for a template authored in place.
- **The book picker in `Copy into` reads the first 200 books.** Nobody is near that; a search belongs
  here if anybody is.

---

## Phase 18 — Documents, and what the machine is doing

Documents mostly works; this is the workspace treatment plus the one thing operators ask for that has no
home — *what is happening right now?*

**No schema change.**

- **A run drawer, not a Jobs workspace** (decision 75). Watching extraction deserves a real surface: per
  document, per page, with retry and the error. It does not deserve a peer workspace, because a queue is
  plumbing that operators have no mental model for, and because splitting "start the run" from "see the
  run" undoes Phase 9.1's finding that feedback belongs where the polling is. The drawer opens from the
  Documents header and from any running row.
- **The filter bar loses its tri-states.** Seven controls in one flat row, four of them three-position
  toggles whose meanings overlap (`Needs review` against `Reviewed`). They collapse into one **Status**
  select with named, mutually exclusive states, plus the template filter and search.
- **Upload date becomes a filter and a sort.** An operator who uploads sixty photos on Monday and sixty
  on Tuesday currently cannot tell them apart; `createdAt` is not even filterable. This is the cheap
  part of Batches (still post-v1) and covers most of what it was wanted for.
- **The upload-only screen** from Phase 13 gets its real form here: choose a template, shoot or pick,
  watch processing, done. It is the one thing a phone should do.

**Docs to update:** docs/05 §8 and §9.

**Done when:**
- A running extraction can be watched per document and per page, with retry, without leaving Documents.
- One Status select replaces the four tri-states and every previous state is still reachable.
- Documents can be filtered and sorted by upload date.
- A phone can upload into a chosen template end to end, and says plainly that review needs a wider screen.

---

## Phase 19 — Review, where the time actually goes

Review is the part of v1 that works. This is polish on the screen the operator spends ninety percent of
their time on, plus the two entry points it should have had.

**No schema change.**

- **Full-height photo beside values**, inside the Phase 13 frame, with the photo pane obeying the rule
  that it never shrinks below readable.
- **Resume at the document, not the tab.** Phase 10 remembers which tab you were on; the unit of
  returning work is the document you stopped in. Reopening a half-reviewed book offers that document.
- **Add to glossary from review.** The glossary reaches every prompt and earns its keep, but it lives in
  a settings page while it is *discovered* mid-review — the moment the operator meets `ဒီ` meaning ditto
  for the third time. Selecting a value offers to explain it, and the next extraction knows.
- **The first readout of `reviewedAt` / `reviewedVia`.** Phase 12 collected them deliberately without
  showing anything, because data not collected cannot be recovered. There is now real data, and
  seconds-per-reviewed-cell is the product's stated measure of success (docs/01 §1). A per-book readout,
  split by how the cell was marked, so a row-level `⌘Enter` stamping N cells at one instant does not
  read as N fast reviews.

**Done when:**
- Review fills the viewport at 1280 with the photo legible, and the panes remember their split.
- Reopening a half-reviewed book offers the document review stopped in.
- A value can be added to the glossary from review, and the next extraction's prompt contains it.
- The readout reports seconds per reviewed cell, separated by review source.

---

## Phase 20 — Column sweep

Pulled forward from post-v1 (#3 in the old order). One column down all documents, cropped source regions
side by side: the fastest possible shape for the most repetitive part of the work. It needs no new
extraction — the bounding boxes have been stored since Phase 5 — and it is a workspace, so it needs the
Phase 13 frame and the Phase 19 review surface underneath it.

Whether this beats row review for real operators is exactly the kind of question decision 64 says to
answer from usage rather than guess. It sits last for that reason: by the time it is built, Phases
13–19 will have produced the evidence.

**Done when:**
- One column can be reviewed down every document in a book using only the keyboard.
- Each value shows its own cropped region from its own page.
- Progress and `reviewedVia` are recorded identically to row review.

---

## Post-v1

**Provisional, as before** (decision 64). Re-rank from real usage rather than building down it. Three
items from the old list were pulled into Phases 16, 17 and 20; what remains:

1. **Vocabulary autocomplete** — per-column value vocabulary built from existing entries, offered on
   edit, with near-miss typo flagging and optional controlled vocabulary. The biggest remaining win on
   typing cost, and the first candidate to promote once Phases 13–19 have been used in anger.
2. **Batches** — upload sessions with metadata, feeding CONSTANT mappings and giving filter/retry
   granularity. Phase 18's upload-date filter covers the cheap half.
3. **Double extraction** — per-template toggle, two passes, disagreement flags.
4. **Source-definition library with versioning** — portable source layers, books pin a version, opt-in
   updates with a diff. Phase 17's plain copy covers the real need first (decision 74).
5. **Edit reasons UI** — the column already exists.
6. **Team sharing** — ownership model change, roles, then concurrent editing. **Move this up** if the
   first paying conversations need seats (decision 65): operators do the work, but a clinic, NGO or
   research manager is who buys. Note that Phase 15's autosave assumes single-owner editing and will
   need revisiting here.
7. **AI proposes groups and selection structure** — the half of Phase 16 deliberately left manual.
   Build it only if real proposals show flat fields are the bottleneck.
8. **Perspective correction** — corner-drag four-point transform.
9. **Template rule overrides** — a nullable `ValidationRule.templateId` and a Validation section in the
   template workspace (docs/01 §16, decision 40). Build when a real form needs a rule the book-level one
   gets wrong.
10. **Quota** — recorded in docs/09 §8 with the condition that triggers building it (decision 55).

---

## Decisions to append to docs/07 Part B

Phases 13–20 rest on decisions **66–77**. 66–70 were written up when Phase 13 shipped, 76–77 when
Phase 14 did, 71–72 when Phase 15 did, 73 when Phase 16 did and 74 when Phase 17 did; the rest need writing up in the decision log with their reasoning, in the same form as
1–65, as their phases ship:

| # | Decision |
|---|---|
| 66 | Phases are never renumbered; 0–12 freeze as shipped, new work continues at 13. |
| 67 | A workspace is a mode with its own layout, not a view of a record. |
| 68 | Settings becomes a gear and most of it is deleted rather than moved; panes are layout, routes are navigation. |
| 69 | Targeted layouts, not responsive: under 1280 is upload-only, 1280 two panes, 1600+ three. |
| 70 | Light-first, and the photo pane decides every layout. |
| 71 | A sample document is a real Document with a specimen flag, not a separate object. ✅ written up |
| 72 | Autosave replaces save-and-discard in the template editor; single-owner editing makes the modal protect nothing. ✅ written up |
| 73 | The AI proposes flat fields only; groups and selection structure stay manual. ✅ written up |
| 74 | Cross-book copy now, versioned library never until asked for. ✅ written up |
| 75 | Jobs is a drawer on Documents, not a workspace. |

---

## Risks to watch

- **Phase 13 touches every screen at once.** It is kept shippable by moving existing internals inside the
  new frame unchanged and redoing them in later phases. Resist the urge to redesign a workspace's
  contents while building the frame — that is what turns one revertible phase into four entangled ones.
- **The first hour is where users are lost, not the tenth** (decision 64). Review is only reached by
  surviving setup. Phases 13–17 are all setup; 19 and 20 are the part that already works.
- **Trust is spent in session one.** At a 40–50% raw error rate, a user who meets the errors before the
  explanation concludes the product is broken. Phase 15 moves that explanation earlier and attaches a
  real number to it.
- **AI-proposed templates can be confidently wrong**, and a wrong field list is harder to spot than a
  missing one — it looks finished. The proposal-with-toggles shape exists for that; never write fields
  without a confirmation.
- **Prompt drift.** Any prompt change invalidates comparisons between runs, including the new template
  prompt. Always bump `promptVersion` and never edit an existing version in place.
- **The transform layer is the product's spine.** Keep it pure and heavily tested; if it is correct,
  mapping mistakes cost zero AI spend to fix.
- **Extraction and template proposal are the only things that cost money per use.** Watch the per-user
  spend query in docs/09 §8; build the quota when the number is real rather than guessed (decision 55).
- **Gemini rate limits** will throttle real batches. Keep concurrency and RPM as single env vars and
  surface `RATE_LIMITED` clearly rather than as a generic failure.
