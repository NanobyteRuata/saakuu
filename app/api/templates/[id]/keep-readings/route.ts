import { requireSessionUserId } from "@/lib/auth/session";
import { keepReadings } from "@/lib/documents/reading-changes";
import { keepReadingsSchema } from "@/lib/documents/schemas";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Keep these readings: the flagged documents count as read with the fields as they are now. Reads nothing. */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    const input = parseInput(keepReadingsSchema, await request.json().catch(() => null));
    return keepReadings(userId, templateId, input);
  });
  return resultResponse(result);
}
