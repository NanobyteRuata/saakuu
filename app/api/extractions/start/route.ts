import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { enforceRateLimits } from "@/lib/rate-limit";
import { startSchema } from "@/lib/extraction/schemas";
import { startExtraction } from "@/lib/extraction/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Creates runs and enqueues jobs; never runs extraction in the request. */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    await enforceRateLimits([["extractionStart", userId]]);
    const input = parseInput(startSchema, await request.json().catch(() => null));
    return startExtraction(userId, input);
  });
  return resultResponse(result);
}
