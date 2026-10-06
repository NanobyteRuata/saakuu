# 05 — UI, Screen by Screen

Design principle: the operator's scarce resource is attention. Minimise eye travel,
minimise keystrokes, and make provenance (which photo did this come from?) reachable
in one action from anywhere.

UI language is English. Data values may be Burmese — render values with
`font-family: "Noto Sans Myanmar", ...` and `lang="my"` where known.

## 0. The frame (Phase 13)

**The app shell fills the viewport and the page itself never scrolls.** Every scroll happens
inside a pane. No layout computes its height from the viewport: there is no `calc(100vh - …)`
anywhere outside dialogs and overlays, which *are* the viewport. The top bar is a fixed row in a
`h-dvh` flex column; everything below it is `min-h-0 flex-1`, and a document-shaped page
(books list, create wizard, account, settings) gets its own scroll from `PageScroll`.

**A workspace is a mode with its own layout, not a view of a record** (decision 67) — the same
reason a video editor has pages rather than tabs. The four workspaces replace the four tabs and are
listed in working order, each carrying a live count:

```
Templates    Documents 60    Review 412 left    Result Table 900 rows    ⚙
```

**The counts are the spine.** They turn a flat bar into a sequence at almost no cost: an operator
who sees `Review 412 left` does not need to be told where to go next, and `Review` is where
`Resume review` used to go. One aggregate endpoint (`GET /api/books/:id/counts`) serves all of
them; it is seeded server-side on first paint, refreshed on navigation, and polled only while an
extraction is running. Because the seed comes from the server layout, **any action that starts a run
must `router.refresh()`** — that is what tells the nav to start polling. Settings is a **gear**, not
a peer (decision 68); its route still works by URL.

**Panes are layout; routes are navigation** (decision 68). A pane's size and collapsed state never
enter the URL, so deep links and the back button keep working — which is why Mapping was moved to a
route in the first place. The `Pane` primitive (`components/shell/pane.tsx`) resizes by drag,
collapses, and remembers its sizes per workspace per user in `localStorage`. Storage can be empty,
cleared or throw, so every read is wrapped and the computed default renders on its own — the same
rule as the landing memory.

**Layout targets** (decision 69). Not responsive in the fluid sense; three targeted layouts,
because breakpoint-switched layouts are far cheaper than fluid ones and honest about what each
device can do:

| Width | Layout |
|---|---|
| `< 1280px` | **Upload only.** Choose a template, shoot or pick photos, watch them process, done (§9, Phase 18). Everything else says, in plain language, that reviewing needs a wider screen. Standing at the filing cabinet with a phone is a real use; reviewing handwriting on one is not. The workspaces are not rendered at all at this width, so a phone never mounts the virtualised table. |
| `1280–1599px` | Two panes. |
| `≥ 1600px` | Three panes, or two with more density. |

**The rule that decides every layout: the pane holding the photo never shrinks below readable.**
Burmese handwriting at 400px is guesswork, so the photo pane carries a `minSize` and everything
else yields to it. For the same reason the app stays **light-first** (decision 70): a video editor
is dark to stop a bright surround biasing colour judgement; here the job is reading pencil on white
paper, and contrast is the whole task.

**Every page photo zooms and pans by hand** (`RegionImage`): pinch or ⌘/Ctrl-scroll zooms about the
cursor, up to 8×, and dragging moves the page; plain scroll still scrolls. Where a screen zooms for
the operator — a new row or cell in review, holding Space — that takes the view back, so a gesture
never fights the keyboard. The specimen pane's zoom is the operator's alone, and its − / + step
from wherever a gesture left it.

## Global

**Top bar** (sticky): `SaaKuu` wordmark left; nav (`Books`) and avatar right.
Avatar menu: email, `Sign out` → confirmation modal.

**Confirmation modals** always state exact counts and never use vague language.
Destructive confirmations disable the confirm button until the impact preview loads.

**Toasts** for success; inline errors for validation; a persistent banner for
degraded states (provider unavailable, queue backed up).

## 1. Sign in / Sign up
Single card. Google button, divider, email + password. Links to sign-up and reset.
Sign-up shows password requirements inline and sends a verification email; the app is
usable only after verification.

## 2. Books list
Cards or rows: name, column count, document count, row count, updated-at, then review progress
(`84 of 700 cells reviewed` over a thin bar) and `Resume review`, which opens the Review workspace at the
first unreviewed cell (Phase 17). A copy icon opens **New book from “…”**: a name (default `<name> (copy)`)
and the counts of templates, columns, mappings, glossary entries and rules it will copy, with "Documents,
photos and rows are not copied." `Create book` is disabled until the counts arrive.
`Create Book` primary button top right. Checkbox selection reveals a selection bar
with `Delete (n)`. Empty state explains the concept in two sentences with a CTA.

## 3. Create Book
One step (Phase 14): **name**, then `Create book`. It lands on the **Templates** workspace, not
Table — Table is the workspace that stays empty longest, and the real next action is building a
template.

Asking an operator to author a schema for data they have not read yet was the first wall in the
product. Phase 10 softened step 2 to empty-and-optional and was left with a primary button reading
`Create book without columns` — a button named after an absence. Phase 14 removed the step. Columns
are authored where they live, on the Result Table (§12) and in Mapping (§7), and `Create columns
from this template` proposes them from the first template's fields. The default model is not asked
for either: it has a default and is overridden per template and per extraction.

## 4. Book workspaces
One header line: `← Books`, the book name (click to edit inline), the workspace nav with its
counts, and `Export CSV`. The nav is described in §0. The header carries no counts of its own and
no `Resume review` button — the nav says both, and every rem of header is a rem the photo pane does
not get.

The book **remembers which workspace you were in** (Phase 10, extended in Phase 13), per user and
per book, in `localStorage` (decision 60). A book nobody has opened before, and which has no
templates, opens on Templates; a workspace you picked yourself always wins over that default,
including the Result Table. The redirect runs once per browser session per book, so the back button
is never caught in it. Storage can be empty or throw — private windows, cleared site data — so
every read is wrapped and the computed default renders on its own. Settings is not a landing
target, because it is a gear rather than a workspace.

Opening a book never drops anyone into full-screen review by itself. A **half-reviewed** book offers instead
(Phase 19): on landing, a toast `You stopped reviewing in <document>.` with `Resume review`. The document is the one
holding the book's most recently reviewed cell, so it follows the operator between browsers. Landing on Review needs
no offer, because Review resumes there itself.

## 5. Settings
Reached from the **gear** in the workspace nav (Phase 13), not as a peer workspace.

*As built (Phase 14):* three sections. **Glossary** (term/meaning list), **Validation rules**, and
the **Danger zone** (delete book). Nothing else. Each setting had to beat "pick a good default and
let them fix it where it is wrong", and only these three did:

