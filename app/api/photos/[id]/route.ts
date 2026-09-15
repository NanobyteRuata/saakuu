import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { deletePhotoSchema } from "@/lib/photos/schemas";
import { deletePhoto } from "@/lib/photos/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const photoId = parseInput(idSchema, (await params).id);
    const input = parseInput(deletePhotoSchema, await request.json().catch(() => null));
    return deletePhoto(userId, photoId, input);
  });
  return resultResponse(result);
}
