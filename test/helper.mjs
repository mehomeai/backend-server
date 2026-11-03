// Shared test harness: starts the backend on an ephemeral loopback port
// with an isolated temp data dir and explicit dev identity config.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { createBackend } from "../src/server.mjs";

export const DEV_SETUP_TOKEN = "test-setup-token-0123456789abcdef";
export const DEV_ACCOUNTS = {
  "test-token-alice-0000000000000001": "acct_alice",
  "test-token-bob-000000000000000002": "acct_bob",
  "test-token-carol-0000000000000003": "acct_carol",
};

export async function startTestBackend() {
  const dataDir = mkdtempSync(join(tmpdir(), "me-backend-test-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    setupToken: DEV_SETUP_TOKEN,
    devAccounts: new Map(Object.entries(DEV_ACCOUNTS)),
  };
  const { handler } = createBackend(config);
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return { server, base, dataDir, config };
}

export async function stopBackend(t, ctx) {
  t.after(() => {
    ctx.server.close();
  });
}

export function accountHeaders(token) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

export async function registerHome(base, { homeId, displayName = "Test Home", endpointHint = "placeholder-tunnel-endpoint" } = {}) {
  const res = await fetch(`${base}/v1/homes/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-me-setup-token": DEV_SETUP_TOKEN },
    body: JSON.stringify({ homeId, displayName, endpointHint }),
  });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

export async function mintTicketForHome(base, homeId, homeToken, ttlSeconds = 900) {
  const r = await fetch(`${base}/v1/homes/${homeId}/join-tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${homeToken}` },
    body: JSON.stringify({ ttlSeconds }),
  });
  const body = await r.json();
  if (r.status !== 201) throw new Error(`mint ticket failed: ${r.status} ${JSON.stringify(body)}`);
  return body;
}
