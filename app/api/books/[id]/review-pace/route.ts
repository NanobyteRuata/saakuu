import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { reviewPace } from "@/lib/review/pace";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Seconds per reviewed cell, per review source (docs/06 Phase 19). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    return reviewPace(userId, bookId);
  });
  return resultResponse(result);
}
