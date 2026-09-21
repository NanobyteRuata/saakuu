import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { getFieldProposal } from "@/lib/templates/field-proposals";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; proposalId: string }> };

/** Poll target: state, and the proposed fields once the page has been read. */
export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const { id, proposalId } = await params;
    return getFieldProposal(userId, parseInput(idSchema, id), parseInput(idSchema, proposalId));
  });
  return resultResponse(result);
}
