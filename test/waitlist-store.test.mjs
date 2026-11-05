// Adapter contract tests for the waitlist storage boundary (ticket W2).
//
// These are SOURCE-DERIVED contract tests: the semantics they pin come from
// the evidenced Replit handler and schema (see docs/waitlist-migration.md),
// exercised here against the deterministic in-memory fixture
// (test/fixtures/memory-waitlist-store.mjs). They prove the storage
// contract — first insert, repeat insert returning the original persisted
// metadata, and failure propagation — for any adapter claiming to implement
// src/waitlist/store.mjs. They do NOT verify the PostgreSQL adapter
// (ticket W5), which remains UNVERIFIED against PostgreSQL.
//
// The consent-version value below is the evidenced literal the handler
// writes ("launch-updates-v1", me-waitlist.ts in the bridge clone at
// 453b5f2). The store itself is version-agnostic; the repeat-insert test
// deliberately passes a different version on the repeat request to prove
// the persisted value — never the repeat request's value — is returned.

import test from "node:test";
import assert from "node:assert/strict";
import { WaitlistStorageError } from "../src/waitlist/store.mjs";
import { createMemoryWaitlistStore } from "./fixtures/memory-waitlist-store.mjs";

const T1 = new Date("2026-11-05T12:00:00.000Z");
const T2 = new Date("2026-11-05T12:05:00.000Z");

function steppingClock(start) {
  let current = start;
  return {
    now: () => current,
    advanceTo(next) {
      current = next;
    },
  };
}

test("first insert persists and returns the persisted row", async () => {
  const store = createMemoryWaitlistStore({ now: () => T1 });
  const result = await store.insertOrReturnExisting({
    email: "alice@example.com",
    consentVersion: "launch-updates-v1",
  });
  assert.equal(result.inserted, true);
  assert.deepEqual(result.row, {
    email: "alice@example.com",
    consentVersion: "launch-updates-v1",
    createdAt: T1.toISOString(),
  });
  assert.equal(store.size(), 1);
  assert.deepEqual(store.rows(), [result.row]);
});

test("repeat insert returns the original persisted consent_version and created_at, and creates no second row", async () => {
  const clock = steppingClock(T1);
  const store = createMemoryWaitlistStore({ now: clock.now });
  const first = await store.insertOrReturnExisting({
    email: "alice@example.com",
    consentVersion: "launch-updates-v1",
  });
  clock.advanceTo(T2);
  // A different consent version in the repeat request must be ignored:
  // the persisted row is returned exactly as first stored.
  const repeat = await store.insertOrReturnExisting({
    email: "alice@example.com",
    consentVersion: "a-different-version-from-the-repeat-request",
  });
  assert.equal(repeat.inserted, false);
  assert.deepEqual(repeat.row, first.row);
  assert.equal(repeat.row.consentVersion, "launch-updates-v1");
  assert.equal(repeat.row.createdAt, T1.toISOString());
  assert.equal(store.size(), 1);
});

test("a different email creates its own row", async () => {
  const store = createMemoryWaitlistStore({ now: () => T1 });
  await store.insertOrReturnExisting({ email: "alice@example.com", consentVersion: "launch-updates-v1" });
  const second = await store.insertOrReturnExisting({
    email: "bob@example.com",
    consentVersion: "launch-updates-v1",
  });
  assert.equal(second.inserted, true);
  assert.equal(second.row.email, "bob@example.com");
  assert.equal(store.size(), 2);
});

test("returned rows are copies: mutating a result does not corrupt persisted state", async () => {
  const store = createMemoryWaitlistStore({ now: () => T1 });
  const first = await store.insertOrReturnExisting({
    email: "alice@example.com",
    consentVersion: "launch-updates-v1",
  });
  first.row.consentVersion = "mutated-by-caller";
  first.row.createdAt = "1970-01-01T00:00:00.000Z";
  const repeat = await store.insertOrReturnExisting({
    email: "alice@example.com",
    consentVersion: "launch-updates-v1",
  });
  assert.equal(repeat.row.consentVersion, "launch-updates-v1");
  assert.equal(repeat.row.createdAt, T1.toISOString());
});

test("storage failure rejects with WaitlistStorageError, preserves the cause, and writes nothing", async () => {
  const store = createMemoryWaitlistStore({ now: () => T1 });
  const cause = new Error("underlying storage is unavailable");
  store.failNextInsert(cause);
  await assert.rejects(
    store.insertOrReturnExisting({ email: "alice@example.com", consentVersion: "launch-updates-v1" }),
    (err) => {
      assert.ok(err instanceof WaitlistStorageError, `expected WaitlistStorageError, got ${err}`);
      assert.equal(err.cause, cause);
      return true;
    },
  );
  assert.equal(store.size(), 0);
  // The injected failure is one-shot and leaves no partial state behind:
  // the next insert behaves as a normal first insert.
  const after = await store.insertOrReturnExisting({
    email: "alice@example.com",
    consentVersion: "launch-updates-v1",
  });
  assert.equal(after.inserted, true);
  assert.equal(store.size(), 1);
});

test("caller-bug inputs reject with TypeError, never WaitlistStorageError", async () => {
  const store = createMemoryWaitlistStore({ now: () => T1 });
  const badInputs = [
    undefined,
    {},
    { email: 42, consentVersion: "launch-updates-v1" },
    { email: "", consentVersion: "launch-updates-v1" },
    { email: "alice@example.com" },
    { email: "alice@example.com", consentVersion: "" },
  ];
  for (const input of badInputs) {
    await assert.rejects(store.insertOrReturnExisting(input), (err) => {
      assert.ok(err instanceof TypeError, `expected TypeError for ${JSON.stringify(input)}, got ${err}`);
      assert.ok(!(err instanceof WaitlistStorageError), "caller bugs must not surface as storage failures");
      return true;
    });
  }
  assert.equal(store.size(), 0);
});

test("the fixture is deterministic under an injected clock", async () => {
  const a = createMemoryWaitlistStore({ now: () => T1 });
  const b = createMemoryWaitlistStore({ now: () => T1 });
  const input = { email: "alice@example.com", consentVersion: "launch-updates-v1" };
  const resultA = await a.insertOrReturnExisting(input);
  const resultB = await b.insertOrReturnExisting(input);
  assert.deepEqual(resultA, resultB);
});
