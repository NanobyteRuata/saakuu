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
| Cost calibration | `ExtractionRun.inputTokens/outputTokens` | Recorded from v1 so estimates can be calibrated against history. |

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
