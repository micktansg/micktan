// Shared plumbing for the /api routes: env access, client IP, and a
// Redis-backed fixed-window rate limiter (in-memory fallback for dev).
//
// Usage in a route:
//   const ip = clientIp(request, clientAddress);
//   const rl = await rateLimit(`judge:${ip}`, 10, 60);
//   if (!rl.allowed) return json429('easy — try again in a bit.', rl.retryAfterSeconds);
//
// The limiter FAILS OPEN: if Redis is unreachable we allow the request and
// log, because availability matters more than strictness on a personal site.

import { Redis } from '@upstash/redis';

export const env = (k: string): string | undefined =>
  ((import.meta as any).env?.[k] || (globalThis as any).process?.env?.[k]) as string | undefined;

const redisClient = (() => {
  const url = env('UPSTASH_REDIS_REST_URL');
  const token = env('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) return null;
  return new Redis({ url, token });
})();

// Dev fallback: fixed windows tracked in memory.
const localWindows: Map<string, { count: number; resetAt: number }> =
  (globalThis as any).__rlLocal ||= new Map();

export const clientIp = (request: Request, clientAddress?: string): string => {
  // Vercel puts the real client IP in x-forwarded-for (first entry).
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return clientAddress || 'unknown';
};

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

// Fixed-window counter: INCR + EXPIRE-on-first-hit. `key` should already
// include the scope (route + ip, or a global bucket name).
export const rateLimit = async (
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> => {
  const fullKey = `rl:${key}`;
  if (redisClient) {
    try {
      const count = await redisClient.incr(fullKey);
      if (count === 1) await redisClient.expire(fullKey, windowSeconds);
      if (count > limit) {
        const ttl = await redisClient.ttl(fullKey);
        return { allowed: false, retryAfterSeconds: Math.max(1, ttl) };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    } catch (err) {
      console.error('[ratelimit] redis error — failing open:', (err as Error).message);
      return { allowed: true, retryAfterSeconds: 0 };
    }
  }
  const now = Date.now();
  const w = localWindows.get(fullKey);
  if (!w || w.resetAt <= now) {
    localWindows.set(fullKey, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  w.count += 1;
  if (w.count > limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
};

// Convenience: checks a per-IP window AND a global daily budget in one call.
// The global cap bounds worst-case spend even under a distributed flood.
export const rateLimitWithBudget = async (opts: {
  scope: string;          // e.g. 'domsday:plan'
  ip: string;
  perIp: number;          // allowed calls per IP per window
  windowSeconds: number;
  dailyBudget?: number;   // optional global calls/day for this scope
}): Promise<RateLimitResult> => {
  const ipCheck = await rateLimit(`${opts.scope}:${opts.ip}`, opts.perIp, opts.windowSeconds);
  if (!ipCheck.allowed) return ipCheck;
  if (opts.dailyBudget) {
    const day = new Date().toISOString().slice(0, 10);
    const budget = await rateLimit(`${opts.scope}:day:${day}`, opts.dailyBudget, 60 * 60 * 24);
    if (!budget.allowed) return budget;
  }
  return { allowed: true, retryAfterSeconds: 0 };
};

export const json429 = (message: string, retryAfterSeconds: number) =>
  new Response(JSON.stringify({ error: message, retryAfterSeconds }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds),
    },
  });

// fetch() with a hard timeout so a stalled upstream (Gemini, GitHub) fails
// fast instead of pinning the serverless function until the platform cap.
export const fetchWithTimeout = (
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
