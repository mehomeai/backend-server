// Mocked-driver tests for the PostgreSQL waitlist adapter (ticket W5).
//
// *** These tests do NOT verify PostgreSQL. *** The adapter remains
// UNVERIFIED against PostgreSQL: no database exists on this machine, no
// connection is attempted anywhere in this file, and the `pg` driver is
// never loaded (the adapter reaches it only through a dynamic import
// behind createPgPoolFactory, which these tests never invoke). A fake
// pool/client is injected through the store's poolFactory seam instead.
// What these tests DO verify, per the Codex ruling's step-5 gate:
// parameter binding (values never interpolated into SQL text), result
// mapping (persisted row returned on insert and on conflict), failure
// propagation as WaitlistStorageError, connection/client release on
// success and on error, lazy pool construction, and the conflict/retry
// control flow. They do not verify PostgreSQL syntax, the migration,
// isolation behavior, or actual uniqueness enforcement.

import test from "node:test";
import assert from "node:assert/strict";
import { WaitlistStorageError } from "../src/waitlist/store.mjs";
import {
  createPostgresWaitlistStore,
  createPgPoolFactory,
  WAITLIST_INSERT_SQL,
  WAITLIST_SELECT_BY_EMAIL_SQL,
} from "../src/waitlist/postgres-store.mjs";

const EMAIL = "alice@example.com";
const CONSENT = "launch-updates-v1";
const CREATED = new Date("2026-11-05T12:00:00.000Z");

function persistedRow(overrides = {}) {
  return { email: EMAIL, consent_version: CONSENT, created_at: CREATED, ...overrides };
}

// A fake pool/client pair recording every interaction. `onQuery(text,
// values)` decides each query's outcome (return { rows } or throw).
function createMockPool({ onQuery, connectError } = {}) {
  const state = { factoryCalls: 0, connectCalls: 0, queries: [], releaseCalls: 0, endCalls: 0 };
  const client = {
    async query(text, values) {
      state.queries.push({ text, values });
      return onQuery(text, values);
    },
    release() {
      state.releaseCalls++;
    },
  };
  const pool = {
    async connect() {
      state.connectCalls++;
      if (connectError) throw connectError;
      return client;
    },
    async end() {
      state.endCalls++;
    },
  };
  const poolFactory = () => {
    state.factoryCalls++;
    return pool;
  };
  return { state, pool, poolFactory };
}

// onQuery that plays back a fixed sequence of results (an Error entry is
// thrown). The last entry repeats if the sequence is exhausted.
function scripted(results) {
  let i = 0;
  return () => {
    const result = results[Math.min(i++, results.length - 1)];
    if (result instanceof Error) throw result;
    return result;
  };
}

test("constructing the store creates no pool; the pg pool factory validates without loading the driver", () => {
  const { state, poolFactory } = createMockPool({ onQuery: () => ({ rows: [] }) });
  createPostgresWaitlistStore({ poolFactory });
  assert.equal(state.factoryCalls, 0);
  assert.equal(state.connectCalls, 0);
  // createPgPoolFactory is pure validation + closure creation until invoked.
  assert.throws(() => createPgPoolFactory({}), TypeError);
  assert.throws(() => createPgPoolFactory({ connectionString: "" }), TypeError);
  assert.equal(typeof createPgPoolFactory({ connectionString: "postgres://unused.invalid/db" }), "function");
  // A missing factory is a caller bug at construction time.
  assert.throws(() => createPostgresWaitlistStore({}), TypeError);
  assert.throws(() => createPostgresWaitlistStore({ poolFactory: "not-a-function" }), TypeError);
});

