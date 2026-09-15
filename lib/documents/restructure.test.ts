import { describe, expect, it } from "vitest";

import { isProblem, planGroup, planReorder, planSplit, type DocumentPages, type RestructurePlan } from "./restructure";

function ok(plan: RestructurePlan | { problem: string }): RestructurePlan {
  if (isProblem(plan)) throw new Error(plan.problem);
  return plan;
}

/** Every input photo appears exactly once, and each document's page indexes are 0..n-1. */
function expectConserved(docs: DocumentPages[], plan: RestructurePlan, extraDocs: string[] = []) {
  const before = docs.flatMap((d) => d.photoIds).sort();
  const after = plan.assignments.map((a) => a.photoId).sort();
  expect(after).toEqual(before);
  const byDoc = new Map<string, number[]>();
  for (const a of plan.assignments) byDoc.set(a.documentId, [...(byDoc.get(a.documentId) ?? []), a.pageIndex]);
  for (const indexes of byDoc.values()) {
    expect([...indexes].sort((x, y) => x - y)).toEqual(indexes.map((_, i) => i));
  }
  const known = new Set([...docs.map((d) => d.documentId), ...extraDocs]);
  for (const id of byDoc.keys()) expect(known.has(id)).toBe(true);
}

function pages(plan: RestructurePlan, documentId: string): string[] {
  return plan.assignments
    .filter((a) => a.documentId === documentId)
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map((a) => a.photoId);
}

describe("planGroup", () => {
  const singles: DocumentPages[] = [
    { documentId: "d1", photoIds: ["p1"] },
    { documentId: "d2", photoIds: ["p2"] },
    { documentId: "d3", photoIds: ["p3"] },
  ];

  it("groups single-photo documents into the first one, in the chosen order", () => {
    const plan = ok(planGroup(singles, ["p1", "p3", "p2"]));
    expectConserved(singles, plan);
    expect(pages(plan, "d1")).toEqual(["p1", "p3", "p2"]);
    expect(plan.emptied.sort()).toEqual(["d2", "d3"]);
  });

  it("keeps unselected pages in their documents, in order", () => {
    const docs: DocumentPages[] = [
      { documentId: "a", photoIds: ["a1", "a2", "a3"] },
      { documentId: "b", photoIds: ["b1", "b2"] },
    ];
    const plan = ok(planGroup(docs, ["b2", "a2"]));
    expectConserved(docs, plan);
    expect(pages(plan, "b")).toEqual(["b2", "a2", "b1"]);
    expect(pages(plan, "a")).toEqual(["a1", "a3"]);
    expect(plan.emptied).toEqual([]);
  });

  it("refuses fewer than 2, duplicates and unknown photos", () => {
    expect(isProblem(planGroup(singles, ["p1"]))).toBe(true);
    expect(isProblem(planGroup(singles, ["p1", "p1"]))).toBe(true);
    expect(isProblem(planGroup(singles, ["p1", "zz"]))).toBe(true);
  });
});

describe("planSplit", () => {
  const doc: DocumentPages = { documentId: "d", photoIds: ["p1", "p2", "p3", "p4"] };

  it("moves selected pages to the new document in page order, whatever the selection order", () => {
    const plan = ok(planSplit(doc, ["p4", "p2"], "n"));
    expectConserved([doc], plan, ["n"]);
    expect(pages(plan, "n")).toEqual(["p2", "p4"]);
    expect(pages(plan, "d")).toEqual(["p1", "p3"]);
  });

  it("refuses splitting off every page, nothing, or pages from elsewhere", () => {
    expect(isProblem(planSplit(doc, ["p1", "p2", "p3", "p4"], "n"))).toBe(true);
    expect(isProblem(planSplit(doc, [], "n"))).toBe(true);
    expect(isProblem(planSplit(doc, ["x"], "n"))).toBe(true);
  });
});

describe("planReorder", () => {
  const doc: DocumentPages = { documentId: "d", photoIds: ["p1", "p2", "p3"] };

  it("applies a full permutation", () => {
    const plan = ok(planReorder(doc, ["p3", "p1", "p2"]));
    expectConserved([doc], plan);
    expect(pages(plan, "d")).toEqual(["p3", "p1", "p2"]);
  });

  it("refuses a list that would drop or duplicate a page", () => {
    expect(isProblem(planReorder(doc, ["p1", "p2"]))).toBe(true);
    expect(isProblem(planReorder(doc, ["p1", "p1", "p2"]))).toBe(true);
    expect(isProblem(planReorder(doc, ["p1", "p2", "p9"]))).toBe(true);
  });
});