| Was here | Now |
|---|---|
| Book name | Edited inline in the workspace header |
| Default AI model | A constant default, overridden per template and in the Extract dialog |
| Numeral system, date era | Offered on the column whose values won't parse (§12, decision 76) |
| Confidence threshold | Deleted; a constant in `lib/table/cellState.ts` (decision 77) |
| Export preferences | Set in the export dialog, which remembers them (§14) |
| Output table | The column editor, on the Result Table (§12) and in Mapping (§7) |

*As built (Phase 12):* the **AI key** lives in the account area, not here — it belongs to the
person, not to one book. See §5.1.

**Edit output table** opens the column editor in a modal, from the Result Table or from Mapping. On
save it calls the preview endpoint and shows the impact report before applying. Severity drives the
styling: SAFE applies immediately with a toast; ADDITIVE applies with a notice; DESTRUCTIVE
requires typing nothing but does require an explicit confirm on a screen that shows
`38 of the 412 affected cells have been edited by you`.

## 5.1 Account page (Phase 12, Phase 21)

`/account`, reached from the avatar menu. Settings that belong to the person, not to a book.

*As launched (Phase 21, decision 79):* the deployment leaves `ENCRYPTION_KEY` unset, so this page is
**`Reading so far` alone**, as a count of documents and readings with no money, and the menu item reads
`Account`. What follows about the key and the money figure describes a deployment that switches
personal keys on.

**AI key.** Paste your own Gemini key, see its last four characters, remove it. One line says where a
key comes from (a link to Google AI Studio) and that it is stored encrypted and never shown again.
A user without one falls back to the server key where the deployment has configured one, and the
Extract dialog names a personal key when one is in use (decision 54). When the deployment has no
`ENCRYPTION_KEY` the section is not rendered at all.

**Reading so far.** One figure: what every completed reading in this user's books has cost, at the
models' list prices, with the document and reading counts beside it. It is stated as an estimate, not
a bill.

**Credits** (Phase 22, decision 81), above `Reading so far`, only where the deployment has switched
balances on and the user isn't on a personal key.
- One figure: credits left, and beside it `about N pages at what your pages have cost so far` once
  they have read something — a credit means less to a clerk than a page does.
- Under it: credits used, credits held by readings in progress, and that a reading that fails costs
  nothing. If the last reading took the balance below zero, it says so rather than showing a minus.
- `Request more` opens an optional note and sends it to whoever runs SaaKuu. Nothing is granted by
  the button; the toast says the credits will appear here once they are added.
- The history, newest first: date, what (`Free credits for a new account`, `Added for you`,
  `Read 3 pages`, `Correction`), and the signed amount to one decimal. `Show older` pages it.
- Never money.

## 6. Templates workspace
List of template cards. Each card:

```
┌───────────────────────────────────────────────────────────────────┐
│ Vaccination card 2023 [Table] [Ready] [Complete]  [edit][copy][×] │
│ 12 fields · 40 documents · 58 photos                              │
│              ^ links to Documents, filtered to this template      │
└───────────────────────────────────────────────────────────────────┘
```

Two badges, never merged: **config state** (`Draft` / `Ready` / `Conflicted`) and
**run state** (`Never run` / `Running 12/40` / `Partial` / `Failed` / `Complete`).
Conflicted shows a tooltip listing broken mappings and a `Fix mappings` link.

Two lines: name with both badges and the icon actions on the first, counts on the second.
Admin actions (edit, duplicate, delete) are icon buttons at the right of the first line. The card carries no
ingestion action: the document count is a link to the Documents tab filtered to this template,
and uploading and extracting happen there (Phase 9.1, docs/06). The run badge still refreshes
every 2 s while a run is going, as read-only status.

