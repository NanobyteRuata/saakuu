import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { replacePhotoSchema } from "@/lib/photos/schemas";
import { replacePhoto } from "@/lib/photos/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Re-shoots this page: same document, same page number. Rows, edits and reviewed marks are kept. */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const photoId = parseInput(idSchema, (await params).id);
    const input = parseInput(replacePhotoSchema, await request.json().catch(() => null));
    return replacePhoto(userId, photoId, input);
  });
  return resultResponse(result, 201);
}
