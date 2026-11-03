// Unauthorized access: discovery/registration and cross-home isolation.
// Requires: account identity from bearer tokens only; setup token for
// registration; tickets bound to a single home; hidden existence for
// non-members.

import test from "node:test";
import assert from "node:assert/strict";
import { startTestBackend, accountHeaders, registerHome, mintTicketForHome, DEV_ACCOUNTS } from "./helper.mjs";

const [ALICE, BOB] = Object.keys(DEV_ACCOUNTS);

test("healthz is anonymous and minimal", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const res = await fetch(`${ctx.base}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test("anonymous discovery is rejected", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const res = await fetch(`${ctx.base}/v1/homes`);
  assert.equal(res.status, 401);
});

test("account token cannot register a home (setup token required)", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const res = await fetch(`${ctx.base}/v1/homes/register`, {
    method: "POST",
    headers: accountHeaders(ALICE),
    body: JSON.stringify({ displayName: "Sneaky" }),
  });
  assert.equal(res.status, 401);
});

test("registration with wrong setup token is rejected", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const res = await fetch(`${ctx.base}/v1/homes/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-me-setup-token": "wrong-token-value-123456" },
    body: JSON.stringify({ displayName: "Sneaky" }),
  });
  assert.equal(res.status, 401);
});

test("non-member cannot discover or read the home", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const { homeId } = await registerHome(ctx.base, { homeId: "home-hidden-01" });

  const list = await fetch(`${ctx.base}/v1/homes`, { headers: accountHeaders(BOB) });
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.deepEqual(listed.homes, []);

  const direct = await fetch(`${ctx.base}/v1/homes/${homeId}`, { headers: accountHeaders(BOB) });
  assert.equal(direct.status, 404);

  const members = await fetch(`${ctx.base}/v1/homes/${homeId}/members`, { headers: accountHeaders(BOB) });
  assert.equal(members.status, 404);
});

test("join rejects client-supplied account IDs and bad tickets", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const { homeId } = await registerHome(ctx.base, { homeId: "home-guarded-01" });

  const withId = await fetch(`${ctx.base}/v1/homes/${homeId}/members/join`, {
    method: "POST",
    headers: accountHeaders(ALICE),
    body: JSON.stringify({ ticketSecret: "something", accountId: "acct_bob" }),
  });
  assert.equal(withId.status, 400);

  const bad = await fetch(`${ctx.base}/v1/homes/${homeId}/members/join`, {
    method: "POST",
    headers: accountHeaders(ALICE),
    body: JSON.stringify({ ticketSecret: "not-a-real-ticket-secret" }),
  });
  assert.equal(bad.status, 403);
});

test("ticket from another home cannot enroll here, and home tokens do not cross", async (t) => {
  const ctx = await startTestBackend();
  t.after(() => ctx.server.close());
  const homeA = await registerHome(ctx.base, { homeId: "home-cross-a" });
  const homeB = await registerHome(ctx.base, { homeId: "home-cross-b" });

  const ticket = await mintTicketForHome(ctx.base, homeA.homeId, homeA.homeToken);
  const joinElsewhere = await fetch(`${ctx.base}/v1/homes/${homeB.homeId}/members/join`, {
    method: "POST",
    headers: accountHeaders(ALICE),
    body: JSON.stringify({ ticketSecret: ticket.ticketSecret }),
  });
  assert.equal(joinElsewhere.status, 403);

  const heartbeat = await fetch(`${ctx.base}/v1/homes/${homeB.homeId}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${homeA.homeToken}` },
    body: JSON.stringify({ status: "online" }),
  });
  assert.equal(heartbeat.status, 403);
});
