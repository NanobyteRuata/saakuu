import { emailOnlySchema } from "@/lib/auth/schemas";
import { resendVerification } from "@/lib/auth/service";
import { resultResponse, runAction } from "@/lib/errors";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const { email } = parseInput(emailOnlySchema, await request.json().catch(() => null));
    return resendVerification(email);
  });
  return resultResponse(result);
}
