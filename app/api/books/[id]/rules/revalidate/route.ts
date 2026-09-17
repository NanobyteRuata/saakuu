import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";
import { getRevalidationStatus, requestRevalidation } from "@/lib/validation/rules-service";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Queues a re-check of every cell in the book. */
export async function POST(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    return requestRevalidation(userId, parseInput(idSchema, (await params).id));
  });
  return resultResponse(result, 202);
}

/** `{ pending }`: whether the book's re-check is waiting or running. */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    return getRevalidationStatus(userId, parseInput(idSchema, (await params).id));
  });
  return resultResponse(result);
}
