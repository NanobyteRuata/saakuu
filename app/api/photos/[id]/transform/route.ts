import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { updateTransformSchema } from "@/lib/photos/schemas";
import { updatePhotoTransform } from "@/lib/photos/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Non-destructive: writes transform JSON only; the original is never modified. */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const photoId = parseInput(idSchema, (await params).id);
    const input = parseInput(updateTransformSchema, await request.json().catch(() => null));
    return updatePhotoTransform(userId, photoId, input);
  });
  return resultResponse(result);
}