test("first insert returns the persisted row, binds values as parameters, and releases the client", async () => {
  const { state, poolFactory } = createMockPool({
    onQuery: () => ({ rows: [persistedRow()] }),
  });
  const store = createPostgresWaitlistStore({ poolFactory });
  const result = await store.insertOrReturnExisting({ email: EMAIL, consentVersion: CONSENT });

  assert.equal(result.inserted, true);
  assert.deepEqual(result.row, { email: EMAIL, consentVersion: CONSENT, createdAt: CREATED.toISOString() });
  assert.equal(state.factoryCalls, 1);
  assert.equal(state.connectCalls, 1);
  assert.equal(state.releaseCalls, 1);
  assert.equal(state.queries.length, 1, "a successful insert must not issue a SELECT");
  const { text, values } = state.queries[0];
  assert.equal(text, WAITLIST_INSERT_SQL);
  assert.match(text, /\$1/);
  assert.match(text, /\$2/);
  assert.match(text, /ON CONFLICT \(email\) DO NOTHING/);
  assert.ok(!text.includes(EMAIL), "email value must never be interpolated into SQL text");
  assert.ok(!text.includes(CONSENT), "consent value must never be interpolated into SQL text");
  assert.deepEqual(values, [EMAIL, CONSENT]);
});

test("conflict returns the persisted row from SELECT, never the repeat request's values", async () => {
  const { state, poolFactory } = createMockPool({
    onQuery: scripted([{ rows: [] }, { rows: [persistedRow()] }]),
  });
  const store = createPostgresWaitlistStore({ poolFactory });
  // The repeat request carries a different consent version; the persisted
  // original must win.
  const result = await store.insertOrReturnExisting({
    email: EMAIL,
    consentVersion: "a-different-version-from-the-repeat-request",
  });

  assert.equal(result.inserted, false);
  assert.deepEqual(result.row, { email: EMAIL, consentVersion: CONSENT, createdAt: CREATED.toISOString() });
  assert.equal(state.queries.length, 2);
  const select = state.queries[1];
  assert.equal(select.text, WAITLIST_SELECT_BY_EMAIL_SQL);
  assert.ok(!select.text.includes(EMAIL), "email value must never be interpolated into SQL text");
  assert.deepEqual(select.values, [EMAIL]);
  assert.equal(state.releaseCalls, 1);
});

test("conflict with no visible row retries the insert-or-select cycle and can then succeed", async () => {
  const { state, poolFactory } = createMockPool({
    onQuery: scripted([{ rows: [] }, { rows: [] }, { rows: [persistedRow()] }]),
  });
  const store = createPostgresWaitlistStore({ poolFactory });
  const result = await store.insertOrReturnExisting({ email: EMAIL, consentVersion: CONSENT });

  assert.equal(result.inserted, true);
  assert.deepEqual(result.row, { email: EMAIL, consentVersion: CONSENT, createdAt: CREATED.toISOString() });
  assert.deepEqual(
    state.queries.map((q) => q.text),
    [WAITLIST_INSERT_SQL, WAITLIST_SELECT_BY_EMAIL_SQL, WAITLIST_INSERT_SQL],
  );
  assert.equal(state.releaseCalls, 1, "the retry stays on the same acquired client");
});

test("a persistent conflict anomaly surfaces WaitlistStorageError instead of a manufactured row", async () => {
  const { state, poolFactory } = createMockPool({ onQuery: () => ({ rows: [] }) });
  const store = createPostgresWaitlistStore({ poolFactory });
  await assert.rejects(store.insertOrReturnExisting({ email: EMAIL, consentVersion: CONSENT }), (err) => {
    assert.ok(err instanceof WaitlistStorageError, `expected WaitlistStorageError, got ${err}`);
    assert.ok(err.cause instanceof Error);
    return true;
  });
  assert.equal(state.queries.length, 4, "two full insert-or-select cycles, then give up");
  assert.equal(state.releaseCalls, 1);
});

test("a query failure propagates as WaitlistStorageError with the cause, and the client is still released", async () => {
  const driverError = new Error("mock driver: relation does not exist");
  const { state, poolFactory } = createMockPool({
    onQuery: () => {
      throw driverError;
    },
  });
  const store = createPostgresWaitlistStore({ poolFactory });
  await assert.rejects(store.insertOrReturnExisting({ email: EMAIL, consentVersion: CONSENT }), (err) => {
    assert.ok(err instanceof WaitlistStorageError, `expected WaitlistStorageError, got ${err}`);
    assert.equal(err.cause, driverError);
    return true;
  });
  assert.equal(state.releaseCalls, 1);
});

