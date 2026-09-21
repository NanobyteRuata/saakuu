import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { columnSourcesSchema } from "@/lib/review/schemas";
import { getColumnSources } from "@/lib/review/service";
import { idSchema, parseInput, searchParamsToObject } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Where one column's cell was read, for a page of rows in manual order (column sweep): `?columnId=&cursor=&limit=`. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    return getColumnSources(userId, bookId, parseInput(columnSourcesSchema, searchParamsToObject(new URL(request.url).searchParams)));
  });
  return resultResponse(result);
}
