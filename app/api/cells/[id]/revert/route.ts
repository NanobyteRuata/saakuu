import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { revertCell } from "@/lib/table/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Puts back the extracted value and its state (logged, undoable). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    return revertCell(userId, parseInput(idSchema, (await params).id));
  });
  return resultResponse(result);
}
