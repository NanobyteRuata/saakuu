import { z } from "zod";

/**
 * Queue and job registry. Every job has a Zod payload schema that the enqueuer and
 * the processor both use, so a malformed job fails loudly instead of half-running.
 *
 * Queues are added here as phases land (e.g. `extraction` in Phase 5).
 */

export const QUEUES = {
  system: "system",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const noopJobSchema = z.object({
  requestedBy: z.string().min(1).max(100),
  echo: z.string().max(500).optional(),
});

export type NoopJobData = z.infer<typeof noopJobSchema>;

export type NoopJobResult = {
  echo: string | null;
  dbOk: true;
  worker: { hostname: string; pid: number };
  completedAt: string;
};

export const JOBS = {
  noop: { queue: QUEUES.system, name: "noop", schema: noopJobSchema },
} as const;
