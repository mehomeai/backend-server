// Handler contract tests for POST /api/me/waitlist (ticket W3).
//
// These are SOURCE-DERIVED contract tests: they pin behavior copied from
// the evidenced Replit handler and generated schema
// (artifacts/api-server/src/routes/me-waitlist.ts and
// lib/api-zod/src/generated/api.ts, bridge clone at 453b5f2; see
// docs/waitlist-migration.md), exercised against the REAL handler and
// limiter with the storage-only in-memory fixture
// (test/fixtures/memory-waitlist-store.mjs). They are NOT differential
// tests: the original handler is not executed (it cannot be run locally
// without deployment access — see docs/waitlist-migration.md).
//
// Every response assertion pins the exact status, the exact body, and the
// headers: Cache-Control: no-store on ALL paths, and Retry-After ONLY on
// the count-based 429.

import test from "node:test";
import assert from "node:assert/strict";
import { createWaitlistHandler, WAITLIST_RECEIPT } from "../src/waitlist/handler.mjs";
import { createWaitlistRateLimiter } from "../src/waitlist/rate-limit.mjs";
import { WaitlistStorageError } from "../src/waitlist/store.mjs";
import { createMemoryWaitlistStore } from "./fixtures/memory-waitlist-store.mjs";

const RECEIPT_BODY = {
  success: true,
  message: "You're on the list. We'll share Me launch updates with you.",
};
const ERROR_400_BODY = { error: "Enter a valid email and agree to receive Me launch updates." };
const ERROR_429_BODY = { error: "Too many attempts. Please try again later." };
const ERROR_503_BODY = { error: "We couldn't save your signup. Please try again shortly." };
const T0 = 1_700_000_000_000;
const FIXED_NOW = new Date("2026-11-05T12:00:00.000Z");

function steppingClock(start) {
  let current = start;
  return {
    now: () => current,
    advanceTo(next) {
      current = next;
    },
  };
}

function makeHandler() {
  const clock = steppingClock(T0);
  const store = createMemoryWaitlistStore({ now: () => FIXED_NOW });
  const limiter = createWaitlistRateLimiter({ now: clock.now });
  const loggedErrors = [];
  const handle = createWaitlistHandler({
    store,
    limiter,
    logError: (err) => loggedErrors.push(err),
  });
  return { handle, store, limiter, clock, loggedErrors };
}

function assertNoStore(result) {
  assert.equal(result.headers["cache-control"], "no-store");
}

test("successful signup: exact receipt, no-store, normalized email persisted with the evidenced consent version", async () => {
  const { handle, store } = makeHandler();
  const result = await handle({
    ip: "203.0.113.7",
    body: { email: "  Alice@Example.COM ", consent: true },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, RECEIPT_BODY);
  assert.deepEqual(result.body, { ...WAITLIST_RECEIPT });
  assertNoStore(result);
  assert.equal(result.headers["retry-after"], undefined);
  assert.equal(store.size(), 1);
  assert.deepEqual(store.rows(), [
    { email: "alice@example.com", consentVersion: "launch-updates-v1", createdAt: FIXED_NOW.toISOString() },
  ]);
});

test("repeated signup: identical receipt, still one row, indistinguishable from the first signup", async () => {
  const { handle, store } = makeHandler();
  const first = await handle({ ip: "203.0.113.7", body: { email: "alice@example.com", consent: true } });
  const repeat = await handle({ ip: "198.51.100.9", body: { email: " ALICE@example.com", consent: true } });
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.body, first.body);
  assertNoStore(repeat);
  assert.equal(store.size(), 1);
});

