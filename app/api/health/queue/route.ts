import { z } from "zod";

import { AppError, resultResponse, runAction } from "@/lib/errors";
import { runNoopRoundTrip } from "@/lib/queue";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ echo: z.string().max(500).optional() }).default({});

/**
 * Enqueues a no-op job and waits for the worker to complete it.
 * Proves app → Redis → worker → DB end to end. A no-op is safe to await in a request;
 * real work (extraction) is never awaited here.
 */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const raw: unknown = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const { echo } = parseInput(bodySchema, raw);
    try {
      return await runNoopRoundTrip({ requestedBy: "api/health/queue", echo });
    } catch (err) {
      if (err instanceof Error && /timed out/i.test(err.message)) {
        throw new AppError("INTERNAL", "The background worker didn't respond in time. Is it running?");
      }
      throw err;
    }
  });
  return resultResponse(result);
}
