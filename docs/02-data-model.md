# 02 — Data Model

Postgres + Prisma. IDs are `cuid2`. Timestamps are `timestamptz`.

## Layer diagram

```
User
 └── Book ── OutputColumn, GlossaryEntry, ValidationRule
      ├── Template ── FieldGroup ── Field
      │         └── Mapping ── MappingInput
      └── Document ── Photo
                 ├── ExtractionRun
                 ├── RawRecord ── RawValue          <- verbatim AI output
                 └── Row ── Cell ── CellEdit        <- derived, deterministic
```

The **raw layer** (`RawRecord`/`RawValue`) is never edited by humans and never
normalised. The **output layer** (`Row`/`Cell`) is derived from it and is where humans
work. Re-running the transform rebuilds the output layer without touching the AI.

---

## Prisma schema

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

// ---------- Auth (Auth.js compatible) ----------

model User {
  id            String    @id @default(cuid())
  email         String    @unique
  emailVerified DateTime?
  name          String?
  image         String?
  passwordHash  String?   // null for OAuth-only users
  createdAt     DateTime  @default(now())
  accounts      Account[]
  sessions      Session[]
  books         Book[]
  cellEdits     CellEdit[]
}

model Account {
  id                String  @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String?
  access_token      String?
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String?
  session_state     String?
  user              User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([provider, providerAccountId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model VerificationToken {
  identifier String   // User.id
  token      String   @unique  // sha256 of the emailed token; the raw token is never stored
  expires    DateTime
  purpose    String   // EMAIL_VERIFY | PASSWORD_RESET
  @@unique([identifier, token])
}

// ---------- Book ----------

enum NumeralSystem { AUTO  LATIN  MYANMAR }
enum DateEra       { GREGORIAN  BUDDHIST  MYANMAR }

model Book {
  id            String   @id @default(cuid())
  userId        String
  name          String
  defaultModel  String   @default("gemini-3.5-flash")
  numeralSystem NumeralSystem @default(AUTO)
  dateEra       DateEra       @default(GREGORIAN)
  // export prefs
  blankToken     String  @default("")
  illegibleToken String  @default("?")
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?

  user          User @relation(fields: [userId], references: [id], onDelete: Cascade)
  columns       OutputColumn[]
  templates     Template[]
  documents     Document[]
  rows          Row[]
  glossary      GlossaryEntry[]
  rules         ValidationRule[]
  batches       Batch[]

  @@index([userId, deletedAt])
}

enum ColumnType { TEXT NUMBER INTEGER DATE BOOLEAN ENUM }

model OutputColumn {
  id         String     @id @default(cuid())
  bookId     String
  key        String     // stable machine key, used as CSV header
  label      String
  dataType   ColumnType @default(TEXT)
  enumValues String[]   @default([])
  position   String     // fractional index
  isRequired Boolean    @default(false)
  createdAt  DateTime   @default(now())
  deletedAt  DateTime?

  book     Book             @relation(fields: [bookId], references: [id], onDelete: Cascade)
  mappings Mapping[]
  cells    Cell[]
  rules    ValidationRule[]

  @@unique([bookId, key])
  @@index([bookId, deletedAt])
}

model GlossaryEntry {
  id       String @id @default(cuid())
  bookId   String
  term     String   // "1 1/2"
  meaning  String   // "1 year and 6 months"
  position String
  book     Book   @relation(fields: [bookId], references: [id], onDelete: Cascade)
  @@index([bookId])
}

// ---------- Template ----------

enum TemplateKind  { FORM  TABLE }
enum ConfigState   { DRAFT  READY  CONFLICTED }

model Template {
  id              String        @id @default(cuid())
  bookId          String
  name            String
  kind            TemplateKind
  configState     ConfigState   @default(DRAFT)
  modelOverride   String?
  doubleExtraction Boolean      @default(false)   // deferred feature, schema ready
  anchors         String[]      @default([])      // printed strings expected on the page
  languageHint    String?       // e.g. "my" (Burmese)
  instructions    String?       // free-text template-level note to the AI
  sequenceFieldId String?       // TABLE only
  position        String
  // reserved for the deferred source-definition library:
  sourceDefId      String?
  sourceDefVersion Int?
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  deletedAt       DateTime?

  book      Book        @relation(fields: [bookId], references: [id], onDelete: Cascade)
  groups    FieldGroup[]
  fields    Field[]
  mappings  Mapping[]
  documents Document[]

  @@index([bookId, deletedAt])
}

enum GroupSelection { NONE  ONE_OF  ANY_OF }   // Phase 3.1
enum NoneMarked     { BLANK  REVIEW  ERROR }   // Phase 3.1
enum MultipleMarked { REVIEW  ERROR }          // Phase 3.1

// A header on the paper. May span columns and nest (Phase 3.1). Never holds raw values.
model FieldGroup {
  id             String         @id @default(cuid())
  templateId     String
  parentGroupId  String?                           // Phase 3.1: null = top level; depth capped in code
  labelSource    String                            // Phase 3.1: renamed from `label`; as written on the paper
  labelMeaning   String?                           // Phase 3.1: English meaning
  position       String                            // shares one order with sibling fields (same parent)
  selection      GroupSelection @default(NONE)     // Phase 3.1: tick columns encoding one / many answers
  noneMarked     NoneMarked     @default(REVIEW)   // Phase 3.1: selection group with nothing ticked
  multipleMarked MultipleMarked @default(ERROR)    // Phase 3.1: ONE_OF group with 2+ ticks
  note           String?                           // Phase 3.1: instruction to the AI
  template       Template       @relation(fields: [templateId], references: [id], onDelete: Cascade)
  parent         FieldGroup?    @relation("GroupNesting", fields: [parentGroupId], references: [id], onDelete: Restrict)
  children       FieldGroup[]   @relation("GroupNesting")
  fields         Field[]
  @@index([templateId])
  @@index([parentGroupId])
}

enum FieldType { TEXT NUMBER INTEGER DATE MARK CHOICE AGE FRACTION }
enum FieldMode { EXTRACT SKIP MANUAL }

model Field {
  id           String    @id @default(cuid())
  templateId   String
  groupId      String?   // parent group; null = top level of the template
  labelSource  String    // as written on the paper, any script
  labelMeaning String?   // English meaning
  dataType     FieldType @default(TEXT)
  mode         FieldMode @default(EXTRACT)
  note         String?   // human-language hint to the AI
  choices      String[]  @default([])   // CHOICE
  markSymbols  Json?     // MARK: { "✓": true, "✗": false, "tally": "count" }
  isSequence   Boolean   @default(false)
  position     String
  createdAt    DateTime  @default(now())
  deletedAt    DateTime?  // soft delete: raw values are kept as orphans

  template      Template       @relation(fields: [templateId], references: [id], onDelete: Cascade)
  group         FieldGroup?    @relation(fields: [groupId], references: [id], onDelete: SetNull)
  rawValues     RawValue[]
  mappingInputs MappingInput[]

  @@index([templateId, deletedAt])
}

// ---------- Mapping ----------

enum MappingKind  { COPY CONCAT SPLIT CONSTANT EXPRESSION }
enum MappingState { OK BROKEN }

model Mapping {
  id             String       @id @default(cuid())
  templateId     String
  outputColumnId String
  kind           MappingKind
  state          MappingState @default(OK)
  separator      String?      // CONCAT, default ", "
  splitBy        String?      // SPLIT: delimiter
  splitIndex     Int?         // SPLIT: 0-based part
  splitRegex     String?      // SPLIT: alternative, first capture group
  constantValue  String?      // CONSTANT
  expression     String?      // EXPRESSION
  fillDown       Boolean      @default(true)  // resolve ditto marks for this column
  position       String

  template     Template     @relation(fields: [templateId], references: [id], onDelete: Cascade)
  outputColumn OutputColumn @relation(fields: [outputColumnId], references: [id], onDelete: Cascade)
  inputs       MappingInput[]

  @@index([templateId])
  @@index([outputColumnId])
}

model MappingInput {
  id        String @id @default(cuid())
  mappingId String
  fieldId   String
  position  Int
  mapping   Mapping @relation(fields: [mappingId], references: [id], onDelete: Cascade)
  field     Field   @relation(fields: [fieldId], references: [id], onDelete: Cascade)
  @@unique([mappingId, fieldId, position])
}

// ---------- Documents & photos ----------

enum RunState     { NEVER_RUN QUEUED RUNNING PARTIAL FAILED COMPLETE }
enum ContentState { UNKNOWN HAS_CONTENT EMPTY NO_ROWS_FOUND }
enum PhotoStatus  { DRAFT QUEUED PROCESSING FAILED DONE }

model Batch {              // reserved; v1 creates a single implicit batch per upload
  id        String   @id @default(cuid())
  bookId    String
  label     String?
  metadata  Json?    // clinic name, date received — can feed CONSTANT mappings later
  createdAt DateTime @default(now())
  book      Book       @relation(fields: [bookId], references: [id], onDelete: Cascade)
  documents Document[]
  @@index([bookId])
}

model Document {
  id                 String       @id @default(cuid())
  bookId             String
  templateId         String
  batchId            String?
  label              String?      // defaults to first photo filename
  position           String
  runState           RunState     @default(NEVER_RUN)
  contentState       ContentState @default(UNKNOWN)
  templateMatchScore Float?       // anchor detection, 0..1
  needsReview        Boolean      @default(false)
  lastRunAt          DateTime?
  lastModel          String?
  manualValues       Json?        // MANUAL-mode field values: { fieldId: value }
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt
  deletedAt          DateTime?

  book     Book           @relation(fields: [bookId], references: [id], onDelete: Cascade)
  template Template       @relation(fields: [templateId], references: [id], onDelete: Cascade)
  batch    Batch?         @relation(fields: [batchId], references: [id], onDelete: SetNull)
  photos   Photo[]
  runs     ExtractionRun[]
  records  RawRecord[]
  rows     Row[]

  @@index([bookId, deletedAt])
  @@index([templateId, runState])
}

model Photo {
  id             String      @id @default(cuid())
  documentId     String
  pageIndex      Int
  originalKey    String      // immutable object storage key
  workingKey     String?     // max 2048px derived copy sent to the model
  thumbKey       String?
  mimeType       String
  width          Int
  height         Int
  byteSize       Int
  transform      Json?       // { crop:{x,y,w,h}, rotate:number, deskew:number }
  status         PhotoStatus @default(DRAFT)
  errorMessage   String?
  createdAt      DateTime    @default(now())

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  @@index([documentId, pageIndex])
}

// ---------- Extraction runs ----------

model ExtractionRun {
  id             String   @id @default(cuid())
  documentId     String
  model          String
  promptVersion  String
  passIndex      Int      @default(0)   // 1 for the second pass of double extraction
  idempotencyKey String   @unique
  state          RunState @default(QUEUED)
  startedAt      DateTime?
  finishedAt     DateTime?
  error          String?
  inputTokens    Int?
  outputTokens   Int?
  rawResponse    Json?    // full model response, for debugging

  document Document    @relation(fields: [documentId], references: [id], onDelete: Cascade)
  records  RawRecord[]
  @@index([documentId, createdAtIdx])
  @@index([state])
}

// ---------- Raw layer (verbatim, never normalised) ----------

enum RowType    { DATA HEADER SUBTOTAL TOTAL NOTE }
enum ValueState { OK ILLEGIBLE EMPTY DASH NOT_APPLICABLE }

model RawRecord {
  id            String   @id @default(cuid())
  documentId    String
  runId         String
  recordIndex   Int      // 0 for FORM; source row order for TABLE
  rowType       RowType  @default(DATA)
  struckThrough Boolean  @default(false)
  sequenceValue String?  // verbatim value of the sequence field
  photoId       String?  // which page this record came from
  bbox          Json?    // { x, y, w, h } normalised 0..1 on that photo
  duplicateOf   String?  // set by overlap dedupe
  createdAt     DateTime @default(now())

  document Document      @relation(fields: [documentId], references: [id], onDelete: Cascade)
  run      ExtractionRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  values   RawValue[]
  rows     Row[]

  @@index([documentId, recordIndex])
  @@index([runId])
}

model RawValue {
  id            String     @id @default(cuid())
  rawRecordId   String
  fieldId       String
  valueText     String?    // EXACTLY as read. Ditto marks stored as the literal token.
  altValueText  String?    // visible correction, or second-pass value
  state         ValueState @default(OK)
  isDitto       Boolean    @default(false)
  confidence    Float?     // model self-report: a sort order, not a truth
  disagreement  Boolean    @default(false)  // double extraction mismatch
  photoId       String?
  bbox          Json?      // normalised region; powers review crops

  record RawRecord @relation(fields: [rawRecordId], references: [id], onDelete: Cascade)
  field  Field     @relation(fields: [fieldId], references: [id], onDelete: Cascade)

  @@unique([rawRecordId, fieldId])
  @@index([fieldId])
}

// ---------- Output layer (derived, human-edited) ----------

enum ValidationState { NONE WARNING ERROR }

model Row {
  id          String  @id @default(cuid())
  bookId      String
  documentId  String
  rawRecordId String?
  position    String  // fractional index; canonical manual order
  isVoid      Boolean @default(false)
  createdAt   DateTime @default(now())

  book      Book       @relation(fields: [bookId], references: [id], onDelete: Cascade)
  document  Document   @relation(fields: [documentId], references: [id], onDelete: Cascade)
  rawRecord RawRecord? @relation(fields: [rawRecordId], references: [id], onDelete: SetNull)
  cells     Cell[]

  @@index([bookId, position])
  @@index([documentId])
}

model Cell {
  id              String          @id @default(cuid())
  rowId           String
  outputColumnId  String
  extractedValue  String?         // post-transform, pre-human
  currentValue    String?         // what exports
  state           ValueState      @default(OK)
  isEdited        Boolean         @default(false)
  isReviewed      Boolean         @default(false)
  inherited       Boolean         @default(false)  // resolved from a ditto mark
  confidence      Float?
  disagreement    Boolean         @default(false)  // re-extraction differs from an edit
  validationState ValidationState @default(NONE)
  validationMsgs  String[]        @default([])
  updatedAt       DateTime        @updatedAt

  row    Row          @relation(fields: [rowId], references: [id], onDelete: Cascade)
  column OutputColumn @relation(fields: [outputColumnId], references: [id], onDelete: Cascade)
  edits  CellEdit[]

  @@unique([rowId, outputColumnId])
  @@index([outputColumnId, validationState])
  @@index([rowId])
}

model CellEdit {
  id            String   @id @default(cuid())
  cellId        String
  userId        String
  previousValue String?
  newValue      String?
  reason        String?   // UI deferred; column present from v1
  createdAt     DateTime @default(now())

  cell Cell @relation(fields: [cellId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([cellId, createdAt])
}

// ---------- Validation ----------

enum RuleKind     { REQUIRED TYPE RANGE LENGTH REGEX ENUM UNIQUE CROSS_COLUMN MONOTONIC }
enum RuleSeverity { WARNING ERROR }

model ValidationRule {
  id             String       @id @default(cuid())
  bookId         String
  outputColumnId String?
  kind           RuleKind
  params         Json         // { min, max, pattern, otherColumnId, operator, ... }
  message        String?
  severity       RuleSeverity @default(WARNING)
  enabled        Boolean      @default(true)

  book   Book          @relation(fields: [bookId], references: [id], onDelete: Cascade)
  column OutputColumn? @relation(fields: [outputColumnId], references: [id], onDelete: Cascade)
  @@index([bookId])
}
```

> Note: `ExtractionRun` needs a `createdAt DateTime @default(now())` field — add it and
> fix the index name (`@@index([documentId, createdAt])`) when writing the real schema.

## Key invariants

1. **Mappings reference IDs only.** Renaming a field or column never breaks anything.
2. **Soft-deleted fields keep their `RawValue` rows.** Undo and re-mapping stay cheap.
3. **`Cell.currentValue` is what exports.** `extractedValue` is the AI's answer and is
   preserved forever so "revert to extracted" always works.
4. **Re-extraction never writes `currentValue` on a cell where `isEdited = true`.**
   It writes `extractedValue` and sets `disagreement = true`.
5. **One `Cell` per (row, column).** Unmapped columns still get a Cell, empty.
6. **`Row.position` is a fractional index string.** Use the `fractional-indexing`
   package. Drag-reorder is a single-row update. Column sorting is client-side view
   state and never writes.
7. **A FORM document has exactly 0 or 1 `RawRecord`.** A TABLE document has 0..N.
8. **`Template.configState = CONFLICTED`** iff any of its mappings is `BROKEN`.
9. **Siblings share one order (Phase 3.1).** Under one parent (the template root, or a group),
   child `FieldGroup`s and `Field`s share a single fractional position space: display order
   merges `FieldGroup.position` and `Field.position` for rows with the same `templateId` and
   parent (`parentGroupId` / `groupId`). A move names the new parent and the sibling it goes
   after, of either kind, and writes one row. Comparisons are code-unit (`COLLATE "C"`), ties
   broken by id.
10. **Group depth is capped in code, not in the schema.** `MAX_GROUP_DEPTH = 3` today; raising it
    needs no migration. A group can never be moved under itself or a descendant. Trees are built
    in memory from at most 100 groups and 500 fields; no recursive SQL.
11. **Every physical column or answer box is a `Field`; groups are headers only.** Groups never
    own raw values. A selection group (`ONE_OF` / `ANY_OF`) is resolved in the transform from its
    descendant `MARK` fields' raw values; its options are those fields in `EXTRACT` or `MANUAL`
    mode. Selection groups don't nest inside each other and contain no non-`MARK` fields.
12. **Deleting a group never deletes or orphans a field.** Groups are hard-deleted, but first
    their child groups and live fields move up one level into the group's slot (order kept), and
    soft-deleted fields are re-parented to the group's parent so a restore lands on the nearest
    surviving ancestor. `parentGroupId` is `onDelete: Restrict`, so a group can never disappear
    with children still attached.

## Photo storage and transforms (Phase 4)

No schema change. Object keys:

```
books/{bookId}/uploads/{uploadId}/original.{ext}   Photo.originalKey — written once by the browser, never by the server
books/{bookId}/pages/{uploadId}/page-NNN.png       Photo.originalKey of a PDF page — rendered once at ingest
books/{bookId}/photos/{photoId}/base.jpg           upright (EXIF applied), ≤2048px, no transform — editor and auto-deskew
books/{bookId}/photos/{photoId}/working-{th}.jpg   Photo.workingKey — transform applied, ≤2048px, sent to the model
books/{bookId}/photos/{photoId}/thumb-{th}.jpg     Photo.thumbKey — transform applied
```

`{th}` is a prefix of the transform hash, so a slow render for an old transform never overwrites the
copy for the current one. The storage helper refuses server writes under `uploads/`.

`Photo.transform` is `{ crop: {x,y,w,h} | null, rotate, deskew }`; `null` means no transform.
- Rendering rotates the upright original by `rotate + deskew` degrees (clockwise) about its centre. The
  canvas expands to the rotated bounding box and the new area is filled white. The crop is then taken
  in that box's coordinates, normalised 0..1.
- `deskew` is limited to ±15°.
- `lib/photos/transform.ts` holds this geometry, and both the editor preview and the worker use it.
- `Photo.width/height` are the upright dimensions of the original. They are 0 until the photo is
  processed.

Documents are ordered by `position` compared code-unit (`COLLATE "C"`), ties by id, like field
positions (invariant 9).

## Extraction runs (Phase 5)

One additive migration: `ExtractionRun.photoIds String[]`, the pages sent in that model call, in page order.
A document of more than 8 pages is split into several runs (docs/03 §6); a retry creates a new run for the
failed pages only.

- **Current run of a page** = the newest run whose `photoIds` contain it. The document's `runState` rolls up the
  current runs: any active → `RUNNING` (`QUEUED` if none has started), all complete → `COMPLETE`, all failed →
  `FAILED`, otherwise `PARTIAL`.
- `rawResponse` is `{ summary?: { contentState, anchorsFound, records }, responses: [{ attempt, text, issues }] }`.
  `summary` is present on completed runs and is what `contentState`, `templateMatchScore` and `needsReview` are
  rolled up from, once no run of the document is active.
- A completed run replaces, in the same transaction, the raw records of older runs on the same pages. Older runs
  stay as history (docs/07 Part C question 4). Records on other pages are kept, so a partial retry loses nothing.
- `RawRecord.recordIndex` = first page index of the request × 1000 + position in the response, so reading order
  holds across requests. A FORM has one request, so its record is 0. `RawRecord.bbox` is the union of its values'
  boxes. Values for `SKIP` fields are never written.

## Indexing notes

- The output table query is `Row where bookId, order by position` with cells joined.
  For a few thousand rows, fetch rows page-by-page (cursor on `position`) and their
  cells in a second query keyed by `rowId in (...)`.
- Needs-review counts are expensive if computed live. Maintain denormalised counters
  on `Document` (`unreviewedCells`, `errorCells`) updated in the same transaction as
  cell writes, or compute them in a periodic job. Start with a live `groupBy` and
  denormalise only if it becomes slow.
