// CORS exact-origin allowlist (Codex autosync plan step 6).
// Requires: ME_CORS_ALLOWED_ORIGINS lists serialized origins verbatim;
// only an exact Origin match is granted (never a wildcard, never with
// Access-Control-Allow-Credentials — clients authenticate with explicit
// Authorization / X-Me-Setup-Token headers, not cookies). Unset env =
// no CORS headers at all (fail-closed, the historical behavior).

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

const ALLOWED = "https://preview-abc123.spock.replit.dev";
const OTHER_ALLOWED = "https://personal-ai-showcase.example.replit.app";
const EVIL = "https://evil.example.test";
const [ALICE] = Object.keys(DEV_ACCOUNTS);

async function startCorsBackend(t, corsAllowedOrigins) {
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataDir: mkdtempSync(join(tmpdir(), "me-backend-cors-")),
    setupToken: DEV_SETUP_TOKEN,
    devAccounts: new Map(Object.entries(DEV_ACCOUNTS)),
    ...(corsAllowedOrigins === undefined ? {} : { corsAllowedOrigins }),
  };
  const { handler } = createBackend(config);
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function preflight(base, origin, path = "/v1/account") {
  return fetch(`${base}${path}`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization, content-type",
    },
  });
}

function assertNoCors(res) {
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
  assert.equal(res.headers.get("access-control-allow-methods"), null);
}

test("allowed origin preflight grants exact origin, methods, headers", async (t) => {
  const base = await startCorsBackend(t, [ALLOWED, OTHER_ALLOWED]);
  const res = await preflight(base, ALLOWED);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
  const methods = res.headers.get("access-control-allow-methods") ?? "";
  for (const m of ["GET", "POST", "DELETE"]) assert.ok(methods.includes(m), `methods include ${m}`);
  const headers = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  assert.ok(headers.includes("authorization"));
  assert.ok(headers.includes("content-type"));
  assert.ok(headers.includes("x-me-setup-token"));
  assert.equal(res.headers.get("access-control-max-age"), "600");
  assert.match(res.headers.get("vary") ?? "", /origin/i);
  // Header-token auth only: credentialed CORS mode is never granted.
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
});

test("preflight is per-origin: the second allowlisted origin also matches", async (t) => {
  const base = await startCorsBackend(t, [ALLOWED, OTHER_ALLOWED]);
  const res = await preflight(base, OTHER_ALLOWED, "/v1/homes");
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), OTHER_ALLOWED);
});

test("disallowed origin preflight grants nothing", async (t) => {
  const base = await startCorsBackend(t, [ALLOWED]);
  const res = await preflight(base, EVIL);
  assert.equal(res.status, 403);
  assertNoCors(res);
});

test("near-miss origins do not match (subdomain, scheme, port, suffix)", async (t) => {
  const base = await startCorsBackend(t, [ALLOWED]);
  for (const origin of [
    "https://sub.preview-abc123.spock.replit.dev",
    "http://preview-abc123.spock.replit.dev",
    "https://preview-abc123.spock.replit.dev:8443",
    "https://preview-abc123.spock.replit.dev.evil.test",
  ]) {
    const res = await preflight(base, origin);
    assert.equal(res.status, 403, origin);
    assertNoCors(res);
  }
});

test("allowed origin sees CORS headers on actual responses, including 401", async (t) => {
  const base = await startCorsBackend(t, [ALLOWED]);
  const denied = await fetch(`${base}/v1/account`, { headers: { origin: ALLOWED } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("access-control-allow-origin"), ALLOWED);
  assert.match(denied.headers.get("vary") ?? "", /origin/i);
  await denied.arrayBuffer();

  const ok = await fetch(`${base}/v1/account`, {
    headers: { origin: ALLOWED, authorization: `Bearer ${ALICE}` },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), ALLOWED);
  await ok.arrayBuffer();
});

test("actual request from a disallowed origin is processed but gets no CORS headers", async (t) => {
  const base = await startCorsBackend(t, [ALLOWED]);
  const res = await fetch(`${base}/healthz`, { headers: { origin: EVIL } });
  assert.equal(res.status, 200);
  assertNoCors(res);
  await res.arrayBuffer();
});

test("requests without an Origin header are unchanged", async (t) => {
  const base = await startCorsBackend(t, [ALLOWED]);
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assertNoCors(res);
  await res.arrayBuffer();
});

test("unset allowlist emits no CORS headers and preflight falls through", async (t) => {
  const base = await startCorsBackend(t, undefined);
  const res = await fetch(`${base}/healthz`, { headers: { origin: ALLOWED } });
  assert.equal(res.status, 200);
  assertNoCors(res);
  await res.arrayBuffer();

  const pre = await preflight(base, ALLOWED);
  assert.equal(pre.status, 404); // historical behavior: no OPTIONS route
  assertNoCors(pre);
  await pre.arrayBuffer();
});

test("loadConfig parses ME_CORS_ALLOWED_ORIGINS, defaults empty, rejects bad entries", () => {
  const env = {
    ME_BACKEND_HOME_SETUP_TOKEN: DEV_SETUP_TOKEN,
    ME_BACKEND_DEV_ACCOUNTS_JSON: JSON.stringify(DEV_ACCOUNTS),
    ME_CORS_ALLOWED_ORIGINS: `${ALLOWED}, ${OTHER_ALLOWED}`,
  };
  const configured = loadConfig(env);
  assert.deepEqual([...configured.corsAllowedOrigins].sort(), [ALLOWED, OTHER_ALLOWED].sort());

  const unset = loadConfig({
    ME_BACKEND_HOME_SETUP_TOKEN: DEV_SETUP_TOKEN,
    ME_BACKEND_DEV_ACCOUNTS_JSON: JSON.stringify(DEV_ACCOUNTS),
  });
  assert.equal(unset.corsAllowedOrigins.size, 0);

  for (const bad of ["*", "https://example.com/path", "example.com", "https://example.com/"]) {
    assert.throws(
      () => loadConfig({ ...env, ME_CORS_ALLOWED_ORIGINS: bad }),
      /ME_CORS_ALLOWED_ORIGINS/,
      bad
    );
  }
});
