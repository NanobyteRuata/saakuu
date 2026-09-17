import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { updateRowSchema } from "@/lib/table/schemas";
import { setRowVoid } from "@/lib/table/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** `{ isVoid }`: marks a row void or not by hand. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const rowId = parseInput(idSchema, (await params).id);
    const { isVoid } = parseInput(updateRowSchema, await request.json().catch(() => null));
    return setRowVoid(userId, rowId, isVoid);
  });
  return resultResponse(result);
}
