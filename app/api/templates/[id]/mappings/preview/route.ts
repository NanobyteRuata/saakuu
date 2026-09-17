import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { previewMappingsSchema } from "@/lib/mappings/schemas";
import { previewMappings } from "@/lib/mappings/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** The mappings (optionally with one unsaved draft) applied to a document's raw values. Writes nothing. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    const input = parseInput(previewMappingsSchema, await request.json().catch(() => null));
    return previewMappings(userId, templateId, input);
  });
  return resultResponse(result);
}
