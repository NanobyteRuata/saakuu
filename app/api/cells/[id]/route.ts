import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { editCellSchema } from "@/lib/table/schemas";
import { editCell } from "@/lib/table/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** `{ value, state?, editId? }`: saves a typed value, logs it, and returns the cell plus cells whose checks changed. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const cellId = parseInput(idSchema, (await params).id);
    const input = parseInput(editCellSchema, await request.json().catch(() => null));
    return editCell(userId, cellId, input);
  });
  return resultResponse(result);
}
