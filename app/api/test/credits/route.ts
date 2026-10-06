import { z } from "zod";

import { prisma } from "@/lib/db/client";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ email: z.email(), credits: z.number().min(-1_000_000).max(1_000_000) });

/**
 * Test-only: `{ email, credits }` writes one GRANT line, as `pnpm credits:grant` does, so Playwright
 * can empty an account against whichever server it is pointed at. Returns 404 unless
 * EMAIL_TRANSPORT=test outside production, the same switch as the test outbox.
 */
export async function POST(request: Request): Promise<Response> {
  const env = getEnv();
  if (env.EMAIL_TRANSPORT !== "test" || env.NODE_ENV === "production") {
    return new Response(null, { status: 404 });
  }
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ granted: false }, { status: 400 });
  const user = await prisma.user.findUnique({ where: { email: body.data.email.toLowerCase() }, select: { id: true } });
  if (!user) return Response.json({ granted: false }, { status: 404 });
  await prisma.creditEntry.create({ data: { userId: user.id, kind: "GRANT", milliCredits: Math.round(body.data.credits * 1000), note: "e2e" } });
  return Response.json({ granted: true });
}
