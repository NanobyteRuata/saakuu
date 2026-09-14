import { requireSessionUserId } from "@/lib/auth/session";
import { previewColumnOps } from "@/lib/books/columns-service";
import { columnOpsSchema } from "@/lib/books/schemas";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    const { ops } = parseInput(columnOpsSchema, await request.json().catch(() => null));
    return previewColumnOps(userId, bookId, ops);
  });
  return resultResponse(result);
}
