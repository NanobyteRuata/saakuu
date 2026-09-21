# 07 — Deferred Features & Decision Log

## Part A — Deferred features and their schema affordances

Everything here is **out of v1** but has its schema reserved, so adding it later needs
no migration and no data backfill.

| Feature | Reserved in schema | Notes |
|---|---|---|
| Double extraction | `Template.doubleExtraction`, `ExtractionRun.passIndex`, `RawValue.altValueText`, `RawValue.disagreement` | Run twice, diff, flag. 2× cost but genuinely calibrated uncertainty, unlike self-reported confidence. |
| Column sweep review | `RawValue.bbox`, `RawValue.photoId` | Bounding boxes captured from v1, so the view can be built without re-extracting anything. |
| Vocabulary autocomplete | none needed — derived from `Cell.currentValue` | Per-column value frequency, offered on edit; near-miss detection flags likely typos. Highest-value post-v1 item. |
| Batches | `Batch` model, `Document.batchId` | Upload sessions with metadata that can feed `CONSTANT` mappings, so `clinic_name` is set once per batch rather than extracted 400 times. |
| Book duplication | none needed | Three levels: structure only / structure + documents+photos / full copy including data. |
| Source-definition library | `Template.sourceDefId`, `Template.sourceDefVersion` | Portable source layers at account level. Books pin a version and pull updates opt-in with a diff. See Part B decision 4. |
| Edit reasons | `CellEdit.reason` | UI only; column exists from v1. |
| Team sharing | `Book.userId` → membership table later | Personal in v1. Concurrent editing of the output table is a separate design problem. |
| Perspective correction | `Photo.transform` JSON is open-ended | Add a `corners` key; crop/rotate/deskew ship in v1. |
| Cost calibration | `ExtractionRun.inputTokens/outputTokens` | Recorded from v1 so estimates can be calibrated against history. Surfaced as money in Phase 12; a quota is sized from it later (decision 55). |
| AI proposes the template | `FieldProposal` (Phase 16) | **Flat fields shipped in Phase 16** (decision 73). Proposing groups and selection structure stays deferred (docs/06 post-v1 #7). `Create columns from this template` was its cheap half, shipped in Phase 10 (decisions 52, 53). |
| Review-speed readouts | `Cell.reviewedAt`, `Cell.reviewedVia` | Collected from Phase 12 so the launch period is measurable; the display is built when there is data worth showing (decisions 56, 57). |

---

## Part B — Decision log

Decisions already made in discussion, with their reasoning, so they are not
relitigated during implementation.

**1. "Extraction logic" is called a Template.** An execution is an Extraction or Run.

**2. A Document sits between photos and rows.** A document is an ordered set of photos
forming one source record. Without it: multi-page forms, multi-photo ledgers,
per-photo retry, and row→photo provenance are all unrepresentable.

**3. Templates live inside a Book, but have two layers.** The source layer (fields,
groups, notes) is portable and knows nothing about output columns. The mapping layer
is book-bound. This is what makes the deferred library possible without redesign.

**4. Source definitions will be versioned; books pin a version.** Editing a shared
definition must never silently break a book. Pulling an update is opt-in and shows a
diff. Pushing local edits back to the library is a separate explicit action.

**5. Raw layer and output layer are separate.** The AI's verbatim reading is stored
once; rows are derived deterministically. Changing a mapping re-computes instantly at
zero AI cost, and "conflicted" becomes fixable without re-shooting anything.

**6. The AI never normalises.** `1 1/2` is transcribed as `1 1/2`, not converted to 18
months. Burmese digits stay Burmese. All conversion happens in the transform layer
where it is inspectable, testable, and re-runnable.

**7. Mappings are N fields → M columns**, not just many-to-one. One-to-many is
expressed as multiple SPLIT mappings from the same field.

**8. Field modes are Extract / Skip / Manual**, not a skip boolean. At 40–50% error
rates on handwritten Burmese, the winning strategy is the AI doing numbers, dates and
marks while humans do names. Manual mode makes that explicit and is typed once per
document rather than once per cell.

**9. Confidence is a sort order, not a truth.** An explicit `ILLEGIBLE` state with a
never-guess instruction is a stronger signal than a self-reported score.

**10. Config state and run state are separate badges.** A template can be Conflicted
and have a Complete run simultaneously. Failures are per-photo, so `PARTIAL` exists.

**11. Everything references IDs, never names.** Renaming is always free. Only deletion
and incompatible type changes trigger conflicts, and those show exact counts —
including how many affected cells carry human edits.

**12. Deleted fields keep their raw values as orphans.** Undo is real; re-mapping is
instant.

**13. Re-extraction never overwrites a human edit.** It writes `extractedValue` and
raises `disagreement`. "Revert to extracted" always works because both values are kept
forever.

**14. Handwritten-table realities are modelled, not patched.** Ditto marks are stored
as literal tokens and resolved downstream with an `inherited` flag; struck-through
rows are reported, not dropped; row types distinguish DATA from HEADER/SUBTOTAL/TOTAL;
a designated sequence column gives the cheapest available quality check.

**15. Empty, dash, N/A and illegible are four different things**, plus OK. Collapsing
them into "blank" destroys meaning that the operator needs.

**16. A blank page is not a failure.** `EMPTY` (no content) and `NO_ROWS_FOUND`
(content but no rows, flag for review) are distinct outcomes.

**17. Documents can be moved between templates**, discarding extraction. The real
cases are a misfiled batch and a template split discovered 200 documents in. Anchor
strings let the system flag a probable mismatch before a human wastes review time.

**18. Validation rules catch what confidence cannot** — a plausible-looking wrong
number. Deterministic, free, and they never block export.

**19. Review offers both row and column layouts.** Row review is the default; column
sweep is the specialised tool, deferred but data-ready.

**20. Manual row order is canonical; column sorting is view-only** and never writes.
Fractional indexes make a drag a single-row update.

**21. Photo edits are non-destructive.** Originals are immutable; transforms are JSON.

**22. CSV exports as UTF-8 with BOM** so Burmese text opens correctly in Excel.

**23. Extraction never runs in a request handler.** Always queued, always idempotent.

**24. Every session is a database row, including password sign-ins.** Auth.js only
issues JWTs for Credentials, so `jwt.encode` is overridden to create a `Session` row
and use its token as the cookie. This means a password reset can sign a user out
everywhere by deleting rows. Auth.js accepts the Credentials + database combination
only while another provider is registered, so Google is always in the provider list and
its button is hidden when unconfigured.

**25. Google links to an existing account only when both sides are verified.** Google
must report the email as verified, and an existing password account must have
confirmed its email. Otherwise someone could pre-register a victim's address and
inherit their Google sign-in. A Google-only user can add a password through the
reset flow.

**26. Email goes through an `EmailSender` interface.** Resend in production, a log
transport for local work without a key, and an in-memory outbox for E2E tests. Swapping
providers touches one file.

**27. Auth secrets are stored hashed.** Passwords use scrypt (`node:crypto`, no native
dependency, parameters stored in the hash). Emailed tokens are stored as sha256 hashes,
single use, and a new token revokes older ones. Verification links expire after 24 hours and
reset links after 1 hour. Confirming an email requires a click, so link scanners
cannot use up the token.

**28. Every physical column or answer box is a field; groups are the headers above them.**
Flattening nested headers into standalone fields ("RDT Positive A") loses the header context the
model needs, readable labels, and the "only one of these is ticked" check. Collapsing tick
columns into one field ("Sex") instead would make the model interpret rather than transcribe, and
lose per-column review crops. Both layers are kept: fields for what is read, groups for structure.
(Phase 3.1)

**29. Table templates list every column; unwanted ones are Skipped, not omitted.** Tables are read
row by row against the header list. An unlisted column between listed ones gets its values pushed
into a neighbour when handwriting drifts, producing plausible wrong values nothing else catches.
Skipped columns cost a few prompt tokens and no output. Forms may omit unrelated fields but should
list look-alikes as Skip. This is reasoning, not measurement; see Part C question 6. (Phase 3.1)

**30. Groups and fields share one order at every level.** Real forms interleave single fields and
grouped columns. A fixed "ungrouped first, groups after" layout can't follow the paper, and paper
order is what the prompt should present. The existing fractional positions already allow this by
merging sibling groups and fields; no migration was needed for ordering itself. (Phase 3.1)

**31. Groups nest; the depth cap is a code constant.** Registers have spanning headers over
sub-headers (`RDT Test › Positive › A`). `parentGroupId` allows any depth, and
`MAX_GROUP_DEPTH = 3` is enforced in validation, so a deeper form later needs a one-line change,
not a migration. The practical limit is readability of header paths, not the database. (Phase 3.1)

**32. "One of / Any of" tick groups are a source-layer setting, resolved in the transform.**
That only one box should be ticked is a fact about the paper, so it lives on the group. The model
still transcribes each tick; the transform derives the answer. What nothing ticked or several
ticked mean is configurable per group (blank often means "not tested"), an illegible tick is
always flagged and never read as blank, and raw ticks are kept. The value exported for "nothing
ticked" and per-option output codes belong to the mapping, because they depend on the output
table. (Phase 3.1)

**33. A mapping reads a selection group through a group reference on `MappingInput`.** A new mapping kind would
duplicate Copy and Join, and an expression helper would hide the option values inside a formula. A group input works
with every kind, and its per-option output values and nothing-ticked value live on the input, next to the reference
they belong to. The schema change is additive. (Phase 6)

**34. Rows are matched between builds by a record key, and edited rows are never deleted.** Re-extraction replaces raw
records, so raw record ids can't carry rows (and their edits) across. The key is the sequence number when the table
has one, else the row's place in reading order. A row that no longer matches and holds edits is kept void as
`ORPHANED` rather than lost. (Phase 6)

**35. Disagreement is raised by a new reading, not by every re-run.** Comparing only the extracted value with the
edited value would flag the same cell on every rebuild after the operator had already chosen their value. (Phase 6)

**36. What a two-digit year means is a field setting, not a book setting.** One column's dates can be recent while an
older column in the same book is not, so the century belongs to the column written that way. It lives in
`Field.typeOptions`, a per-type settings bag, so later type settings need no migration. The century is a fixed constant
per era (2000 / 2500 / 1300), never "this century today", so a rebuild is reproducible. The default stays `REFUSE`: an
unconfigured field flags the date rather than guessing. (Phase 6)

**37. Deleting a row is soft and survives re-extraction.** A hard delete would come straight back on the next rebuild,
because the raw record still produces it. `Row.deletedAt` lets the merge keep matching the row by record key and leave it
deleted, and keeps the deleted row's edits recoverable. (Phase 7)

**38. Edits are stored in the column's canonical form when they read as its type.** An operator typing `12/3/2024` into
a date column means the date, and the export should say `2024-03-12`; "the AI transcribes, it does not normalise" is about
the model, not about a person's typing. A value that doesn't read as the type is stored exactly as typed and flagged, so
nothing typed is ever lost. The cell shows the saved form at once. (Phase 7)

**39. Build issues and rule issues are stored apart; validation state is derived.** Rules change far more often than
extractions and must re-check without rebuilding rows, and an edited cell's build warnings stop applying. So the
transform stores `Cell.buildIssues`, and `validationState` is recomputed from them, the column type (for edited values),
the required flag and the rules, in the same transaction as whatever changed. Rule saves re-check their columns in the
request so flags appear at once; a queued job re-checks whole books. (Phase 7)

**40. Template-level rule overrides are deferred.** docs/01 §16 allows overriding book rules per template, but
`ValidationRule` has no template reference, and no real override case exists yet. Adding a nullable `templateId` later is
additive. The template editor's Validation tab waits for it. (Phase 7) The placeholder tab was removed before v1
rather than shipping a promise; overrides are on the post-v1 list in docs/06. (Phase 9)

**41. An editing session is one undo step.** Saves debounce while typing; logging each as its own `CellEdit` would make
Undo step back through half-typed values. A save names the session's entry and extends it while it is still the cell's
latest change. Undo is refused once someone or something changed the cell again, rather than overwriting it. (Phase 7)

**42. Rule patterns run on RE2, not JavaScript regular expressions.** Rules run on the server, inside the transaction of
every edit to their column. A backtracking pattern such as `(a|aa)*$` can take exponential time and no static check catches
every such shape, so patterns go through `re2js` (a pure-JS RE2 port, no native build), which is linear. The cost is RE2
syntax: no backreferences or lookarounds. Mapping split patterns (Phase 6) still use JavaScript regular expressions with the
nested-repeat check; moving them to RE2 is a follow-up. (Phase 7)

**43. Dash and not-applicable export as literal `-` and `N/A`; blank and illegible use the book's tokens.** docs/01 §11.6
keeps five meanings apart, and the schema has tokens for only two. Writing the other two as fixed text keeps them distinct in
the file without new settings. Values are otherwise exported verbatim: no spreadsheet-formula escaping, which would change
what people typed. (Phase 8)

**44. Export links are signed, not stored.** `POST /export` returns a link carrying the options, signed with AUTH_SECRET and
valid five minutes, so the browser can download a stream directly without a table of export jobs. The download still needs
the same session and re-checks the book. Streaming pages are read one after another, not in one snapshot; an edit made
mid-download may or may not be in the file. (Phase 8)

**45. Review counts what the table counts.** Void rows are skipped in review and left out of progress, document completion
and export warnings, like the table readout. A document with no such cells is neither reviewed nor unreviewed in progress,
and is not `reviewed` in the Documents filter. Including void rows in an export adds a `_void` column so they stay
recognisable. (Phase 8)

**46. Rate limits fail open.** Limits live in Redis. If Redis is down the check is skipped and logged, not refused:
sign-in and sign-up depend on Postgres, and a Redis outage locking every user out is worse than an unmetered minute.
Fixed windows, not sliding: a burst at a window edge can reach twice the limit, which is acceptable for abuse
prevention and needs one `INCR`. The client address is counted from the right of `X-Forwarded-For` by
`TRUSTED_PROXY_HOPS`, never taken from the left, which the client controls. Failed sign-ins lock an email only at one
address (10), with a looser per-email ceiling (50), so a stranger can't lock someone out. (Phase 9)

**47. Deleted photos' files wait for a grace period, tracked by a tombstone table.** A photo row is hard-deleted (its
keys would otherwise be lost), so `StorageDeletion` records the keys and when they may go. Soft-deleting `Photo` instead
would have touched every photo query. The grace period is tied to backup retention (docs/09 §2), not to undo: v1 has no
restore for deleted documents. (Phase 9)

