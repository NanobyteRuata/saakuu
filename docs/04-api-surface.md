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

## Books
```
GET    /api/books                          list
POST   /api/books                          { name, defaultModel, columns[] }
GET    /api/books/:id                      book + columns + counts
PATCH  /api/books/:id                      { name?, defaultModel?, numeralSystem?, dateEra?, exportPrefs?: { blankToken?, illegibleToken? } }
POST   /api/books/delete                   { ids[], impactHash, confirm } soft delete
POST   /api/books/delete-impact            { ids[] } -> { impactHash, books, documents, photos, rows, editedCells }
GET    /api/books/:id/delete-impact        same, for one book
```
Every id must be a live book the caller owns, otherwise the whole request is `NOT_FOUND`.

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
POST   /api/templates/:id/duplicate        { includeMappings, kind?, name? } -> { id, skippedMappings }
POST   /api/templates/delete               { ids[], impactHash, confirm }   soft-deletes templates and their documents
POST   /api/templates/delete-impact        { ids[] } -> { impactHash, templates, documents, photos, rows, editedCells }
GET    /api/templates/:id/delete-impact    same, for one template
```
- `PATCH` refuses `kind` (switching Form ↔ Table is structural); duplicate with `kind` instead.
  `doubleExtraction` only accepts `false` in v1. `sequenceFieldId` is TABLE-only and must be a
  live `EXTRACT` field; that field's mode can't change while it is the sequence field.
- `configState` is recomputed in the same transaction as every field create/delete/restore:
  `CONFLICTED` if any mapping is `BROKEN`, else `DRAFT` until ≥1 live field and ≥1 mapping, else `READY`.
- Cross-book duplicate (`targetBookId`) is deferred. Mappings are copied only when every input
  field and the column are live; the rest are counted in `skippedMappings`.

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
GET    /api/books/:id/documents            ?templateId&runState&needsReview&hasEdits&q&cursor&limit
                                           ordered by position (code-unit collation); cursor is opaque
POST   /api/templates/:id/documents        { photoIds[] } -> { documentId, removedDocuments }
PATCH  /api/documents/:id                  { label?, manualValues?: { fieldId: string | null } }
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
POST   /api/uploads/complete               { key, templateId, filename, batchId? } -> { documentId, photo }
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

## Export
```
POST   /api/books/:id/export               { includeVoid, includeProvenance, columns? } -> { downloadUrl }
GET    /api/exports/:token                 streams CSV, UTF-8 with BOM
```
Export streams rather than buffering. Provenance columns when requested:
`_document`, `_template`, `_photo`, `_model`, `_reviewed`, `_confidence`.

## Worker-only internals

Not HTTP. The worker imports the same `lib/` code directly. Keep all business logic in
`lib/` so it is callable from both the Next.js process and the worker — no logic in
route handlers beyond validation, guard, call, respond.