**Duplicate** asks `Copy into` — `This book` or any other book the user owns (Phase 17). Into this book
it offers `Copy mappings to output columns too`, as before. Into another book that checkbox is replaced by
the count of what travels (*"Copies 20 fields and 5 groups (2 selection groups) with every setting, note,
anchor and instruction, as a draft in Q2."*) and what stays (*"7 mappings stay here: they fill this book's
columns. In Q2, Create columns from this template finishes the copy in one click."*). Confirming opens the
copy in the target book.

## 7. Template editor
Full-page, two sections: **Fields** · **Mapping**.

*As built (Phase 15):* **Fields is a paned workspace with the paper in it.**

```
1280   [ photo | reading ]  [ tree, properties under the selected row ]
1600   [ photo | reading ]  [ tree ]  [ properties ]
```

- The header (breadcrumb, template settings, `Fields | Mapping`) is a fixed row; everything below is
  panes that scroll internally. The `max-w-[1800px]` cap is gone, which is what it was waiting for.
- The photo pane obeys the rule every layout yields to: it never shrinks below `PHOTO_MIN_PX`
  (`lib/ui/panes.ts`, the same number row review uses). Inside it, the page sits above the reading in
  a nested pane group, so hovering a value boxes it on the image directly above rather than in a
  modal over it.
- The two-pane and three-pane splits are **remembered separately** (`template-2`, `template-3`):
  they are different shapes, and one must not overwrite the other. `PaneGroup` also throws out a
  stored layout that no longer fits instead of throwing — a remembered split is a convenience and
  can never be allowed to take a workspace down with it.
- Below 1600 the properties open **under the row they belong to**, outside the sortable list so the
  drag projection never treats the panel as another item to reorder. Config was not given a
  permanent narrow column: it is the densest form in the app, and a third pane would both starve it
  and put the photo and the config at opposite edges of the screen.
- Mapping keeps its scrolling two-column body inside the same header.
- **Template settings are a disclosure**, not a header: name and both badges stay on the line, and
  language, model, anchors, instructions and double extraction open under it. Six hundred pixels of
  form touched once per template cannot sit permanently on a screen whose whole point is the photo.

**Autosave, not save-and-discard** (decision 72). The properties forms have no `Save` or `Discard`
button. A form saves when focus leaves it, and when the operator picks another item — the parent
flushes the open form first — with one PATCH, not two. The footer says `Saves when you move on` /
`Saving…` / `All changes saved`. A draft that *will not* save (an empty label, a half-filled mark
row) is held by the workspace and restored, with its message, when the operator comes back to it:
no modal, and nothing typed is lost. Because no save is ever an explicit click, a document unload
while a save is in the air asks first, as row review and the batch upload already do.

Each is its own route (Phase 10): Fields at the template root and Mapping at
`/books/[bookId]/templates/[templateId]/mapping`, so both are deep-linkable, code-split and
survive the back button. Inside a template the book layout drops its `max-w-6xl` and the book
header collapses to one breadcrumb line, so the preview gets real width instead of what is left
after the book chrome.

Mapping stays **inside the template** rather than becoming a fifth book tab: mappings belong to
a template, a book can hold several, and a book-level tab would need a template picker that
rebuilds the same nesting with worse deep links (decision 62). What was wrong was width and
the missing URL, not the nesting.

**`Try one document`** (Phase 10, moved to the front in Phase 15) is offered from the mapping
preview's empty state and the Documents tab's empty state for a template, and — as `Test on this page`,
with no dialog, because the page is already in the pane — in the template workspace, enabled as soon as
one field is set to Extract (a hover tooltip says why it is disabled before then). It
uploads or picks a single document, extracts only it, and shows what was read beside the photo —
hovering a value moves the photo to where it was read. It is the product's trust moment — the first time anyone sees what the AI actually
read — and it is also what fills the mapping preview, so one action answers two problems. In the
workspace the reading survives a reload: opening a specimen shows its latest reading, or picks up
one still running, rather than inviting a second paid read of the same page. A reading older than
the latest field change says so (`Read before your latest field changes`), and a failed one says it
failed. (A third **Validation** tab for per-template rule overrides is
post-v1, see docs/06; book rules live in Settings.)

**`Propose fields`** (Phase 16, decision 73) sits beside `Test on this page` under the specimen, and
the empty tree points at it. It is the one place the operator used to author from nothing, now
done the product's way: the machine proposes and the human decides. It is a dialog in three stages:

1. **Estimate.** "The AI reads *page* as a form and lists each labelled place a value is written,
   in reading order." (For a table: "each column, from its header, left to right".) Then the model
   select and the time, `Under a minute.` On a personal key it reads `About $0.00x, under a minute.`
   with the key line (`Uses your own AI key (····1234).`); the server's key shows neither money nor a
   key line (Phase 21). The same wording as the Extract dialog (`lib/ai/cost-lines.ts`).
   Blockers and a missing key are shown in place, and `Propose fields` stays disabled.
2. **Reading.** The dialog polls. Closing it is safe and says so: the proposal has been paid for,
   so reopening the dialog on the same page resumes it rather than charging again.
3. **Proposal.** A list in paper order with a checkbox per field showing the label in its script,
   the English meaning, a type badge, and the choices and note where present. Every row starts
   ticked, except one whose label is already in the tree (`Already in the tree`). There are
   `Choose all` and `Choose none` buttons, a live `9 of 12 fields chosen`, and an amber line: *the
   AI can be confidently wrong, and a wrong list looks finished*. `Add N fields` opens the counted
   confirmation, which has the same shape as `Create columns from this template`: **Adds 11
   fields**, where they land (end of the tree, paper order, Extract), how many are left out, and
   the list. Escape is blocked while it saves. `Read again` goes back to the estimate for a fresh
   proposal.

Fields land flat at the top level. Groups, headers and tick groups stay manual, because a wrong
group costs more to undo than a missing one.

*As built (decision 78):* **the specimen pane owns the template's specimens**, which appear nowhere
else.
- **Empty pane, and `New specimen`** (the `+` in the pane header, "a different form") show the same two
  choices. `Upload a photo` takes several photos at once, and they become the pages of **one** specimen in
  the order picked (the first registers the specimen, the rest are added to it as pages). `Choose an
  uploaded page` lists this template's documents with a thumbnail and page count; picking one copies it
  into a new specimen. The document is untouched, and the copy is unread: Test reads it on its own.
- **The image icon adds a page** to the specimen on screen (`Add a page to this specimen`), through the
  page intake. The toast says `Page 2 added to this specimen. Test again to read it.`, the pane shows the
  new page, and the test reading turns stale.
- **The trash icon removes the specimen**, after a confirmation stating its page count and that the
  documents, including any copy added from it, aren't affected.
- **`Add to documents`** (it replaced `Use as a real document`) adds a *copy*; the specimen stays. It
  saves the properties form being edited first, then asks the server which case applies:
  - test current — "Adds a copy of this page to your documents, with this reading (14 values). Nothing
    is read again.";
  - fields or pages changed, or no test yet — "… It's read again there (2 pages), because your fields
    changed since this test.", with the time (and the cost and key line on a personal key);
  - can't be read now — "… unread. *reason* Extract it from Documents later.".
  Every case adds "This specimen stays here for building the template.", and a warning when the page was
  already added before ("… on 2026-09-24 (1 copy). Adding it again puts its rows in the table twice.").
- **The reading pane has a heading**: `Test reading · stays with this template, not in your table`.
- **Stale, one rule on both sides.** `Read before your latest field changes` shows when the reading is
  older than the template's `fieldsChangedAt`, when a page was added, replaced or cropped since it, or
  when the fields on screen changed since it appeared. `fieldsChangedAt` moves with fields, groups and
  the prompt settings — not with mappings, which is why it is not `updatedAt`. The server's promote
  check uses the same columns.

### Fields tab
Two-pane. Left: the field tree (groups → fields), drag-reorderable, with an add bar above it.
Right: the selected field's or group's properties.

**Tree (Phase 3.1).** Mirrors the paper. Groups and single fields interleave in one order at
every level, and groups nest up to 3 levels; there is no fixed "Ungrouped" section.
- Group rows are bordered, padded and lightly tinted, so a header reads differently from a field.
  Thin vertical guide lines, one per nesting level, run beside the rows inside each group, so a
  group's contents read as one block without breaking the flat drag list.
- **Adding.** One add bar, pinned above the list while it scrolls: a `Field | Group` switch, the
  label, the parent (top level or any group) and, for fields, the type (defaults to Mark / tick
  inside a selection group, Text elsewhere). Choice isn't offered there: a choice field needs its
  choices, so add the field, then set Type to Choice in its properties. Selecting a row points the parent at it: a group
  itself, or a field's group. Adding a group switches the bar to adding fields into that group.
- Each group row has a `+` that opens an inline row at the end of that group: type a label, Enter,
  the next label, Enter; Escape closes it. New rows scroll into view.
- Drag vertically to reorder; drag right to move into the group above, left to move out one
  level. Keyboard: Space to lift, ↑/↓ to move, →/← to nest or un-nest, Space to drop.
- Screen readers hear each drag step by label, never by id: what was picked up and where it is,
  where it would land ("Neg. would go inside RDT Test, after Positive"), why a spot is refused,
  and the result.
- Parent pickers grey out parents that would refuse the item (depth, cycle, selection rules).
- A `Group` select in the field and group properties panels is the non-drag alternative.
- A move past the depth cap, or a group into itself, is refused with a plain message.
- Group rows: source label (in its script), meaning (muted), a selection chip (`One of` /
  `Any of`) and a field count. Field rows can show their header path (`RDT Test › Positive › A`)
  where the bare label is ambiguous, e.g. in search results and the properties panel title.
- Deleting a group states exact counts and never deletes fields: "2 fields and 1 group move up
  into RDT Test. No fields are deleted."
- The empty state and the Mode help text carry the guidance from docs/01 §6.5: for Table
  templates, add every column in paper order and set unwanted ones to Skip; for forms, add
  look-alike fields as Skip.

Field row shows: source label (in its own script, prominent), meaning label (muted,
smaller), type chip, mode chip. Mode chips are colour-coded and immediately legible —
`Extract` neutral, `Skip` muted/struck, `Manual` accented.

Field properties panel: source label, meaning label, data type, mode, note (multiline,
with a hint explaining it is an instruction to the AI and an example), choices editor
for CHOICE, symbol map for MARK, `use as sequence` toggle for table templates.
For DATE (Phase 6): **Dates written with a two-digit year** — flag them (default), read them in the
book era's century, or split at a year — with a one-line example of what `30.8.20` becomes.

Group properties panel (Phase 3.1): label on the paper, meaning, parent group, selection
(`Header only` / `One of` / `Any of`), when nothing is ticked (`Normal blank` /
`Flag for review` / `Error`), when several are ticked (`One of` only: `Flag for review` /
`Error`), and a note for the AI. The selection settings explain their effect in one line
("Blank means not tested: no flag") and list the group's option fields; a group whose
descendants aren't all mark fields shows why `One of` is unavailable.

Header of the tab: template name, kind (read-only after creation), language hint,
anchors editor, template-level instructions, double-extraction toggle (disabled in v1
with a "coming soon" tooltip).

### Mapping tab
Two columns: fields on the left, output columns on the right, with the mapping list
between them. Each mapping row: target column, kind selector, inputs (field pickers,
reorderable for CONCAT), and kind-specific options. Broken mappings are marked with
the reason. Unmapped columns are listed separately under "Not filled by this template"
so nothing is invisible.

A **preview** panel shows the mapping applied to the most recent document's raw
values, so the user sees real output before running anything. This is the single
highest-value affordance in the editor — it turns mapping from guesswork into
feedback.

*As built (Phase 6):*
- Two panes. Left: a rebuild bar, then **Filled by this template** (one row per mapped column: kind chip, what it reads,
  and a `Broken` chip with the reason), **Not filled by this template** (each with `Map`), and a collapsible list of
  fields no mapping uses. Right (sticky): the preview.
- One editor opens in place at a time: how the column is filled (Copy / Join / Split / Fixed value / Expression, each
  with a one-line hint), field pickers in paper order with header paths (tick groups listed as `Tick group · One of`),
  up/down reordering for Join, and "Fill in ditto marks from the row above" on table templates. A tick group source
  shows its options with a value box each (blank = the option's label) and "When nothing is ticked, export". Expressions
  are written with `{Label}` references and an "Insert a field" picker. Escape cancels.
- The preview follows the unsaved editor (debounced 400 ms): it shows the mapped columns plus the one being edited
  (highlighted), up to 50 rows, void rows labelled (`Total, void`), ditto-filled values with `⇡`, flagged cells with a
  bar, a flag glyph and every message listed in words below, and the document checks (sequence gaps and so on). A draft
  that can't be saved shows why. Empty state when nothing is extracted yet.
- Saving or deleting a mapping rebuilds rows automatically; the bar shows `Rebuilding rows… 12 of 40 documents` and
  `Rebuild rows` runs it on demand. Deleting a mapping is a counted confirmation: cells that empty, edited cells kept.
- Documents list chips and the document drawer's `Row checks` show the transform's document flags.

Added in Phase 10:
- **`Create columns from this template`** sits above the two panes. For every `Extract`-mode field
  with no mapping it creates an Output Column (label from the meaning label, falling back to the
  source label; key auto-slugged; type from the field's data type) and a `COPY` mapping to it.
  A **selection group is one answer, so it proposes one column**, mapped from the group: `One of`
  becomes a list column of its option labels, `Any of` a text column, and the group's tick fields
  are not proposed separately. Counted confirmation first, listing every proposed column:
  `Creates 11 columns and 11 mappings`. The proposal is recomputed on the server as it is applied,
  so a second click creates nothing twice. A first book is almost always 1:1 field → column, so
  this replaces the hardest part of setup with one click and a round of renaming (decision 52).
- **`Edit output columns`** opens the existing column editor modal here, where the operator
  discovers they need a column — not only in Settings.
- The preview's empty state is not a dead end. Instead of `No extracted documents yet` alone it
  names the working order — fields → upload → **extract one** → map against its real values →
  extract the rest — and offers `Try one document` inline. This panel is the single
  highest-value affordance in the editor, and it was blank on every first visit.

### Validation tab (post-v1)
Per-template overrides of the book's rules. Not built in v1: the tab is not shown. The per-column rule list with
add/edit/remove, severity selector and live failing-cell count is built at book level, in Settings (Phase 7).

## 8. Documents workspace
Virtualised table. Columns: checkbox, thumbnail, label, template, pages, run state,
content state, rows produced, unreviewed, errors, last run, model.
Filter bar: template, run state, needs review, has edits, free-text search.
Row click opens the document detail drawer.
Selection bar: `Extract`, `Re-extract`, `Move to template`, `Delete`.

Flags surface as inline chips: `possible template mismatch`, `sequence gap`,
`no rows found`, `has disagreements`.

*As built (Phase 11):* a **`changed since last read`** chip joins them, and a
**`Needs re-extraction`** filter joins the filter bar. A document earns the chip when a page of
it was transformed, replaced or added after its last successful run (decision 58). Before this,
cropping a page of an extracted document left it looking identical to a correct one; the warning
appeared once at save time and then nothing. Over four hundred documents that is silent bad
data. The Extract dialog states the same count as a warning.
- The chip is placed high in the chip list: only the first two render, and it is the one with an
  action behind it.
- Both sides of the comparison are columns on Document (`contentChangedAt`, `lastExtractedAt`), so
  the filter stays a two-column test — the list is virtualised and cursor-paginated, and a per-row
  "max over photos against the latest run" would be a join per visible row.
- `lastExtractedAt` only advances on a `COMPLETE` run, so a re-extraction that *failed* does not
  clear the chip while the stale reading is still on screen.

*As built (Phase 18):*
- **One Status select replaces the run-state select and the four tri-states.** Seven controls in one row,
  four of them three-position toggles whose meanings overlapped: `Needs review` was a stored flag from
  extraction and transform warnings, `Reviewed` was about cells, and side by side they read as opposites.
  Status offers fourteen named, mutually exclusive states in four groups: **Reading** (`Not read yet`,
  `Waiting to be read`, `Being read`, `Read`, `Partly read`, `Reading failed`), **Review** (`Not fully
  reviewed`, `Fully reviewed`, `Flagged for a closer look`, `Not flagged`), **Edits** and **Page changes**.
  Each is exactly one state the old bar could express. What is no longer expressible is a *combination* of
  them, which nobody used and which is what made the bar hard to read. The `needs review` chip became
  `flagged` so the chip and the filter that finds it use one word. An old URL still lands on the status it
  meant.
- **Upload date is a column, a filter and a sort.** `Uploaded` lists the days documents went up, with a
  count each (`Uploaded 2026-09-21 · 60 documents`), in the viewer's own time zone. A batch shot at 6am in
  Yangon belongs to that morning, not to the previous UTC day. `Sort` is `Book order` (the manual order, the
  default), `Newest upload first` or `Oldest upload first`. This is the cheap half of Batches.
- The bar is now search, template, Status, Uploaded, Sort, and `Clear filters` for anything that narrows. A
  sort alone does not count as a filter, so `Extract all in <template>` still appears with a sort chosen.
  The empty state's `Clear filters` had been leaving `needsReextraction` set; it now clears everything.
- **The run drawer** (decision 75) opens from `Runs` in the header, which reads `Runs · reading` with a
  pulse while a loaded document is being read. It also opens from any running row's `Running 3/12`, and
  from the `extraction failed, retry in runs` chip, on that document. Opened from a row, that document
  comes first and is outlined, however far down it would sort.
  - It lists documents being read, then documents with failed pages, then documents read in the last day.
  - Each shows every page as a small numbered square (read, reading, waiting, failed, not read), then
    each failed page with the worker's plain-language reason and `Retry page`, plus `Retry N failed
    pages` when there are several.
  - It polls every 2 s only while something in it is being read.
  - A retry reloads the list and refreshes the route, so the nav starts polling (§0).
  - The document's name opens its detail drawer.
  - There is no cancel: it was never built (docs/04).

## 9. Upload & document detail

*As built (Phase 15):* **one component, four modes** (`components/photo/photo-intake.tsx`). The
batch upload, the specimen a template is built against, `Try one document` and replace/add page all
render `PhotoIntake`; three of them wrap it in `PhotoIntakeDialog`, and the specimen renders inline
in the template workspace's photo pane. The drop zone, the accept list, the size and type rules, the
progress line, the abort on unmount and the error container are the same code in all four. Only two
things differ per mode: what an uploaded key becomes (`/api/uploads/complete`, the same with
`isSpecimen`, `/api/photos/:id/replace`, `/api/documents/:id/pages`) and what is shown afterwards.

Underneath is one upload path (`lib/photos/use-intake-uploads.ts`), where there were three: an
inline XHR in the batch dialog, `uploadToStorage` in replace/add, and a bare `fetch` in `Try one
document` with no progress and no way to abort. The three copies of the mime and size rules had
already drifted — one `accept` attribute listed types only, which hides HEIC, because browsers
report it as an empty string.

**Finishing and leaving are separate closes.** Leaving by the X, Escape or the backdrop asks about
uploads still in flight; finishing — `Done`, or a single-file mode's success — does not, because the
count that guard reads is reported a render after the file it describes has landed.

A **specimen** is created by the same upload with `isSpecimen` set, so it is born one and there is
no moment where it counts as an ordinary document. Several photos picked at once become one specimen's
pages. Since decision 78 it never appears in the Documents workspace — no chip, no drawer action — and
reaches the documents only as a copy, from `Add to documents` in the template workspace (§7). The page
intake's `specimen` purpose changes only its toast: a specimen is tested, not extracted.

**Upload:** drop zone, progress per file, then a staging grid of uploaded photos.
Default is one document per photo. Multi-select → `Group into one document`. A grouped
document shows its pages in order with drag-reorder handles. `Done` creates the
documents.

*As built (Phase 4):*
- Upload is a large modal, opened only from the Documents tab (`Upload documents`, or the empty
  state). The template is pre-selected from the template filter, or when the book has one template;
  otherwise the operator picks one before the drop zone unlocks. The template can't change once
  files are added. Arriving from a template card means the filter is already set, so the template
  is already chosen.
- Each finished upload is already a document; everything saves as it happens. Per card:
  - select to group
  - drag pages to reorder
  - `Split into single pages`
  - crop/straighten a page (photo editor)
  - delete a page or the document (counted confirmations)
  - open the document drawer for label, Manual values and the rest
- `Done` closes the modal and refreshes the list, and is disabled while files are uploading. Closing
  mid-upload asks first ("Stop uploading?") and aborts unfinished uploads; files that finished stay as
  documents.
- Each PDF arrives as one document with its pages in order.

**Document detail drawer:** photo strip (drag-reorder), per-photo status/size/actions,
MANUAL-mode field inputs (typed once here, not per cell), run history, and
`Extract` / `Re-extract`.

*As built (Phase 11):* **`Replace`** on each page card and **`Add page`** in the Pages header.

Until now a page that turned out unreadable during review was a dead end: every upload creates a
*new* document, no endpoint adds a page to an existing one, and a page of an extracted document
cannot be deleted. The only path left was deleting the whole document and starting over, which
throws away its rows, its human edits and its review state — the exact work the product exists
to protect (decision 59).

Replace takes the old page's place: same document, same page index, old photo soft-deleted so a
row's provenance chip still opens an image between the replace and the re-extraction. Rows,
cells and edits are untouched, because they hang off Document and Row, never Photo. The document
is then marked `Changed since last read`, and re-extracting keeps every edited cell under the
Phase 6 rule. Deleting or reordering a page of an extracted document stays refused.

The Replace dialog states the exact counts before the file picker unlocks ("Its 12 rows and 4 cells
you edited are kept, and so are your reviewed marks") — what it keeps *is* the point of the feature.
Replacing takes a single photo; a PDF is several pages, so it is refused there and belongs in
`Upload documents`. `Add page` accepts a PDF, whose pages are appended in order. Both are refused while
the document is being extracted, because a run already under way cannot see the swap.

Photo grid has a small/medium size toggle. Collapsed state shows a count badge.

*As built (Phase 18):* **the phone screen.** Below 1280px every book URL shows one screen instead of the
workspaces:
- the plain line that review needs a wider screen;
- the template, locked once files are added;
- two big buttons: `Take photo`, a camera input with `capture` that opens the camera straight away, and
  `Choose files`, which picks photos or PDFs from the gallery or files;
- one row per file, going `Uploading 40%` → `Saving…` → `Processing…` → `Ready` (or its error).

`Done` then says how many documents went into which template and whether pages are still processing, which
finishes on its own. `Upload more` starts again with the same template.

Why a separate screen and not the batch dialog:
- The batch dialog was a 6xl modal with its own 288px template picker, opened from a page that had already
  asked which template.
- The phone has no grouping: one photo is one document, one PDF one document with its pages in order, and the
  screen says so. Grouping means looking at pages side by side, which is a computer's job.
- It uses the same upload hook, the same `/api/uploads/batch` + `/complete` registration, and the same
  processing poll as the batch intake. That poll is now one hook, `lib/photos/use-photo-processing.ts`,
  where it had lived inside the batch dialog.
- Leaving mid-upload is guarded by the browser's `beforeunload`; finishing never asks (Phase 15).

## 10. Photo editor

*As built (Phase 15):* the editor is unchanged and still writes only the transform JSON, but it is
now also reachable from the template workspace's photo pane, so a page that was shot crooked can be
straightened where it is being read from rather than only from the Documents drawer.

Modal, image centred, toolbar below.
Tools: **Crop** (drag handles, aspect free), **Rotate** (90° buttons + fine slider),
**Deskew** (auto-detect button + slider with a grid overlay), **Reset**.
Footer: `Cancel` / `Save`. Saving writes the transform JSON only; the original is
never modified. A note warns that changing the transform makes the last extraction
stale for this document.

*As built (Phase 4):*
- The editor shows the upright, untransformed copy. The preview uses the same geometry as the server
  render, so the saved result matches what was on screen.
- Turning by 90° clears the crop.
- Auto-detect suggests a deskew for the current turn and switches the grid on.
- The crop box moves with the arrow keys and resizes with Shift + arrows.
- The drawer's page cards show `Edited (updating…)` until the new thumbnail is rendered.

*As built (Phase 11):* the warning shown at save time stopped being the only record. Saving a
transform marks the document `Changed since last read`, so the operator can find every page they
touched later instead of having to remember them. A page card whose page changed since the last
reading says so too, which is what `Photo.transformedAt` is for.

## 11. Extract modal
Shows: document count, page count, model selector (pre-filled from template override,
else book default), estimated tokens/time. Warning blocks for: documents containing
edited cells, templates in Conflicted state, documents flagged as possible mismatch.
Confirm enqueues and closes; a progress indicator appears on the affected rows.

*Credits (Phase 22):* under the page and time line, `About 4.0 credits. You have 21.3.` When it
doesn't fit, that line is replaced by the refusal — `This needs about 40.0 credits. You have 12.0.`
with a link to the account page — and the confirm button is disabled. `Propose fields` and
`Add to documents` say the same in the same words. In the run drawer a read document's line ends
`· used 0.4 credits`.

*Model hint (Phase 22):* one line under the model picker in Extract and in `Propose fields`
(`modelHint`, `lib/ai/models.ts`) — `Most reliable so far.` for 3.5 Flash, `Newer. If it finds nothing
on a page, try 3.5 Flash.` for 3.7 — with `Uses more credits.` / `Uses fewer credits.` added only where
the operator has credits. It says what to do, not what the model is: on the first real pages 3.7 cost
about a fifth as much and twice returned no fields from a page 3.5 read. An empty proposal says to read
again with another model before it says to type the fields by hand.

*As built (Phase 5):*
- Opened from the Documents selection bar (`Extract`, `Re-extract`), the document drawer footer, and
  `Extract all in <template>` — which appears in the Documents header when the template filter is the only one
  narrowing the list and nothing is selected, and covers every document of that template, not just the loaded page. Documents that
  can't be extracted are listed with the reason and skipped.
- The dialog makes one nonce when it opens and sends it with every submit, and the confirm button disables while
  starting, so a double click is one extraction.
- The Documents list polls every 2 s while a loaded document is queued or running; multi-request documents show
  `Running 3/12` pages. Failed and partial documents get a chip pointing to the drawer.
- The drawer lists runs with their pages, error and `Retry these pages` on a failed run that is still the latest
  reading of its pages. It explains a blank page (not a failure) and "no rows found" (check template or photo).
- Template cards refresh every 2 s while their run badge is `Running`, but show no progress detail; the
  Documents list is where a run is watched.

Added in Phase 10:
- **A `DRAFT`-template warning**, which the dialog never had: it warned for `CONFLICTED` but not for a
  template with no mappings at all. A first-time user could extract four hundred documents, pay for
  every one, and land on an empty table. It is a **warning, not a blocker** — extracting before mapping is the *correct* order, because the mapping preview needs real
  values — so the wording teaches that order instead of forbidding it:
  *"«Name» has no mappings yet, so no rows will appear until you add them. Extracting one document first
  is the normal way to set one up — the preview needs real values."*
- **The expected error rate, before the book's first extraction** — shown while no run of the book has
  finished, and not on every run after that (decision 61):
  *"On handwriting like this, expect to correct roughly half the cells. Correcting is still much faster
  than typing."* 40–50% on handwritten Burmese is the premise the product is designed around, but
  "reviewing beats typing" is counterintuitive at that rate and session one is where a new user decides
  whether to believe it. Meeting the number unprepared reads as a broken product; being told first reads
  as an honest one. The claim is scoped to **the paper**, never phrased as the product's accuracy.

*As built (Phase 11):* the dialog states how many of the selected documents changed since they
were last read. It is phrased as a count rather than a caution — re-reading them is the fix, and
every edited cell is kept.

*As built (Phase 12):* the estimate reads **in money, not tokens** — tokens mean nothing to an
operator: *"12 documents · 14 pages · 2 requests to the model. About $0.05, about 2 minutes."* A
second, quieter line says it is estimated at list prices and names the key the run will spend —
the user's own (with its last four characters) or the server's — because the operator is about to
pay for it and should know whose account it lands on before they confirm, not after. Below a cent
it says "less than $0.01" rather than "$0.00", which would read as free.

*As built (Phase 21, decision 79):* that is now what the dialog says **on a personal key only**. On the
deployment's key, which is what every operator reads on at launch, the line is *"12 documents · 14 pages ·
2 requests to the model. About 2 minutes."* and there is no second line: the money would be the
deployment's cost rather than a price, and with one key there is none to name.

## 12. Result Table workspace (output table)
Virtualised grid filling the workspace. Sticky header, sticky first column optional. The grid is the
scroll container; it takes its height from the frame rather than from the viewport (§0).

**Cell states** — governed entirely by `docs/08-cell-visual-language.md`. Do not
invent cell styling here or in components; call `resolveCellVisual()` and render the
four channels it returns (authorship tint, text semantics, attention bar, reviewed
dot). Summary:

| Channel | Encodes | Rendering |
|---|---|---|
| A — background tint | authorship | human / inherited / awaiting entry / extracted |
| B — text | semantics + confidence | ok / empty / dash / n/a / illegible, plus a dotted underline for low confidence |
| C — left edge bar | attention | error > disagreement > warning, one bar only |
| D — corner dot | progress | reviewed |
| E — outline/ring | interaction | hover, focus, editing, selection |

**Row interactions:** drag handle for reorder; hover highlights the row and reveals a
provenance chip (template name + photo thumbnail); clicking the chip opens the photo
viewer at that record's region. Right-click (or a row menu) gives: review this row,
revert row to extracted, mark void, delete.

**Column headers:** label, type chip, counts of errors and unreviewed cells, a menu
with sort (view-only), filter, and `Sweep this column` (Phase 20, §13.1).

**Editing:** click or Enter to edit, Escape to cancel, Tab/Enter to move. Edits
debounce and save individually. Undo (Cmd+Z) reverts the last edit via the CellEdit
log.

Toolbar above the table: filters (needs review, has errors, edited, by template),
`Review rows`, `Export CSV`, and a progress readout (`1,204 cells · 318 unreviewed ·
12 errors`).

*As built (Phase 7):*
- Every page of rows loads in the background (`Loading rows… 1,500 of 3,060`); rows are virtualised with TanStack Virtual
  and the row model (view-only sort and filters) is TanStack Table. Sticky header and sticky row column.
- Row column: drag handle, row number, document label (void rows show `Total, void · …`), a row menu. Hovering the row
  swaps the label for the provenance chip (template name + page thumbnail); the chip opens the photo viewer zoomed to
  the record's box, with `Show whole page`.
- Row menu (also right-click): Mark row reviewed / not reviewed, Revert row to extracted… (counted), Mark void / Not
  void, Open source photo, Delete row… (counted; re-extraction won't bring it back).
- Keyboard: arrows, Page Up/Down, Home/End move (Tab leaves the grid); Enter, F2 or typing edits; Enter/Tab save and move; Escape
  cancels (and takes back what that session already saved); Delete clears; ⌘Z / Ctrl+Z undoes, one editing session or
  one cell revert at a time. Clicking a focused cell or double-clicking edits.
- Saves are debounced 400 ms and serialised per cell; a failed save shows a toast and puts the server value back.
  Dragging is off while a sort is active; a drop writes one row.
- Header: label, required mark, type, error count and unreviewed count (non-void rows), and a menu with sort, filters
  (Needs attention, Errors, Warnings, Edited, Not reviewed, Empty, Containing…) and `Sweep this column (coming later)`.
  *(Phase 20: now a link, `Sweep this column · N unreviewed`, into §13.1.)*

A column no template maps carries a **`Not filled`** chip in its header (Phase 10), and the column
editor names the templates that could fill a new column — in its impact report, and in the confirmation
that follows an additive change, which is the one an operator adding a column actually sees. A column
added later was otherwise silently blank for ever: it appeared in the table, stayed empty, and nothing
pointed at the mapping it needed.
- Toolbar: Needs attention, Has errors, Edited, template (when several), Show void rows, Clear filters, row height,
  legend, Refresh, `Review rows` (disabled until Phase 8). Readout: `24,000 cells · 24,000 unreviewed · 305 errors`.
- Disagreement cells carry a chevron opening extracted vs yours with `Keep mine` / `Use extracted`.
- Settings → Validation rules: rule list with how many cells each flags, an inline editor per kind with a live count of
  failing cells, counted delete, `Re-check all cells`.

*As built (Phase 14):* the toolbar carries **`Edit output table`**, and so do both of this
workspace's empty states — a book with no columns is exactly when the editor is wanted, and the
no-columns state used to point at Settings for an editor that is no longer there.

**Values that would not convert** get an offer on their own column (decision 76). A `DATE`,
`NUMBER` or `INTEGER` column whose cells failed to coerce shows a `3 not parsing` flag beside its
error and unreviewed counts, and its menu opens with the question rather than the filters:

> **3 dates aren't parsing in this column.**
> Is this paper using the Myanmar era, or Buddhist-era years? It describes the paper, so it is set
> for the whole book. Rows rebuild from what the AI already read — no AI cost.
> `[ Buddhist era (BE) ] [ Myanmar calendar ]`

A number column asks about Burmese digits instead. Accepting saves the book setting, which rebuilds
every template's rows; the table waits for each template's rebuild to report itself finished and then
says what changed — `4 values now parse`, or plainly that the rebuild finished and these values are
still wrong, so a wrong guess is not left looking like a slow one. Nobody has to know a queue was
involved.

The flag is decided structurally — a flagged cell still holding text its type would not accept — not
by matching the wording of a coercion error, and **cells you edited are not counted**: the question
is about the paper, and your own typo is not evidence about the paper.

## 13. Review workspace (row review)
Two panes, resizable and remembered (§0). Left: the source photo, zoomable, with the current
record's region boxed
and the active cell's region highlighted more strongly. Right: that row's cells as a
vertical form, each with its label, value input, confidence indicator, and validation
message.

Keyboard-first:
- `Tab` / `Shift+Tab` — next/previous cell
- `Enter` — accept and advance
- `Cmd+Enter` — mark row reviewed and go to next row
- `I` — mark illegible
- `R` — revert cell to extracted
- `[` / `]` — previous/next document
- `Space` (held) — zoom the photo to the active region

Header shows position (`Document 12 of 40 · Row 3 of 9`) and a progress bar.

*As built (Phase 8):*
- `/books/:id/review`, full height outside the book tabs; `?row=` opens at a row (Table toolbar `Review rows` passes the
  focused row; the row menu has `Review this row`), otherwise at the first row with an unreviewed cell. Void rows are skipped.
- Header: `← Table`, position, `saving…` / `all changes saved`, progress bar with `1,204 of 1,500 cells reviewed · 31 of 40
  documents complete` (whole book), `Next unreviewed`, `Export CSV`. Leaving with saves in flight asks first.
- Photo: working copy zoomed so the row fills the width, row boxed dashed, active cell boxed solid and kept centred; hold
  Space to zoom to the active cell; `Show whole page`. Photo and regions load once you stop on a row for 120 ms.
- Cells: label, header paths of the fields read, confidence (`uncertain · 41%` below the book threshold), edited / reviewed,
  the value with the docs/08 channels, the extracted value when edited or disagreeing, validation messages.
- Keys, when not typing: Tab / Shift+Tab and ↑/↓ move across row ends; Enter marks the cell reviewed and moves on;
  ⌘Enter / Ctrl+Enter marks the row reviewed and opens the next; `I` marks unreadable and reviewed, moves on; `R` reverts the
  cell; `[` `]` first row of the previous / next document; `N` next unreviewed; F2 or typing edits; Delete clears; ⌘Z undoes;
  Esc returns to the table. While typing: Enter saves, marks reviewed and moves on; Tab saves and moves; ⌘Enter saves and
  marks the row; Esc cancels (takes back that session's saves). Letter keys act only outside the editor, so a value starting
  with `i`, `r` or `n` is typed after F2.
- The end of the book shows `Every cell is reviewed` with Export, or the count still unreviewed with `Next unreviewed`.

*As built (Phase 19):*
- The photo runs the **full height** of the workspace. The header (position, progress, `saving…` / `all changes saved`,
  `Pace`, `Next unreviewed`) sits at the top of the values pane instead of across both.
- Without `?row=`, review **resumes where it stopped**: the first row with an unreviewed cell at or after the row holding
  the book's most recently reviewed cell, wrapping to the top, announced as `Resuming in <document>, where review stopped.`
  The nav and the books list's `Resume review` land here.
- *(Phase 20)* **`S`** opens the column sweep (§13.1) on the active column at this row, and so does `Sweep column` in
  the header. It joins `I`, `R`, `N` and `G` as a letter key, so a value starting with `i`, `r`, `n`, `g` or `s` is
  typed after F2.
- **Add to glossary:** `G` offers the text selected in the active value, else the text as written on the paper (a ditto
  mark, not what it resolved to), else the value; selecting text in the
  active value with the mouse shows `Add "…" to glossary` beside it. A dialog takes the meaning and adds the entry;
  the next extraction's prompt carries it. A single press on the active value selects rather than edits; releasing
  without a selection edits, as before.
- **Pace:** a popover of seconds per reviewed cell, one line per source — `Cell by cell (Enter)`, `Whole rows (⌘Enter)`,
  `Unreadable (I)` — never blended. Pauses over five minutes count as breaks, and their cells are counted but not timed.

## 13.1 Column sweep (Phase 20)
`/books/:id/review/sweep?column=<id>[&row=<id>]`, inside the Review workspace (the nav's `Review` stays lit). One output
column down every document in manual order, each value beside **its own cropped region from its own page**, so the eye
stays on one kind of handwriting. Without `?column=` it opens on the first column with an unreviewed value; without
`?row=`, at the first row whose value in that column is unreviewed. Void rows are skipped, as in row review.

Entry points: `Sweep this column` in a Result Table column header's menu; `Sweep column` (`S`) in row review's header,
which opens the active column at the active row; `Review rows` in the sweep's header goes back to row review at the
active row.

Two panes, resizable and remembered under `sweep` (§0):
- **Values** (primary, 480px floor): header with the column picker, `Value 13 of 100`, `Pace`, `Next unreviewed`,
  `Review rows`, a progress bar for the column, `312 of 900 reviewed in this column · 1,204 of 6,300 cells in the book`,
  and `saving…` / `all changes saved`. Then a virtualised list: a document label where each document starts, and per
  row the crop (the column's region with a small margin, at most 96px high, drawn from the working copy) beside the
  value with the docs/08 channels, `uncertain · 41%` when low, `edited`, reviewed dot, validation messages. A value with
  no region of its own shows the row's box and says so; none at all says `No region recorded for this value.`
- **Page** (collapsible, keeps the photo pane's readable floor): the active value's page, the row boxed dashed and the
  value boxed solid, zoomed to the row. Context for a crop that isn't enough.

Keys, when not typing, mean what they mean in row review: `Enter` accepts and moves down; `↑` `↓` / `Tab` `Shift+Tab`
move; `←` `→` switch to the previous / next column on the same row; `I` marks unreadable and moves down; `R` reverts;
`N` next unreviewed in this column; `[` `]` first value of the previous / next document; `G` offers what was written on
the paper (else the value) to the glossary; `F2` or typing edits (Enter saves, accepts and moves down; Tab saves and
moves; Esc cancels); `Delete` clears; `⌘Z` undoes; hold `Space` to zoom the page pane to the value; `PageUp` /
`PageDown` jump ten; `Home` / `End`; `Esc` returns to the table.

Reviews are recorded **exactly as row review records them**: the same `POST /api/cells/review`, `CELL` for `Enter`,
`ILLEGIBLE` for `I`. The nav count, the progress bar, where review resumes and `Pace` all include sweep reviews with
nothing added (Pace's `Cell by cell (Enter)` line counts both screens).

The end of the column shows `Every value in <column> is reviewed` with `Sweep <next column with work>`, or the count
still unreviewed with `Next unreviewed`.

## 14. Export dialog
Options: include void rows, include provenance columns, column subset, blank token,
illegible token. Shows the resulting row count. Warns if unreviewed cells or
validation errors remain, with counts, but never blocks.

*As built (Phase 8, amended in Phase 14):* opened from `Export CSV` in the book header (disabled with no rows) and in row
review. The blank and illegible tokens are **set here and remembered**: this dialog is the only place they are edited, and
the choice is written back to the book, so the next export of it starts where this one finished. Having them here *and* in
Settings was two places to set one thing, and Settings is the one you forget you touched. Shows `240 rows × 8 columns` and, when anything is left, `Not finished: 318 of
1,920 cells not reviewed · 12 cells with errors · 3 cells with warnings. You can still export.` The download starts in place.

## 15. Empty and error states
Every list needs a real empty state that explains the next action: no books, no
templates, no fields, no documents, no rows, all reviewed, extraction failed,
provider unavailable. Write these as real copy, not "No data".

*As built (Phase 9):* every route segment has an error boundary: the root (`global-error`, which replaces the root
layout), `(app)`, `(auth)`, books, the book tabs and review. Each says the data is safe, offers `Try again`, and shows
the error's `Reference` so a report can be matched to the server log. Unknown URLs get `Page not found` with a link to
the books list. Loads that can fail in place offer `Try again` rather than only a message: the Mapping tab, the mapping
preview, the document drawer and the Extract dialog's estimate. The document drawer keeps polling through a failed
refresh (backing off to 30 s) and says what it shows may be out of date. `No documents match these filters` has
`Clear filters`. The Extract dialog says up front when AI reading isn't set up on the server and disables Extract.
Every empty state listed above was already written as real copy in Phases 2–8.

## 16. Accessibility & performance notes
- Never signal state by colour alone.
- The output table and documents list must stay smooth at 3,000 rows — virtualise
  both, memoise cell components, and never re-render the grid on every keystroke.
- Photos: serve thumbnails in grids, working copies in viewers, originals only on
  explicit download.
- All modals are focus-trapped and Escape-dismissible except mid-destructive-confirm.
