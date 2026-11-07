// HTTP integration tests for the waitlist route registration (ticket W4).
//
// These tests prove the disabled-flag route integration in the real
// server (src/server.mjs):
// - absent or disabled flag: POST /api/me/waitlist gets the backend's
//   normal unmatched-route 404, and the injected store factory records
//   ZERO calls (no storage/pool initialization happens at all);
// - explicitly enabled: the route answers unauthenticated requests with
//   the evidenced responses, using ONLY the injected in-memory fixture
//   (test/fixtures/memory-waitlist-store.mjs) — no production store
//   exists yet (the PostgreSQL adapter is ticket W5, UNVERIFIED);
// - existing protected routes remain protected, and existing flows are
//   unchanged.
// Enabling without any store fails closed at construction time.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { createBackend } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { DEV_SETUP_TOKEN, DEV_ACCOUNTS } from "./helper.mjs";
import { createMemoryWaitlistStore } from "./fixtures/memory-waitlist-store.mjs";

const RECEIPT_BODY = {
  success: true,
  message: "You're on the list. We'll share Me launch updates with you.",
};
const ERROR_400_BODY = { error: "Enter a valid email and agree to receive Me launch updates." };
const ERROR_503_BODY = { error: "We couldn't save your signup. Please try again shortly." };

function countingFactory(store) {
  const factory = () => {
    factory.calls += 1;
    return store;
  };
  factory.calls = 0;
  return factory;
}

async function startBackend(t, extraConfig) {
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataDir: mkdtempSync(join(tmpdir(), "me-backend-waitlist-")),
    setupToken: DEV_SETUP_TOKEN,
    devAccounts: new Map(Object.entries(DEV_ACCOUNTS)),
    ...extraConfig,
  };
  const { handler } = createBackend(config);
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function signup(base, body, headers = {}) {
  return fetch(`${base}/api/me/waitlist`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("absent flag: route is unmatched (normal 404) and the store factory is never called", async (t) => {
  const store = createMemoryWaitlistStore();
  const factory = countingFactory(store);
  const base = await startBackend(t, { waitlistStoreFactory: factory });
  const res = await signup(base, { email: "alice@example.com", consent: true });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found." });
  assert.equal(factory.calls, 0);
  assert.equal(store.size(), 0);
});

test("explicitly disabled flag: route is unmatched (normal 404) and the store factory is never called", async (t) => {
  const store = createMemoryWaitlistStore();
  const factory = countingFactory(store);
  const base = await startBackend(t, { waitlistEnabled: false, waitlistStoreFactory: factory });
  const res = await signup(base, { email: "alice@example.com", consent: true });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found." });
  assert.equal(factory.calls, 0);
  assert.equal(store.size(), 0);
});

test("enabled: unauthenticated signups produce the evidenced responses via the injected fixture only", async (t) => {
  const store = createMemoryWaitlistStore();
  const factory = countingFactory(store);
  const base = await startBackend(t, { waitlistEnabled: true, waitlistStoreFactory: factory });
  assert.equal(factory.calls, 1); // constructed once, behind enablement

  // No Authorization header of any kind: the route is public.
  const first = await signup(base, { email: "  Alice@Example.COM ", consent: true });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.deepEqual(await first.json(), RECEIPT_BODY);
  assert.equal(store.size(), 1);
  assert.equal(store.rows()[0].email, "alice@example.com");
  assert.equal(store.rows()[0].consentVersion, "launch-updates-v1");

  const repeat = await signup(base, { email: "alice@example.com", consent: true });
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), RECEIPT_BODY);
  assert.equal(store.size(), 1);

  const invalid = await signup(base, { email: "alice@example.com", consent: "yes" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("cache-control"), "no-store");
  assert.deepEqual(await invalid.json(), ERROR_400_BODY);

  const honeypot = await signup(base, { email: "bot@example.com", consent: true, website: "spam" });
  assert.equal(honeypot.status, 200);
  assert.deepEqual(await honeypot.json(), RECEIPT_BODY);
  assert.equal(store.size(), 1); // honeypot wrote nothing
});

test("enabled: a storage failure surfaces as the exact 503 with no-store over HTTP", async (t) => {
  const store = createMemoryWaitlistStore();
  const base = await startBackend(t, { waitlistEnabled: true, waitlistStoreFactory: () => store });
  store.failNextInsert(new Error("underlying storage is unavailable"));
  const res = await signup(base, { email: "alice@example.com", consent: true });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), ERROR_503_BODY);
  assert.equal(store.size(), 0);
});

test("enabled: existing protected routes remain protected and existing flows are unchanged", async (t) => {
  const store = createMemoryWaitlistStore();
  const base = await startBackend(t, { waitlistEnabled: true, waitlistStoreFactory: () => store });

  const homes = await fetch(`${base}/v1/homes`);
  assert.equal(homes.status, 401);
  assert.deepEqual(await homes.json(), { error: "Account authorization required." });

  const account = await fetch(`${base}/v1/account`);
  assert.equal(account.status, 401);
  assert.deepEqual(await account.json(), { error: "Account authorization required." });

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);

  // The dev registration flow still works end to end.
  const registered = await fetch(`${base}/v1/homes/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-me-setup-token": DEV_SETUP_TOKEN },
    body: JSON.stringify({ homeId: "home_waitlist_route_test", displayName: "Test Home" }),
  });
  assert.equal(registered.status, 201);
});

test("enabled without any store fails closed at construction", () => {
  assert.throws(
    () =>
      createBackend({
        host: "127.0.0.1",
        port: 0,
        dataDir: mkdtempSync(join(tmpdir(), "me-backend-waitlist-")),
        setupToken: DEV_SETUP_TOKEN,
        devAccounts: new Map(Object.entries(DEV_ACCOUNTS)),
        waitlistEnabled: true,
      }),
    /no waitlist store was provided/,
  );
});

test("flag parsing: only ME_WAITLIST_ENABLED=1 enables; absent or other values stay disabled", () => {
  const devEnv = {
    ME_BACKEND_HOME_SETUP_TOKEN: DEV_SETUP_TOKEN,
    ME_BACKEND_DEV_ACCOUNTS_JSON: JSON.stringify(DEV_ACCOUNTS),
  };
  assert.equal(loadConfig({ ...devEnv, ME_WAITLIST_ENABLED: "1" }).waitlistEnabled, true);
  assert.equal(loadConfig({ ...devEnv }).waitlistEnabled, false);
  assert.equal(loadConfig({ ...devEnv, ME_WAITLIST_ENABLED: "true" }).waitlistEnabled, false);
  assert.equal(loadConfig({ ...devEnv, ME_WAITLIST_ENABLED: "0" }).waitlistEnabled, false);
});
