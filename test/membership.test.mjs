// Membership lifecycle: register -> ticket -> join -> discovery/members,
// single-use tickets, expiry, duplicate registration, revocation.

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { startTestBackend, accountHeaders, registerHome, mintTicketForHome, DEV_SETUP_TOKEN, DEV_ACCOUNTS } from "./helper.mjs";

const [ALICE, BOB] = Object.keys(DEV_ACCOUNTS);

test("full register, join, discover, heartbeat, and status flow", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());

  const { homeId, homeToken } = await registerHome(ctx.base, { homeId: "home-flow-01" });
  const ticket = await mintTicketForHome(ctx.base, homeId, homeToken);

  const join = await fetch(`${ctx.base}/v1/homes/${homeId}/members/join`, {
    method: "POST",
    headers: accountHeaders(ALICE),
    body: JSON.stringify({ ticketSecret: ticket.ticketSecret }),
  });
  assert.equal(join.status, 201);
  const joined = await join.json();
  assert.equal(joined.membership.accountId, "acct_alice");
  assert.equal(joined.membership.role, "owner");

  const list = await fetch(`${ctx.base}/v1/homes`, { headers: accountHeaders(ALICE) });
  assert.equal(list.status, 200);
  const { homes } = await list.json();
  assert.equal(homes.length, 1);
  assert.equal(homes[0].homeId, homeId);

  const hb = await fetch(`${ctx.base}/v1/homes/${homeId}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${homeToken}` },
    body: JSON.stringify({ status: "online" }),
  });
  assert.equal(hb.status, 200);

  const status = await fetch(`${ctx.base}/v1/homes/${homeId}/status`, { headers: accountHeaders(ALICE) });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.homeId, homeId);
  assert.ok(statusBody.lastSeenAt);
});

test("duplicate home registration is rejected", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  await registerHome(ctx.base, { homeId: "home-dup-01" });
  const res = await fetch(`${ctx.base}/v1/homes/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-me-setup-token": DEV_SETUP_TOKEN },
    body: JSON.stringify({ homeId: "home-dup-01" }),
  });
  assert.equal(res.status, 409);
});

test("ticket reuse fails and cannot enroll a second device", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const { homeId, homeToken } = await registerHome(ctx.base, { homeId: "home-once-01" });
  const ticket = await mintTicketForHome(ctx.base, homeId, homeToken);

  const first = await fetch(`${ctx.base}/v1/homes/${homeId}/members/join`, {
    method: "POST",
    headers: accountHeaders(ALICE),
    body: JSON.stringify({ ticketSecret: ticket.ticketSecret }),
  });
  assert.equal(first.status, 201);

  const replay = await fetch(`${ctx.base}/v1/homes/${homeId}/members/join`, {
    method: "POST",
    headers: accountHeaders(BOB),
    body: JSON.stringify({ ticketSecret: ticket.ticketSecret, ticketId: ticket.ticketId }),
  });
  assert.equal(replay.status, 410);

  const members = await fetch(`${ctx.base}/v1/homes/${homeId}/members`, { headers: accountHeaders(ALICE) });
  const { members: list } = await members.json();
  assert.deepEqual(list.map((m) => m.accountId), ["acct_alice"]);
});

test("expired ticket is rejected", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const { homeId, homeToken } = await registerHome(ctx.base, { homeId: "home-expire-01" });
  const ticket = await mintTicketForHome(ctx.base, homeId, homeToken, 2);
  await sleep(2500);
  const res = await fetch(`${ctx.base}/v1/homes/${homeId}/members/join`, {
    method: "POST",
    headers: accountHeaders(BOB),
    body: JSON.stringify({ ticketSecret: ticket.ticketSecret }),
  });
  assert.equal(res.status, 410);
});

test("second member joins as member; home revocation removes access", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const { homeId, homeToken } = await registerHome(ctx.base, { homeId: "home-revoke-01" });

  for (const [token, account] of [[ALICE, "acct_alice"], [BOB, "acct_bob"]]) {
    const ticket = await mintTicketForHome(ctx.base, homeId, homeToken);
    const res = await fetch(`${ctx.base}/v1/homes/${homeId}/members/join`, {
      method: "POST",
      headers: accountHeaders(token),
      body: JSON.stringify({ ticketSecret: ticket.ticketSecret }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.membership.accountId, account);
  }

  const homeAuth = { "content-type": "application/json", authorization: `Bearer ${homeToken}` };
  const revoke = await fetch(`${ctx.base}/v1/homes/${homeId}/members/acct_bob`, {
    method: "DELETE",
    headers: homeAuth,
  });
  assert.equal(revoke.status, 200);

  const after = await fetch(`${ctx.base}/v1/homes/${homeId}`, { headers: accountHeaders(BOB) });
  assert.equal(after.status, 404);

  const list = await fetch(`${ctx.base}/v1/homes`, { headers: accountHeaders(BOB) });
  const { homes } = await list.json();
  assert.deepEqual(homes, []);
});
