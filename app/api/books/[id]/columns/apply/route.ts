import { requireSessionUserId } from "@/lib/auth/session";
import { applyColumnOps } from "@/lib/books/columns-service";
import { applyColumnOpsSchema } from "@/lib/books/schemas";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Applies a column diff. Requires `confirm: true` and the `impactHash` from the preview. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    const input = parseInput(applyColumnOpsSchema, await request.json().catch(() => null));
    return applyColumnOps(userId, bookId, input);
  });
  return resultResponse(result);
}
