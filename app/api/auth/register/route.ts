import { registerSchema } from "@/lib/auth/schemas";
import { register } from "@/lib/auth/service";
import { resultResponse, runAction } from "@/lib/errors";
import { enforceRateLimits } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request-ip";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const input = parseInput(registerSchema, await request.json().catch(() => null));
    await enforceRateLimits([
      ["registerIp", clientIp(request.headers)],
      ["registerEmail", input.email],
    ]);
    return register(input);
  });
  return resultResponse(result);
}
