import { creditRequestSchema } from "@/lib/account/schemas";
import { requireSessionUserId } from "@/lib/auth/session";
import { requestCredits } from "@/lib/credits/service";
import { resultResponse, runAction } from "@/lib/errors";
import { enforceRateLimits } from "@/lib/rate-limit";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** `{ note? }`: emails whoever runs SaaKuu that this user wants more credits. Grants nothing. */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    await enforceRateLimits([["creditRequest", userId]]);
    const input = parseInput(creditRequestSchema, await request.json().catch(() => null));
    return requestCredits(userId, input.note);
  });
  return resultResponse(result);
}
