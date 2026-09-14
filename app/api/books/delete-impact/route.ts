import { requireSessionUserId } from "@/lib/auth/session";
import { booksImpactRequestSchema } from "@/lib/books/schemas";
import { booksDeleteImpact } from "@/lib/books/service";
import { resultResponse, runAction } from "@/lib/errors";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Impact of deleting several books at once (POST so a long id list never hits URL limits). */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const { ids } = parseInput(booksImpactRequestSchema, await request.json().catch(() => null));
    return booksDeleteImpact(userId, ids);
  });
  return resultResponse(result);
}
