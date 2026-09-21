# 04 — API Surface

Server Actions for mutations that originate from a form or a single UI control.
Route Handlers (`app/api/...`) for uploads, downloads, polling, and anything the
worker or a future client needs. Every entry point: Zod-validated input, ownership
guard, typed result.

## Conventions

- All handlers call `requireBookAccess(userId, bookId)` from `lib/auth/guards.ts`.
- List endpoints are cursor-paginated: `?cursor=&limit=` → `{ items, nextCursor }`.
- Mutations return `{ ok: true, data }` or `{ ok: false, error: { code, message, details } }`.
- Errors use stable codes: `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION`, `CONFLICT`,
  `RATE_LIMITED`, `PROVIDER_ERROR`, `INTERNAL`.
- Destructive endpoints take `confirm: true` **and** an `impact` hash returned by the
  matching preview endpoint, so the UI cannot skip the blast-radius check.

**Phase 9 as built:**
- Every `/api` response carries `X-Request-Id` (a well-formed incoming one is kept). Log lines of the request carry it
  as `requestId`, and jobs it enqueues carry it as `correlationId` (docs/09 §7).
- `RATE_LIMITED` responses are `429` with `Retry-After` (seconds) and `details: { retryAfterSeconds }`. Limits apply to
  `register`, `resend-verification`, `forgot`, `verify`, `reset`, credentials sign-in (failures only; the form shows
  "Too many sign-in attempts…"), and `extractions/start`, `retry`, `estimate`. Table and client-address rule in
  docs/09 §6.
- A non-JSON error response (a proxy page, a crash before the handler) reaches the UI as
  "The server had a problem (HTTP 502). Try again in a moment.", not as a connection problem.

## Auth
```
GET/POST /api/auth/*                Auth.js handlers (Google, credentials)
POST /api/auth/register             { email, password, name? } -> sends verification
POST /api/auth/verify               { token }
POST /api/auth/resend-verification  { email }
POST /api/auth/forgot               { email }
POST /api/auth/reset                { token, password }   signs out every session
```
- `register`, `resend-verification` and `forgot` return `{ emailSent: true }` whether or not
  an account exists, so they cannot be used to discover accounts.
- Credentials sign-in and sign-out are Server Actions (`lib/auth/actions.ts`), not routes.
- `GET /api/test/outbox?to=` returns the latest in-memory email for E2E tests. It returns 404
  unless `EMAIL_TRANSPORT=test`, and that transport is refused in production.

## Account

**Phase 12 as built.** Settings that belong to the person, not to a book (`/account`).
```
PUT    /api/account/ai-key                 { key } -> { hint }     saves this user's own Gemini key
DELETE /api/account/ai-key                 -> { hint: null }       falls back to the server key
```
- The key is encrypted at rest (`lib/crypto`, `ENCRYPTION_KEY`) and **never returned, logged or included
  in an error**. Both responses carry `hint`, the last four characters, which is all the UI shows.
- Neither endpoint checks the key against the provider: a model call costs money, so a bad key surfaces
  on the first run as `KEY_REFUSED`, worded to point back at this page.
- Rate limit `accountAiKey`, 10/minute per user.
- `PUT` is refused with `VALIDATION` when the deployment has no `ENCRYPTION_KEY`; the page says so
  rather than offering a field that cannot work.
- The page also reads total spend, derived from `ExtractionRun.inputTokens`/`outputTokens` priced per
  model. There is no quota (decision 55, docs/09 §8).

## Books
```
GET    /api/books                          list
POST   /api/books                          { name, defaultModel, columns[] }
GET    /api/books/:id                      book + columns + counts
GET    /api/books/:id/counts               (Phase 13) -> { documents, rows, unreviewedCells, runActive }
PATCH  /api/books/:id                      { name?, defaultModel?, numeralSystem?, dateEra?, exportPrefs?: { blankToken?, illegibleToken? } }
POST   /api/books/delete                   { ids[], impactHash, confirm } soft delete
POST   /api/books/delete-impact            { ids[] } -> { impactHash, books, documents, photos, rows, editedCells }
GET    /api/books/:id/delete-impact        same, for one book
```
Every id must be a live book the caller owns, otherwise the whole request is `NOT_FOUND`.

`/counts` feeds the workspace nav (docs/05 §0). It is seeded server-side on first paint, refetched
on navigation, and polled at 2s **only while `runActive`** — the last poll of a run carries
`runActive: false` with the finished counts, so the nav is right after an extraction without a
manual refresh. `unreviewedCells` comes from the same aggregate the review queue reports, so
`Review N left` and the review screen's progress bar cannot drift apart.

## Output columns
```
GET    /api/books/:id/columns
POST   /api/books/:id/columns/preview      { ops[] } -> impact report (see below)
POST   /api/books/:id/columns/apply        { ops[], impactHash, confirm }
```

