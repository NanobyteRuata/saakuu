import { requireSessionUserId } from "@/lib/auth/session";
import { creditAccount } from "@/lib/credits/service";
import { AppError, resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** `?cursor=`: this user's balance and a page of their ledger, newest first. */
export async function GET(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const raw = new URL(request.url).searchParams.get("cursor");
    const cursor = raw === null ? undefined : parseInput(idSchema, raw);
    const account = await creditAccount(userId, cursor);
    if (!account) throw new AppError("NOT_FOUND", "Credits aren't switched on for this server.");
    return account;
  });
  return resultResponse(result);
}
