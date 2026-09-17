import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { getTableMeta } from "@/lib/table/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Columns, templates, Manual/Skip column sources, confidence threshold and live row count for the table. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    return getTableMeta(userId, parseInput(idSchema, (await params).id));
  });
  return resultResponse(result);
}
