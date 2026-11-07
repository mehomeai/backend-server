// Waitlist rate limiter (waitlist synthetic implementation, ticket W3).
//
// This module owns ONLY the rate-limit mechanics for POST
// /api/me/waitlist: the fixed-window counter, the lazy expiry sweep, the
// entry cap, and construction of the limiter key from the RAW request
// body. It contains no validation, no consent rule, no honeypot handling,
// and no storage — those live in the handler (src/waitlist/handler.mjs),
// mirroring the source, where all of it sits inside one route function.
//
// Source of the semantics (see docs/waitlist-migration.md for the full
// evidence record): artifacts/api-server/src/routes/me-waitlist.ts in the
// bridge clone at 453b5f2, lines 6-9 and 17-36:
//
//   const attempts = new Map<string, { count: number; resetAt: number }>();
//   const windowMs = 15 * 60 * 1000;
//   ...
//   for (const [key, value] of attempts) {
//     if (value.resetAt <= now) attempts.delete(key);
//   }
//   const emailKey = typeof req.body?.email === "string"
//     ? req.body.email.trim().toLowerCase().slice(0, 254)
//     : "invalid";
//   const key = `${req.ip ?? "unknown"}:${emailKey}`;
//   const attempt = attempts.get(key);
//   if (attempt && attempt.count >= 15) -> 429 with Retry-After
//   if (attempt) attempt.count += 1;
//   else if (attempts.size < 10000) attempts.set(key, { count: 1, resetAt: now + windowMs });
//   else -> 429 without Retry-After
//
// Properties preserved exactly:
// - FIXED window: resetAt is set once at entry creation; increments never
//   move it.
// - Inclusive expiry boundary: an entry whose resetAt <= now is expired.
// - The sweep is lazy and per-request (it runs inside checkAndRecord);
//   there is no timer, so stale entries occupy the map until the next call.
// - Attempts 1-15 are admitted; the 16th is the first rejection. A
//   count-based rejection does NOT increment the counter.
// - The 10,000-entry cap rejects only NEW keys, and that rejection carries
//   NO Retry-After (retryAfterSeconds is null). Existing keys keep
//   incrementing while the map is full.
// - The counter is process-local memory only, exactly like the source: it
//   resets on restart and is per-process in a multi-process deployment.
//
// The clock is injected so tests can step time deterministically; the
// default is the real clock.

export const WAITLIST_RATE_LIMIT = 15;
export const WAITLIST_RATE_WINDOW_MS = 15 * 60 * 1000;
export const WAITLIST_RATE_MAX_ENTRIES = 10_000;

// Build the limiter key from the RAW (pre-validation, pre-normalization)
// request body, exactly as the source does: the email portion is the raw
// body's email when it is a string — trimmed, lowercased, then truncated
// to 254 chars — and the literal "invalid" otherwise. Only the KEY is
// truncated; the stored/validated email never is (see handler.mjs).
export function buildWaitlistLimiterKey(ip, rawBody) {
  const email = rawBody !== null && typeof rawBody === "object" ? rawBody.email : undefined;
  const emailKey = typeof email === "string" ? email.trim().toLowerCase().slice(0, 254) : "invalid";
  return `${ip ?? "unknown"}:${emailKey}`;
}

export function createWaitlistRateLimiter({ now = () => Date.now() } = {}) {
  const attempts = new Map();

  return {
    // Sweep, then check-and-increment for `key`, in the source's order.
    // Returns { allowed: true } or
    // { allowed: false, retryAfterSeconds: number } for a count-based
    // rejection, or { allowed: false, retryAfterSeconds: null } for a
    // cap-based rejection (the source sends no Retry-After there).
    checkAndRecord(key) {
      const nowMs = now();
      for (const [entryKey, value] of attempts) {
        if (value.resetAt <= nowMs) attempts.delete(entryKey);
      }
      const attempt = attempts.get(key);
      if (attempt && attempt.count >= WAITLIST_RATE_LIMIT) {
        return { allowed: false, retryAfterSeconds: Math.ceil((attempt.resetAt - nowMs) / 1000) };
      }
      if (attempt) {
        attempt.count += 1;
        return { allowed: true };
      }
      if (attempts.size < WAITLIST_RATE_MAX_ENTRIES) {
        attempts.set(key, { count: 1, resetAt: nowMs + WAITLIST_RATE_WINDOW_MS });
        return { allowed: true };
      }
      return { allowed: false, retryAfterSeconds: null };
    },

    // Introspection for tests/observability: current map size. Because the
    // sweep is lazy, this can include expired entries until the next
    // checkAndRecord call — exactly like the source's module-level map.
    size() {
      return attempts.size;
    },
  };
}
