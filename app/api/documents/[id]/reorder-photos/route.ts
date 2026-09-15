import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { reorderPhotosSchema } from "@/lib/documents/schemas";
import { reorderPhotos } from "@/lib/documents/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const documentId = parseInput(idSchema, (await params).id);
    const input = parseInput(reorderPhotosSchema, await request.json().catch(() => null));
    return reorderPhotos(userId, documentId, input);
  });
  return resultResponse(result);
}
