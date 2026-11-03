// Restart persistence: state written to the data dir must survive a full
// server restart, including homes, memberships, tickets consumption, and
// home credential verifiers.

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createBackend } from "../src/server.mjs";
import { startTestBackend, accountHeaders, mintTicketForHome, DEV_SETUP_TOKEN, DEV_ACCOUNTS } from "./helper.mjs";

const [ALICE] = Object.keys(DEV_ACCOUNTS);

function configFor(dataDir) {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    setupToken: DEV_SETUP_TOKEN,
    devAccounts: new Map(Object.entries(DEV_ACCOUNTS)),
  };
}

test("restart preserves homes, memberships, and home credentials", async (t) => {
  const first = await startTestBackend();
  const { base, dataDir } = first;

  const reg = await fetch(`${base}/v1/homes/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-me-setup-token": DEV_SETUP_TOKEN },
    body: JSON.stringify({ homeId: "home-restart-01", displayName: "Restart Home" }),
  });
  assert.equal(reg.status, 201);
  const { homeId, homeToken } = await reg.json();

  const ticket = await mintTicketForHome(base, homeId, homeToken);
  const join = await fetch(`${base}/v1/homes/${homeId}/members/join`, {
    method: "POST",
    headers: accountHeaders(ALICE),
    body: JSON.stringify({ ticketSecret: ticket.ticketSecret }),
  });
  assert.equal(join.status, 201);

  const hb = await fetch(`${base}/v1/homes/${homeId}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${homeToken}` },
    body: JSON.stringify({ status: "online" }),
  });
  assert.equal(hb.status, 200);

  first.server.close();
  await once(first.server, "close");

  // Restart with the same data dir: simulates process restart / host reboot.
  const secondBackend = createBackend(configFor(dataDir));
  const second = createServer(secondBackend.handler);
  second.listen(0, "127.0.0.1");
  await once(second, "listening");
  t.after(() => second.close());
  const base2 = `http://127.0.0.1:${second.address().port}`;

  const list = await fetch(`${base2}/v1/homes`, { headers: accountHeaders(ALICE) });
  assert.equal(list.status, 200);
  const { homes } = await list.json();
  assert.equal(homes.length, 1);
  assert.equal(homes[0].homeId, homeId);

  const members = await fetch(`${base2}/v1/homes/${homeId}/members`, { headers: accountHeaders(ALICE) });
  assert.equal(members.status, 200);
  const { members: list2 } = await members.json();
  assert.deepEqual(list2.map((m) => m.accountId), ["acct_alice"]);

  // Consumed ticket stays consumed, and the home credential still works.
  const replay = await fetch(`${base2}/v1/homes/${homeId}/members/join`, {
    method: "POST",
    headers: accountHeaders(ALICE),
    body: JSON.stringify({ ticketSecret: ticket.ticketSecret, ticketId: ticket.ticketId }),
  });
  assert.equal(replay.status, 410);

  const hb2 = await fetch(`${base2}/v1/homes/${homeId}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${homeToken}` },
    body: JSON.stringify({ status: "degraded" }),
  });
  assert.equal(hb2.status, 200);

  const status = await fetch(`${base2}/v1/homes/${homeId}/status`, { headers: accountHeaders(ALICE) });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.lastStatus, "degraded");
});
