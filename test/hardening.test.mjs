// Regression + hardening tests:
//   - auto-generated homeIds always satisfy HOME_ID_RE (base64url bug fix)
//   - prototype-key boundaries ("constructor", "__proto__", malformed encoding)
//   - H1 installation_id correlation (register/heartbeat/read-back)

import test from "node:test";
import assert from "node:assert/strict";
import { startTestBackend, accountHeaders, mintTicketForHome, DEV_SETUP_TOKEN, DEV_ACCOUNTS } from "./helper.mjs";

const [ALICE, BOB] = Object.keys(DEV_ACCOUNTS);
const HOME_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const SETUP_HEADERS = { "content-type": "application/json", "x-me-setup-token": DEV_SETUP_TOKEN };

async function registerRaw(base, body) {
  const res = await fetch(`${base}/v1/homes/register`, {
    method: "POST",
    headers: SETUP_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("register without homeId always yields a valid, unique homeId", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const { status, body } = await registerRaw(ctx.base, { displayName: `Auto ${i}` });
    assert.equal(status, 201, `attempt ${i}: ${JSON.stringify(body)}`);
    assert.match(body.homeId, HOME_ID_RE, `attempt ${i}: ${body.homeId}`);
    assert.ok(!seen.has(body.homeId), `duplicate generated homeId: ${body.homeId}`);
    seen.add(body.homeId);
    assert.ok(typeof body.homeToken === "string" && body.homeToken.length > 0);
  }
});

test("prototype-named homeId behaves as an ordinary record", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());

  const first = await registerRaw(ctx.base, { homeId: "constructor", displayName: "Proto" });
  assert.equal(first.status, 201);

  const dup = await registerRaw(ctx.base, { homeId: "constructor" });
  assert.equal(dup.status, 409);

  // Full membership flow works on the prototype-named home (members record
  // is a real own property, not the inherited constructor).
  const ticket = await mintTicketForHome(ctx.base, "constructor", first.body.homeToken);
  const join = await fetch(`${ctx.base}/v1/homes/constructor/members/join`, {
    method: "POST",
    headers: accountHeaders(ALICE),
    body: JSON.stringify({ ticketSecret: ticket.ticketSecret }),
  });
  assert.equal(join.status, 201);

  const members = await fetch(`${ctx.base}/v1/homes/constructor/members`, {
    headers: accountHeaders(ALICE),
  });
  assert.equal(members.status, 200);
  const { members: list } = await members.json();
  assert.deepEqual(list.map((m) => m.accountId), ["acct_alice"]);
});

test("__proto__ and malformed references are rejected safely", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const { body: reg } = await registerRaw(ctx.base, { homeId: "home-proto-guard" });
  const homeAuth = { "content-type": "application/json", authorization: `Bearer ${reg.homeToken}` };

  const protoGet = await fetch(`${ctx.base}/v1/homes/__proto__`, { headers: accountHeaders(ALICE) });
  assert.equal(protoGet.status, 404);

  const protoDelete = await fetch(`${ctx.base}/v1/homes/home-proto-guard/members/__proto__`, {
    method: "DELETE",
    headers: homeAuth,
  });
  assert.equal(protoDelete.status, 404);

  const badEncoding = await fetch(`${ctx.base}/v1/homes/home-proto-guard/members/%E0%A4%A`, {
    method: "DELETE",
    headers: homeAuth,
  });
  assert.equal(badEncoding.status, 400);

  const protoTicket = await fetch(`${ctx.base}/v1/homes/home-proto-guard/members/join`, {
    method: "POST",
    headers: accountHeaders(BOB),
    body: JSON.stringify({ ticketSecret: "x", ticketId: "__proto__" }),
  });
  assert.equal(protoTicket.status, 403);
});

test("installation_id is stored verbatim and updatable via heartbeat", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const installationId = "123e4567-e89b-12d3-a456-426614174000";

  const reg = await registerRaw(ctx.base, {
    homeId: "home-install-map",
    installationId,
    endpointHint: "http://127.0.0.1:7070",
    protocolVersion: "home-api-v1",
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.installationId, installationId);

  const ticket = await mintTicketForHome(ctx.base, "home-install-map", reg.body.homeToken);
  const join = await fetch(`${ctx.base}/v1/homes/home-install-map/members/join`, {
    method: "POST",
    headers: accountHeaders(ALICE),
    body: JSON.stringify({ ticketSecret: ticket.ticketSecret }),
  });
  assert.equal(join.status, 201);

  const read = await fetch(`${ctx.base}/v1/homes/home-install-map`, { headers: accountHeaders(ALICE) });
  assert.equal(read.status, 200);
  const { home } = await read.json();
  assert.equal(home.installationId, installationId);
  assert.equal(home.endpointHint, "http://127.0.0.1:7070");

  const hb = await fetch(`${ctx.base}/v1/homes/home-install-map/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${reg.body.homeToken}` },
    body: JSON.stringify({ status: "online", installationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
  });
  assert.equal(hb.status, 200);

  const status = await fetch(`${ctx.base}/v1/homes/home-install-map/status`, {
    headers: accountHeaders(ALICE),
  });
  assert.equal(status.status, 200);

  const reread = await fetch(`${ctx.base}/v1/homes/home-install-map`, { headers: accountHeaders(ALICE) });
  const { home: updated } = await reread.json();
  assert.equal(updated.installationId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

  const bad = await registerRaw(ctx.base, { homeId: "home-bad-install", installationId: "has-\u0000-control" });
  assert.equal(bad.status, 400);

  const tooLong = await registerRaw(ctx.base, { homeId: "home-long-install", installationId: `u-${"x".repeat(200)}` });
  assert.equal(tooLong.status, 400);
});