test("validation failure: malformed, non-string, missing, and over-long emails all map to the one exact 400", async () => {
  const { handle, store } = makeHandler();
  const badBodies = [
    { email: "not-an-email", consent: true },
    { email: "missing-tld@example", consent: true },
    { email: "", consent: true },
    { email: 42, consent: true },
    { consent: true },
    // 255 chars after normalization: over the evidenced max of 254.
    { email: `${"a".repeat(243)}@example.com`, consent: true },
  ];
  for (const body of badBodies) {
    const result = await handle({ ip: "203.0.113.7", body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.deepEqual(result.body, ERROR_400_BODY);
    assertNoStore(result);
  }
  assert.equal(store.size(), 0);
});

test("consent failure: anything other than exactly true maps to the same exact 400 as a bad email", async () => {
  const { handle, store } = makeHandler();
  const badConsents = ["true", 1, "yes", false, undefined];
  for (const consent of badConsents) {
    const result = await handle({ ip: "203.0.113.7", body: { email: "alice@example.com", consent } });
    assert.equal(result.status, 400, `consent=${String(consent)}`);
    assert.deepEqual(result.body, ERROR_400_BODY);
    assertNoStore(result);
  }
  assert.equal(store.size(), 0);
});

test("non-object bodies fail validation with the same 400 (after consuming limiter capacity)", async () => {
  const { handle, store, limiter } = makeHandler();
  for (const body of [null, "a string", 42, ["an", "array"]]) {
    const result = await handle({ ip: "203.0.113.7", body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.deepEqual(result.body, ERROR_400_BODY);
    assertNoStore(result);
  }
  assert.equal(store.size(), 0);
  assert.equal(limiter.size(), 1); // all four shared the "invalid" key
});

test("unknown fields are not rejected by the schema", async () => {
  const { handle, store } = makeHandler();
  const result = await handle({
    ip: "203.0.113.7",
    body: { email: "alice@example.com", consent: true, nickname: "Al", source: "homepage" },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, RECEIPT_BODY);
  assert.equal(store.size(), 1);
});

test("honeypot: a truthy website returns the receipt with NO storage write; empty string flows normally", async () => {
  const { handle, store } = makeHandler();
  const spam = await handle({
    ip: "203.0.113.7",
    body: { email: "bot@example.com", consent: true, website: "http://spam.example" },
  });
  assert.equal(spam.status, 200);
  assert.deepEqual(spam.body, RECEIPT_BODY);
  assertNoStore(spam);
  // Whitespace-only is truthy: still the honeypot path.
  const whitespace = await handle({
    ip: "203.0.113.7",
    body: { email: "bot2@example.com", consent: true, website: " " },
  });
  assert.equal(whitespace.status, 200);
  assert.equal(store.size(), 0);
  // Empty string is falsy: a normal signup that persists.
  const human = await handle({
    ip: "203.0.113.7",
    body: { email: "human@example.com", consent: true, website: "" },
  });
  assert.equal(human.status, 200);
  assert.equal(store.size(), 1);
  assert.equal(store.rows()[0].email, "human@example.com");
});

test("honeypot field over 200 chars fails validation BEFORE the honeypot branch is reached", async () => {
  const { handle, store } = makeHandler();
  const result = await handle({
    ip: "203.0.113.7",
    body: { email: "bot@example.com", consent: true, website: "x".repeat(201) },
  });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, ERROR_400_BODY);
  assert.equal(store.size(), 0);
});

test("storage failure maps to the exact 503, is logged server-side only, and writes nothing", async () => {
  const { handle, store, loggedErrors } = makeHandler();
  const cause = new Error("underlying storage is unavailable");
  store.failNextInsert(cause);
  const result = await handle({ ip: "203.0.113.7", body: { email: "alice@example.com", consent: true } });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, ERROR_503_BODY);
  assertNoStore(result);
  assert.equal(store.size(), 0);
  assert.equal(loggedErrors.length, 1);
  assert.ok(loggedErrors[0] instanceof WaitlistStorageError);
  assert.equal(loggedErrors[0].cause, cause);
  // The injected failure is one-shot: the next signup succeeds.
  const after = await handle({ ip: "203.0.113.7", body: { email: "alice@example.com", consent: true } });
  assert.equal(after.status, 200);
});

test("honeypot submissions consume limiter capacity (the increment precedes the honeypot branch)", async () => {
  const { handle, store } = makeHandler();
  const honeypot = { email: "bot@example.com", consent: true, website: "spam" };
  for (let i = 0; i < 15; i++) {
    const result = await handle({ ip: "203.0.113.7", body: honeypot });
    assert.equal(result.status, 200, `honeypot attempt ${i + 1}`);
  }
  assert.equal(store.size(), 0); // honeypots never wrote
  // The 16th request under the same key — even a genuine signup — is
  // rate-limited, and the count-based rejection carries Retry-After.
  const sixteenth = await handle({ ip: "203.0.113.7", body: { email: "bot@example.com", consent: true } });
  assert.equal(sixteenth.status, 429);
  assert.deepEqual(sixteenth.body, ERROR_429_BODY);
  assertNoStore(sixteenth);
  assert.equal(sixteenth.headers["retry-after"], "900");
  assert.equal(store.size(), 0);
});

test("failed validation also consumes limiter capacity: the limit is on attempts, not successes", async () => {
  const { handle } = makeHandler();
  for (let i = 0; i < 15; i++) {
    const result = await handle({ ip: "203.0.113.7", body: { email: "alice@example.com", consent: "yes" } });
    assert.equal(result.status, 400, `invalid attempt ${i + 1}`);
  }
  const sixteenth = await handle({ ip: "203.0.113.7", body: { email: "alice@example.com", consent: true } });
  assert.equal(sixteenth.status, 429);
  assert.deepEqual(sixteenth.body, ERROR_429_BODY);
  assert.equal(sixteenth.headers["retry-after"], "900");
});

test("after the window expires (inclusive boundary), signups are admitted again", async () => {
  const { handle, clock } = makeHandler();
  for (let i = 0; i < 15; i++) {
    await handle({ ip: "203.0.113.7", body: { email: "alice@example.com", consent: true } });
  }
  const limited = await handle({ ip: "203.0.113.7", body: { email: "alice@example.com", consent: true } });
  assert.equal(limited.status, 429);
  clock.advanceTo(T0 + 15 * 60 * 1000);
  const after = await handle({ ip: "203.0.113.7", body: { email: "alice@example.com", consent: true } });
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, RECEIPT_BODY);
});

// --- Gap-audit additions (2026-11-05): behaviors pinned by the reference
// contract suite (~/workspace/replit-copy-2026-11-03/waitlist-contract-tests,
// 29 tests) that no branch test pinned. See
// WAITLIST-GAP-AUDIT-2026-11-05.md rows R9, R10, R11, R16, R26, R28. ---

test("non-string email variants (null, object, array) return the one exact 400 and write no row", async () => {
  const { handle, store } = makeHandler();
  for (const email of [null, { addr: "alice@example.com" }, ["alice@example.com"]]) {
    const result = await handle({ ip: "203.0.113.7", body: { email, consent: true } });
    assert.equal(result.status, 400, `email=${JSON.stringify(email)}`);
    assert.deepEqual(result.body, ERROR_400_BODY);
    assertNoStore(result);
  }
  assert.equal(store.size(), 0);
});

test("an undefined body fails validation with the same exact 400", async () => {
  const { handle, store } = makeHandler();
  const result = await handle({ ip: "203.0.113.7", body: undefined });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, ERROR_400_BODY);
  assertNoStore(result);
  assert.equal(store.size(), 0);
});

test("email length boundary applies to the NORMALIZED value: 254 admitted, 255 raw trimming to 254 admitted, 255 after trim rejected", async () => {
  const { handle, store } = makeHandler();
  const email254 = `${"a".repeat(242)}@example.com`; // exactly 254 chars
  const email255 = `${"a".repeat(243)}@example.com`; // exactly 255 chars
  assert.equal(email254.length, 254);
  assert.equal(email255.length, 255);
  // Exactly 254 after normalization: admitted.
  const exact = await handle({ ip: "203.0.113.7", body: { email: email254, consent: true } });
  assert.equal(exact.status, 200);
  assert.deepEqual(exact.body, RECEIPT_BODY);
  assertNoStore(exact);
  // 255 raw characters but 254 after trimming the leading space: admitted
  // (a repeat of the same normalized email, so still one stored row).
  const padded = await handle({ ip: "203.0.113.7", body: { email: ` ${email254}`, consent: true } });
  assert.equal(padded.status, 200);
  assert.deepEqual(padded.body, RECEIPT_BODY);
  assert.equal(store.size(), 1);
  // Still 255 after trimming: over the evidenced max of 254.
  const over = await handle({ ip: "203.0.113.7", body: { email: email255, consent: true } });
  assert.equal(over.status, 400);
  assert.deepEqual(over.body, ERROR_400_BODY);
  assert.equal(store.size(), 1);
});

test("honeypot with an invalid email returns 400: validation precedes the honeypot branch", async () => {
  const { handle, store } = makeHandler();
  const result = await handle({
    ip: "203.0.113.7",
    body: { email: "not-an-email", consent: true, website: "http://spam.example" },
  });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, ERROR_400_BODY);
  assertNoStore(result);
  assert.equal(store.size(), 0);
});

