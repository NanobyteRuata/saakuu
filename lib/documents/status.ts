/**
 * The Documents workspace's one Status filter (Phase 18). It replaces a run-state select and four
 * three-position toggles whose meanings overlapped — `Needs review` was a stored flag, `Reviewed` was
 * about cells, and the two read as opposites. Each status is one named, mutually exclusive predicate;
 * every single state the old controls could express is one of them. Client-safe: the SQL lives in
 * `lib/documents/service.ts`.
 */

export const DOCUMENT_STATUSES = [
  "not-read",
  "waiting",
  "reading",
  "read",
  "partly-read",
  "failed",
  "flagged",
  "not-flagged",
  "not-reviewed",
  "reviewed",
  "edited",
  "not-edited",
  "changed",
  "up-to-date",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  "not-read": "Not read yet",
  waiting: "Waiting to be read",
  reading: "Being read",
  read: "Read",
  "partly-read": "Partly read",
  failed: "Reading failed",
  flagged: "Flagged for a closer look",
  "not-flagged": "Not flagged",
  "not-reviewed": "Not fully reviewed",
  reviewed: "Fully reviewed",
  edited: "Has edited cells",
  "not-edited": "No edited cells",
  changed: "Changed since last read",
  "up-to-date": "Unchanged since last read",
};

export const DOCUMENT_STATUS_GROUPS: { label: string; statuses: DocumentStatus[] }[] = [
  { label: "Reading", statuses: ["not-read", "waiting", "reading", "read", "partly-read", "failed"] },
  { label: "Review", statuses: ["not-reviewed", "reviewed", "flagged", "not-flagged"] },
  { label: "Edits", statuses: ["edited", "not-edited"] },
  { label: "Page changes", statuses: ["changed", "up-to-date"] },
];

const RUN_STATE_STATUS: Record<string, DocumentStatus> = {
  NEVER_RUN: "not-read",
  QUEUED: "waiting",
  RUNNING: "reading",
  COMPLETE: "read",
  PARTIAL: "partly-read",
  FAILED: "failed",
};

const LEGACY_TOGGLES: [param: string, yes: DocumentStatus, no: DocumentStatus][] = [
  ["needsReview", "flagged", "not-flagged"],
  ["hasEdits", "edited", "not-edited"],
  ["reviewed", "reviewed", "not-reviewed"],
  ["needsReextraction", "changed", "up-to-date"],
];

/**
 * The status a pre-Phase-18 URL meant, so a bookmarked filter still lands somewhere sensible. The old
 * bar could combine its controls; a combination keeps its first narrowing control, in bar order.
 */
export function legacyStatus(params: Record<string, string>): DocumentStatus | undefined {
  const run = params.runState ? RUN_STATE_STATUS[params.runState] : undefined;
  if (run) return run;
  for (const [param, yes, no] of LEGACY_TOGGLES) {
    if (params[param] === "true") return yes;
    if (params[param] === "false") return no;
  }
  return undefined;
}
