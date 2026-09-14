import { loadDotEnv } from "@/lib/env";

loadDotEnv();

import { log } from "@/lib/log";
import { closeQueues, runNoopRoundTrip } from "@/lib/queue";

/** Enqueues a no-op job and waits for a running worker to complete it. */
async function main(): Promise<void> {
  const { jobId, result } = await runNoopRoundTrip({ requestedBy: "scripts/enqueue-noop", echo: "hello" });
  log.info("noop round trip complete", { jobId, result });
}

main()
  .then(() => closeQueues())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    log.error("noop round trip failed", err);
    process.exit(1);
  });
