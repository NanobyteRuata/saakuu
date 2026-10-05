import { describe, expect, it } from "vitest";

import { planReadingCopy, type SourceRecord, type SourceRun } from "./copy";

/**
 * Copying a specimen's reading onto a new document (decision 78) writes real data without a model
 * call, so a wrong remap would put provenance on the wrong page silently. This is the pure half.
 */

const t = (s: number) => new Date(Date.UTC(2026, 8, 24, 0, 0, s));

function run(id: string, photoIds: string[], over: Partial<SourceRun> = {}): SourceRun {
  return {
    id,
    model: "gemini-3.5-flash",
    promptVersion: "extract-v3",
    passIndex: 0,
    state: "COMPLETE",
    startedAt: t(1),
    finishedAt: t(2),
    photoIds,
    rawResponse: { summary: { contentState: "HAS_CONTENT", records: 1 }, responses: [{ text: "big" }] },
    createdAt: t(0),
    ...over,
  };
}

function record(id: string, runId: string, photoId: string | null, over: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id,
    runId,
    recordIndex: 0,
    rowType: "DATA",
    struckThrough: false,
    sequenceValue: null,
    photoId,
    bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 },
    duplicateOf: null,
    values: [
      {
        fieldId: "f1",
        valueText: "၁၂.၅၀",
        altValueText: null,
        state: "OK",
        isDitto: false,
        confidence: 0.4,
        disagreement: false,
        photoId,
        bbox: { x: 0.5, y: 0.2, w: 0.1, h: 0.04 },
      },
    ],
    ...over,
  };
}

function ids() {
  let n = 0;
  return () => `new${++n}`;
}

describe("planReadingCopy", () => {
  const pages = new Map([
    ["p1", "q1"],
    ["p2", "q2"],
  ]);

  it("remaps every id and page and keeps values exactly as read", () => {
    const runs = [run("r1", ["p1", "p2"])];
    const records = [record("a", "r1", "p1"), record("b", "r1", "p2", { recordIndex: 1, duplicateOf: "a" })];
    const plan = planReadingCopy(runs, records, pages, ids());
    expect(plan).not.toBeNull();
    if (!plan) return;

    expect(plan.runs).toHaveLength(1);
    const [newRun] = plan.runs;
    expect(newRun?.id).toBe("new1");
    expect(newRun?.photoIds).toEqual(["q1", "q2"]);
    expect(newRun?.idempotencyKey).toBe("copy:new1");
    expect(newRun?.createdAt).toEqual(t(0));
    // Only the summary travels; the model's responses stay with the original.
    expect(newRun?.rawResponse).toEqual({ summary: { contentState: "HAS_CONTENT", records: 1 } });

    expect(plan.records.map((r) => [r.id, r.runId, r.photoId, r.duplicateOf])).toEqual([
      ["new2", "new1", "q1", null],
      ["new3", "new1", "q2", "new2"],
    ]);
    expect(plan.values.map((v) => [v.rawRecordId, v.photoId, v.valueText, v.confidence])).toEqual([
      ["new2", "q1", "၁၂.၅၀", 0.4],
      ["new3", "q2", "၁၂.၅၀", 0.4],
    ]);
    expect(plan.values[0]?.bbox).toEqual({ x: 0.5, y: 0.2, w: 0.1, h: 0.04 });
  });

  it("copies only the current run of each page", () => {
    const runs = [run("old", ["p1", "p2"], { createdAt: t(0) }), run("r1", ["p1"], { createdAt: t(10) }), run("r2", ["p2"], { createdAt: t(11) })];
    const plan = planReadingCopy(runs, [record("a", "r1", "p1"), record("b", "r2", "p2")], pages, ids());
    expect(plan?.runs.map((r) => r.photoIds)).toEqual([["q2"], ["q1"]]);
  });

  it("refuses a reading that is not whole and finished", () => {
    // A page no run covered.
    expect(planReadingCopy([run("r1", ["p1"])], [record("a", "r1", "p1")], pages, ids())).toBeNull();
    // A current run that failed.
    expect(planReadingCopy([run("r1", ["p1", "p2"], { state: "FAILED" })], [], pages, ids())).toBeNull();
    // A record left over from a run that is no longer current.
    const runs = [run("old", ["p1", "p2"], { createdAt: t(0) }), run("r1", ["p1", "p2"], { createdAt: t(5) })];
    expect(planReadingCopy(runs, [record("a", "old", "p1")], pages, ids())).toBeNull();
  });

  it("refuses a value on a page that is not copied rather than write a dangling reference", () => {
    const rec = record("a", "r1", "p1");
    const values = rec.values.map((v) => ({ ...v, photoId: "replaced" }));
    expect(planReadingCopy([run("r1", ["p1", "p2"])], [{ ...rec, values }], pages, ids())).toBeNull();
  });
});
