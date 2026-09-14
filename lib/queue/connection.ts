import { Redis } from "ioredis";

import { getEnv } from "@/lib/env";

/**
 * BullMQ requires `maxRetriesPerRequest: null` on connections used by workers and
 * QueueEvents (blocking commands). Using it everywhere keeps one code path.
 */
export function createRedisConnection(): Redis {
  return new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
}
