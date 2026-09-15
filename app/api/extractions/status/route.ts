import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { statusQuerySchema } from "@/lib/extraction/schemas";
import { getExtractionStatus } from "@/lib/extraction/service";
import { parseInput, searchParamsToObject } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Poll: `?documentIds=a,b,c` → run state and page progress per document. */
export async function GET(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const { documentIds } = parseInput(statusQuerySchema, searchParamsToObject(new URL(request.url).searchParams));
    return getExtractionStatus(userId, documentIds);
  });
  return resultResponse(result);
}
