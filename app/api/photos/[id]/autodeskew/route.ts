import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { autodeskewSchema } from "@/lib/photos/schemas";
import { suggestDeskew } from "@/lib/photos/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Suggests a deskew angle. Nothing is saved. */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const photoId = parseInput(idSchema, (await params).id);
    const input = parseInput(autodeskewSchema, await request.json().catch(() => ({})));
    return suggestDeskew(userId, photoId, input.rotate);
  });
  return resultResponse(result);
}