**48. Photos of long-deleted documents and books are purged.** After the grace period their photo rows and files are
removed; rows, raw values and runs stay. Storage is the ongoing cost of keeping deleted work, and nothing in v1 reads
those photos. (Phase 9)

**49. The reaper decides from BullMQ, not from a heartbeat.** A `RUNNING` run is stale when its document has no active or
waiting extraction job. That needs no schema change and no heartbeat writes during model calls, which can take minutes.
The claim's `startedAt` doubles as a fencing token, so a worker that lost its lock can't write over a newer attempt.
(Phase 9)

**50. The template editor's Validation tab is removed from v1.** It was a placeholder for per-template rule overrides
(decision 40). Shipping a tab that only says "later" costs a click and trust; overrides are post-v1 item 10. (Phase 9)

**51. The setup defects found in the Phase 10 walkthrough are fixed before launch, not added to
post-v1.** They are gaps in what Phases 2–9 already claim done, not new capabilities. On a feature list
a defect loses to a feature every time, for ever. The plan already has the precedent twice: 3.1 and 9.1
were both inserted after their predecessor shipped, from looking at the real thing. (Phase 10)

**52. The app proposes output columns; the human disposes.** `Create columns from this template` makes
one Output Column and one `COPY` mapping per unmapped `Extract` field. A first book is almost always
1:1 field → column, so the hardest part of setup becomes one click and a round of renaming. This is the
product's own thesis — the machine does the first pass, the human corrects it — applied to setup instead
of only to data. It also dissolves four separate findings at once: no empty column list, no Settings
round-trip, no `DRAFT` template at the first extraction, no silently unfilled column. (Phase 10)

