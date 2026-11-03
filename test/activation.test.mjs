// Home activation v1 (B7): one-time account-bound activation + recovery
// WITHOUT forwarding reusable account credentials. Uses real jose account
// fixtures (same pattern as hosted.test.mjs) + real API.

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
import { deriveAccountId } from "../src/oidc.mjs";

const ISSUER = "http://127.0.0.1/oidc-activation-test";
const AUDIENCE = "me-backend-test";

async function startActivationBackend(t, { staleAfterSeconds = 300, persistFn = undefined } = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "act-key-1", alg: "RS256", use: "sig" };
  const dataDir = mkdtempSync(join(tmpdir(), "me-backend-activation-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    authMode: "hosted",
    devAccounts: new Map(),
    oidc: {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: { keys: [jwk] },
      algorithms: ["RS256"],
      insecureIssuerAllowed: true,
    },
    staleAfterSeconds,
  };
  if (persistFn) config.persistFn = persistFn;
  const backend = createBackend(config);
  const server = createServer(backend.handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, privateKey, state: backend.state, accountIdFor: (sub) => deriveAccountId(ISSUER, sub) };
}

async function signToken(privateKey, { sub = "alice", kid = "act-key-1" } = {}) {
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime("5m")
    .sign(privateKey);
}

const bearer = (token) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });
const json = (obj) => ({ "content-type": "application/json", body: JSON.stringify(obj) });

async function mintActivation(base, accountJwt, body) {
  const res = await fetch(`${base}/v1/homes/activation-tickets`, {
    method: "POST",
    headers: bearer(accountJwt),
    body: JSON.stringify(body),
  });
  return res;
}

