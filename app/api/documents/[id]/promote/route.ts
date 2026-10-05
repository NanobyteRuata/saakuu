import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { promoteSpecimenSchema } from "@/lib/documents/schemas";
import { promoteSpecimen } from "@/lib/templates/specimens";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Adds a copy of a specimen to the documents; the template keeps its reference page (decision 78). */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const documentId = parseInput(idSchema, (await params).id);
    const input = parseInput(promoteSpecimenSchema, await request.json().catch(() => null));
    return promoteSpecimen(userId, documentId, input);
  });
  return resultResponse(result);
}