**53. AI-proposed templates are post-v1, not v1.** Same idea as 52 one level up: a photo in, a field tree
out, corrected by hand. Worth a phase of its own, not worth delaying launch, and proposing Phase 3.1's
groups and selection groups is much harder than proposing flat fields. (Post-v1 item 1; *superseded in
part by decision 73: flat fields were pulled into Phase 16 once the shell existed to put the paper beside the
tree.*)

**54. Both AI key sources: the user's own key and the server's.** A user can paste their own Gemini key;
the server key stays as the fallback for people the owner invites directly. BYO alone would have removed
the owner's cost exposure at the price of onboarding friction — "go make an API key" — landing in exactly
the first hour Phase 10 exists to smooth, for an audience that is explicitly non-technical. Server-key
alone would have put every stranger's extraction on the owner's bill. (Phase 12)

**55. Quota is not built until pricing is known.** Token counts have been recorded per run since Phase 5,
so the data to size a limit is already accumulating. Setting a number before hosted extraction is a real
cost line, and before per-document pricing is understood, prices the product blind. The trigger condition
is recorded in docs/09 §8 so it is not forgotten. (Phase 12)

**56. Cell review is timestamped from launch; the readouts come later.** The product's stated measure of
success is seconds per reviewed cell (docs/01 §1), and today that is not computable: marking a cell
reviewed writes no timestamp and no log row, and `Cell.updatedAt` is bumped by anything. The column is
tiny and the display can wait, but data not collected at launch cannot be recovered afterwards. (Phase 12)

