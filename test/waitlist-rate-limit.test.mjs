// Limiter tests for the waitlist rate limiter (ticket W3).
//
// These are SOURCE-DERIVED contract tests: every behavior pinned here is
// copied from the evidenced Replit handler's limiter
// (artifacts/api-server/src/routes/me-waitlist.ts, bridge clone at
// 453b5f2; see docs/waitlist-migration.md) — 15 admissions per fixed
// 15-minute window, the next request rejected, the inclusive expiry
// boundary, the lazy per-request sweep, the 10,000-entry cap whose
// rejection omits Retry-After, and limiter-key construction from the RAW
// body before validation. Time is an injected stepping clock throughout,
// so window boundaries are exact.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWaitlistLimiterKey,
  createWaitlistRateLimiter,
  WAITLIST_RATE_LIMIT,
  WAITLIST_RATE_MAX_ENTRIES,
  WAITLIST_RATE_WINDOW_MS,
} from "../src/waitlist/rate-limit.mjs";

const T0 = 1_700_000_000_000; // arbitrary fixed epoch ms

function steppingClock(start) {
  let current = start;
  return {
    now: () => current,
    advanceTo(next) {
      current = next;
    },
    advanceBy(ms) {
      current += ms;
    },
  };
}

test("the 15-request allowance is admitted and the next request is rejected with Retry-After", () => {
  const clock = steppingClock(T0);
  const limiter = createWaitlistRateLimiter({ now: clock.now });
  for (let i = 1; i <= WAITLIST_RATE_LIMIT; i++) {
    assert.deepEqual(limiter.checkAndRecord("ip:alice@example.com"), { allowed: true }, `attempt ${i}`);
  }
  const rejected = limiter.checkAndRecord("ip:alice@example.com");
  assert.equal(rejected.allowed, false);
  // resetAt was fixed at T0 + window; at T0 the full window remains.
  assert.equal(rejected.retryAfterSeconds, WAITLIST_RATE_WINDOW_MS / 1000);
  // A count-based rejection does not increment: later rejections keep
  // counting down from the same fixed resetAt, never extend it.
  clock.advanceBy(60_000);
  const rejectedLater = limiter.checkAndRecord("ip:alice@example.com");
  assert.equal(rejectedLater.allowed, false);
  assert.equal(rejectedLater.retryAfterSeconds, WAITLIST_RATE_WINDOW_MS / 1000 - 60);
});

test("budgets are per key: a different key is unaffected by an exhausted one", () => {
  const clock = steppingClock(T0);
  const limiter = createWaitlistRateLimiter({ now: clock.now });
  for (let i = 0; i < WAITLIST_RATE_LIMIT; i++) limiter.checkAndRecord("ip:alice@example.com");
  assert.equal(limiter.checkAndRecord("ip:alice@example.com").allowed, false);
  assert.deepEqual(limiter.checkAndRecord("ip:bob@example.com"), { allowed: true });
  assert.deepEqual(limiter.checkAndRecord("other-ip:alice@example.com"), { allowed: true });
});

test("the window boundary is inclusive: an entry expiring exactly at resetAt is swept", () => {
  const clock = steppingClock(T0);
  const limiter = createWaitlistRateLimiter({ now: clock.now });
  for (let i = 0; i < WAITLIST_RATE_LIMIT; i++) limiter.checkAndRecord("ip:alice@example.com");
  // One millisecond before resetAt the entry is still live: rejected.
  clock.advanceTo(T0 + WAITLIST_RATE_WINDOW_MS - 1);
  assert.equal(limiter.checkAndRecord("ip:alice@example.com").allowed, false);
  // Exactly at resetAt (resetAt <= now) the entry is expired: a fresh
  // window opens and admits again.
  clock.advanceTo(T0 + WAITLIST_RATE_WINDOW_MS);
  assert.deepEqual(limiter.checkAndRecord("ip:alice@example.com"), { allowed: true });
});

test("the expiry sweep is lazy: expired entries linger until the next checkAndRecord call", () => {
  const clock = steppingClock(T0);
  const limiter = createWaitlistRateLimiter({ now: clock.now });
  limiter.checkAndRecord("ip:alice@example.com");
  assert.equal(limiter.size(), 1);
  // Time passes beyond the window, but there is no timer: nothing is
  // swept until a request arrives.
  clock.advanceTo(T0 + WAITLIST_RATE_WINDOW_MS + 1);
  assert.equal(limiter.size(), 1);
  // The next call — for ANY key — runs the sweep first.
  limiter.checkAndRecord("ip:bob@example.com");
  assert.equal(limiter.size(), 1); // alice swept, bob recorded
});

test("the 10,000-entry cap rejects NEW keys WITHOUT Retry-After, while existing keys keep incrementing", () => {
  const clock = steppingClock(T0);
  const limiter = createWaitlistRateLimiter({ now: clock.now });
  for (let i = 0; i < WAITLIST_RATE_MAX_ENTRIES; i++) {
    assert.deepEqual(limiter.checkAndRecord(`ip:user${i}@example.com`), { allowed: true });
  }
  assert.equal(limiter.size(), WAITLIST_RATE_MAX_ENTRIES);
  const capped = limiter.checkAndRecord("ip:newcomer@example.com");
  assert.equal(capped.allowed, false);
  assert.equal(capped.retryAfterSeconds, null); // cap rejection omits Retry-After
  assert.equal(limiter.size(), WAITLIST_RATE_MAX_ENTRIES); // no entry was created
  // An existing key is not subject to the cap.
  assert.deepEqual(limiter.checkAndRecord("ip:user0@example.com"), { allowed: true });
});

test("limiter key construction uses the RAW body's email: trimmed, lowercased, truncated to 254 chars", () => {
  assert.equal(
    buildWaitlistLimiterKey("203.0.113.7", { email: "  Alice@Example.COM " }),
    "203.0.113.7:alice@example.com",
  );
  const longEmail = `${"a".repeat(300)}@example.com`;
  const key = buildWaitlistLimiterKey("203.0.113.7", { email: longEmail });
  assert.equal(key, `203.0.113.7:${"a".repeat(254)}`);
  assert.equal(key.split(":")[1].length, 254);
});

test("limiter key construction falls back to 'invalid' and 'unknown' exactly as the source", () => {
  assert.equal(buildWaitlistLimiterKey("203.0.113.7", { email: 42 }), "203.0.113.7:invalid");
  assert.equal(buildWaitlistLimiterKey("203.0.113.7", {}), "203.0.113.7:invalid");
  assert.equal(buildWaitlistLimiterKey("203.0.113.7", null), "203.0.113.7:invalid");
  assert.equal(buildWaitlistLimiterKey("203.0.113.7", "a string body"), "203.0.113.7:invalid");
  assert.equal(buildWaitlistLimiterKey(undefined, { email: "alice@example.com" }), "unknown:alice@example.com");
  assert.equal(buildWaitlistLimiterKey(null, { email: "alice@example.com" }), "unknown:alice@example.com");
});
