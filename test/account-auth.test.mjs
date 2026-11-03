// Account-auth-v1 (B4): public login metadata + verification handoff.
// Covers dev-honest/hosted-ready/503-not-ready config, no secret leakage,
// clientId!=audience, remote JWKS rotation via ephemeral loopback fixture,
// token_use + jku denial, and GET /v1/account verification.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createBackend } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { deriveAccountId, createOidcVerifier } from "../src/oidc.mjs";

const ISSUER = "http://127.0.0.1/oidc-auth-v1-test";
const AUDIENCE = "me-backend-api-test";
const CLIENT_ID = "me-mobile-public-test-client";
const REDIRECT = "myapp://auth/callback";

async function startBackend(t, oidc, { authMode = "hosted", staleAfterSeconds = 300 } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "me-acct-auth-"));
  const config = { host: "127.0.0.1", port: 0, dataDir, authMode, devAccounts: new Map(), oidc, staleAfterSeconds };
  const { handler } = createBackend(config);
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function signToken(privateKey, { sub = "alice", iss = ISSUER, aud = AUDIENCE, expSeconds = 300, kid = "k1", alg = "RS256", extra = {}, headers = {} } = {}) {
  const builder = new SignJWT({ sub, ...extra })
    .setProtectedHeader({ alg, kid, ...headers })
    .setIssuedAt();
  if (iss !== null) builder.setIssuer(iss);
  if (aud !== null) builder.setAudience(aud);
  if (expSeconds !== null) builder.setExpirationTime(`${expSeconds}s`);
  return builder.sign(privateKey);
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });

// Ephemeral loopback JWKS fixture: serves the current key array; tests can
// rotate by mutating `current.keys`. Plain http only because tests set the
// explicit loopback flag — production configs reject this.
async function startJwksFixture(t, keys) {
  const current = { keys };
  const server = createServer((req, res) => {
    if (req.url === "/jwks.json") {
      const body = JSON.stringify({ keys: current.keys });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/jwks.json`;
  return { url, current };
}

test("auth config: dev is honest, no OAuth, no secrets", async (t) => {
  const { mkdtempSync: mk } = await import("node:fs");
  void mk;
  const dataDir = mkdtempSync(join(tmpdir(), "me-acct-dev-"));
  const config = {
    host: "127.0.0.1", port: 0, dataDir, authMode: "dev",
    setupToken: "test-setup-token-0123456789abcdef",
    devAccounts: new Map([["dev-token-alice-0000000000000001", "acct_alice"]]),
    oidc: null,
  };
  const { handler } = createBackend(config);
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/v1/auth/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.protocol, "account-auth-v1");
  assert.equal(body.authMode, "dev");
  assert.equal(body.devOnly, true);
  assert.equal(body.oauthConfigured, false);
  const text = JSON.stringify(body);
  assert.ok(!text.includes("dev-token-alice"));
  assert.ok(!text.toLowerCase().includes("secret"));
  assert.ok(!text.includes("keys"));

  // /v1/account in dev: valid token works, garbage denied.
  const ok = await fetch(`${base}/v1/account`, { headers: bearer("dev-token-alice-0000000000000001") });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).accountId, "acct_alice");
  const bad = await fetch(`${base}/v1/account`, { headers: bearer("nope-bad-token-0000000001") });
  assert.equal(bad.status, 401);
});

test("auth config: hosted ready exposes public metadata, hides secrets; /v1/account verifies", async (t) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const base = await startBackend(t, {
    issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [jwk] },
    algorithms: ["RS256"], insecureIssuerAllowed: true,
    clientId: CLIENT_ID, scopes: ["openid", "profile", "email"],
    redirectUris: [REDIRECT], appScheme: "myapp",
    extraAudiences: [], expectedTokenUse: null,
  });

  const res = await fetch(`${base}/v1/auth/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.protocol, "account-auth-v1");
  assert.equal(body.issuer, ISSUER);
  assert.equal(body.audience, AUDIENCE);
  assert.equal(body.clientId, CLIENT_ID);
  assert.deepEqual(body.scopes, ["openid", "profile", "email"]);
  assert.deepEqual(body.redirectUris, [REDIRECT]);
  assert.equal(body.appScheme, "myapp");
  const text = JSON.stringify(body);
  assert.ok(!text.includes("keys"));
  assert.ok(!text.toLowerCase().includes("secret"));

  const token = await signToken(privateKey, { sub: "alice-sub", extra: { email: "alice@example.test", name: "Alice" } });
  const me = await fetch(`${base}/v1/account`, { headers: bearer(token) });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.accountId, deriveAccountId(ISSUER, "alice-sub"));
  assert.equal(meBody.issuer, ISSUER);
  assert.equal(meBody.claims.email, "alice@example.test");

  // Denials on the verification route (invalid JWT is not a login).
  for (const bad of [
    await signToken(privateKey, { iss: "http://127.0.0.1/other" }),
    await signToken(privateKey, { aud: "someone-else" }),
    await signToken(privateKey, { expSeconds: -60 }),
    "garbage",
  ]) {
    const r = await fetch(`${base}/v1/account`, { headers: bearer(bad) });
    assert.equal(r.status, 401);
  }
  const anon = await fetch(`${base}/v1/account`);
  assert.equal(anon.status, 401);
});

