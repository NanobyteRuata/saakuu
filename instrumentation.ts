/** Next.js startup hook: request-scoped log context on the Node.js server runtime (lib/log-context.ts). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await import("./lib/log-context-node");
  const { installRequestIdSource } = await import("./lib/log-context");
  installRequestIdSource(async () => {
    const { headers } = await import("next/headers");
    return (await headers()).get("x-request-id");
  });
}
