# Q1 read-only integration/security review

Scope: read-only across `infra-server`, `agentic-framework`, `phone-app`,
`setup-infra`, `backend-server`. No implementation or test file in any repo
was modified; this document is the only write. Owners are actively editing —
notably R2 restructured `agentic-framework/src/me_runtime/` (flat modules →
`tools/` package with LangChain-tool adapters) during this review, and F2
extended `phone-app/src/paired-home-client.ts` (923 → 1222 lines). All
findings below were verified against the CURRENT file content at review
time; where an older revision behaved differently it is called out as
already-fixed. No credentials or personal data are reproduced here. No model,
commit, deployment, or global-config changes were made.

How verified: direct source reads (exact file/function/line cited), plus
live repro where marked. Lightweight suites only — no installs, no browser
or model downloads (disk constraint respected).

## P0 — setup lifecycle cannot launch the current H1 home (S2 ↔ H1)

`setup-infra/scripts/me_setup.py:node_args_for` (lines 318–334) returns bare
`[node_bin]` for `.mjs` entrypoints, so `me_lifecycle.py:home_argv`
(line 110–111) spawns `node src/cli.mjs start|bootstrap` with no TS flags.
But `infra-server/src/server.mjs` transitively imports the vendored
`vendor/openmuse/apps/server/src/engine/worker.ts`, which uses TypeScript
parameter properties (`worker.ts:31–40`, `private readonly db: Store`, …).
Node 24's default strip-only mode rejects those.

Repro (exact, no flags — as H1's handoff documents it):
`node src/cli.mjs bootstrap --user=alice --db=/tmp/x.sqlite`
→ `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter
property is not supported in strip-only mode` at `worker.ts:32`.

Consequences, all confirmed: `me_lifecycle start` spawns a process that
crashes on import; `bootstrap` exits 1; `docs/home-h1-handoff.md:17–20`
"Run it" commands fail as written (H1's own `npm run start:home`/`test:home`
pass the flag — the handoff snippet does not); `test_me_lifecycle`
`test_lifecycle_pair_converse_rerun_preserves` fails deterministically at
the bootstrap step (`home bootstrap exited 1: in strip-only mode`).

Fix (owner S2, with H1): S2's `node_args_for` must pass
`--experimental-transform-types` when the entrypoint transitively imports
TS (simplest correct move: always add `NODE_TS_FLAGS` for the H1 CLI), or
H1 keeps the plain-ESM CLI path TS-free / publishes required flags
machine-readably. One-line-class fix, cross-repo handshake needed.

## P1 — truthy non-boolean capabilities widen host-denied gates (H2 + R1)

`infra-server/src/runtime-config.mjs:clampCapabilities` (lines 89–101)
compares `out[key] === true` against the host policy. A client-supplied
truthy non-boolean (`"yes"`, `1`, `[]`) is never `=== true`, so no
`capability_denied` is thrown, and the widened value is stored in the task
input and forwarded to the bridge. Every R1 tool gate is truthiness-based
(`tools/{animate,web,exec,files}.py` use `capabilities.get(...)`), so the
clamp is the only defense — and it is bypassed.

Repro, verified live against current source (host policy all-false):
`clampCapabilities({animation:"yes"}, deniedPolicy)` returns
`animation:"yes"` with no throw (same for `1`, `[]`, `browser:"true"`,
`web_fetch:"yes"`); R1 `build_animation` then executed and recorded
8 artifacts. End-to-end: `POST /v1/conversations/:id/tasks`
`{"request":"x","capabilities":{"animation":"yes"}}` on a home without
`HOME_CAP_ANIMATION=1` is accepted (201) and runs, instead of 400.

Blast radius, per second gate: `animation` and `browser` have none beyond
the clamp (browser additionally needs provisioned Playwright/Chromium);
`code_exec` is saved by its second gate (`ME_RUNTIME_ALLOW_CODE_EXEC`);
`web_fetch` is saved by the allowlist gate (empty allowlist denies; the new
R1 code states approvals can never expand it). `files` cannot widen (host
policy is hardcoded true).

Fix (owner H2, defense R1): H2 — reject non-boolean capability values in
`clampCapabilities` (`typeof v !== "boolean"` → `capability_denied`); add
truthy-value cases to the existing `test:home` widening test (which today
uses proper booleans only). R2 — `is True` comparisons at the tool gates.

## P1 — approval "deny" vocabulary mismatch breaks the rejection path (F2 ↔ H2)

The phone client validates and sends `decision: "deny"`
(`phone-app/src/paired-home-client.ts:685,692,695`), but the real home
requires `"approve" | "reject"`
(`infra-server/src/task-broker.mjs:504`, else 400 `bad_request`). The
phone's fake home accepts `"deny"`
(`phone-app/src/fake-home-server.ts:377–382`), so client tests pass while
real integration breaks: `decideTaskApprovals(id, [{id, decision:"deny"}])`
against the real home → 400, and the denial is never recorded. Phone tests
never send `"deny"` (only `"approve"`, `client.test.ts:459`); home tests
use `"reject"`. Effect is fail-closed (task stays `waiting_approval`) but
the safety control's deny path is unusable from the phone — approve-or-abandon.

Fix (owner F2, confirm H2): F2 adopts `"reject"` in client + fake and adds a
real-services deny-path assertion; H2 confirms the vocabulary in the task
contract surface. Note the new R1 bridge already speaks approve/reject with
args-hash binding (`bridge.py:218–242`, `tools/interact.py:40–58`) — the
phone is the outlier.

## P1 — approval action expiry is recorded but never enforced (H2)

`task-broker.mjs:383` stores `expiresAt` (+24h) on every pending action, but
`decideApprovals` (lines 490–536) never reads action records and checks no
expiry — a decision with a valid id is accepted indefinitely. The handoff
(`docs/home-h2-handoff.md:77`) says expiry "relies on far-future action
TTLs", which is aspirational, not implemented (verified: no read path for
action `expiresAt` exists anywhere in `src/`).

