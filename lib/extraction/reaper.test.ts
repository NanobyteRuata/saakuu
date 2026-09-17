import { describe, expect, it } from "vitest";

import type { JobPresence } from "@/lib/queue";

import { MAX_REAPS, planReap, type StaleRun } from "./reaper";

const run = (id: string, documentId: string, reaps = 0): StaleRun => ({ id, documentId, reaps });

describe("planReap", () => {
  it("never touches runs whose document's job is running or waiting to run", () => {
    const jobs = new Map<string, JobPresence>([
      ["d1", "active"],
      ["d2", "pending"],
    ]);
    expect(planReap([run("r1", "d1"), run("r2", "d2")], jobs)).toEqual({ requeue: [], fail: [] });
  });

  it("puts runs back when no job owns them", () => {
    const plan = planReap([run("r1", "d1"), run("r2", "d1", MAX_REAPS - 1)], new Map([["d1", "none"]]));
    expect(plan.requeue.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(plan.fail).toEqual([]);
  });

  it("fails a run that has been reaped too often, so a page that crashes the worker can't loop", () => {
    const plan = planReap([run("r1", "d1", MAX_REAPS)], new Map());
    expect(plan.fail.map((r) => r.id)).toEqual(["r1"]);
    expect(plan.requeue).toEqual([]);
  });
});