`ops[]` is a diff, not a replacement, applied in order:
```jsonc
{ "kind": "add",    "tempId": "tmp_…", "afterId": "<id|tempId>" | null, "key", "label", "dataType", "enumValues", "isRequired" }
{ "kind": "update", "id", "key"?, "label"?, "dataType"?, "enumValues"?, "isRequired"? }
{ "kind": "delete", "id" }
{ "kind": "move",   "id", "afterId": "<id|tempId>" | null }   // null = first; writes exactly one row
```
Severity is the net effect: label/key/required/order and added list values are `SAFE`; new
columns are `ADDITIVE`; deletes, removed list values and type changes other than to `TEXT` are
`DESTRUCTIVE`. A deleted column's key is rewritten to `<key>~del~<id>` so the key can be reused.
New columns get an empty `Cell` in every existing row. Apply locks the book row, recomputes the
report and returns `CONFLICT` if the hash no longer matches.

**Impact report shape** (used by every destructive preview):
```jsonc
{
  "impactHash": "sha256:...",
  "severity": "SAFE" | "ADDITIVE" | "DESTRUCTIVE",
  "brokenMappings": [{ "templateId", "templateName", "columnLabel", "reason" }],
  "clearedColumns": ["columnId"],
  "affectedRows": 412,
  "affectedCells": 412,
  "editedCells": 38,
  "reviewedCells": 120
}
```

## New book from a book (Phase 17)
```
GET    /api/books/:id/copy                 -> { templates, columns, mappings, glossary, rules }
POST   /api/books/:id/copy                 { name } -> { id, templates, columns, mappings, glossary, rules, skippedMappings }   201
```
- One transaction. Copies live templates (source layers), live output columns, mappings (each following
  its column to the copy), glossary and validation rules (a `CROSS_COLUMN` rule's `otherColumnId` follows
  too), plus `defaultModel`, `numeralSystem`, `dateEra`, `blankToken`, `illegibleToken`. Never documents,
  photos or rows. Rules on a deleted column are not copied.
- `GET /api/books` items carry `cells` and `reviewedCells`, the same aggregate as the review progress bar.
  `?view=names` returns `{ id, name }` only, for pickers.

## Glossary & validation rules
```
GET/POST               /api/books/:id/glossary          { term, meaning }; list ordered by position
PATCH/DELETE           /api/books/:id/glossary/:entryId
GET/POST/PATCH/DELETE  /api/books/:id/rules
POST /api/books/:id/rules/revalidate       re-runs rules over all cells (queued job)
```

## Templates
```
GET    /api/books/:id/templates
POST   /api/books/:id/templates            { name, kind, modelOverride? }
GET    /api/templates/:id                  source layer + mapping layer + counts
PATCH  /api/templates/:id                  { name?, instructions?, anchors?, languageHint?, modelOverride?, doubleExtraction?, sequenceFieldId? }
GET    /api/templates/:id/duplicate        -> { fields, groups, selectionGroups, mappings }   what a copy carries
POST   /api/templates/:id/duplicate        { includeMappings, kind?, name?, targetBookId? }
                                              -> { id, bookId, fields, groups, mappings, skippedMappings, mappingsLeftBehind }
POST   /api/templates/delete               { ids[], impactHash, confirm }   soft-deletes templates and their documents
POST   /api/templates/delete-impact        { ids[] } -> { impactHash, templates, documents, photos, rows, editedCells }
GET    /api/templates/:id/delete-impact    same, for one template
```
- `PATCH` refuses `kind` (switching Form ↔ Table is structural); duplicate with `kind` instead.
  `doubleExtraction` only accepts `false` in v1. `sequenceFieldId` is TABLE-only and must be a
  live `EXTRACT` field; that field's mode can't change while it is the sequence field.
- `configState` is recomputed in the same transaction as every field create/delete/restore:
  `CONFLICTED` if any mapping is `BROKEN`, else `DRAFT` until ≥1 live field and ≥1 mapping, else `READY`.
- Within a book, mappings are copied only when `includeMappings` and every input field and the column
  are live; the rest are counted in `skippedMappings`. With a `targetBookId` of another book the user
  owns (Phase 17), mappings are **never** read or written — they name this book's columns — and
  `mappingsLeftBehind` counts them. Another user's book is `NOT_FOUND`.

### Field proposals (Phase 16)
```
POST   /api/templates/:id/field-proposals/estimate   { documentId, model? }
                                              -> { providerProblem, keySource, keyHint, blocker, pages,
                                                   estCostUsd, estSeconds, model }
POST   /api/templates/:id/field-proposals            { documentId, model, nonce } -> { id }   202
GET    /api/templates/:id/field-proposals?documentId= -> { proposal: FieldProposalView | null }
GET    /api/templates/:id/field-proposals/:proposalId -> FieldProposalView
POST   /api/templates/:id/field-proposals/:proposalId/accept   { include: number[] }
                                              -> { created, left, alreadyAccepted }   201
```
- The AI reads one **specimen** of the template and proposes flat fields (decision 73). Starting never calls
  the model: it records a `QUEUED` `FieldProposal` (with `promptVersion`) and enqueues `template.propose` on the
  extraction queue. Rate limit `fieldProposalStart`, 10 a minute per user; the estimate shares `extractionEstimate`.
