import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { applyColumnProposal, columnProposal } from "@/lib/mappings/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** What `Create columns from this template` would create, for the counted confirmation. */
export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    return columnProposal(userId, templateId);
  });
  return resultResponse(result);
}

/** Creates the proposal; recomputed server-side, so a double submit creates nothing twice. */
export async function POST(_request: Request, { params }: Params): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    return applyColumnProposal(userId, templateId);
  });
  return resultResponse(result, 201);
}
