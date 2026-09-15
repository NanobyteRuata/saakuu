import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { resetPhotoTransform } from "@/lib/photos/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const photoId = parseInput(idSchema, (await params).id);
    return resetPhotoTransform(userId, photoId);
  });
  return resultResponse(result);
}