- `blocker` (plain language) when the document isn't a specimen of this template, has a failed or still-processing
  photo, or has more than 8 photos. `startFieldProposal` refuses the same cases with `VALIDATION`, and a missing
  key with `PROVIDER_ERROR`. The nonce makes a double submit return the same proposal.
- `FieldProposalView`: `{ id, documentId, state: QUEUED|RUNNING|FAILED|COMPLETE, model, promptVersion, error,
  items: [{ index, labelSource, labelMeaning, dataType, choices, note, alreadyInTree }], acceptedAt, acceptedCount }`.
  `alreadyInTree` compares labels with the template's live fields. The `GET ?documentId=` form returns the newest
  unaccepted, non-failed proposal of that page from the last day, so a paid proposal survives closing the dialog.
  Polling re-enqueues one stuck `QUEUED` for a minute or `RUNNING` for fifteen.
- `accept` is the only write: `include` holds indexes into the **stored** items, never labels, so the client can't
  write anything the model didn't propose. The fields are created top-level after the last top-level sibling, in the
  proposal's order, as `EXTRACT`. `CONFLICT` if the proposal isn't `COMPLETE`. A second accept creates nothing and
  answers `alreadyAccepted: true`.

### Fields & groups
```
POST   /api/templates/:id/groups           { label }
PATCH  /api/groups/:id                     { label?, afterId? }       afterId: group id | null (first); writes one row
DELETE /api/groups/:id                     fields move to the end of Ungrouped

POST   /api/templates/:id/fields           { labelSource, labelMeaning?, dataType, mode, note?, groupId?, choices?, markSymbols? }
PATCH  /api/fields/:id                     any of the above + move: { groupId | null, afterId | null }; a move writes one row
GET    /api/fields/:id/delete-impact       impact report + { fields, fieldLabels, rawValues, clearsSequence }
POST   /api/fields/delete                  { ids[], impactHash, confirm }   soft delete, one template per call
POST   /api/fields/:id/restore             -> { field, sequenceRestored, mappingsRepaired, configState }
```
- Structural writes lock the template row, so concurrent moves can't compute the same position.
- Field delete keeps the row, its `RawValue`s and `MappingInput`s; mappings reading it turn `BROKEN`.
  If it was the sequence field, `Template.sequenceFieldId` is cleared but `Field.isSequence` stays
  set, so restore reinstates it (when the template has no other sequence field). Restore returns
  the field to its group and position and marks its mappings `OK` again when all their inputs and
  their column are live.
- `markSymbols` maps a symbol to `true`, `false` or `"count"`. `CHOICE` needs ≥1 choice; choices
  and symbols are cleared when the type changes away from `CHOICE`/`MARK`.

**Phase 3.1 changes** (nested groups and paper order; see docs/06):
```
POST   /api/templates/:id/groups            { labelSource, labelMeaning?, parentGroupId?, noneMarked?, multipleMarked?, note? }   starts as Header only
PATCH  /api/groups/:id                      any of the above except parentGroupId, + selection?, + move: { parentGroupId | null, after: { kind: "field" | "group", id } | null }
GET    /api/groups/:id/delete-impact        -> { impactHash, groupLabel, fields, groups, deletedFields, parentLabel }   counts for the confirmation
DELETE /api/groups/:id                      { impactHash, confirm } -> { movedFields, movedGroups }   children move up into the group's slot
POST   /api/templates/:id/fields            groupId is the parent group (any depth); appended at the end of that parent
                                           + typeOptions?: { date: { twoDigitYear, pivotYear } }   DATE fields only (Phase 6)
PATCH  /api/fields/:id                      move: { groupId | null, after: { kind: "field" | "group", id } | null }   replaces afterId
POST   /api/fields/:id/restore              -> { ..., placedOutside }
```
- `after` names a sibling of either kind because groups and fields share one order under a parent;
  null = first. A move still writes one row.
- `VALIDATION` refusals, each with a plain message: depth over `MAX_GROUP_DEPTH` (3, counting the
  moved group's subtree); a group under itself or a descendant; a selection group containing a
  non-`MARK` field or another selection group, or with fewer than 2 options; changing a field
  inside a selection group away from `MARK`. The nesting and non-`MARK` rules always apply. Fewer than
  2 options is refused only when the group had no problem before, so a group left with one option
  by a field delete can still be renamed (the editor shows the problem).
- A group is created as Header only: `selection` is set with PATCH once it holds 2 mark fields.
- Group delete is refused with `CONFLICT` when its `impactHash` no longer matches (counts or the
  children that move changed since the preview).
- Field create without `dataType` gets `MARK` inside a selection group, `TEXT` elsewhere.
- Restore lands in the field's group (a deleted group already handed it to the nearest surviving
  ancestor). If a non-`MARK` field would land inside a selection group, it's placed just after that
  group instead and `placedOutside` is true.
