import { getEnv } from "@/lib/env";
import { latestMessageTo } from "@/lib/email/outbox";

export const dynamic = "force-dynamic";

/**
 * Test-only: the latest email sent to `?to=`. Exists so Playwright can follow verification and
 * reset links. Returns 404 unless EMAIL_TRANSPORT=test outside production.
 */
export async function GET(request: Request): Promise<Response> {
  const env = getEnv();
  if (env.EMAIL_TRANSPORT !== "test" || env.NODE_ENV === "production") {
    return new Response(null, { status: 404 });
  }
  const to = new URL(request.url).searchParams.get("to");
  if (!to) {
    return Response.json({ message: null }, { status: 400 });
  }
  return Response.json({ message: latestMessageTo(to) });
}
