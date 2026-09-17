import type { ComputedCell, ComputedRow, Issue, ValidationState, ValueState } from "./types";

/**
 * Merging computed rows into the rows and cells already stored (docs/03 §8 step 9). Pure: it decides
 * every write, so the rule that re-runs never overwrite a human edit is enforced and tested here.
 *
 * - Rows match by raw record, then by record key (the sequence value, or position for tables without
 *   one), so a re-extraction finds the rows it replaces.
 * - A cell nobody edited takes the new value. It stays reviewed only if its value didn't change.
 * - An edited cell keeps `currentValue`. Only `extractedValue` moves; when the new reading differs from
 *   the previous reading and from your value, `disagreement` is raised and the cell is unreviewed.
 * - A row void by rule follows the rule; a row whose void state you changed keeps your choice.
 * - A row no longer produced is deleted, unless it holds edits: then it is kept, void, as `ORPHANED`.
 * - A row deleted by hand is matched like any other and stays deleted: the merge never writes `deletedAt`.
 *
 * Validation state is not decided here: after the plan is written, `revalidate` (lib/validation) combines each
 * cell's build issues with the book's rules. `validationState` on a created cell is only a first value.
 */

export type CellValues = {
  extractedValue: string | null;
  currentValue: string | null;
  state: ValueState;
  /** The state of `extractedValue`; `state` follows `currentValue`. */
  extractedState: ValueState;
  buildIssues: Issue[];
  isEdited: boolean;
  isReviewed: boolean;
  inherited: boolean;
  confidence: number | null;
  disagreement: boolean;
  validationState: ValidationState;
  validationMsgs: string[];
};

export type ExistingCell = CellValues & { id: string; outputColumnId: string };

export type ExistingRow = {
  id: string;
  rawRecordId: string | null;
  recordKey: string | null;
  isVoid: boolean;
  voidReason: string | null;
  cells: ExistingCell[];
};

/** Where new rows go in the book's manual order: after or before a row of the same document, or at the document's place. */
export type RowAnchor = { after: string } | { before: string } | { document: true };

export type RowWrite = { id: string; rawRecordId: string | null; recordKey: string | null; isVoid: boolean; voidReason: string | null };

/** An edited cell takes the new reading's details (so revert restores them), never `currentValue` or `state`. */
export type EditedCellUpdate = {
  id: string;
  extractedValue: string | null;
  extractedState: ValueState;
  inherited: boolean;
  confidence: number | null;
  buildIssues: Issue[];
  disagreement: boolean;
  isReviewed: boolean;
};

export type MergePlan = {
  newRowGroups: { anchor: RowAnchor; rows: RowWrite[] }[];
  rowUpdates: RowWrite[];
  /** `rowId` is an existing row or one of `newRowGroups`. */
  cellCreates: { rowId: string; outputColumnId: string; values: CellValues }[];
  /** Cells nobody edited: every value is replaced. */
  autoCellUpdates: { id: string; values: CellValues }[];
  /** Edited cells: never `currentValue`. */
  editedCellUpdates: EditedCellUpdate[];
  rowDeletes: string[];
  /** Kept because they hold edits; included in `rowUpdates`. */
  orphanedRows: string[];
};

export function freshCell(c: ComputedCell): CellValues {
  return {
    extractedValue: c.value,
    currentValue: c.value,
    state: c.state,
    extractedState: c.state,
    buildIssues: c.buildIssues,
    isEdited: false,
    isReviewed: false,
    inherited: c.inherited,
    confidence: c.confidence,
    disagreement: false,
    validationState: c.validationState,
    validationMsgs: c.validationMsgs,
  };
}

export function sameIssues(a: Issue[], b: Issue[]): boolean {
  return a.length === b.length && a.every((x, i) => x.severity === b[i]?.severity && x.message === b[i]?.message);
}

/** Validation fields are left out: revalidation owns them. */
function sameValues(a: CellValues, b: CellValues): boolean {
  return (
    a.extractedValue === b.extractedValue &&
    a.currentValue === b.currentValue &&
    a.state === b.state &&
    a.extractedState === b.extractedState &&
    sameIssues(a.buildIssues, b.buildIssues) &&
    a.isEdited === b.isEdited &&
    a.isReviewed === b.isReviewed &&
    a.inherited === b.inherited &&
    a.confidence === b.confidence &&
    a.disagreement === b.disagreement
  );
}

function rowWrite(row: ExistingRow, computed: ComputedRow): RowWrite {
  // Void by rule follows the rule; a void state someone changed by hand is theirs to keep.
  const followsRule = row.isVoid === (row.voidReason !== null);
  return {
    id: row.id,
    rawRecordId: computed.rawRecordId,
    recordKey: computed.recordKey,
    isVoid: followsRule ? computed.voidReason !== null : row.isVoid,
    voidReason: computed.voidReason,
  };
}