test("a connect failure propagates as WaitlistStorageError with the cause, and nothing is released", async () => {
  const connectError = new Error("mock driver: connection refused");
  const { state, poolFactory } = createMockPool({ onQuery: () => ({ rows: [] }), connectError });
  const store = createPostgresWaitlistStore({ poolFactory });
  await assert.rejects(store.insertOrReturnExisting({ email: EMAIL, consentVersion: CONSENT }), (err) => {
    assert.ok(err instanceof WaitlistStorageError, `expected WaitlistStorageError, got ${err}`);
    assert.equal(err.cause, connectError);
    return true;
  });
  assert.equal(state.connectCalls, 1);
  assert.equal(state.releaseCalls, 0, "no client was acquired, so no release may happen");
  assert.equal(state.queries.length, 0);
});

test("a pool factory failure propagates as WaitlistStorageError, and construction stayed lazy until first use", async () => {
  const factoryError = new Error("mock factory: driver unavailable");
  let factoryCalls = 0;
  const store = createPostgresWaitlistStore({
    poolFactory: () => {
      factoryCalls++;
      throw factoryError;
    },
  });
  assert.equal(factoryCalls, 0, "constructing the store must not invoke the factory");
  await assert.rejects(store.insertOrReturnExisting({ email: EMAIL, consentVersion: CONSENT }), (err) => {
    assert.ok(err instanceof WaitlistStorageError, `expected WaitlistStorageError, got ${err}`);
    assert.equal(err.cause, factoryError);
    return true;
  });
  assert.equal(factoryCalls, 1);
});

test("caller-bug inputs throw TypeError before any pool work begins", async () => {
  const { state, poolFactory } = createMockPool({ onQuery: () => ({ rows: [persistedRow()] }) });
  const store = createPostgresWaitlistStore({ poolFactory });
  const badInputs = [
    undefined,
    {},
    { email: 42, consentVersion: CONSENT },
    { email: "", consentVersion: CONSENT },
    { email: EMAIL },
    { email: EMAIL, consentVersion: "" },
  ];
  for (const input of badInputs) {
    await assert.rejects(store.insertOrReturnExisting(input), (err) => {
      assert.ok(err instanceof TypeError, `expected TypeError for ${JSON.stringify(input)}, got ${err}`);
      assert.ok(!(err instanceof WaitlistStorageError), "caller bugs must not surface as storage failures");
      return true;
    });
  }
  assert.equal(state.factoryCalls, 0);
  assert.equal(state.connectCalls, 0);
  assert.equal(state.queries.length, 0);
});

test("the pool is constructed once and reused across operations", async () => {
  const { state, poolFactory } = createMockPool({
    onQuery: (text, values) => ({ rows: [persistedRow({ email: values[0] })] }),
  });
  const store = createPostgresWaitlistStore({ poolFactory });
  await store.insertOrReturnExisting({ email: EMAIL, consentVersion: CONSENT });
  const second = await store.insertOrReturnExisting({ email: "bob@example.com", consentVersion: CONSENT });
  assert.equal(second.row.email, "bob@example.com");
  assert.equal(state.factoryCalls, 1);
  assert.equal(state.connectCalls, 2);
  assert.equal(state.releaseCalls, 2);
});

test("close ends a constructed pool and is a no-op before first use", async () => {
  const unused = createMockPool({ onQuery: () => ({ rows: [] }) });
  const unusedStore = createPostgresWaitlistStore({ poolFactory: unused.poolFactory });
  await unusedStore.close();
  assert.equal(unused.state.factoryCalls, 0, "close before use must not construct the pool");
  assert.equal(unused.state.endCalls, 0);

  const used = createMockPool({ onQuery: () => ({ rows: [persistedRow()] }) });
  const usedStore = createPostgresWaitlistStore({ poolFactory: used.poolFactory });
  await usedStore.insertOrReturnExisting({ email: EMAIL, consentVersion: CONSENT });
  await usedStore.close();
  assert.equal(used.state.endCalls, 1);
});
