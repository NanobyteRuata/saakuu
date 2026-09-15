import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { groupPhotosSchema } from "@/lib/documents/schemas";
import { groupPhotos } from "@/lib/documents/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Groups uploaded photos into one document, pages in the listed order. */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    const input = parseInput(groupPhotosSchema, await request.json().catch(() => null));
    return groupPhotos(userId, templateId, input);
  });
  return resultResponse(result);
}