Fix (owner H2): read the action in `decideApprovals`, reject past-expiry
decisions (410/409). Test with a short-TTL action (no 24h waits).

## P2 — fetch follows redirects without re-validating the allowlist (R1)

`tools/web.py:87` uses `follow_redirects=True`; `_require_fetch` (lines
63–80) validates scheme/allowlist/private-IP on the ORIGINAL URL only. An
allowlisted host issuing 30x to a non-allowlisted host is followed and its
content returned into model context. Related: `_is_private_host` (lines
44–57) resolves at check time while httpx re-resolves at connect (DNS
rebinding window; unresolvable hosts fail closed — good).

Fix (owner R1): `follow_redirects=False` + surface the redirect, or
validate every hop/final URL. Credit: the private-IP guard and the
"approvals can never expand the allowlist" rule are genuine improvements
over the previous slice.

## P2 — JSON API client has no redirect policy for credentialed requests (F2)

`paired-home-client.ts:request()` (lines 988–993) follows platform fetch
defaults: a 307/308 (same behavior pre-tunnel, or via MITM/DNS) re-sends
`Authorization: Bearer <session>` and POST bodies — including
`device_secret` on `/v1/sessions` — to the redirect target. The artifact
downloader in the same file already pins `redirect: "error"` (line 750);
the JSON path does not (the `FetchImpl` type, lines 116–124, does not even
expose `redirect`, so the fix needs type + call-site change).

Fix (owner F2): `redirect: "error"` (or manual + origin check) on `request()`.

## P2 — setup data-dir validation does not resolve symlinks (S2, low)

`me_setup.py:resolve_data_dir` (lines 210–226) checks the deny list against
`normpath` only. A `--data-dir` reaching a denied tree through a symlink
passes the check. Impact is low (operator-trusted input; non-root writes to
system dirs fail anyway), and sibling handling is otherwise careful
(fail-closed loopback/tunnel/credential rules verified).

Fix (owner S2): `Path.resolve()` before `_is_denied`; refuse symlink final
components. Also: `resolve_checkout` records explicit/env checkout paths
without existence checks (lines 336–354) — warn when they do not exist.

## P2 — test/engine skew from active R2 restructure (R2)

`tests/test_bridge_fixture.py::test_animation_builds_real_artifacts` FAILS:
the new engine emits `animation.gif`/`scene.py`/`scene.json`/`preview.html`/
`animation.mp4`, the test still expects `frame_*.svg`/`index.html`
(verified: manual bridge run, assertion at line 164). All 18 other tests in
the file pass. Owner R2: update the test to the new engine outputs (or pin
the engine contract first). Separately, R2's mid-review changes FIXED two
things this review would otherwise have flagged — recorded below.

## P2 — order-dependent setup test failure (S2 triage, not confirmed defect)

