# 05 — UI, Screen by Screen

Design principle: the operator's scarce resource is attention. Minimise eye travel,
minimise keystrokes, and make provenance (which photo did this come from?) reachable
in one action from anywhere.

UI language is English. Data values may be Burmese — render values with
`font-family: "Noto Sans Myanmar", ...` and `lang="my"` where known.

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
Cards or rows: name, column count, document count, row count, updated-at.
`Create Book` primary button top right. Checkbox selection reveals a selection bar
with `Delete (n)`. Empty state explains the concept in two sentences with a CTA.

## 3. Create Book
Step 1: name, default model.
Step 2: output columns — an editable list with add/remove/drag-reorder. Per column:
label, key (auto-slugged from label, editable), type, and for ENUM a values editor.
`Create` → navigate to the book's Table tab.

## 4. Book detail shell
Header: book name (click to edit inline), row count, `Export CSV`.
Tabs: **Table** · **Templates** · **Documents** · **Settings**.

## 5. Settings tab
Sections: General (name, default model, numeral system, date era), Output table
(opens the column editor), Glossary (term/meaning list), Validation rules, Export
preferences, Danger zone (delete book).

**Edit output table** opens the column editor in a modal. On save it calls the preview
endpoint and shows the impact report before applying. Severity drives the styling:
SAFE applies immediately with a toast; ADDITIVE applies with a notice; DESTRUCTIVE
requires typing nothing but does require an explicit confirm on a screen that shows
`38 of the 412 affected cells have been edited by you`.

## 6. Templates tab
List of template cards. Each card:

```
┌──────────────────────────────────────────────────────────────┐
│ Vaccination card 2023        [Table]  [Ready] [Complete 40/40]│
│ 12 fields · 40 documents · 58 photos · last run 2h ago        │
│                                                               │
│ [ Upload documents ]  [ Extract ]            [edit] [copy] [×]│
│ ▸ Documents (40)                                              │
└──────────────────────────────────────────────────────────────┘
```

Two badges, never merged: **config state** (`Draft` / `Ready` / `Conflicted`) and
**run state** (`Never run` / `Running 12/40` / `Partial` / `Failed` / `Complete`).
Conflicted shows a tooltip listing broken mappings and a `Fix mappings` link.

Primary actions (Upload, Extract) are buttons; admin actions (edit, duplicate, delete)
are icon buttons in a visually separated group at the right.

Expanding shows that template's documents inline, capped at 20 with a link to the
Documents tab filtered to this template.

## 7. Template editor
Full-page, three tabs: **Fields** · **Mapping** · **Validation**.

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

### Validation tab
Per-column rule list with add/edit/remove, severity selector, and a live count of how
many existing cells would fail each rule.

## 8. Documents tab
Virtualised table. Columns: checkbox, thumbnail, label, template, pages, run state,
content state, rows produced, unreviewed, errors, last run, model.
Filter bar: template, run state, needs review, has edits, free-text search.
Row click opens the document detail drawer.
Selection bar: `Extract`, `Re-extract`, `Move to template`, `Delete`.

Flags surface as inline chips: `possible template mismatch`, `sequence gap`,
`no rows found`, `has disagreements`.

## 9. Upload & document detail
**Upload:** drop zone, progress per file, then a staging grid of uploaded photos.
Default is one document per photo. Multi-select → `Group into one document`. A grouped
document shows its pages in order with drag-reorder handles. `Done` creates the
documents.

*As built (Phase 4):*
- Upload is a large modal. `Upload documents` is always on the Documents tab: the template is
  pre-selected from the template filter, or when the book has one template; otherwise the operator
  picks one before the drop zone unlocks. A template card opens the same modal with its template fixed.
  The template can't change once files are added.
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

Photo grid has a small/medium size toggle. Collapsed state shows a count badge.

## 10. Photo editor
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

## 11. Extract modal
Shows: document count, page count, model selector (pre-filled from template override,
else book default), estimated tokens/time. Warning blocks for: documents containing
edited cells, templates in Conflicted state, documents flagged as possible mismatch.
Confirm enqueues and closes; a progress indicator appears on the affected rows.

*As built (Phase 5):*
- Opened from the Documents selection bar (`Extract`, `Re-extract`), the document drawer footer, and a template
  card (all of that template's documents). Documents that can't be extracted are listed with the reason and skipped.
- The dialog makes one nonce when it opens and sends it with every submit, and the confirm button disables while
  starting, so a double click is one extraction.
- The Documents list polls every 2 s while a loaded document is queued or running; multi-request documents show
  `Running 3/12` pages. Failed and partial documents get a chip pointing to the drawer.
- The drawer lists runs with their pages, error and `Retry these pages` on a failed run that is still the latest
  reading of its pages. It explains a blank page (not a failure) and "no rows found" (check template or photo).
- Template cards refresh every 2 s while their run badge is `Running`.

## 12. Table tab (output table)
Virtualised grid. Sticky header, sticky first column optional.

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
with sort (view-only), filter, and `Sweep this column` (deferred).

**Editing:** click or Enter to edit, Escape to cancel, Tab/Enter to move. Edits
debounce and save individually. Undo (Cmd+Z) reverts the last edit via the CellEdit
log.

Toolbar above the table: filters (needs review, has errors, edited, by template),
`Review rows`, `Export CSV`, and a progress readout (`1,204 cells · 318 unreviewed ·
12 errors`).

## 13. Row review mode
Split view. Left: the source photo, zoomable, with the current record's region boxed
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

## 14. Export dialog
Options: include void rows, include provenance columns, column subset, blank token,
illegible token. Shows the resulting row count. Warns if unreviewed cells or
validation errors remain, with counts, but never blocks.

## 15. Empty and error states
Every list needs a real empty state that explains the next action: no books, no
templates, no fields, no documents, no rows, all reviewed, extraction failed,
provider unavailable. Write these as real copy, not "No data".

## 16. Accessibility & performance notes
- Never signal state by colour alone.
- The output table and documents list must stay smooth at 3,000 rows — virtualise
  both, memoise cell components, and never re-render the grid on every keystroke.
- Photos: serve thumbnails in grids, working copies in viewers, originals only on
  explicit download.
- All modals are focus-trapped and Escape-dismissible except mid-destructive-confirm.
