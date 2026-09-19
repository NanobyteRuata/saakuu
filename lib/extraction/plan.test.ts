import { describe, expect, it } from "vitest";

import { currentRuns, extractionKey, supersededRecordIds } from "./plan";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 15, 10, minute));

describe("supersededRecordIds", () => {
  const records = [
    { id: "r1", runId: "old", runCreatedAt: at(0), photoId: "p1" },
    { id: "r2", runId: "old", runCreatedAt: at(0), photoId: "p2" },
    { id: "r3", runId: "chunk2", runCreatedAt: at(0), photoId: "p9" },
    { id: "r4", runId: "newer", runCreatedAt: at(9), photoId: "p1" },
    { id: "r5", runId: "legacy", runCreatedAt: at(0), photoId: null },
  ];

  it("replaces only older records on the retried pages, keeping other chunks and newer runs", () => {
    expect(supersededRecordIds(records, { id: "retry", photoIds: ["p1", "p2"], createdAt: at(5) })).toEqual(["r1", "r2", "r5"]);
  });

  it("never replaces the run's own records", () => {
    expect(supersededRecordIds(records, { id: "old", photoIds: ["p1"], createdAt: at(0) })).toEqual(["r5"]);
  });

  // Phase 11: a re-shot page is a new photo id, so without the replaced page the document would keep
  // both readings and build two sets of rows from the same page of paper.
  it("replaces the records of a page that this run's page was shot to replace", () => {
    const reshot = [
      { id: "r1", runId: "old", runCreatedAt: at(0), photoId: "p1" },
      { id: "r2", runId: "old", runCreatedAt: at(0), photoId: "p2" },
    ];
    // p1new replaces p1; p2 is a different page and its reading must survive.
    expect(supersededRecordIds(reshot, { id: "after", photoIds: ["p1new"], createdAt: at(5) }, ["p1"])).toEqual(["r1"]);
  });

  it("keeps a newer run's records even on a replaced page", () => {
    const reshot = [{ id: "r4", runId: "newer", runCreatedAt: at(9), photoId: "p1" }];
    expect(supersededRecordIds(reshot, { id: "after", photoIds: ["p1new"], createdAt: at(5) }, ["p1"])).toEqual([]);
  });
});

describe("currentRuns", () => {
  it("picks the newest run per page", () => {
    const runs = [
      { id: "a", state: "COMPLETE" as const, photoIds: ["p1", "p2"], createdAt: at(0) },
      { id: "b", state: "FAILED" as const, photoIds: ["p2"], createdAt: at(1) },
    ];
    expect(currentRuns(["p1", "p2"], runs).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("extractionKey", () => {
  const base = {
    documentId: "d1",
    model: "gemini-3.5-flash",
    promptVersion: "v1",
    pages: [{ photoId: "p1", transformHash: "abc" }],
    passIndex: 0,
    nonce: "nonce-0123456789abcdef",
  };

  it("is the same for a repeated submit of one action, so it inserts once", () => {
    expect(extractionKey({ ...base })).toBe(extractionKey({ ...base, pages: [{ transformHash: "abc", photoId: "p1" }] }));
  });

  it("differs for a new action or an edited page", () => {
    expect(extractionKey({ ...base, nonce: "nonce-other-0123456789" })).not.toBe(extractionKey(base));
    expect(extractionKey({ ...base, pages: [{ photoId: "p1", transformHash: "def" }] })).not.toBe(extractionKey(base));
  });
});
