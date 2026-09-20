# 06 — Build Plan

Phases 0–13 are **shipped**; the launch gate after Phase 12 has passed. They are kept below in one
line each, because 63 code comments, 167 lines across docs/01–09 and 91 `decision N` references
point at them by number. **Phases are never renumbered** (decision 66); new work continues at
Phase 14.

Phases 13–20 came from walking the whole product as a first-time operator and then as a returning one
(see the analysis behind decisions 66–77). v1's parts each work; what it lacks is a **spine** — nothing
on screen carries the working order, and the operator holds it in their head. Phase 13 built that
spine and the phases after it fill it.

Each phase is independently shippable and has acceptance criteria. Do not start a phase before the
previous one's criteria pass.

---

## Shipped — Phases 0–13

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

Detailed acceptance criteria for phases 0–12 are in git history (`docs/06-build-plan.md` before
Phase 13) and their reasoning is in docs/07 Part B, decisions 1–65. Phase 13's are below, and its
reasoning is decisions 66–70.

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

## Phase 14 — Cutting what nobody needs

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

---

## Phase 15 — The paper on screen

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

---

## Phase 16 — The AI proposes the template

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

**Done when:**
- A photo of a twelve-field Burmese card proposes a field list, and accepting it lands those fields in
  the tree in paper order.
- Nothing is written until the proposal is confirmed, and deselected fields are not created.
- The estimate names a cost in money and the key it will use before anything runs.
- A TABLE template and a FORM template produce visibly different proposals from the same page.
- The run records its `promptVersion`.

---

## Phase 17 — The second book

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

**Done when:**
- A twenty-field template with nested and selection groups copies into another book with its structure
  and every group setting intact, and no mapping.
- `Create columns from this template` then completes the copy in one click.
- A new book from an existing book opens with its templates, columns, mappings, glossary and rules, and
  zero documents and rows.
- The books list shows review progress per book, and `Resume review` on a row goes straight to the first
  unreviewed cell without loading the table.

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

Phases 13–20 rest on decisions **66–77**, which need writing up in the decision log with their
reasoning, in the same form as 1–65:

| # | Decision |
|---|---|
| 66 | Phases are never renumbered; 0–12 freeze as shipped, new work continues at 13. |
| 67 | A workspace is a mode with its own layout, not a view of a record. |
| 68 | Settings becomes a gear and most of it is deleted rather than moved; panes are layout, routes are navigation. |
| 69 | Targeted layouts, not responsive: under 1280 is upload-only, 1280 two panes, 1600+ three. |
| 70 | Light-first, and the photo pane decides every layout. |
| 71 | A sample document is a real Document with a specimen flag, not a separate object. |
| 72 | Autosave replaces save-and-discard in the template editor; single-owner editing makes the modal protect nothing. |
| 73 | The AI proposes flat fields only; groups and selection structure stay manual. |
| 74 | Cross-book copy now, versioned library never until asked for. |
| 75 | Jobs is a drawer on Documents, not a workspace. |
| 76 | Numeral system and era are asked by exception at the point of failure, not configured up front. |
| 77 | The confidence threshold is deleted rather than defaulted: a knob with no feedback loop over an uncalibrated signal. |

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
