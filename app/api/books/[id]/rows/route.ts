import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { listRowsSchema } from "@/lib/table/schemas";
import { listRows } from "@/lib/table/service";
import { idSchema, parseInput, searchParamsToObject } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** A page of the output table in manual order: `?cursor=&limit=` (compact wire format, lib/table/wire.ts). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    const input = parseInput(listRowsSchema, searchParamsToObject(new URL(request.url).searchParams));
    return listRows(userId, bookId, input);
  });
  return resultResponse(result);
}
