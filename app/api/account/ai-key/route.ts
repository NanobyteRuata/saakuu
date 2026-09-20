import { removeAiKey, saveAiKey } from "@/lib/account/service";
import { saveAiKeySchema } from "@/lib/account/schemas";
import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { enforceRateLimits } from "@/lib/rate-limit";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** `{ key }`: stores this user's own Gemini key, encrypted. Returns its last four characters only. */
export async function PUT(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    await enforceRateLimits([["accountAiKey", userId]]);
    const input = parseInput(saveAiKeySchema, await request.json().catch(() => null));
    return saveAiKey(userId, input.key);
  });
  return resultResponse(result);
}

/** Removes the stored key; the user falls back to the server's, where the deployment has one. */
export async function DELETE(): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    await enforceRateLimits([["accountAiKey", userId]]);
    return removeAiKey(userId);
  });
  return resultResponse(result);
}
