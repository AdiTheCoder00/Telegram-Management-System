import { getRedis } from "@/lib/queue/redis";

/**
 * Fixed-window rate limiter. Uses Redis when REDIS_URL is configured (shared across instances),
 * otherwise an in-process map (per instance — adequate for development / single-node).
 */
const memory = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const redis = getRedis();
  if (redis) {
    try {
      const bucket = `rl:${key}:${Math.floor(Date.now() / windowMs)}`;
      const count = await redis.incr(bucket);
      if (count === 1) await redis.pexpire(bucket, windowMs);
      const retryAfterSec = Math.ceil((windowMs - (Date.now() % windowMs)) / 1000);
      return { ok: count <= limit, remaining: Math.max(0, limit - count), retryAfterSec };
    } catch {
      // fall through to memory limiter if Redis is temporarily unavailable
    }
  }
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowMs });
    if (memory.size > 10_000) for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
    return { ok: true, remaining: limit - 1, retryAfterSec: Math.ceil(windowMs / 1000) };
  }
  entry.count++;
  return {
    ok: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    retryAfterSec: Math.ceil((entry.resetAt - now) / 1000),
  };
}

export function resetRateLimits() {
  memory.clear();
}
