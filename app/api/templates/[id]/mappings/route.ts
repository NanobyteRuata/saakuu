import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { mappingDraftSchema } from "@/lib/mappings/schemas";
import { createMapping, listMappings } from "@/lib/mappings/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Mappings with their current problems, plus the book's live columns and the count of extracted documents. */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    return listMappings(userId, templateId);
  });
  return resultResponse(result);
}

/** Creates a mapping and queues a rebuild of the template's rows. */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    const input = parseInput(mappingDraftSchema, await request.json().catch(() => null));
    return createMapping(userId, templateId, input);
  });
  return resultResponse(result, 201);
}
