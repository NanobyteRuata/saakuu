import type { ConfigState } from "./schemas";

/**
 * A template's config badge (docs/02 invariant 8, docs/06 Phase 3). Conflicted wins: any
 * broken mapping makes the template Conflicted. Otherwise it stays Draft until it has at least
 * one live field and one mapping.
 */
export function computeConfigState(counts: { liveFields: number; mappings: number; brokenMappings: number }): ConfigState {
  if (counts.brokenMappings > 0) return "CONFLICTED";
  if (counts.liveFields === 0 || counts.mappings === 0) return "DRAFT";
  return "READY";
}

export type RunCounts = Partial<Record<"NEVER_RUN" | "QUEUED" | "RUNNING" | "PARTIAL" | "FAILED" | "COMPLETE", number>>;

export type RunSummary =
  | { state: "NEVER_RUN" }
  | { state: "RUNNING"; done: number; total: number }
  | { state: "FAILED" | "PARTIAL" | "COMPLETE" };

/** The run badge for a template, from its documents' run states (docs/05 §6). */
export function summariseRunState(counts: RunCounts): RunSummary {
  const n = (k: keyof RunCounts) => counts[k] ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  const active = n("QUEUED") + n("RUNNING");
  if (total === 0 || n("NEVER_RUN") === total) return { state: "NEVER_RUN" };
  if (active > 0) return { state: "RUNNING", done: total - active - n("NEVER_RUN"), total };
  if (n("FAILED") > 0 && n("COMPLETE") === 0 && n("PARTIAL") === 0) return { state: "FAILED" };
  if (n("COMPLETE") === total) return { state: "COMPLETE" };
  return { state: "PARTIAL" };
}