test("storage failures consume limiter capacity: after 15 signups fail with 503, the next request is 429", async () => {
  const { handle, store } = makeHandler();
  for (let i = 0; i < 15; i++) {
    store.failNextInsert(new Error("underlying storage is unavailable"));
    const result = await handle({ ip: "203.0.113.7", body: { email: "alice@example.com", consent: true } });
    assert.equal(result.status, 503, `failing attempt ${i + 1}`);
    assert.deepEqual(result.body, ERROR_503_BODY);
    assertNoStore(result);
  }
  assert.equal(store.size(), 0);
  // The 16th request never reaches storage: the limiter fires first, and
  // the count-based rejection carries Retry-After.
  const sixteenth = await handle({ ip: "203.0.113.7", body: { email: "alice@example.com", consent: true } });
  assert.equal(sixteenth.status, 429);
  assert.deepEqual(sixteenth.body, ERROR_429_BODY);
  assert.equal(sixteenth.headers["retry-after"], "900");
  assert.equal(store.size(), 0);
});

test("map cap: a NEW key at 10,000 entries gets 429 WITHOUT Retry-After (no-store still set); an existing key still proceeds", async () => {
  const { handle, limiter } = makeHandler();
  // Invalid emails still create limiter entries (the limiter precedes
  // validation), exactly as in the reference scenario.
  for (let i = 0; i < 10_000; i++) {
    const result = await handle({ ip: "203.0.113.7", body: { email: `bad${i}`, consent: true } });
    assert.equal(result.status, 400, `fill ${i}`);
  }
  assert.equal(limiter.size(), 10_000);
  const capped = await handle({ ip: "203.0.113.7", body: { email: "new@example.com", consent: true } });
  assert.equal(capped.status, 429);
  assert.deepEqual(capped.body, ERROR_429_BODY);
  assertNoStore(capped);
  assert.equal(capped.headers["retry-after"], undefined);
  // An existing key is unaffected by the cap: it increments and proceeds
  // to validation, which rejects the malformed email as usual.
  const existing = await handle({ ip: "203.0.113.7", body: { email: "bad0", consent: true } });
  assert.equal(existing.status, 400);
  assert.deepEqual(existing.body, ERROR_400_BODY);
});

