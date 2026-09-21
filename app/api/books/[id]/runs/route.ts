import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { listRunActivity } from "@/lib/extraction/activity";
import { runActivitySchema } from "@/lib/extraction/schemas";
import { idSchema, parseInput, searchParamsToObject } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** The run drawer: documents being read or read in the last day, per page, with what failed and why. */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    const input = parseInput(runActivitySchema, searchParamsToObject(new URL(request.url).searchParams));
    return listRunActivity(userId, bookId, input);
  });
  return resultResponse(result);
}