**57. The review timestamp records how the cell was reviewed.** `Cell.reviewedVia` is `CELL` (a per-cell
confirm), `ROW` (a row-level `⌘Enter`) or `ILLEGIBLE` (`I`). A single row-mark reviews N cells at one
instant; averaged blindly, that makes any "seconds per cell" figure fiction. Deciding this at collection
time is free; discovering it later means the launch period's data is already useless. (Phase 12)

**58. Staleness means "the document changed since it was last read", not "a crop changed".** A page
replaced, added or transformed all invalidate the previous reading in the same way. A marker that caught
only transforms would be worse than none, because it would be trusted and would still miss a third of
the cases. A document is stale when `Document.contentChangedAt` is later than the latest successful run's
`finishedAt`. (Phase 11)

**59. A page can be replaced without destroying the document.** Today `completeUpload` takes only a
`templateId`, so every upload makes a new document, and `assertNoExtractionOutput` refuses to delete a
page of an extracted one. The only path left is deleting the whole document — losing its rows, its human
edits and its review state, which is the exact work the product exists to protect. Replace keeps the
`documentId` and `pageIndex`, soft-deletes the old photo so existing provenance still resolves, and
leaves rows and cells untouched. It then composes with 58 and the Phase 6 no-overwrite rule: replace →
marked stale → re-extract → edited cells survive. (Phase 11)