Full `discover` run: 28/30 (`test_backup_verifies_and_restore_roundtrip`
FAILED). The same test passes in isolation and in module runs; the
deterministic failure in that neighborhood is the e2e strip-only crash
above, plus one observed leaked-service cleanup warning. Likely
cross-test interference (ports/processes), not a backup-logic defect — the
backup/restore code itself is careful (pre-restore copy, WAL sidecar
removal, finalize + re-verify, authoritative-id adoption with backup).
Owner S2: rerun full suite after the P0 fix; isolate shared ports if it
persists.

## Already fixed — do not re-report

- Backend offline-queue `requestId` ReferenceError: current
  `paired-home-client.ts:565,572` uses `requestKey` correctly.
- Client 409 mapping ("invitation already used" for everything): current
  `errorForResponse` (lines 1085–1102) is route/code-aware
  (`request_key_conflict` → REQUEST_KEY_CONFLICT, `wrong_state` →
  WRONG_STATE).
- Approval id-only binding / constant `"a-web"` bypass in the old
  agent/bridge: gone — current R2 design binds decisions to `args_hash`,
  verified in both `tools/interact.py:52–54` and `bridge.py:226–242`, with
  checkpoint/run_id/workspace binding and run_id-reuse refusal (no blind
  replay).
- Missing H1 contract: published (`contracts/home-api-v1.md` +
  `.openapi.json`); backend already reconciled `installation_id` in a prior
  turn.

## Spot-checked solid (no action)

Auth: session lookup is the sole identity source; format check +
sha256-verifier comparison + expiry + per-request revocation
(`server.mjs:authenticate`); pairing consumes invitations atomically
(`BEGIN IMMEDIATE` + `consumed_at IS NULL` CAS); two-phone race covered by
test. Messages: caller-`user`-only, idempotent `request_key` with
409-on-conflict, owner-scoped with no-existence-leak 404s. Tasks: owner
scoped everywhere including artifact content (which also hides filesystem
paths and serves `octet-stream` + sanitized attachment filename);
cancel-then-abort cannot resurrect (worker CAS fails on non-`running`
status — covered by test); restart marks orphaned runs failed, never
replays. Storage: 0700/0600, FK on, schema-version gate with v1→v2
migration preserving data. Phone: secrets only in SecureStorage, cache
asserted secret-free by design, `expectedUserId` check on enroll,
home-authoritative sync replacing cache, revocation self-heals to
DEVICE_REVOKED. Setup: loopback-only refusal, Quick Tunnel refused, 0600
credential files, stale-pidfile fingerprinting before any signal, restore
verifies source + preserves current db + finalizes + re-verifies, household
tree never deleted, `installation_id` authority chain (db > live > reserve)
with backups.

Smaller notes (F2, low): `connectionState` reports `connected` from
anonymous healthz even with a dead session (transport signal only — rename
or document); `enterDemoMode` keeps cached snapshots for the next pairing —
clear cache on enrollment switch on shared devices; `randomUuidV4` is
Math.random-based, acceptable as documented (uniqueness-only idempotency
keys) with the injectable crypto generator available.

## Test evidence (all actually run, nothing invented)

- `infra-server`: `node --experimental-transform-types ... --test
  test/*.test.mjs` → 26/26 pass.
- `phone-app`: `node ... --test tests/*.test.ts` → 11/11 pass;
  `test/real-services.test.mjs` (real H1+B1+client) → 1/1 pass on two of
  three runs; first run hit a transient ECONNRESET in the restart phase —
  F2 triage if it recurs (suspect restart reconnect race).
- `agentic-framework`: `pytest tests/test_bridge_fixture.py` → 18 pass
  with the animation test deselected; `test_animation_builds_real_artifacts`
  FAILS (engine/test skew, P2-8 above).
- `setup-infra`: `python3 -m unittest discover -s scripts -p
  'test_me_*.py'` → 28/30 (P0 e2e strip-only failure + order-dependent
  backup failure, P2-9); lifecycle module alone 11/12; backup test passes
  isolated.
- Live repros: capability-truthiness widening confirmed through clamp AND
  R1 execution; strip-only crash confirmed via exact H1 CLI invocation.

## Priority handoff

1. S2+H1 (P0): unbreak lifecycle launches — TS flags for the H1 CLI path.
   Unblocks the setup e2e and every documented H1 launch command.
2. H2 (P1): strict-boolean capability validation; enforce approval expiry.
3. F2 (P1/P2): `"reject"` vocabulary + deny-path real-services assertion;
   redirect policy on the JSON client.
4. R1 (P1/P2): `is True` gate hardening; redirect re-validation.
5. R2 (P2): animation test/engine alignment.
6. S2 (P2): symlink-aware data-dir check; full-suite order dependence.
