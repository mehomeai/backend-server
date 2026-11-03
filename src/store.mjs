// Durable JSON state with atomic file replacement.
//
// Single-process constraint: there is no file locking. Concurrent writers
// (two server processes sharing one data dir) can lose updates: last rename
// wins. Run exactly one backend per data dir; production needs a real
// database with transactions. No production database concurrency is claimed.
//
// State is a small coordination record (homes, memberships, join tickets,
// heartbeat status). It never stores private chat history or message payloads.
// Writes go to a temp file in the same directory followed by rename, so a
// crash cannot leave a half-written state file behind.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const STATE_FILENAME = "backend-state.json";
export const STATE_VERSION = 1;

export function blankState() {
  return {
    version: STATE_VERSION,
    homes: {},
    homeTokenVerifiers: {},
    members: {},
    tickets: {},
    regTickets: {},
    activationTickets: {},
  };
}

export function stateFilePath(dataDir) {
  return join(dataDir, STATE_FILENAME);
}

export function loadState(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const path = stateFilePath(dataDir);
  if (!existsSync(path)) {
    const fresh = blankState();
    saveState(dataDir, fresh);
    return fresh;
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || parsed.version !== STATE_VERSION) {
    throw new Error(`Unsupported state version in ${path}.`);
  }
  parsed.homes ??= {};
  parsed.homeTokenVerifiers ??= {};
  parsed.members ??= {};
  parsed.tickets ??= {};
  parsed.regTickets ??= {};
  parsed.activationTickets ??= {};
  return parsed;
}

export function saveState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  const path = stateFilePath(dataDir);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