- Group responses carry `labelSource`, `labelMeaning`, `parentGroupId`, `position`, `selection`,
  `noneMarked`, `multipleMarked`, `note`. `GET /api/templates/:id` returns groups and fields flat;
  `lib/templates/tree.ts` builds the ordered tree and header paths.

### Mappings
```
GET    /api/templates/:id/mappings
POST   /api/templates/:id/mappings         { outputColumnId, kind, inputs[], separator?, splitBy?, splitIndex?, splitRegex?, constantValue?, expression?, fillDown? }
PATCH  /api/mappings/:id
DELETE /api/mappings/:id
POST   /api/templates/:id/mappings/validate   -> per-mapping OK/BROKEN + reasons
POST   /api/templates/:id/retransform         re-runs transform for all documents, no AI cost
```

`retransform` is the cheap path used after any mapping or normalisation change. It is
queued (it can touch thousands of rows) and reports progress like an extraction job.

**Phase 6 as built** (supersedes the lines above where they differ):
```
GET    /api/templates/:id/mappings              -> { mappings: MappingView[], columns[], extractedDocuments }
POST   /api/templates/:id/mappings              MappingDraft -> MappingView   201
PATCH  /api/mappings/:id                        MappingDraft (the full shape again) -> MappingView
GET    /api/mappings/:id/delete-impact          -> { impactHash, columnLabel, documents, clearedCells, editedCells }
DELETE /api/mappings/:id                        { impactHash, confirm } -> { configState }
POST   /api/templates/:id/mappings/validate     -> { mappings: [{ id, state, problem }], configState }
POST   /api/templates/:id/mappings/preview      { documentId?, draft?: MappingDraft & { id? } }
                                                -> { documents, document, rows (≤ 50), totalRows, flags, draftProblem }
GET    /api/templates/:id/specimens             -> { documents: [{ id, label, createdAt, photos }] }
                                                   Phase 15: the pages a template is built against, with
                                                   fresh presigned URLs; its own endpoint because the pane
                                                   refetches them after an upload or a crop
POST   /api/templates/:id/retransform           -> { state, done, total }   202
GET    /api/templates/:id/retransform           -> { state: "idle" | "queued" | "running", done, total,
                                                     lastRun: { documents, failed, error, finishedAt } | null }
```
```jsonc
// MappingDraft
{ "outputColumnId", "kind": "COPY" | "CONCAT" | "SPLIT" | "CONSTANT" | "EXPRESSION",
  "inputs": [{ "kind": "field", "id" } | { "kind": "group", "id", "optionValues": { "<optionFieldId>": "1" }, "noneValue": "Not tested" | null }],
  "separator", "splitBy", "splitIndex", "splitRegex", "constantValue", "expression", "fillDown" }
```
- Options that don't belong to the kind are cleared. For `EXPRESSION` the inputs are the `{id}` references in the
  expression (a group input sent with the same id keeps its option values).
- `VALIDATION`, each with a plain message: a column that already has a mapping in this template; a deleted column, field
  or group; a group that is header only or breaks its selection rules; wrong input count for the kind; a tick group as
  a Split input; a separator split without a part, or a pattern without a capture group or with a repeated repeating
  group; an expression that doesn't parse or uses anything outside the
  allow-list (docs/03 §9).
- `MappingView.problem` is worked out on read, so a mapping broken by a later change says why.
- Every create, update and delete queues a rebuild of the template's rows. The delete impact counts the cells that
  empty (values nobody edited) and the edited cells that keep their value; `CONFLICT` when the counts changed.
- `preview` writes nothing: the saved mappings, with the draft in place of the mapping it edits, applied to the chosen
  document's raw values (default: the most recently extracted). A draft that can't be saved comes back as
  `draftProblem` and the preview uses the saved mappings.
- `retransform` status is the template's pending or running job; when `idle`, `lastRun` is the last finished rebuild
  (kept a week): how many documents failed, or why it failed.
- `GET /api/groups/:id/delete-impact` also returns `brokenMappings` (mappings that read the group as a tick group).
- Document list items and details carry `transformFlags`; moving documents clears them.

