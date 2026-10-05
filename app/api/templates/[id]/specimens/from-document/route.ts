import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { specimenFromDocumentSchema } from "@/lib/templates/schemas";
import { specimenFromDocument } from "@/lib/templates/specimens";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Copies an uploaded page of this template into a new specimen; the document is untouched (decision 78). */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    const input = parseInput(specimenFromDocumentSchema, await request.json().catch(() => null));
    return specimenFromDocument(userId, templateId, input);
  });
  return resultResponse(result);
}