test("auth config: missing client metadata is 503, verification still works", async (t) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  // No clientId / redirectUris (as in pre-B4 hosted configs).
  const base = await startBackend(t, {
    issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [jwk] },
    algorithms: ["RS256"], insecureIssuerAllowed: true,
  });
  const res = await fetch(`${base}/v1/auth/config`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, "configure_not_ready");

  const token = await signToken(privateKey, { sub: "still-works" });
  const me = await fetch(`${base}/v1/account`, { headers: bearer(token) });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).accountId, deriveAccountId(ISSUER, "still-works"));
});

test("config validation: clientId!=audience, redirect allowlist, JWKS URL safety", async (t) => {
  const jwks = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }] });
  const good = {
    ME_BACKEND_AUTH_MODE: "hosted",
    ME_BACKEND_OIDC_ISSUER: "https://issuer.example.test",
    ME_BACKEND_OIDC_AUDIENCE: "me-backend-api",
    ME_BACKEND_OIDC_JWKS: jwks,
    ME_BACKEND_OIDC_CLIENT_ID: "me-mobile-client",
    ME_BACKEND_OIDC_REDIRECT_URIS: "myapp://auth/callback",
  };
  assert.equal(loadConfig(good).oidc.clientId, "me-mobile-client");

  // clientId reused as audience would let an ID token pass as API token.
  assert.throws(() => loadConfig({
    ...good, ME_BACKEND_OIDC_AUDIENCE: "same-value", ME_BACKEND_OIDC_CLIENT_ID: "same-value",
  }), /must differ/);

  assert.throws(() => loadConfig({ ...good, ME_BACKEND_OIDC_REDIRECT_URIS: "myapp://a,myapp://a" }), /duplicate/);
  assert.throws(() => loadConfig({ ...good, ME_BACKEND_OIDC_REDIRECT_URIS: "myapp://a/*" }), /wildcard|Invalid/);
  assert.throws(() => loadConfig({ ...good, ME_BACKEND_OIDC_SCOPES: "bogus scope!!" }), /Invalid OIDC scope/);

  // JWKS URL: exactly one of static/URL; https required for remote.
  assert.throws(() => loadConfig({
    ...good, ME_BACKEND_OIDC_JWKS_URL: "https://issuer.example.test/jwks.json",
  }), /only one/);
  const { ME_BACKEND_OIDC_JWKS: _drop, ...noStatic } = good;
  void _drop;
  const withUrl = loadConfig({ ...noStatic, ME_BACKEND_OIDC_JWKS_URL: "https://issuer.example.test/jwks.json" });
  assert.equal(withUrl.oidc.jwksUrl, "https://issuer.example.test/jwks.json");
  // Remote http never allowed for non-loopback, even with the test flag.
  assert.throws(() => loadConfig({
    ...noStatic,
    ME_BACKEND_OIDC_JWKS_URL: "http://issuer.example.test/jwks.json",
    ME_BACKEND_OIDC_ALLOW_INSECURE_ISSUER: "1",
  }), /https/);
  // Loopback http allowed only with the explicit test flag (fixture mode).
  const loopback = loadConfig({
    ME_BACKEND_AUTH_MODE: "hosted",
    ME_BACKEND_OIDC_ISSUER: "http://127.0.0.1/iss",
    ME_BACKEND_OIDC_AUDIENCE: "me-backend-api",
    ME_BACKEND_OIDC_JWKS_URL: "http://127.0.0.1:9/jwks.json",
    ME_BACKEND_OIDC_ALLOW_INSECURE_ISSUER: "1",
    ME_BACKEND_OIDC_CLIENT_ID: "c",
    ME_BACKEND_OIDC_REDIRECT_URIS: "myapp://auth/callback",
  });
  assert.ok(loopback.oidc.jwksUrl.startsWith("http://127.0.0.1"));
  // Same loopback URL without the flag is rejected (no silent http).
  assert.throws(() => loadConfig({
    ME_BACKEND_AUTH_MODE: "hosted",
    ME_BACKEND_OIDC_ISSUER: "http://127.0.0.1/iss",
    ME_BACKEND_OIDC_AUDIENCE: "me-backend-api",
    ME_BACKEND_OIDC_JWKS_URL: "http://127.0.0.1:9/jwks.json",
    ME_BACKEND_OIDC_CLIENT_ID: "c",
    ME_BACKEND_OIDC_REDIRECT_URIS: "myapp://auth/callback",
  }), /https/);
});

