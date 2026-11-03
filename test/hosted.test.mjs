// Hosted auth readiness (B2): real OIDC JWT verification against a local
// ephemeral signing key + JWKS fixture (loopback only, no IdP, no network).
// Covers wrong signature/issuer/audience/expiry denials, account-bound
// registration tickets with owner creation, and server-side availability.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createBackend } from "../src/server.mjs";
import { loadConfig, assertSafeBind } from "../src/config.mjs";
import { deriveAccountId, createOidcVerifier } from "../src/oidc.mjs";
import { pruneTickets } from "../src/server.mjs";

const ISSUER = "http://127.0.0.1/oidc-issuer-test";
const AUDIENCE = "me-backend-test";

async function startHostedBackend(t, { staleAfterSeconds = 300 } = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key-1", alg: "RS256", use: "sig" };
  const dataDir = mkdtempSync(join(tmpdir(), "me-backend-hosted-"));
  const oidc = {
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: { keys: [jwk] },
    algorithms: ["RS256"],
    insecureIssuerAllowed: true,
  };
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    authMode: "hosted",
    devAccounts: new Map(),
    oidc,
    staleAfterSeconds,
  };
  const { handler } = createBackend(config);
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const accountIdFor = (sub) => deriveAccountId(ISSUER, sub);
  return { base, privateKey, publicKey, accountIdFor, oidc };
}

async function signToken(privateKey, { sub = "alice", omitSub = false, iss = ISSUER, aud = AUDIENCE, expSeconds = 300, kid = "test-key-1", alg = "RS256" } = {}) {
  const builder = new SignJWT(omitSub ? {} : { sub })
    .setProtectedHeader({ alg, kid })
    .setIssuedAt();
  if (iss !== null) builder.setIssuer(iss);
  if (aud !== null) builder.setAudience(aud);
  if (expSeconds !== null) builder.setExpirationTime(`${expSeconds}s`);
  return builder.sign(privateKey);
}

const bearer = (token) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

test("hosted: valid token authenticates; forged/expired/mismatched tokens denied", async (t) => {
  const ctx = await startHostedBackend(t);
  const good = await signToken(ctx.privateKey);

  const ok = await fetch(`${ctx.base}/v1/homes`, { headers: bearer(good) });
  assert.equal(ok.status, 200);

  const { privateKey: otherKey } = await generateKeyPair("RS256");
  const cases = {
    "wrong signature": await signToken(otherKey, {}),
    "wrong issuer": await signToken(ctx.privateKey, { iss: "http://127.0.0.1/other-issuer" }),
    "wrong audience": await signToken(ctx.privateKey, { aud: "someone-else" }),
    "expired": await signToken(ctx.privateKey, { expSeconds: -60 }),
    "missing exp": await signToken(ctx.privateKey, { expSeconds: null }),
    "missing sub": await signToken(ctx.privateKey, { omitSub: true }),
    "unknown kid": await signToken(ctx.privateKey, { kid: "no-such-key" }),
    "garbage": "not-a-jwt",
  };
  for (const [name, token] of Object.entries(cases)) {
    const res = await fetch(`${ctx.base}/v1/homes`, { headers: bearer(token) });
    assert.equal(res.status, 401, name);
  }
  // alg=none hand-crafted token is rejected.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const nonePayload = `${b64({ alg: "none" })}.${b64({ sub: "alice", iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
  const noneRes = await fetch(`${ctx.base}/v1/homes`, { headers: bearer(nonePayload) });
  assert.equal(noneRes.status, 401);
});

