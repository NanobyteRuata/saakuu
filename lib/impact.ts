import { createHash } from "node:crypto";

import type { ChangeSeverity } from "@/lib/books/column-ops";

/**
 * Blast-radius reports for destructive endpoints (docs/04 → Impact report shape).
 *
 * The preview returns an `impactHash` over what the user was shown plus the state it was
 * computed from. The apply recomputes it inside its transaction and refuses on mismatch, so the
 * UI can't skip the preview and nobody confirms numbers that have since changed.
 */

export type BrokenMapping = { templateId: string; templateName: string; columnLabel: string; reason: string };

export type ImpactReport = {
  impactHash: string;
  severity: ChangeSeverity;
  brokenMappings: BrokenMapping[];
  clearedColumns: string[];
  affectedRows: number;
  affectedCells: number;
  editedCells: number;
  reviewedCells: number;
};

export type BooksDeleteImpact = {
  impactHash: string;
  books: number;
  documents: number;
  photos: number;
  rows: number;
  editedCells: number;
};

/** JSON with object keys sorted at every level; `undefined` members are dropped. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function impactHash(payload: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(payload)).digest("hex")}`;
}