## Documents & photos
```
GET    /api/books/:id/documents            filters: templateId, runState, needsReview, hasEdits, q, cursor
POST   /api/templates/:id/documents        { photoIds[] } group uploaded photos into documents
GET    /api/documents/:id
PATCH  /api/documents/:id                  { label?, position?, manualValues? }
POST   /api/documents/move                 { ids[], targetTemplateId, confirm }
GET    /api/documents/move-impact          { ids[], targetTemplateId } -> rows/cells/edits discarded
POST   /api/documents/delete               { ids[], confirm }
POST   /api/documents/:id/split            { photoIds[] } -> new document
POST   /api/documents/:id/reorder-photos   { photoIds[] in order }
```

**Move semantics:** field IDs differ between templates, so raw values cannot carry
over. Moving transfers photos, batch membership and page order; it deletes the raw
layer and derived rows; the document lands in `NEVER_RUN`. Warn hard when edits exist.

**Phase 4 as built** (supersedes the lines above where they differ):
```
GET    /api/books/:id/documents            ?templateId&runState&needsReview&hasEdits&reviewed&needsReextraction&q&cursor&limit
                                           ordered by position (code-unit collation); cursor is opaque
POST   /api/templates/:id/documents        { photoIds[] } -> { documentId, removedDocuments }
PATCH  /api/documents/:id                  { label?, manualValues?: { fieldId: string | null },
                                             isSpecimen? }   Phase 15: clearing it promotes a specimen
POST   /api/documents/delete-impact        { ids[] } -> { impactHash, documents, photos, rows, editedCells }
POST   /api/documents/delete               { ids[], impactHash, confirm }   soft delete
POST   /api/documents/move-impact          { ids[], targetTemplateId } -> { impactHash, targetTemplateName, documents,
                                           alreadyOnTarget, photos, rawValues, rows, cells, editedCells, reviewedCells,
                                           manualValueDocuments }
POST   /api/documents/move                 { ids[], targetTemplateId, impactHash, confirm }
POST   /api/documents/:id/split            { photoIds[] } -> { documentId }   new document placed right after
POST   /api/documents/:id/reorder-photos   { photoIds[] }   must list exactly the document's pages
```
- Grouping: the target is the document of the first listed photo; its pages become the listed photos in
  order, then its own unlisted pages. Documents left empty are soft-deleted. All photos must be on
  documents of that template.
- Group, split, page reorder and page delete lock the book row and are refused with `CONFLICT` for a
  document that has extraction runs or rows (its rows would stop matching its pages); move it to clear
  the extraction first.
- `manualValues` are stored exactly as typed; `null` clears one. Only live `MANUAL` fields of the
  document's template accept a value.
- Move also clears `manualValues`, `lastRunAt`, `lastModel`, `templateMatchScore`, `needsReview`, and
  keeps run history.

### Upload
```
POST   /api/uploads/batch                  { templateId } -> { batchId }   one implicit batch per upload session
POST   /api/uploads/presign                { templateId, filename, mimeType, byteSize } -> { url, key, headers }
POST   /api/uploads/complete               { key, templateId, filename, batchId?, isSpecimen? }
                                           -> { documentId, photo }   a specimen is born one (Phase 15)
GET    /api/photos/status?ids=a,b,c        poll processing state + image URLs
```
- The browser PUTs straight to storage. Content type and length are signed into the URL.
- `complete` checks the key belongs to the book and the object exists within 25 MB, then creates one
  document (label = filename) holding one `QUEUED` photo. One document per photo is the default.
  Completing the same key twice returns the same document.
- Processing never runs in the request. `complete` enqueues `photo.ingest` on the `media` queue. The
  worker sniffs the real file type, decodes HEIC, applies EXIF orientation and writes the base,
  working (≤2048px, JPEG q85) and thumbnail copies.
- A PDF is one document: its placeholder photo is replaced in place by one photo per page (≤100
  pages), each page rendered to PNG and ingested by its own job.
- A photo still `QUEUED` after a minute is re-enqueued when polled.
- Accepted types: JPEG, PNG, WebP, HEIC/HEIF, PDF.

### Photo editing
```
POST   /api/photos/:id/replace             { key, filename } -> { photo }        Phase 11: re-shoot this page
POST   /api/documents/:id/pages            { key, filename } -> { photo }        Phase 11: add a page at the end
PATCH  /api/photos/:id/transform           { crop?, rotate?, deskew? }  non-destructive
POST   /api/photos/:id/transform/reset
POST   /api/photos/:id/autodeskew          { rotate } -> { deskew }   suggestion for that turn; nothing saved
GET    /api/photos/:id/delete-impact       -> { impactHash, documentLabel, pages, deletesDocument }
DELETE /api/photos/:id                     { impactHash, confirm } -> { documentDeleted }
```
- The transform geometry is described in docs/02 → Photo storage and transforms.
- Saving a transform clears `workingKey` and enqueues `photo.render`. The render is stored only if the
  transform is still current when it finishes.
- A failed render never fails the photo. It stays `DONE` and editable, with `errorMessage` saying the
  edit wasn't applied. Saving again, even unchanged, retries the render. Polling re-enqueues renders
  that were never queued.
