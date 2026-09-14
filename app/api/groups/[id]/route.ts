import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { updateGroupSchema } from "@/lib/templates/schemas";
import { deleteGroup, updateGroup } from "@/lib/templates/structure-service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Rename and/or move (`afterId`, null = first). A move writes one row. */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const groupId = parseInput(idSchema, (await params).id);
    const input = parseInput(updateGroupSchema, await request.json().catch(() => null));
    return updateGroup(userId, groupId, input);
  });
  return resultResponse(result);
}

/** Deletes the group; its fields move to Ungrouped. */
export async function DELETE(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const groupId = parseInput(idSchema, (await params).id);
    return deleteGroup(userId, groupId);
  });
  return resultResponse(result);
}