test("remote JWKS: rotation picked up; unknown keys denied", async (t) => {
  const kp1 = await generateKeyPair("RS256");
  const kp2 = await generateKeyPair("RS256");
  const jwk1 = { ...(await exportJWK(kp1.publicKey)), kid: "rot-1", alg: "RS256", use: "sig" };
  const jwk2 = { ...(await exportJWK(kp2.publicKey)), kid: "rot-2", alg: "RS256", use: "sig" };
  const fixture = await startJwksFixture(t, [jwk1]);
  const base = await startBackend(t, {
    issuer: ISSUER, audience: AUDIENCE, jwksUrl: fixture.url, jwksTimeoutMs: 5000,
    algorithms: ["RS256"], insecureIssuerAllowed: true,
    clientId: CLIENT_ID, scopes: ["openid", "profile", "email"],
    redirectUris: [REDIRECT], appScheme: null, extraAudiences: [], expectedTokenUse: null,
  });

  const tok1 = await signToken(kp1.privateKey, { sub: "rot-user", kid: "rot-1" });
  const first = await fetch(`${base}/v1/account`, { headers: bearer(tok1) });
  assert.equal(first.status, 200);

  // Rotate: publish key2 alongside key1 (rotation-safe servers keep both
  // during rollover). A token under the new kid must verify without restart
  // (after the short remote-set cooldown so the verifier refetches).
  fixture.current.keys = [jwk1, jwk2];
  const { setTimeout: sleep } = await import("node:timers/promises");
  await sleep(2200);
  const tok2 = await signToken(kp2.privateKey, { sub: "rot-user", kid: "rot-2" });
  const second = await fetch(`${base}/v1/account`, { headers: bearer(tok2) });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).accountId, deriveAccountId(ISSUER, "rot-user"));

  // Unknown kid (never published) is denied.
  const kpX = await generateKeyPair("RS256");
  const tokX = await signToken(kpX.privateKey, { sub: "rot-user", kid: "no-such-key" });
  const denied = await fetch(`${base}/v1/account`, { headers: bearer(tokX) });
  assert.equal(denied.status, 401);
});

test("token_use pinned: access accepted, id/missing denied; jku never trusted", async (t) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const verifier = createOidcVerifier({
    issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [jwk] },
    algorithms: ["RS256"], insecureIssuerAllowed: true, expectedTokenUse: "access",
  });
  const okToken = await signToken(privateKey, { sub: "u", extra: { token_use: "access" } });
  assert.ok(await verifier.verifyAccountToken(okToken));
  const idToken = await signToken(privateKey, { sub: "u", extra: { token_use: "id" } });
  assert.equal(await verifier.verifyAccountToken(idToken), null);
  const noUse = await signToken(privateKey, { sub: "u" });
  assert.equal(await verifier.verifyAccountToken(noUse), null);

  // jku pointing at an attacker URL is ignored: the token is signed by an
  // untrusted key, so it fails against the fixed trusted set.
  const { privateKey: evilKey } = await generateKeyPair("RS256");
  const evil = await signToken(evilKey, {
    sub: "u", headers: { jku: "http://127.0.0.1:9/evil-jwks.json" },
  });
  assert.equal(await verifier.verifyAccountToken(evil), null);

  // Same denial through HTTP with a pinned backend.
  const base = await startBackend(t, {
    issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [jwk] },
    algorithms: ["RS256"], insecureIssuerAllowed: true,
    clientId: CLIENT_ID, scopes: ["openid"], redirectUris: [REDIRECT],
    appScheme: null, extraAudiences: [], expectedTokenUse: "access",
  });
  const httpOk = await fetch(`${base}/v1/account`, { headers: bearer(okToken) });
  assert.equal(httpOk.status, 200);
  const httpId = await fetch(`${base}/v1/account`, { headers: bearer(idToken) });
  assert.equal(httpId.status, 401);
});