- Problems with the file itself (unreadable, too many PDF pages) fail ingest at once, without retries.
- Photos of a soft-deleted document or book are not processed.
- Marking a document's last run stale is Phase 5: the idempotency key includes the transform hash.
- `DELETE` removes the row and renumbers the pages; deleting the only page soft-deletes the document.
  Stored files stay until the Phase 9 storage cleanup.

**Phase 11 — replace and add:** both take a key from the usual `presign` + browser `PUT`; only the
*complete* step differs, so nothing about uploading changes.
- `replace` puts the new photo at the same `documentId` and `pageIndex` and soft-deletes the old one
  (`replacedAt`, `deletedAt`), linking the new one back with `replacesPhotoId`. Rows, cells, edits and
  reviewed marks are untouched. `assertNoExtractionOutput` is **not** applied to replace or add — that is
  the whole point; it still refuses delete, reorder, group and split. Replacing with a PDF is refused.
- `add` appends at `max(live pageIndex) + 1`, up to `MAX_DOCUMENT_PAGES`. A PDF is split as on upload.
- Both set `Document.contentChangedAt`, as does saving a transform, which is what earns the document its
  `Needs re-extraction` state. Completing the same key twice returns the existing photo and replaces once;
  a key already consumed by a *different* page or document is refused rather than silently ignored.
- Both are refused with `CONFLICT` while the document's `runState` is `QUEUED` or `RUNNING`. A run in
  flight holds the old page ids and cannot notice a swap, so it would finish reading the page that was
  replaced and stamp `lastExtractedAt` after `contentChangedAt` — leaving the document looking freshly
  read when it is not. A page replaced before its ingest job runs is skipped by ingest for the same reason.
- A replaced page's row is kept so provenance from existing rows still resolves to an image; its files age
  out through the normal tombstone path once it is older than the grace period.

## Extraction
```
GET    /api/models                                     available models + cost tier
POST   /api/extractions/estimate                       { documentIds[], model } -> { pages, estInputTokens, warnings }
POST   /api/extractions/start                          { documentIds[], model, nonce } -> { jobIds[] }
GET    /api/extractions/status?documentIds=a,b,c       poll: per-document runState + progress
POST   /api/extractions/retry                          { documentIds[] | photoIds[] }
POST   /api/extractions/cancel                         { documentIds[] }
GET    /api/runs/:id                                   run detail incl. rawResponse (debug)
```

`estimate` also returns warnings: documents with edited cells, documents flagged as
possible template mismatch, templates in `CONFLICTED` state.

**Phase 5 as built** (supersedes the lines above where they differ):
```
GET    /api/models                                     [{ id, label, description, costTier }]
POST   /api/extractions/estimate    { documentIds[] | templateId, model? }
                                    -> { documentIds, documents, extractable, pages, requests, estInputTokens, estSeconds,
                                         model, suggestedModel, warnings[], blockers: [{ documentId, label, reason }] }
POST   /api/extractions/start       { documentIds[] | templateId, model, nonce } -> { queued, alreadyStarted, skipped[] }
GET    /api/extractions/status?documentIds=a,b,c       [{ id, runState, contentState, needsReview, templateMatchScore,
                                                          lastRunAt, lastModel, pages: { total, done, failed } }]
POST   /api/extractions/retry       { documentIds[] | photoIds[] } -> same shape as start
GET    /api/runs/:id                run detail incl. rawResponse and record count
```
- `templateId` covers the template's live documents (up to 2,000). `suggestedModel` is the template's override
  when every document shares it, else the book default.
- Blockers skip a document, never the request: already extracting, no pages, pages still processing or failed,
  an edited page still rendering, no `EXTRACT` fields, a FORM with more than 8 pages.
- `start` creates one run per request (≤8 pages) per document with keys from docs/03 §7, locking up to 100
  document rows per transaction (in id order). If any key already exists the document counts as `alreadyStarted`
  and nothing is inserted, so a double click starts one run. One job per document, id `extract-{documentId}`:
  enqueueing while that job is waiting, backing off or running does nothing, and a finished one is replaced.
- `retry` re-runs pages whose current run failed (all of them, or only the listed `photoIds`). Its key is derived
  from the failed runs, so a double retry creates one run.
- `status` re-enqueues a document whose runs have been `QUEUED` for over a minute with nothing running (a lost job).
  Because enqueueing is a no-op while the document's job exists, polling never cuts a retry backoff short or
  resets its attempts.
- Moving documents that are extracting is refused with `CONFLICT`.
- `cancel` is not built (not in the Phase 5 scope).
- Phase 9: `estimate` also returns `providerProblem: string | null`, set when the server has no usable AI provider
  (Gemini without an API key); the dialog shows it and disables Extract, and `start` and `retry` refuse with
  `PROVIDER_ERROR`.
