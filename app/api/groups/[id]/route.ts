import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { deleteGroupSchema, updateGroupSchema } from "@/lib/templates/schemas";
import { deleteGroup, updateGroup } from "@/lib/templates/structure-service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Edit properties and/or move (`move: { parentGroupId, after }`). A move writes one row. */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const groupId = parseInput(idSchema, (await params).id);
    const input = parseInput(updateGroupSchema, await request.json().catch(() => null));
    return updateGroup(userId, groupId, input);
  });
  return resultResponse(result);
}

/**
 * Deletes the group; its sub-groups and fields move up one level into its slot.
 * Body: `{ impactHash, confirm: true }` from the delete-impact preview.
 */
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const groupId = parseInput(idSchema, (await params).id);
    const input = parseInput(deleteGroupSchema, await request.json().catch(() => null));
    return deleteGroup(userId, groupId, input);
  });
  return resultResponse(result);
}
