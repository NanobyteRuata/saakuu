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
POST   /api/templates/:id/groups            { labelSource, labelMeaning?, parentGroupId?, selection?, noneMarked?, multipleMarked?, note? }
PATCH  /api/groups/:id                      any of the above except parentGroupId, + move: { parentGroupId | null, after: { kind: "field" | "group", id } | null }
GET    /api/groups/:id/delete-impact        -> { fields, groups, deletedFields, parentLabel }   counts for the confirmation
DELETE /api/groups/:id                      -> { movedFields, movedGroups }   children move up into the group's slot
POST   /api/templates/:id/fields            groupId is the parent group (any depth); appended at the end of that parent
PATCH  /api/fields/:id                      move: { groupId | null, after: { kind: "field" | "group", id } | null }   replaces afterId
```
- `after` names a sibling of either kind because groups and fields share one order under a parent;
  null = first. A move still writes one row.
- `VALIDATION` refusals, each with a plain message: depth over `MAX_GROUP_DEPTH` (3, counting the
  moved group's subtree); a group under itself or a descendant; a selection group containing a
  non-`MARK` field or another selection group, or with fewer than 2 options; changing a field
  inside a selection group away from `MARK`.
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

### Upload
```
POST   /api/uploads/presign                { filename, mimeType, byteSize } -> { url, key }
POST   /api/uploads/complete               { key, templateId, documentId? }
```
Server-side on complete: read EXIF and apply orientation, convert HEIC → JPEG, split
PDFs into per-page images, generate `workingKey` (max 2048px) and `thumbKey`, create
the `Photo` row. Reject files over 25 MB and non-image/PDF MIME types.

### Photo editing
```
PATCH  /api/photos/:id/transform           { crop?, rotate?, deskew? }  non-destructive
POST   /api/photos/:id/transform/reset
POST   /api/photos/:id/autodeskew          -> suggested angle
DELETE /api/photos/:id
```
Changing a transform invalidates `workingKey`; regenerate lazily on next extraction
and mark the document as stale (its last run no longer matches its inputs).

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