**60. The book remembers which tab you were on.** Opening a book always landed on Table, the tab that
stays empty longest for a new user and the most expensive to load for a returning one. The last tab is
kept per user and per book in `localStorage`, with a computed default when it is missing or unreadable;
a book with no templates always opens on Templates. Opening a book never drops the operator straight
into full-screen review — a `Resume review` button in the header does that explicitly. (Phase 10)

**61. The expected error rate is stated before the first extraction.** 40–50% on handwritten Burmese is
the premise the whole product is designed around (docs/01 §1), but "reviewing beats typing" is
counterintuitive at that rate, and session one is where a new user decides whether to believe it.
Discovering the number unprepared reads as a broken product; being told it first reads as an honest one
and turns a quit-moment into a confirmed prediction. The copy is scoped to the paper —
"on handwriting like this" — never to the product as a claim about its accuracy. (Phase 10)

**62. Mapping stays inside the template, but gets its own route.** It was considered as a fifth book tab.
Mappings belong to a Template, a book can hold several, and a book-level tab would need a template picker
that rebuilds the nesting with worse deep links. The editing loop — add a field, map it, read the
preview, fix the field — is three-quarters inside the template. The preview stays glued to the mapping
editor because it follows the *unsaved* draft; split out, it would become a read-only duplicate of the
Table tab. What was actually wrong was width and the lack of a URL, so Mapping becomes
`/templates/[id]/mapping` and the editor stops being squeezed by the book chrome. (Phase 10)

