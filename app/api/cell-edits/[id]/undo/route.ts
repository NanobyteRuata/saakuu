import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { undoEdit } from "@/lib/table/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Undoes a logged change while the cell still holds what it wrote; `CONFLICT` once the cell changed again. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    return undoEdit(userId, parseInput(idSchema, (await params).id));
  });
  return resultResponse(result);
}