// --- Zod validation port (2026-11-05, Codex ruling 01a1ae31 step 4):
// the handler validates with the pinned Zod v3.25.76 schema instead of
// the former hand-written pattern. These cases pin the observed Zod
// boundary for the forms where the two rules disagreed (see
// scripts/waitlist-email-corpus.mjs, which runs the same corpus against
// the frozen T5 oracle): Zod rejects dot-placement and `%` forms the old
// pattern accepted, and accepts underscore locals and trailing-hyphen
// domain labels the old pattern rejected. Quoted/unicode/IP-literal
// forms are rejected by both rules and are pinned here as well. ---

test("email-format boundary is Zod v3.25.76's .email(): exotic forms decided by the library", async () => {
  const { handle, store } = makeHandler();
  // Admitted by Zod (each inserts one row); the old pinned pattern
  // rejected all four.
  const admitted = ["a_b@example.com", "a@example-.com", "a@a-.com", "a@b-.co"];
  for (const email of admitted) {
    const result = await handle({ ip: "203.0.113.7", body: { email, consent: true } });
    assert.equal(result.status, 200, email);
    assert.deepEqual(result.body, RECEIPT_BODY);
    assertNoStore(result);
  }
  assert.equal(store.size(), admitted.length);
  // Rejected by Zod; the old pinned pattern admitted the first five.
  const rejected = [
    "a..b@example.com",
    ".a@example.com",
    "a.@example.com",
    "a%b@example.com",
    "a..a@a.bb",
    // Rejected by both rules; pinned here so the boundary is explicit.
    '"quoted local"@example.com',
    "münchen@example.de",
    "a@[127.0.0.1]",
    "a@b.c",
  ];
  for (const email of rejected) {
    const result = await handle({ ip: "203.0.113.7", body: { email, consent: true } });
    assert.equal(result.status, 400, email);
    assert.deepEqual(result.body, ERROR_400_BODY);
    assertNoStore(result);
  }
  assert.equal(store.size(), admitted.length);
});
