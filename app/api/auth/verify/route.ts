import { verifyEmailSchema } from "@/lib/auth/schemas";
import { verifyEmail } from "@/lib/auth/service";
import { resultResponse, runAction } from "@/lib/errors";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const { token } = parseInput(verifyEmailSchema, await request.json().catch(() => null));
    return verifyEmail(token);
  });
  return resultResponse(result);
}