**63. `rawResponse` is kept on failures and stripped from old successes.** It is the full model response
for every run, held for ever, and the Phase 9 storage lifecycle covers photo objects rather than this
JSON, so it grows in Postgres without limit. A failed run is when the response is actually wanted;
a successful run older than 30 days loses it in the existing daily `storage.cleanup`. (Phase 12)

**64. The post-v1 order is provisional until real usage replaces the guess.** It was written before
anyone used the product. Its top items — vocabulary autocomplete and column sweep — both speed up
*review*, which is already the strongest part of the app, while setup is where users actually fail.
Launch, watch three real operators, then re-rank. (Post-v1)

**65. Team sharing moves up if the buyers need seats.** v1 is personal to one user, and team sharing sits
at post-v1 item 9. But operators do the work and operators do not buy software: the buyer is a clinic,
NGO or research manager. If the first paying conversations need multiple seats, that item is mispriced
where it sits. Do not move it on a guess — move it on a conversation. (Post-v1)

**66. Phases are never renumbered.** Phases 0–12 freeze as shipped and new work continues at 13.
63 code comments, 167 lines across docs/01–09 and 91 `decision N` references point at phases by
number; renumbering would silently invalidate every one of them, and the cost is paid by whoever
reads the codebase next rather than by whoever renumbers. (Phase 13)

**67. A workspace is a mode with its own layout, not a view of a record.** The four tabs were peers
carrying no order and no state, with Table — the tab that is empty longest and slowest to load —
first, so the working order lived only in the build plan. A workspace fills the viewport and owns
its layout, which is why a video editor has pages rather than tabs. The counts on the nav are what
make the bar a sequence rather than a list: an operator who sees `Review 412 left` does not need to
be told where to go next. (Phase 13)

**68. Settings becomes a gear, and panes are layout while routes are navigation.** Settings was a
peer of the three workspaces where the work actually happens, and Phase 14 is what makes it small
enough to be an icon; its route still works by URL. Separately, a pane's size and collapsed state
never enter the URL. Layout state in the URL breaks deep links and fills the back button with
states nobody navigated to — which is exactly why Phase 10 moved Mapping *to* a route: it is
navigation, and a pane split is not. (Phase 13)

**69. Targeted layouts, not responsive.** Three widths, three layouts: under 1280 is upload-only,
1280 is two panes, 1600+ is three or two with more density. Breakpoint-switched layouts are far
cheaper to build than fluid ones and more honest about what each device can do. Standing at the
filing cabinet with a phone is a real use; reviewing Burmese handwriting on one is not, so the
narrow layout offers upload and says plainly that review needs a wider screen rather than shipping
a version of review that cannot work. The workspaces are not rendered at all below 1280, so a phone
never mounts the virtualised table. (Phase 13)

