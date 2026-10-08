# 07 — Deferred Features & Decision Log

## Part A — Deferred features and their schema affordances

Everything here is **out of v1** but has its schema reserved, so adding it later needs
no migration and no data backfill.

| Feature | Reserved in schema | Notes |
|---|---|---|
| Double extraction | `Template.doubleExtraction`, `ExtractionRun.passIndex`, `RawValue.altValueText`, `RawValue.disagreement` | Run twice, diff, flag. 2× cost but genuinely calibrated uncertainty, unlike self-reported confidence. |
| Column sweep review | `RawValue.bbox`, `RawValue.photoId` | **Shipped in Phase 20**, with no schema change and no re-extraction: the boxes captured from v1 are what it crops. |
| Vocabulary autocomplete | none needed — derived from `Cell.currentValue` | Per-column value frequency, offered on edit; near-miss detection flags likely typos. Highest-value post-v1 item. |
| Batches | `Batch` model, `Document.batchId` | Upload sessions with metadata that can feed `CONSTANT` mappings, so `clinic_name` is set once per batch rather than extracted 400 times. |
| Book duplication | none needed | Three levels: structure only / structure + documents+photos / full copy including data. |
| Source-definition library | `Template.sourceDefId`, `Template.sourceDefVersion` | Portable source layers at account level. Books pin a version and pull updates opt-in with a diff. See Part B decision 4. |
| Edit reasons | `CellEdit.reason` | UI only; column exists from v1. |
| Team sharing | `Book.userId` → membership table later | Personal in v1. Concurrent editing of the output table is a separate design problem. |
| Perspective correction | `Photo.transform` JSON is open-ended | Add a `corners` key; crop/rotate/deskew ship in v1. |
| Cost calibration | `ExtractionRun.inputTokens/outputTokens` | Recorded from v1 so estimates can be calibrated against history. Surfaced as money in Phase 12; a quota is sized from it later (decision 55). |
| AI proposes the template | `FieldProposal` (Phase 16) | **Flat fields shipped in Phase 16** (decision 73); since Phase 24 each proposed name starts with the header above it (decision 84). Proposing which ticks belong together stays deferred (docs/06 post-v1 #7). `Create columns from this template` was its cheap half, shipped in Phase 10 (decisions 52, 53). |
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
sweep is the specialised tool, deferred but data-ready. *(Phase 20: column sweep shipped, inside the Review
workspace, recording reviews exactly as row review does.)*

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
alone would have put every stranger's extraction on the owner's bill. (Phase 12; *superseded by
decision 79: the server's key is the only one in use, and bring-your-own is dormant behind
`ENCRYPTION_KEY`.*)

**55. Quota is not built until pricing is known.** *(Superseded by decision 81: the balance was built
before the price, with enforcement off until a number is chosen.)* Token counts have been recorded per run since Phase 5,
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

*Superseded in part by decision 78:* the specimen flag stays, but promotion is no longer a flag flip,
and specimens left the Documents list.

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

**74. Cross-book copy now; a versioned library only when someone asks for one.** The second book is
where a recurring register lives: the same malaria form, next quarter. v1 could only copy a template
within its own book, so the second book meant re-authoring every field, group, selection rule, note and
mapping by hand. Two plain copies answer it. A **template copied into another book** takes its source
layer — fields, groups, selection settings, notes, anchors, language hint, instructions — and never its
mappings, because they name output columns that belong to the first book (decision 3: the source layer
is portable, the mapping layer is book-bound). It lands as `Draft`, and the target book's `Create columns
from this template` finishes it in one click; the confirmation counts what travels and what stays. A
**new book from a book** copies templates, columns, mappings, glossary and validation rules — and the
paper's numeral system, era and export tokens — but no documents, photos or rows. Because the columns
come too, each mapping and each cross-column rule follows its column to the copy, so a repeat book
arrives configured and empty. The versioned library (Part A) — books pinning a shared definition and
pulling updates with a diff — answers a need nobody has expressed: plain copies drift, and so far that
is what operators want, since next quarter's paper is allowed to differ. `sourceDefId` stays reserved.
(Phase 17)

**75. Jobs is a drawer on Documents, not a workspace.** Operators ask "what is happening right now?" and v1
had nowhere to answer it. Progress was a `Running 3/12` in a table column, and a failed page's reason was
two clicks deep in one document's history. Watching extraction deserves a real surface — per document, per
page, with the error and retry — but not a peer workspace. A queue is plumbing operators have no mental
model for. Splitting "start the run" (Documents) from "see the run" (Jobs) would also undo Phase 9.1's
finding that feedback belongs where the polling is.

So it is a drawer. It opens from the Documents header, and from any running or failed row on that document.
It lists what is being read, then what failed, then what finished in the last day.

A page's state there is its current run's, derived by the same function the document drawer uses, and
"retryable" is one shared rule. Two surfaces that could describe one page differently would be worse than
one. It needs no schema: per-page state was always derivable from `ExtractionRun.photoIds`.

Cancel stays unbuilt. Nobody has asked, and a half-cancelled multi-request document has no good meaning yet.
(Phase 18)

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

**78. Specimens belong to the template: in and out by copy, never a flag flip.** Decision 71 kept the
specimen a real Document, and that half stands — extraction, `Test on this page` and the reading pane all
depend on it. The other half, promotion as a flag flip from the Documents list, had four costs once used:
- **The template lost its reference page** the moment the page became real data.
- **A Test re-read real data.** Once a page was a document, testing new fields against it re-extracted
  a document whose rows were in the table and possibly edited. The only safe place for a test is a page
  nothing else depends on.
- **Specimens sat among real documents**, with a chip on every row explaining why the numbers didn't
  add up.
- **A page already uploaded couldn't be the reference** without photographing it again — the reverse
  flip would have taken its rows out of the table and the export.

So a specimen now lives only in its template, and a page crosses in either direction by copy. An
uploaded page is copied into a new, unread specimen; the document is untouched. A specimen is added to
the documents as a copy, and the template keeps it. When its test is current, the copy carries the
reading — runs, raw records and raw values, ids and pages remapped, values exactly as read, token counts
left off so spend is never counted twice — and the transform builds its rows for nothing. When the fields
or pages changed since the test, the copy is read again, and the confirmation says so and what it costs.

The copy is independent all the way down: every file is copied, not shared. The storage lifecycle would
in fact have kept a shared original alive (it never deletes a key a Photo row references), but a photo's
renders live under its own id, and an upload's idempotency check is keyed by `originalKey`, so two photos
on one key would make "was this upload already used?" ambiguous.

"Current" needed a column of its own. `Template.updatedAt` moves with every mapping save, because the
config state is recomputed on the template row, so a test would have looked stale after merely visiting
Mapping, and promotion would have paid for a read it didn't need. `fieldsChangedAt` moves only with what
a reading depends on: fields, groups, the language hint, instructions and the sequence field.

Repeat promotion is warned about, with the count and date of earlier copies, and not blocked: an operator
may really want a second copy, and `UNIQUE` rules flag the duplicate rows either way. (Specimens by copy)

**79. One AI key, the deployment's; sign-up by invitation; no money shown on it.** Decision 54 shipped
both key sources and described the server's as the fallback "for people the owner invites directly".
Nothing made that true: sign-up was open, so the fallback was for anyone. Two ways to close it. Require
a personal key from everyone who isn't invited — which sends a clinic's data-entry clerk to Google AI
Studio in the first hour, the hour decision 64 says users are lost in, and leaves the product with two
bills to explain. Or keep one key and bound who can use it. The second was chosen: it is the simpler
product, and it makes pricing one question (what a page costs the operator) instead of two.

What it costs is that the owner's exposure is now bounded by a list of email addresses and nothing
else. `SIGNUP_ALLOWED_EMAILS` gates the two places an account is created and the one place the key is
handed out, and never a sign-in: taking someone off stops their spending and leaves them their data.
Because it is the whole limit it fails closed — an unreadable value, or none at all in production,
stops the app rather than opening the door. Decision 55's quota is unchanged in substance
but changed in standing: it was a thing to build when the bill was worth naming, and is now the thing
that has to exist before the list can be removed.

Money is hidden where the server's key pays. Phase 12 put the estimate in money because the operator
was about to pay it. On the deployment's key they are not, the number is a cost rather than a price,
and a tester who has seen "$0.05 for 14 pages" has been given an anchor before any price exists. The
rule is stated once (`showsMoney`): money appears when the run lands on the operator's own bill.

Bring-your-own stays in the code, off. It is switched by `ENCRYPTION_KEY`, as it always was, and an
organisation with its own Google contract may yet ask for it. Delete it when pricing is settled and
nobody has. A paid-tier key is a condition of this decision, not a detail: operators' paper now goes
through the owner's Google account, and free-tier requests may be used to improve Google's models.
(Phase 21)

**80. One host, and it never builds.** Production is a single machine running Caddy, the app, the worker,
Postgres and Redis under Compose, with photos in an external bucket. A platform that runs each of those
as its own service costs several times as much at this size and buys nothing a few invited testers
need; the worker also has to be a long-running process, which rules out the serverless hosts. The first
deploy copied the checkout to that machine and built there, and `next build` then competed with the
live stack for 2 GB of memory. So CI builds: a push to `main` that passes the tests publishes an image
tagged with its commit, and the host only pulls. That also makes rollback a matter of naming an older
commit, where before it meant rebuilding one.

The image is public, because the repository is: it holds no secrets, and a public image spares the host
a registry credential. The host's `.env` is the one copy of the secrets and is never sent, overwritten
or read by the pipeline; GitHub holds only what it needs to log in. What this leaves open is that one
machine is one failure: the answer for now is the nightly dump and a host that can be rebuilt from
`docs/09` §9, not a second machine. (Deployment)

---

**81. Credits are a fixed slice of provider cost, kept as a ledger.** Decision 55 waited for pricing
before building a quota, and decision 79 made that quota the thing sign-up waits on. The owner's model
settled it: free credits at sign-up, more to buy later. What had to be chosen was the unit.

*Pages* are what an operator counts and what an earlier draft proposed. But a page is not a cost: a
full table register writes back several times what a short card does, so a flat page price either
loses money on registers or overcharges cards, and every later AI feature would need its own rule for
how many pages it is worth. *Tokens* are what the bill counts, but there is no single token price —
input and output are priced apart, and each model has its own — so one token balance cannot exist. A
**credit** is neither: $0.02 of provider cost at list price (`CREDIT_MICRO_USD`), about one simple
form page. Every reading is charged its real cost in credits, so one balance covers everything on any
model and nothing can cost the owner more than it charges. The price of a credit is deliberately not
in the code: it is set when credits are sold, and has to cover failed readings, payment fees and the
server as well as the provider.

The cost of this choice is that the amount is exact only afterwards. Before a reading the operator
sees an estimate; the charge is what the tokens came to. So the rule is that the *estimate* must fit:
a balance may end a little below zero and the next start is refused, rather than a reading being
stopped halfway with the owner's money already spent. And because a credit means less to a clerk than
a page, the account page translates the balance back into pages at what their own pages have cost.

It is a **ledger**, not a counter: a line for the free credits, for each grant, for each completed
reading and, later, for each purchase. Deriving usage from `ExtractionRun` would have let a user
delete a document to get its credits back, since runs cascade with their document; the ledger has no
foreign key to the run for the same reason `aiSpend` counts deleted books. What a queued or running
reading is holding is a column on the run rather than a ledger line, so a reading that fails needs no
refund on any of its paths: it stops being active and the hold is gone.

Two bounds, not one. Per-user credits cannot bound open sign-up alone — free credits times unlimited
accounts is unlimited — so `DAILY_CREDIT_CAP` limits everyone together, and production will not start
with sign-up open unless both are set. Failed readings are free to the operator even where the
provider billed the owner; the operator did nothing wrong, and that cost belongs in the price.
(Phase 22)

---

**82. How long the model thinks is one deployment setting, recorded on every reading.** `AI_THINKING`
changes what a reading costs and may change what it says, so readings made at different settings are
not comparable — the same reason a prompt is never edited in place. But it is not a prompt version:
the words sent are identical, and bumping `promptVersion` for it would say otherwise. So each
`ExtractionRun` and `FieldProposal` records the setting beside the prompt version, with the tokens
spent thinking.

It is a setting of the deployment, not of a book, a template or an operator. An operator cannot judge
"low or medium" any better than they could judge a confidence threshold (decision 77), and the
product's answer to a question like that is to pick for them. It is an environment variable rather
than a constant because the right value is found by reading real pages at two settings, and that
should not take a commit.

The provider boundary holds: the setting is `default | minimal | low | medium | high` in
`lib/ai/provider.ts`, and only `gemini.ts` knows what those are called there.

This decision was first written for a second setting of the same kind, how sharply the page image
is read. It was built, compared on real pages and removed: twice the image tokens read no better on
a sharp page and worse on a blurry one (docs/06, Phase 23). A setting that has lost its comparison
is not kept for later. (Phase 23)

---

**83. In a table answer, a cell left out is blank.** The first real register page read under prompt
`v1` — ten rows of twenty-eight columns — cost $0.22 with no thinking in it at all. The answer was
23,722 tokens, about 85 a cell, and some two hundred of the 280 cells were blank, each written out
in full with a 24-letter field id. At that rate a full page of twenty-five rows does not fit in what
the model can write, so it would be cut off, billed and worth nothing.

Prompt `v2` has the model list only the cells with something in them, by a short alias, and
validation stores every other Extract field of the row as `EMPTY`. The raw layer keeps its shape —
one value per field per row — so the transform, review and export are untouched.

What this gives up is a difference the answer used to carry. Under `v1` a cell the model skipped was
visibly missing; under `v2` it reads as blank. The honest `ILLEGIBLE` the product depends on now
rests on the model listing every cell it cannot read, so the prompt states it as a rule of its own and a unit test pins that validation
never turns a listed `ILLEGIBLE` into a blank. A form is left as it was: it is one record, so there
is nothing worth saving, and there a field left out means "not found on this page".

One thing was taken too far and put back. `v2` also let the model leave out `isDitto` when false
and did not require a bounding box. On its first real reading the model stopped writing both: no
ditto mark was flagged and most values had no box. Leaving out a *cell* is safe because validation
knows what an absent cell means; leaving out a *property* is not, because the model reads "optional"
as "skip". `v3` requires both again and `v4` the confidence figure too, which went the same way;
only `altValueText` may be absent.

Short property names, or a row as a bare array, would save more and were not taken: each makes the
answer harder for the model to get right and for a person to read in `rawResponse`. (Phase 23)

**84. A field is one box on the paper; the header is part of its name, and ticks are combined in the mapping.**
*Supersedes decisions 28 (in part), 30, 31 and 33, and moves the rules of 32 onto the mapping.*
Headers were rows of their own (`FieldGroup`) that fields sat inside, three levels deep, on the
reasoning that the model needs the header context (decision 28). That reasoning was never
measured, and the structure was expensive: a drag-to-indent tree, one order shared by two tables,
depth and move rules, re-parenting on delete.

It was measured on 2026-10-07. A plain header reaches the model only as extra words in a field's
`path`, so the question was whether those words need a tree behind them. A hand-made register with
the hard cases — `Temp` and `Weight` repeated under `Day 1` and `Day 3`, a three-level RDT header,
then the same page with half of the twin cells blanked so position alone could not place a value —
was read twice with a **flat** template that carried the header words as text. All 60 twin values
landed in the right column, including a row with only Day 3 filled, and every tick was read right
in 22 rows. Nesting and tick sets gave the AI nothing measurable. What did go wrong on that page
was handwriting (a whole column read `၁` as `၅` on one reading and not the other), which no
structure fixes.

The phase first stopped halfway: a header *property* on each field, a band drawn over neighbours
that shared one, and `FieldGroup` kept as a "tick set". Built and used, both were still things the
operator had to learn, with forms and rules of their own, for a result the plain version gives.
So the final shape has neither:

- **No header property.** The header is the front of the name, joined with ` › `
  (`၁ ရက်နေ့ › ကိုယ်ပူချိန်`, `RDT Test › Positive › A`), and `Propose fields` writes names that
  way. The operator may type any name. For the model the name is split on ` › ` back into the
  `path` elements a nested template sent, so the extraction prompt stays `v4` and a template that
  was nested sends the same field paths as before.
- **Same name twice is a warning, never a block.** The operator is told to put the header in front
  so the two can be told apart. Refusing would stop someone mid-transcription over something only
  they can judge.
- **A name's end is never cut off** where names are listed: it is the field's own words. Names
  wrap, or the headers in front are shortened.
- **No tick sets on the Fields side.** That one of two boxes is ticked is a fact about the paper
  (decision 32), but everything done with that fact — the value per box, what nothing ticked and
  several ticked mean — depends on the output table, and decision 32 already put half of it on the
  mapping. Now all of it is there: a mapping kind, **From ticks** (`TICKS`), lists the tick fields,
  the value each writes, only one or several, and both rules. Warnings still land on the cell.
- **A kind, not a reference** — the reverse of decision 33, whose group reference has nothing left
  to point at. A new kind does repeat a little of Copy and Join, but the rules only make sense
  when every input is a tick, so as options on Join they would need answers for mixed inputs that
  nobody wants to define. It also makes an input always a field with a real foreign key, so the
  field-or-group input, its `missing` state and the JSON keyed by field id are gone. What is given
  up: a tick answer as an input *inside* a Join or an Expression. They can still read single tick
  fields.
- **`Create columns from this template` proposes one column per tick field.** It does not guess
  which ticks belong together; the operator combines them. A wrong guess costs more to undo than
  a missing one (decision 73's reasoning, applied to mappings).

The part of decision 28 that stands is the other half: every tick column stays its own field, so
the model transcribes ticks and never chooses between them. The model is no longer told which
ticks belong together; the readings above are why that is expected to cost nothing.

Nothing that reaches a row changed. Two migrations carry production across (docs/06 Phase 24):
header words into the name, paper order as one list, and every mapping that read a tick set into a
From ticks mapping with the same fields in the same order, the value each wrote, the same rules
and the set's name for its warnings. Tick sets no mapping read are dropped; their fields stay.
Both were rehearsed on a copy of the dev database; the second compared every row the transform
builds for 168 documents, messages included, and found no difference.

Limits of the evidence: one page, one hand, two readings, and those readings had the header words
in the field's *note*. A third reading on the finished code (2026-10-08), same page and same
template, put all 71 cells in the same place as the one before it. **A reading where only the
header in the name tells twin columns apart has still not been compared**; if one goes wrong, the
note is the fallback that is known to work. (Phase 24)

**85. An Age field chooses its unit; years is the default.** Every Age field used to come out as total
months, so a paper `2` became `24` in the table. The reviewer checks a cell against the photo, and a
number that doesn't match the paper costs a calculation per cell. `Field.typeOptions.age.unit` is
`YEARS` (default), `MONTHS` or `YEARS_MONTHS` (text such as `1y 6m`, proposed as a Text column). It is
a transform setting, so changing it rebuilds rows without a new reading, and human edits are kept as
on any rebuild. An age that isn't an exact number of years (`4/12`) is rounded to two decimals with a
warning that points at Months. **A missing unit means `MONTHS`, not the default**: the service stamps
`YEARS` when a field is created as, proposed as, or changed to an Age, and a save that carries no unit
keeps the one the field has. So a lost setting (a browser tab from before the deploy, a migration that
didn't run) can never turn 18 into 1.5 across a book. Migration `20261008000002_age_unit` writes
`MONTHS` on every Age field that existed, for the record only. Known edges: a Years field sent to a
Whole number column, or a Years and months field sent to a Number column, flags its cells — the hint
under the setting says which column type to use; nothing blocks it. (2026-10-08)

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
11. ~~Does BYO API key actually clear for a non-technical operator, or does it cost more signups than it
    saves in bill?~~ Not put to the test: decision 79 chose one key before launch. It reopens only if an
    organisation asks to read on its own Google account.
12. ~~When quota is finally built (decision 55), what is the right unit — documents, pages or tokens?~~
    None of the three: a credit, a fixed slice of provider cost (decision 81). What is still open is
    what a credit sells for and how people pay, to be answered from the ledger and from `Request more`.
13. Does the per-column correction rate (how often the AI's reading survived review) change what people
    do — switch a bad field to `MANUAL`, reword a note, change model? The data starts accumulating in
    Phase 12; the readout is only worth building if the answer is yes.