async function activate(base, body) {
  // Deliberately NO Authorization header: ticket-only capability.
  const res = await fetch(`${base}/v1/homes/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

test("activation: mint with account JWT, redeem without JWT creates owner home", async (t) => {
  const ctx = await startActivationBackend(t);
  const alice = await signToken(ctx.privateKey, { sub: "alice-sub" });

  const mintedRes = await mintActivation(ctx.base, alice, {
    installationId: "11111111-1111-4111-8111-111111111111",
    displayName: "Cabin",
  });
  assert.equal(mintedRes.status, 201);
  const ticket = await mintedRes.json();
  assert.equal(ticket.mode, "new");
  assert.equal(ticket.homeId, null);
  assert.ok(ticket.ticketId.startsWith("act_"));
  assert.ok(typeof ticket.activationSecret === "string" && ticket.activationSecret.length > 32);
  // Capability-only: no homeToken, no account data.
  assert.ok(!("homeToken" in ticket));
  assert.ok(!("accountId" in ticket));

  const actRes = await activate(ctx.base, {
    ticketId: ticket.ticketId,
    activationSecret: ticket.activationSecret,
    installationId: "11111111-1111-4111-8111-111111111111",
    endpointHint: "https://home.example.test",
    protocolVersion: "home-api-v1",
  });
  assert.equal(actRes.status, 201);
  const act = await actRes.json();
  assert.ok(act.homeId);
  assert.equal(act.installationId, "11111111-1111-4111-8111-111111111111");
  assert.ok(act.homeToken.startsWith("me_home_"));
  assert.equal(act.mode, "new");

  // Owner binding visible via account discovery.
  const homes = await (await fetch(`${ctx.base}/v1/homes`, { headers: bearer(alice) })).json();
  assert.equal(homes.homes.length, 1);
  assert.equal(homes.homes[0].homeId, act.homeId);
  assert.equal(homes.homes[0].membershipRole, "owner");

  // HomeToken works for heartbeat/status; account JWT cannot heartbeat.
  const hb = await fetch(`${ctx.base}/v1/homes/${act.homeId}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${act.homeToken}` },
    body: JSON.stringify({ status: "online" }),
  });
  assert.equal(hb.status, 200);
  const hbAccount = await fetch(`${ctx.base}/v1/homes/${act.homeId}/heartbeat`, {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({ status: "online" }),
  });
  assert.equal(hbAccount.status, 403);

  // Replay of the same ticket is gone.
  const replay = await activate(ctx.base, {
    ticketId: ticket.ticketId,
    activationSecret: ticket.activationSecret,
    installationId: "11111111-1111-4111-8111-111111111111",
    endpointHint: "https://home.example.test",
  });
  assert.equal(replay.status, 410);
});

test("activation: invalid redeem never burns the ticket", async (t) => {
  const ctx = await startActivationBackend(t);
  const alice = await signToken(ctx.privateKey, { sub: "alice-sub" });
  const ticket = await (await mintActivation(ctx.base, alice, {
    installationId: "22222222-2222-4222-8222-222222222222",
  })).json();

  // Bad endpoint (remote http, non-URL) -> 400, ticket survives.
  for (const bad of ["http://remote.example.test/hook", "not-a-url", "ftp://x.test"]) {
    const badRes = await activate(ctx.base, {
      ticketId: ticket.ticketId,
      activationSecret: ticket.activationSecret,
      installationId: "22222222-2222-4222-8222-222222222222",
      endpointHint: bad,
    });
    assert.equal(badRes.status, 400, bad);
  }
  // Loopback http IS allowed for dev/test.
  const loopbackOk = await activate(ctx.base, {
    ticketId: ticket.ticketId,
    activationSecret: ticket.activationSecret,
    installationId: "22222222-2222-4222-8222-222222222222",
    endpointHint: "http://127.0.0.1:7070",
  });
  assert.equal(loopbackOk.status, 201);
});

test("activation: wrong installation denied without consuming", async (t) => {
  const ctx = await startActivationBackend(t);
  const alice = await signToken(ctx.privateKey, { sub: "alice-sub" });
  const ticket = await (await mintActivation(ctx.base, alice, {
    installationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  })).json();

  const wrong = await activate(ctx.base, {
    ticketId: ticket.ticketId,
    activationSecret: ticket.activationSecret,
    installationId: "different-installation-id",
    endpointHint: "https://home.example.test",
  });
  assert.equal(wrong.status, 403);

  // Correct installation still works (ticket was not burned).
  const good = await activate(ctx.base, {
    ticketId: ticket.ticketId,
    activationSecret: ticket.activationSecret,
    installationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    endpointHint: "https://home.example.test",
  });
  assert.equal(good.status, 201);
});

test("activation: expired and conflated tickets denied", async (t) => {
  const ctx = await startActivationBackend(t);
  const alice = await signToken(ctx.privateKey, { sub: "alice-sub" });

  // Expired: force expiry in server state, then redeem -> 410.
  const ticket = await (await mintActivation(ctx.base, alice, {
    installationId: "33333333-3333-4333-8333-333333333333",
  })).json();
  ctx.state.activationTickets[ticket.ticketId].expiresAt =
    new Date(Date.now() - 1000).toISOString();
  const expired = await activate(ctx.base, {
    ticketId: ticket.ticketId,
    activationSecret: ticket.activationSecret,
    installationId: "33333333-3333-4333-8333-333333333333",
    endpointHint: "https://home.example.test",
  });
  assert.equal(expired.status, 410);

  // Conflation: registration-ticket secret is not a valid activation.
  const regTicket = await (await fetch(`${ctx.base}/v1/homes/registration-tickets`, {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({}),
  })).json();
  const conflated = await activate(ctx.base, {
    ticketId: regTicket.ticketId,
    activationSecret: regTicket.registrationTicket,
    installationId: "33333333-3333-4333-8333-333333333333",
    endpointHint: "https://home.example.test",
  });
  assert.equal(conflated.status, 403);

  // Conflation reverse: activation secret is not a valid registration ticket.
  const act2 = await (await mintActivation(ctx.base, alice, {
    installationId: "44444444-4444-4444-8444-444444444444",
  })).json();
  const reverse = await fetch(`${ctx.base}/v1/homes/register`, {
    method: "POST",
    headers: bearer(alice),
    body: JSON.stringify({
      homeId: "home-conflate-01",
      registrationTicket: act2.activationSecret,
      registrationTicketId: act2.ticketId,
    }),
  });
  assert.ok([400, 403].includes(reverse.status));
});

test("activation: recovery only owner can mint; redeem rotates credential", async (t) => {
  const ctx = await startActivationBackend(t);
  const alice = await signToken(ctx.privateKey, { sub: "alice-sub" });
  const bob = await signToken(ctx.privateKey, { sub: "bob-sub" });

  const ticket = await (await mintActivation(ctx.base, alice, {
    installationId: "55555555-5555-4555-8555-555555555555",
  })).json();
  const act = await (await activate(ctx.base, {
    ticketId: ticket.ticketId,
    activationSecret: ticket.activationSecret,
    installationId: "55555555-5555-4555-8555-555555555555",
    endpointHint: "https://home-old.example.test",
  })).json();
  const oldHomeToken = act.homeToken;

  // Non-member cannot mint recovery (hidden as 404).
  const bobRecovery = await mintActivation(ctx.base, bob, {
    installationId: "55555555-5555-4555-8555-555555555555",
    existingHomeId: act.homeId,
  });
  assert.equal(bobRecovery.status, 404);

  // Member-but-not-owner cannot mint recovery (403): bob joins via a
  // home-minted join ticket (also proves join tickets work on
  // activation-created homes), then attempts a recovery mint.
  const joinTicket = await (await fetch(`${ctx.base}/v1/homes/${act.homeId}/join-tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${oldHomeToken}` },
    body: JSON.stringify({}),
  })).json();
  const join = await fetch(`${ctx.base}/v1/homes/${act.homeId}/members/join`, {
    method: "POST",
    headers: bearer(bob),
    body: JSON.stringify({ ticketSecret: joinTicket.ticketSecret }),
  });
  assert.equal(join.status, 201);
  assert.equal((await join.json()).membership.role, "member");
  const bobMemberRecovery = await mintActivation(ctx.base, bob, {
    installationId: "55555555-5555-4555-8555-555555555555",
    existingHomeId: act.homeId,
  });
  assert.equal(bobMemberRecovery.status, 403);

  // Owner mints recovery; redeem rotates homeToken.
  const recTicket = await (await mintActivation(ctx.base, alice, {
    installationId: "55555555-5555-4555-8555-555555555555",
    existingHomeId: act.homeId,
  })).json();
  assert.equal(recTicket.mode, "recovery");
  assert.equal(recTicket.homeId, act.homeId);

  const rec = await (await activate(ctx.base, {
    ticketId: recTicket.ticketId,
    activationSecret: recTicket.activationSecret,
    installationId: "55555555-5555-4555-8555-555555555555",
    endpointHint: "https://home-new.example.test",
  })).json();
  assert.equal(rec.mode, "recovery");
  assert.equal(rec.homeId, act.homeId);
  assert.notEqual(rec.homeToken, oldHomeToken);

  // Old credential dead (unknown verifier -> 401), new credential live.
  const hbOld = await fetch(`${ctx.base}/v1/homes/${act.homeId}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${oldHomeToken}` },
    body: JSON.stringify({ status: "online" }),
  });
  assert.equal(hbOld.status, 401);
  const hbNew = await fetch(`${ctx.base}/v1/homes/${act.homeId}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${rec.homeToken}` },
    body: JSON.stringify({ status: "online", endpointHint: "https://home-new.example.test" }),
  });
  assert.equal(hbNew.status, 200);
});

test("activation: persist failure rolls back (ticket not burned, no half home)", async (t) => {
  const { saveState } = await import("../src/store.mjs");
  const fail = { next: false };
  const persistFn = (dir, state) => {
    if (fail.next) {
      fail.next = false;
      throw new Error("injected persist failure");
    }
    saveState(dir, state);
  };
  const ctx = await startActivationBackend(t, { persistFn });
  const aliceReal = await signToken(ctx.privateKey, { sub: "alice-sub" });
  const ticket = await (await mintActivation(ctx.base, aliceReal, {
    installationId: "66666666-6666-4666-8666-666666666666",
  })).json();
  assert.equal(ctx.state.activationTickets[ticket.ticketId].consumedAt, null);

  // Wrong-secret attempt must not consume.
  const wrongSecret = await activate(ctx.base, {
    ticketId: ticket.ticketId,
    activationSecret: "wrong-secret-value-0123456789abcdef",
    installationId: "66666666-6666-4666-8666-666666666666",
    endpointHint: "https://home.example.test",
  });
  assert.equal(wrongSecret.status, 403);
  assert.equal(ctx.state.activationTickets[ticket.ticketId].consumedAt, null);

  // Injected persist failure on redeem: 500 with full in-memory rollback.
  const homesBefore = Object.keys(ctx.state.homes).length;
  fail.next = true;
  const failed = await activate(ctx.base, {
    ticketId: ticket.ticketId,
    activationSecret: ticket.activationSecret,
    installationId: "66666666-6666-4666-8666-666666666666",
    endpointHint: "https://home.example.test",
  });
  assert.equal(failed.status, 500);
  assert.equal(ctx.state.activationTickets[ticket.ticketId].consumedAt, null);
  assert.equal(Object.keys(ctx.state.homes).length, homesBefore);

  // Real redeem still succeeds after denied + failed attempts.
  const good = await activate(ctx.base, {
    ticketId: ticket.ticketId,
    activationSecret: ticket.activationSecret,
    installationId: "66666666-6666-4666-8666-666666666666",
    endpointHint: "https://home.example.test",
  });
  assert.equal(good.status, 201);
});

test("activation: per-account cap with pruning (15 live)", async (t) => {
  const ctx = await startActivationBackend(t);
  const alice = await signToken(ctx.privateKey, { sub: "alice-sub" });
  for (let i = 0; i < 15; i++) {
    const r = await mintActivation(ctx.base, alice, {
      installationId: `cap-install-${String(i).padStart(3, "0")}`,
    });
    assert.equal(r.status, 201, `mint ${i}`);
  }
  const over = await mintActivation(ctx.base, alice, { installationId: "cap-install-over" });
  assert.equal(over.status, 429);
});

test("activation: heartbeat stale + endpoint update via homeToken", async (t) => {
  const ctx = await startActivationBackend(t, { staleAfterSeconds: 1 });
  const alice = await signToken(ctx.privateKey, { sub: "alice-sub" });
  const ticket = await (await mintActivation(ctx.base, alice, {
    installationId: "77777777-7777-4777-8777-777777777777",
  })).json();
  const act = await (await activate(ctx.base, {
    ticketId: ticket.ticketId,
    activationSecret: ticket.activationSecret,
    installationId: "77777777-7777-4777-8777-777777777777",
    endpointHint: "https://home.example.test",
  })).json();

  const homeAuth = { "content-type": "application/json", authorization: `Bearer ${act.homeToken}` };
  // Fresh home never heartbeated: honestly offline.
  const fresh = await (await fetch(`${ctx.base}/v1/homes/${act.homeId}/status`, { headers: bearer(alice) })).json();
  assert.equal(fresh.online, false);

  await fetch(`${ctx.base}/v1/homes/${act.homeId}/heartbeat`, {
    method: "POST", headers: homeAuth, body: JSON.stringify({ status: "online" }),
  });
  const live = await (await fetch(`${ctx.base}/v1/homes/${act.homeId}/status`, { headers: bearer(alice) })).json();
  assert.equal(live.online, true);

  // Endpoint update via heartbeat (homeToken only, same home).
  const upd = await fetch(`${ctx.base}/v1/homes/${act.homeId}/heartbeat`, {
    method: "POST", headers: homeAuth,
    body: JSON.stringify({ status: "online", endpointHint: "https://home-moved.example.test" }),
  });
  assert.equal(upd.status, 200);
  const read = await (await fetch(`${ctx.base}/v1/homes/${act.homeId}`, { headers: bearer(alice) })).json();
  assert.equal(read.home.endpointHint, "https://home-moved.example.test");

  await sleep(1300);
  const stale = await (await fetch(`${ctx.base}/v1/homes/${act.homeId}/status`, { headers: bearer(alice) })).json();
  assert.equal(stale.online, false);
  assert.equal(stale.staleAfterSeconds, 1);
});