function sameRow(row: ExistingRow, w: RowWrite): boolean {
  return row.rawRecordId === w.rawRecordId && row.recordKey === w.recordKey && row.isVoid === w.isVoid && row.voidReason === w.voidReason;
}

export function planMerge(computed: ComputedRow[], existing: ExistingRow[], newId: () => string): MergePlan {
  const plan: MergePlan = {
    newRowGroups: [],
    rowUpdates: [],
    cellCreates: [],
    autoCellUpdates: [],
    editedCellUpdates: [],
    rowDeletes: [],
    orphanedRows: [],
  };

  // Match by raw record first, so a key match can never take a row another computed row owns.
  const matched: (ExistingRow | undefined)[] = computed.map(() => undefined);
  const used = new Set<string>();
  const byRecord = new Map(existing.flatMap((r) => (r.rawRecordId === null ? [] : [[r.rawRecordId, r] as const])));
  computed.forEach((c, i) => {
    const row = byRecord.get(c.rawRecordId);
    if (row && !used.has(row.id)) {
      matched[i] = row;
      used.add(row.id);
    }
  });
  const byKey = new Map<string, ExistingRow>();
  for (const r of existing) if (r.recordKey !== null && !used.has(r.id) && !byKey.has(r.recordKey)) byKey.set(r.recordKey, r);
  computed.forEach((c, i) => {
    if (matched[i]) return;
    const row = byKey.get(c.recordKey);
    if (row && !used.has(row.id)) {
      matched[i] = row;
      used.add(row.id);
    }
  });

  let group: { anchor: RowAnchor; rows: RowWrite[] } | null = null;
  for (let i = 0; i < computed.length; i++) {
    const c = computed[i];
    if (!c) continue;
    const row = matched[i];
    if (!row) {
      if (!group) {
        const prev = matched.slice(0, i).reverse().find((r) => r !== undefined);
        const next = matched.slice(i + 1).find((r) => r !== undefined);
        group = { anchor: prev ? { after: prev.id } : next ? { before: next.id } : { document: true }, rows: [] };
        plan.newRowGroups.push(group);
      }
      const id = newId();
      group.rows.push({ id, rawRecordId: c.rawRecordId, recordKey: c.recordKey, isVoid: c.voidReason !== null, voidReason: c.voidReason });
      for (const cell of c.cells) plan.cellCreates.push({ rowId: id, outputColumnId: cell.outputColumnId, values: freshCell(cell) });
      continue;
    }
    group = null;

    const write = rowWrite(row, c);
    if (!sameRow(row, write)) plan.rowUpdates.push(write);
    const cells = new Map(row.cells.map((x) => [x.outputColumnId, x]));
    for (const cell of c.cells) {
      const old = cells.get(cell.outputColumnId);
      if (!old) {
        plan.cellCreates.push({ rowId: row.id, outputColumnId: cell.outputColumnId, values: freshCell(cell) });
      } else if (old.isEdited) {
        const readingChanged = cell.value !== old.extractedValue;
        const disagreement = cell.value === old.currentValue ? false : readingChanged ? true : old.disagreement;
        const isReviewed = disagreement && readingChanged ? false : old.isReviewed;
        const detailsChanged =
          cell.state !== old.extractedState ||
          cell.inherited !== old.inherited ||
          cell.confidence !== old.confidence ||
          !sameIssues(cell.buildIssues, old.buildIssues);
        if (readingChanged || detailsChanged || disagreement !== old.disagreement || isReviewed !== old.isReviewed) {
          plan.editedCellUpdates.push({
            id: old.id,
            extractedValue: cell.value,
            extractedState: cell.state,
            inherited: cell.inherited,
            confidence: cell.confidence,
            buildIssues: cell.buildIssues,
            disagreement,
            isReviewed,
          });
        }
      } else {
        const unchanged = old.currentValue === cell.value && old.state === cell.state;
        const values = { ...freshCell(cell), isReviewed: unchanged && old.isReviewed };
        if (!sameValues(old, values)) plan.autoCellUpdates.push({ id: old.id, values });
      }
    }
  }

  for (const row of existing) {
    if (used.has(row.id)) continue;
    if (!row.cells.some((c) => c.isEdited)) {
      plan.rowDeletes.push(row.id);
      continue;
    }
    const followsRule = row.isVoid === (row.voidReason !== null);
    const write: RowWrite = { id: row.id, rawRecordId: null, recordKey: row.recordKey, isVoid: followsRule ? true : row.isVoid, voidReason: "ORPHANED" };
    plan.orphanedRows.push(row.id);
    if (!sameRow(row, write)) plan.rowUpdates.push(write);
  }
  return plan;
}
