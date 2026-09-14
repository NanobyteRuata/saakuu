import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]) },
}));

import { processSystemJob } from "./system";

function fakeJob(name: string, data: unknown): Job {
  return { id: "1", name, data, queueName: "system" } as unknown as Job;
}

describe("system queue processor", () => {
  it("completes a noop job", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await processSystemJob(fakeJob("noop", { requestedBy: "test", echo: "hi" }));
    expect(result).toMatchObject({ echo: "hi", dbOk: true, worker: { pid: process.pid } });
  });

  it("fails a noop job with an invalid payload", async () => {
    await expect(processSystemJob(fakeJob("noop", { echo: 42 }))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("fails unknown jobs", async () => {
    await expect(processSystemJob(fakeJob("nope", {}))).rejects.toThrow(/Unknown job/);
  });
});
