import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { acceptFieldProposalSchema } from "@/lib/templates/field-proposal-schemas";
import { acceptFieldProposal } from "@/lib/templates/field-proposals";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; proposalId: string }> };

/** Creates the ticked fields. The only write a proposal ever makes to the template; idempotent. */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const { id, proposalId } = await params;
    const input = parseInput(acceptFieldProposalSchema, await request.json().catch(() => null));
    return acceptFieldProposal(userId, parseInput(idSchema, id), parseInput(idSchema, proposalId), input);
  });
  return resultResponse(result, 201);
}