**70. Light-first, and the photo pane decides every layout.** A video editor is dark so a bright
surround does not bias colour judgement. Here the job is reading pencil on white paper, and
contrast is the whole task, so the app stays light. For the same reason the pane holding the photo
never shrinks below readable — handwriting at 400px is guesswork — and every other pane yields to
it. (Phase 13)

**71. A sample document is a real Document with a specimen flag, not a separate object.** The page
an operator photographs to build a template against goes through the same upload, the same
processing, the same extraction and the same raw layer as everything else; `Document.isSpecimen` is
the only difference. A separate "sample, never extracted" object was rejected twice over: it would
make the operator upload the same page twice for reasons they cannot be told, and it would have been
a *fourth* photo-intake UI in a product that was already merging three. Because its rows are built
like any other document's, promotion is a flag flip — no re-extraction, no rebuild — which matters,
since the page reached for to build a template is usually a real page with real data on it.

The rule for what a specimen is left out of: **the numbers that mean *work to do*** — the output
table, the export, review progress, the template's document count, `Extract all` — and it stays in
**the numbers that mean *files I have***, the Documents list, because that is where promotion needs
a home. Those predicates were spelled out independently in five raw queries and two Prisma ones, so
they moved to `lib/db/scope.ts` first: one specimen rule, one place to change it. (Phase 15)

**72. Autosave replaces save-and-discard in the template editor.** Switching fields with unsaved
changes used to raise `Discard unsaved changes?`. Quick-add only sets a label and a type, so every
field is finished in the properties form, which made that modal a toll paid once per field while
building a twenty-field template. A template is owned by one user with no concurrent editing, so it
protected against nothing at all. Forms now save when focus leaves them and when another item is
picked, coalesced so the two paths produce one PATCH rather than two.

