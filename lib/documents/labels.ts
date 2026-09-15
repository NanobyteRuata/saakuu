import type { PhotoStatus } from "@prisma/client";

import type { ContentState, RunState } from "./schemas";

export const RUN_STATE_LABELS: Record<RunState, string> = {
  NEVER_RUN: "Never run",
  QUEUED: "Queued",
  RUNNING: "Running",
  PARTIAL: "Partial",
  FAILED: "Failed",
  COMPLETE: "Complete",
};

export const CONTENT_STATE_LABELS: Record<ContentState, string> = {
  UNKNOWN: "Not read yet",
  HAS_CONTENT: "Has content",
  EMPTY: "Blank page",
  NO_ROWS_FOUND: "No rows found",
};

export const PHOTO_STATUS_LABELS: Record<PhotoStatus, string> = {
  DRAFT: "Waiting",
  QUEUED: "Queued",
  PROCESSING: "Processing",
  FAILED: "Failed",
  DONE: "Ready",
};

/** 1536000 → "1.5 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