- **Phase 12:** `providerProblem` is resolved **per user**, not per server — someone with their own key can
  extract where the deployment has none, and a saved key that will not decrypt is a problem for that user
  alone. `estimate` also returns `keySource: "user" | "server" | "fake" | null` and `keyHint` (last four
  characters of the user's own key), so the dialog names whose key a run spends, plus `estOutputTokens` and
  `estCostUsd`. The dialog states the cost **in money**; tokens mean nothing to an operator. Output tokens are
  averaged from the book's own completed runs where it has any, and from constants on a first reading — a page
  of a TABLE register holds however many rows the paper holds. A run always uses the **book owner's** key.

## Output table
```
GET    /api/books/:id/rows                 cursor on position; ?columns=&filter=&needsReview=
PATCH  /api/cells/:id                      { value, reason? } -> writes CellEdit, sets isEdited
POST   /api/cells/bulk                     { edits: [{cellId, value}] }
POST   /api/cells/:id/revert               currentValue = extractedValue, isEdited = false
POST   /api/cells/review                   { cellIds[], isReviewed }
POST   /api/rows/reorder                   { rowId, beforeRowId?, afterRowId? } -> new fractional position
PATCH  /api/rows/:id                       { isVoid? }
POST   /api/rows/delete                    { ids[], confirm }
GET    /api/books/:id/review-queue         next unreviewed cells, ordered by column then row
```

`PATCH /api/cells/:id` must be idempotent enough for fast typing: debounce client-side
at ~400ms, and no-op when the value is unchanged.

**Phase 7 as built** (supersedes the lines above where they differ):
```
GET    /api/books/:id/table-meta           -> { columns, templates, columnSources: { templateId: { columnId: "MANUAL" | "SKIP" } },
                                                numeralSystem, dateEra, totalRows }
                                           Phase 14: confidenceThreshold is gone (a constant); the era and numerals are
                                           here so a column whose values won't parse can offer the fix (decision 76).
GET    /api/books/:id/rows                 ?cursor&limit (≤ 500) -> { columnIds, items: WireRow[], documents, nextCursor }
PATCH  /api/cells/:id                      { value, state?, editId? } -> CellChangeResult
POST   /api/cells/:id/revert               -> CellChangeResult
POST   /api/cells/:id/keep                 "Keep mine": clears disagreement -> CellChangeResult
POST   /api/cell-edits/:id/undo            -> CellChangeResult; CONFLICT once the cell changed again
POST   /api/cells/review                   { cellIds? , rowIds?, isReviewed, via? } -> { cells }
POST   /api/rows/reorder                   { rowId, afterRowId | null } -> { position, affected }
PATCH  /api/rows/:id                       { isVoid } -> { isVoid, affected }
POST   /api/rows/revert-impact             { ids[] } -> { impactHash, rows, editedCells, disagreements }
POST   /api/rows/revert                    { ids[], impactHash, confirm } -> { cells, affected, edits: [{ editId, rowId }] }
POST   /api/rows/delete-impact             { ids[] } -> { impactHash, rows, cells, editedCells, reviewedCells }
POST   /api/rows/delete                    { ids[], impactHash, confirm } -> { deleted, affected }   soft delete
```
```jsonc
// CellChangeResult
{ "cell": TableCell, "rowId", "editId": "<CellEdit id to undo>" | null,
  "affected": [{ "id", "rowId", "validationState", "validationMsgs" }] }   // other cells whose checks changed
```
- Rows come in manual order (`position` code-unit, then id), live rows of live documents and templates only. The wire
  format (`lib/table/wire.ts`) lists cells in `columnIds` order and leaves defaults out; `documents` covers the page.
  The browser loads every page, so view-only sorting, filters and header counts cover the whole book.
- `editId` on a save continues that editing session's log entry while it is the cell's latest change (docs/02 → Output
  table). Every cell change re-checks validation in the same transaction and returns what else changed.
- Reorder writes exactly one row. Sorting in the table never calls the server.

**Validation rules as built (Phase 7):**
```
GET    /api/books/:id/rules                -> RuleView[]  (rule + failing: cells it flags now, problem)
POST   /api/books/:id/rules                RuleDraft -> RuleView   201
PATCH  /api/books/:id/rules/:ruleId        RuleDraft (full shape) -> RuleView
DELETE /api/books/:id/rules/:ruleId        -> { deleted }
POST   /api/books/:id/rules/preview        RuleDraft -> { failing, problem }   writes nothing
POST   /api/books/:id/rules/revalidate     -> { pending }   202, queues `validation.book` on the transform queue
GET    /api/books/:id/rules/revalidate     -> { pending }
```
```jsonc
// RuleDraft
{ "outputColumnId", "severity": "WARNING" | "ERROR", "message": string | null, "enabled",
  "kind": "REQUIRED" | "TYPE" | "RANGE" | "LENGTH" | "REGEX" | "ENUM" | "UNIQUE" | "CROSS_COLUMN" | "MONOTONIC",
  "params": {} | { min, max } | { pattern } | { values[] } | { otherColumnId, operator: "LT" | "LTE" | "EQ" | "NEQ" | "GTE" | "GT" }
            | { strict } }
```
- `VALIDATION`, each with a plain message: a deleted column; a range on a column that isn't a number or date, bounds
  that don't parse (numbers plain, dates `YYYY-MM-DD`) or min above max; a pattern RE2 can't compile (no backreferences
  or lookarounds; code points as `\x{1000}`); comparing a column with itself or across kinds (number/date/text; text only `EQ`/`NEQ`);
  an increasing rule on a non-number, non-date column. Rule messages default to plain text written from the check.
- Create, update and delete lock the book and re-check the affected columns before answering. Output-column changes
  queue the book-wide re-check. Template-level overrides are deferred (docs/07 decision 40).
- `GET /rules` counts failures (it reads every cell); the Settings page renders the list without counts and fetches them after.

## Export
```
POST   /api/books/:id/export               { includeVoid, includeProvenance, columns? } -> { downloadUrl }
GET    /api/exports/:token                 streams CSV, UTF-8 with BOM
```
Export streams rather than buffering. Provenance columns when requested:
`_document`, `_template`, `_photo`, `_model`, `_reviewed`, `_confidence`.

**Phase 8 as built** (supersedes the lines above where they differ):
```
POST   /api/books/:id/export/preview       ExportOptions -> { rows, columns, cells, unreviewedCells, errorCells, warningCells }   writes nothing
POST   /api/books/:id/export               ExportOptions -> { downloadUrl: "/api/exports/<token>" }   valid 5 minutes
GET    /api/exports/:token                 text/csv; charset=utf-8, attachment; errors are plain text
```
```jsonc
// ExportOptions
{ "includeVoid": false, "includeProvenance": false, "columns"?: ["<column id>"],   // absent = all; always book order
  "blankToken"?: string, "illegibleToken"?: string }                               // default: the book's export settings
```
- The token is the options signed with HMAC-SHA256 (AUTH_SECRET), nothing stored (docs/07 decision 44). The download
  requires the same signed-in user and re-checks the book.
- File: BOM, header row of column `key`s, then rows in manual order (same order and live-row rules as `GET /rows`), CRLF,
  RFC 4180 quoting, 500 rows per page. A database error mid-stream aborts the download instead of ending the file early. Values are `currentValue` verbatim; `EMPTY` → blank token, `ILLEGIBLE` → illegible
  token, `DASH` → `-`, `NOT_APPLICABLE` → `N/A` (decision 43).
- Provenance: `_document` label, `_template` name, `_photo` page number, `_model` last model, `_reviewed` `yes` when every
  cell of the row is reviewed, `_confidence` the row's lowest cell confidence. `includeVoid` adds a `_void` column (`yes`/`no`).
- Preview counts cells of non-void rows over the chosen columns, as the table counts them.

## Review
Phase 8 as built:
```
GET    /api/books/:id/review-queue         ?cursor&limit (≤ 500) -> { items: [{ rowId, documentId, unreviewedCellIds }], nextCursor,
                                                progress: { cells, reviewedCells, documents, reviewedDocuments } }
GET    /api/rows/:id/sources               -> { rowId, photoId, bbox, cells: { columnId: { photoId, bbox, paths[] } } }
POST   /api/cells/review                   (Phase 7) marks cells or whole rows; row review batches rows marked quickly
```
- Review covers live, non-void rows and cells of live columns. A document counts once it has such a cell and is complete when
  all of them are reviewed; the Documents list shows `reviewed` and filters `?reviewed=true|false` on the same rule.
- A cell's region is the union of the boxes of the fields its column's working mapping reads (a selection group reads its
  option fields), on the record's page. `paths` are those fields' header paths.

**Phase 12:** `POST /api/cells/review` takes `via: "CELL" | "ROW" | "ILLEGIBLE"`, required when `isReviewed` is true and
ignored when it is false. It records **how** the cell was reviewed alongside `Cell.reviewedAt`: a per-cell confirm
(`Enter`), a row-level mark (`⌘Enter`, or the table's row menu), or `I` for unreadable. Without the source a single row
mark stamps N cells at one instant and every later "seconds per cell" figure is fiction (decision 57). Clearing a mark
nulls both columns. The `isReviewed: !input.isReviewed` filter already there is also what stops a row mark restamping a
cell the operator had confirmed on its own. Nothing reads these columns yet — the readouts are deliberately later, the
collection is not (decision 56).

## Worker-only internals

Not HTTP. The worker imports the same `lib/` code directly. Keep all business logic in
`lib/` so it is callable from both the Next.js process and the worker — no logic in
route handlers beyond validation, guard, call, respond.
