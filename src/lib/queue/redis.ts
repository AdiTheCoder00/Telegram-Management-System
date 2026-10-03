import { Redis } from "ioredis";

const g = globalThis as unknown as { redis?: Redis | null };

/** Shared Redis connection, or null when REDIS_URL is not configured. */
export function getRedis(): Redis | null {
  if (g.redis !== undefined) return g.redis;
  const url = process.env.REDIS_URL;
  if (!url) return (g.redis = null);
  // maxRetriesPerRequest: null is required by BullMQ for blocking connections.
  g.redis = new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
  g.redis.on("error", (e) => console.error("[redis] connection error:", e.message));
  return g.redis;
}

export async function closeRedis() {
  if (g.redis) await g.redis.quit().catch(() => undefined);
  g.redis = undefined;
}
