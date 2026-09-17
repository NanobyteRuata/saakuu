import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { deleteMappingSchema, mappingDraftSchema } from "@/lib/mappings/schemas";
import { deleteMapping, updateMapping } from "@/lib/mappings/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Replaces the mapping's settings (the full shape, as for create) and queues a rebuild. */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const mappingId = parseInput(idSchema, (await params).id);
    const input = parseInput(mappingDraftSchema, await request.json().catch(() => null));
    return updateMapping(userId, mappingId, input);
  });
  return resultResponse(result);
}

/** Body: `{ impactHash, confirm: true }` from the delete-impact preview. Edited cells keep their values. */
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const mappingId = parseInput(idSchema, (await params).id);
    const input = parseInput(deleteMappingSchema, await request.json().catch(() => null));
    return deleteMapping(userId, mappingId, input);
  });
  return resultResponse(result);
}
