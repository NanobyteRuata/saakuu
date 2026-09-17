import { Redis } from "ioredis";

import { getEnv } from "@/lib/env";

/**
 * BullMQ requires `maxRetriesPerRequest: null` on connections used by workers and
 * QueueEvents (blocking commands).
 */
export function createRedisConnection(): Redis {
  return new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
}

/**
 * Connections for adding jobs. Unlike worker connections they fail fast: a request that enqueues must
 * not wait forever on an unreachable Redis. After a few reconnect attempts the connection ends, and
 * `getQueue` builds a new one on the next use.
 */
export function createProducerConnection(): Redis {
  return new Redis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
  });
}