test("hosted: registration tickets bind identity; register creates owner", async (t) => {
  const ctx = await startHostedBackend(t);
  const alice = await signToken(ctx.privateKey, { sub: "alice-sub" });
  const bob = await signToken(ctx.privateKey, { sub: "bob-sub" });

  // Fleet setup secret is dead in hosted mode.
  const setupOnly = await fetch(`${ctx.base}/v1/homes/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-me-setup-token": "any-fleet-secret-0123456789" },
    body: JSON.stringify({ homeId: "home-hosted-01" }),
  });
  assert.equal(setupOnly.status, 401);

  // Mint a ticket bound to alice (+installation).
  const minted = await fetch(`${ctx.base}/v1/homes/registration-tickets`, {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({ installationId: "123e4567-e89b-42d3-a456-426614174000" }),
  });
  assert.equal(minted.status, 201);
  const ticket = await minted.json();
  assert.equal(ticket.accountId, ctx.accountIdFor("alice-sub"));

  const reg = await fetch(`${ctx.base}/v1/homes/register`, {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({
      homeId: "home-hosted-01",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      registrationTicket: ticket.registrationTicket,
      registrationTicketId: ticket.ticketId,
    }),
  });
  assert.equal(reg.status, 201);
  const home = await reg.json();
  assert.equal(home.membership.accountId, ticket.accountId);
  assert.equal(home.membership.role, "owner");

  // Replay the consumed ticket (identified replay reports gone).
  const replay = await fetch(`${ctx.base}/v1/homes/register`, {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({
      homeId: "home-hosted-02",
      registrationTicket: ticket.registrationTicket,
      registrationTicketId: ticket.ticketId,
    }),
  });
  assert.equal(replay.status, 410);

  // Bob cannot use alice's ticket.
  const aliceTicket2 = await (
    await fetch(`${ctx.base}/v1/homes/registration-tickets`, {
      method: "POST",
      headers: bearer(alice),
      body: JSON.stringify({}),
    })
  ).json();
  const crossUse = await fetch(`${ctx.base}/v1/homes/register`, {
    method: "POST",
    headers: bearer(bob),
    body: JSON.stringify({ homeId: "home-hosted-03", registrationTicket: aliceTicket2.registrationTicket }),
  });
  assert.equal(crossUse.status, 403);

  // Re-registering the same homeId never overwrites the live home, and the
  // failed 409 does not burn the ticket: it still registers another home.
  const aliceTicket3 = await (
    await fetch(`${ctx.base}/v1/homes/registration-tickets`, {
      method: "POST",
      headers: bearer(alice),
      body: JSON.stringify({}),
    })
  ).json();
  const dup = await fetch(`${ctx.base}/v1/homes/register`, {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({ homeId: "home-hosted-01", registrationTicket: aliceTicket3.registrationTicket }),
  });
  assert.equal(dup.status, 409);
  const afterDup = await fetch(`${ctx.base}/v1/homes/register`, {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({ homeId: "home-hosted-04", registrationTicket: aliceTicket3.registrationTicket }),
  });
  assert.equal(afterDup.status, 201);
  const read = await fetch(`${ctx.base}/v1/homes/home-hosted-01`, { headers: bearer(alice) });
  assert.equal(read.status, 200);
});

test("hosted: installation binding enforced; endpoint updates need home token", async (t) => {
  const ctx = await startHostedBackend(t);
  const alice = await signToken(ctx.privateKey, { sub: "alice-sub" });

  const minted = await (
    await fetch(`${ctx.base}/v1/homes/registration-tickets`, {
      method: "POST",
      headers: bearer(alice),
      body: JSON.stringify({ installationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    })
  ).json();
  const mismatch = await fetch(`${ctx.base}/v1/homes/register`, {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({
      homeId: "home-hosted-bind",
      installationId: "different-installation-id",
      registrationTicket: minted.registrationTicket,
    }),
  });
  assert.equal(mismatch.status, 403);

  // Account credential cannot heartbeat; only the home token can.
  const minted2 = await (
    await fetch(`${ctx.base}/v1/homes/registration-tickets`, {
      method: "POST",
      headers: bearer(alice),
      body: JSON.stringify({}),
    })
  ).json();
  const reg = await (
    await fetch(`${ctx.base}/v1/homes/register`, {
      method: "POST",
      headers: bearer(alice),
      body: JSON.stringify({ homeId: "home-hosted-hb", registrationTicket: minted2.registrationTicket }),
    })
  ).json();
  const hbAccount = await fetch(`${ctx.base}/v1/homes/home-hosted-hb/heartbeat`, {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({ status: "online" }),
  });
  assert.equal(hbAccount.status, 403);
  const hbHome = await fetch(`${ctx.base}/v1/homes/home-hosted-hb/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${reg.homeToken}` },
    body: JSON.stringify({ status: "online", endpointHint: "https://home.example.test" }),
  });
  assert.equal(hbHome.status, 200);

  const status = await fetch(`${ctx.base}/v1/homes/home-hosted-hb/status`, { headers: bearer(alice) });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.online, true);
  assert.equal(body.staleAfterSeconds, 300);
  assert.equal(body.lastStatus, "online");
});

test("hosted: availability goes stale server-side without fresh heartbeats", async (t) => {
  const ctx = await startHostedBackend(t, { staleAfterSeconds: 1 });
  const alice = await signToken(ctx.privateKey, { sub: "alice-sub" });

  const minted = await (
    await fetch(`${ctx.base}/v1/homes/registration-tickets`, {
      method: "POST",
      headers: bearer(alice),
      body: JSON.stringify({}),
    })
  ).json();
  const reg = await (
    await fetch(`${ctx.base}/v1/homes/register`, {
      method: "POST",
      headers: bearer(alice),
      body: JSON.stringify({ homeId: "home-hosted-stale", registrationTicket: minted.registrationTicket }),
    })
  ).json();

  // Never heartbeated: honestly offline.
  const fresh = await fetch(`${ctx.base}/v1/homes/home-hosted-stale/status`, { headers: bearer(alice) });
  assert.equal((await fresh.json()).online, false);

  await fetch(`${ctx.base}/v1/homes/home-hosted-stale/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${reg.homeToken}` },
    body: JSON.stringify({ status: "online" }),
  });
  const live = await fetch(`${ctx.base}/v1/homes/home-hosted-stale/status`, { headers: bearer(alice) });
  assert.equal((await live.json()).online, true);

  await sleep(1300);
  const stale = await fetch(`${ctx.base}/v1/homes/home-hosted-stale/status`, { headers: bearer(alice) });
  const staleBody = await stale.json();
  assert.equal(staleBody.online, false);
  assert.equal(staleBody.staleAfterSeconds, 1);
});

test("config: hosted mode needs no dev accounts; dev mode stays loopback-only", async (t) => {
  const hosted = loadConfig({
    ME_BACKEND_PORT: "8787",
    ME_BACKEND_DATA_DIR: "/tmp/me-hosted-cfg-probe",
    ME_BACKEND_AUTH_MODE: "hosted",
    ME_BACKEND_OIDC_ISSUER: "https://issuer.example.test",
    ME_BACKEND_OIDC_AUDIENCE: "me-backend",
    ME_BACKEND_OIDC_JWKS: JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", kid: "k1" }] }),
  });
  assert.equal(hosted.authMode, "hosted");
  assert.equal(hosted.devAccounts.size, 0);
  assert.equal(hosted.setupToken, null);
  assert.deepEqual(hosted.oidc.algorithms, ["RS256"]);

  // Dev bind refusal, hosted allowance.
  assert.throws(
    () => assertSafeBind({ authMode: "dev", host: "0.0.0.0" }),
    /loopback/
  );
  assert.doesNotThrow(() => assertSafeBind({ authMode: "dev", host: "127.0.0.1" }));
  assert.doesNotThrow(() => assertSafeBind({ authMode: "hosted", host: "0.0.0.0" }));

  // Hardening of OIDC inputs.
  assert.throws(() => loadConfig({
    ME_BACKEND_AUTH_MODE: "hosted",
    ME_BACKEND_OIDC_ISSUER: "https://issuer.example.test",
    ME_BACKEND_OIDC_AUDIENCE: "me-backend",
    ME_BACKEND_OIDC_JWKS: JSON.stringify({ keys: [] }),
  }), /non-empty keys/);
  assert.throws(() => loadConfig({
    ME_BACKEND_AUTH_MODE: "hosted",
    ME_BACKEND_OIDC_ISSUER: "http://issuer.example.test",
    ME_BACKEND_OIDC_AUDIENCE: "me-backend",
    ME_BACKEND_OIDC_JWKS: JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }] }),
  }), /https/);
  assert.throws(() => loadConfig({
    ME_BACKEND_AUTH_MODE: "hosted",
    ME_BACKEND_OIDC_ISSUER: "https://issuer.example.test",
    ME_BACKEND_OIDC_AUDIENCE: "me-backend",
    ME_BACKEND_OIDC_JWKS: JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }] }),
    ME_BACKEND_OIDC_ALGORITHMS: "HS256",
  }), /Symmetric|not permitted/);

  // Hosted config rejects an accidental dev token map (no silent backdoor).
  assert.throws(() => loadConfig({
    ME_BACKEND_AUTH_MODE: "hosted",
    ME_BACKEND_OIDC_ISSUER: "https://issuer.example.test",
    ME_BACKEND_OIDC_AUDIENCE: "me-backend",
    ME_BACKEND_OIDC_JWKS: JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }] }),
    ME_BACKEND_DEV_ACCOUNTS_JSON: JSON.stringify({ "dev-token-alice-0000000000000001": "acct_alice" }),
  }), /must not configure ME_BACKEND_DEV_ACCOUNTS_JSON/);

  // Insecure-issuer escape hatch: loopback http only, never remote http —
  // via config and via the direct verifier API.
  const loopbackHttp = {
    ME_BACKEND_AUTH_MODE: "hosted",
    ME_BACKEND_OIDC_ISSUER: "http://127.0.0.1/issuer-test",
    ME_BACKEND_OIDC_AUDIENCE: "me-backend",
    ME_BACKEND_OIDC_JWKS: JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }] }),
    ME_BACKEND_OIDC_ALLOW_INSECURE_ISSUER: "1",
  };
  assert.equal(loadConfig(loopbackHttp).authMode, "hosted");
  assert.throws(() => loadConfig({
    ...loopbackHttp,
    ME_BACKEND_OIDC_ISSUER: "http://issuer.example.test",
  }), /loopback/);
  assert.throws(() => createOidcVerifier({
    issuer: "http://issuer.example.test",
    audience: "me-backend",
    jwks: { keys: [{}] },
    algorithms: ["RS256"],
    insecureIssuerAllowed: true,
  }), /loopback|arbitrary remote/);
});

test("hosted: static dev tokens never authenticate, even if configured directly", async (t) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const dataDir = mkdtempSync(join(tmpdir(), "me-hosted-failclosed-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    authMode: "hosted",
    // Simulates a mistaken direct config carrying a dev map: the server must
    // ignore it, so the static token gets 401 while a real JWT succeeds.
    devAccounts: new Map([["static-dev-token-0000000000000001", "acct_alice"]]),
    oidc: {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: { keys: [jwk] },
      algorithms: ["RS256"],
      insecureIssuerAllowed: true,
    },
    staleAfterSeconds: 300,
  };
  const { handler } = createBackend(config);
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const staticRes = await fetch(`${base}/v1/homes`, {
    headers: bearer("static-dev-token-0000000000000001"),
  });
  assert.equal(staticRes.status, 401);

  const jwt = await signToken(privateKey, { sub: "real-user", kid: "k1" });
  const jwtRes = await fetch(`${base}/v1/homes`, { headers: bearer(jwt) });
  assert.equal(jwtRes.status, 200);
});

test("hosted: registration tickets are capped per account with pruning", async (t) => {
  const ctx = await startHostedBackend(t);
  const alice = await signToken(ctx.privateKey, { sub: "cap-user" });
  // 20 live tickets is the per-account cap; the 21st is refused.
  for (let i = 0; i < 20; i++) {
    const minted = await fetch(`${ctx.base}/v1/homes/registration-tickets`, {
      method: "POST",
      headers: bearer(alice),
      body: JSON.stringify({ label: `ticket-${i}` }),
    });
    assert.equal(minted.status, 201, `mint ${i}`);
  }
  const over = await fetch(`${ctx.base}/v1/homes/registration-tickets`, {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({}),
  });
  assert.equal(over.status, 429);
});

test("pruneTickets sweeps long-expired and unsafe keys, keeps live ones", () => {
  const now = Date.now();
  const collection = {
    live: { ticketId: "live", expiresAt: new Date(now + 60000).toISOString(), consumedAt: null },
    recentExpired: { ticketId: "recentExpired", expiresAt: new Date(now - 1000).toISOString(), consumedAt: null },
    oldExpired: { ticketId: "oldExpired", expiresAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(), consumedAt: null },
    oldConsumed: { ticketId: "oldConsumed", expiresAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(), consumedAt: new Date(now - 90 * 60 * 1000).toISOString() },
  };
  const pruned = pruneTickets(collection, now);
  assert.equal(pruned, 2);
  assert.ok(collection.live);
  assert.ok(collection.recentExpired);
  assert.ok(!collection.oldExpired);
  assert.ok(!collection.oldConsumed);
});
