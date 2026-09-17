import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";
import { ruleDraftSchema } from "@/lib/validation/rules";
import { previewRule } from "@/lib/validation/rules-service";

export const dynamic = "force-dynamic";

/** An unsaved rule → how many cells it would flag, or why it can't be saved. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    return previewRule(userId, bookId, parseInput(ruleDraftSchema, await request.json().catch(() => null)));
  });
  return resultResponse(result);
}