What the modal was nominally for — losing typed work — is handled by keeping it instead: a draft
that will not save is held by the workspace and restored with its message when the operator returns
to that field. The one case autosave genuinely adds is a save in the air during a document unload,
which now asks first, as row review and the batch upload already did. This assumes single-owner
editing and will need revisiting if team sharing arrives (docs/06 post-v1 #6). (Phase 15)

**73. The AI proposes flat fields only; groups and selection structure stay manual.** Phase 16 lets the AI
read a specimen and propose the template's fields, the one place the operator still authored from nothing.
It proposes a **flat** list. Groups, nested headers and `One of` / `Any of` groups (Phase 3.1) are much
harder to infer from a photo, and a wrong group costs more to undo than a missing one: its selection rule
changes how every option under it is read and flagged, so the operator has to understand and dismantle it,
not just delete a row. A missing group is one `+` on the tree.

The result is a **proposal, not a write** (docs/06 risk: *a wrong field list looks finished*). A proposal
is a toggle list plus a counted confirmation, and nothing reaches the template until the operator confirms.
The accept endpoint takes indexes into the stored proposal, never labels, so the client can't write anything
the model didn't say. It is a separate `FieldProposal` record, not an `ExtractionRun` with a kind, because
every run of a document is read as an extraction (its run state and raw layer), and a proposal is neither.
It records `promptVersion` (`template-v1`) and its tokens, because it costs money like extraction does.
The kind is asked first, as it always was at creation, because it changes the question. A form is every
labelled place a value goes, with a small grid expanded into its cells. A table is the grid's column headers
alone. Proposing structure is post-v1 #7, built only if real proposals show flat fields are the bottleneck.
(Phase 16)

**76. Numeral system and era are asked by exception, at the point of failure.** They are real: they
reach the prompt and the transform, and changing one rebuilds every row. But they describe *the
paper*, not the book, and an operator asked up front does not know what "Myanmar era" will do to
their data — the question arrives before the evidence that would answer it. So they default to
`AUTO` / `GREGORIAN` and are offered on the column that failed: a flag counting the values that did
not convert, and inside it *"Dates in this column aren't parsing. Is this paper using the Myanmar
era?"* with the fix in place. The offer is shown from structure rather than from an error message —
coercion never discards data, so a flagged cell still holding text its column's type would not
accept is a parse failure — which means rewording an error can never silently switch the offer off.
(Phase 14)

**77. The confidence threshold is deleted rather than defaulted.** It asked a non-technical operator
for a percentage controlling a dotted underline, over the model's *self-reported* confidence: the
prompt literally asks for "your own estimate from 0 to 1", and the settings help text already
conceded it was "only a hint". A tuning knob with no feedback loop over an uncalibrated signal is
worse than no knob, because it invites an operator to spend attention where attention buys nothing.
Defaulting it would have left the column and the question; dropping it leaves a constant in
`lib/table/cellState.ts` and nobody notices. The general rule the phase applied: every setting has to
beat "pick a good default and let them fix it where it is wrong." (Phase 14)

---

## Part C — Open questions for later

Not blocking v1, but worth revisiting once real data exists.

1. Should `TOTAL`/`SUBTOTAL` rows default to void, or be excluded from the output table
   entirely with an option to show them? Current answer: void but visible.
2. What is the right default for an unresolvable ditto at the very first row of a
   document? Current answer: leave empty, flag for review.
3. Should the sequence check be a validation rule (configurable severity) or a
   hard-coded document flag? Current answer: document flag in v1, promote to a rule
   later if users want to tune it.
4. When a document is re-extracted with a different model, should previous runs' raw
   values be kept for comparison, or superseded? Current answer: keep the
   `ExtractionRun` rows, supersede the raw values; revisit if model comparison becomes
   a real workflow.
5. Does the operator ever need to add a row by hand (a row with no source photo)?
   Likely yes for marginal insertions. `Row.rawRecordId` is nullable to allow it.
6. Does listing every table column (unwanted ones as Skip) measurably beat listing only the wanted
   ones? Current answer: list every column (decision 29). Validate in Phase 5 by running the same
   ~20 real photos through both template variants and comparing per-cell error rates, especially
   on narrow tick columns.
7. How does a mapping reference a selection group? Options: a new mapping kind, an `EXPRESSION`
   helper such as `oneOf(...)`, or a group reference on `MappingInput`. Answered in Phase 6: a group
   reference on `MappingInput` (decision 33).
8. Is a nesting depth of 3 enough? Current answer: yes for the forms seen so far; raise
   `MAX_GROUP_DEPTH` when a real form needs more (decision 31).
9. Should selection-group resolution failures (nothing / several ticked) surface as cell-level
   validation or as a document-level review flag? Confirmed in Phase 6: cell-level on the mapped
   cell (warning or error per the group's setting), and the document's `needsReview` through its
   `CELLS_FLAGGED` flag.
10. Should deleting or reordering a page of an already-extracted document be allowed, and what happens
    to the `RawRecord`s that point at it? Current answer: blocked. Phase 11 supports replace and add,
    which cover the real need (a re-shot page, an incompletely photographed form) without having to
    decide what a dangling record means.
11. Does BYO API key actually clear for a non-technical operator, or does it cost more signups than it
    saves in bill? Both key sources ship (decision 54); watch which one new users actually complete at.
12. When quota is finally built (decision 55), what is the right unit — documents, pages or tokens?
    Documents is what an operator counts, tokens is what the bill counts, pages is what the cost
    actually scales with. Answer it from the first months of recorded token data, not now.
13. Does the per-column correction rate (how often the AI's reading survived review) change what people
    do — switch a bad field to `MANUAL`, reword a note, change model? The data starts accumulating in
    Phase 12; the readout is only worth building if the answer is yes.
