# Final validation — overall cross-repo local validation record (review branch, no deployed release)

Status: initial integrated implementation complete on review branch `feat/home-agent-foundation` (committed/pushed; draft PR #1 pending review/checks). No merge to protected `main`; no deployed release.

Local evidence root (ephemeral, not committed): `/private/tmp/me-opencode-live-20261103` — proof logs under `logs/`, release marker at `source-release-ready.json` (protocol `source-release-ready-v1`). Results below are the local validation record; current remote PR check status not verified — see draft PR #1 checks.

Canonical architecture: `agentic-framework/docs/product-architecture.md` (implemented locally). Delivery status: `agentic-framework/docs/product-delivery-plan.md`.

## 1. Result table (2026-11-03 local finals; proofs under the LOCAL evidence root above)

| Scope | Result | Proof (local logs) |
| --- | --- | --- |
| Backend independent full | **39 pass / 0 fail** | `logs/accepted-backend-latest.log` |
| Home independent full | **103 pass / 1 skip / 0 fail** (single intentional runtime-presence gate marker; actual bridge cases ran) | `logs/accepted-home-latest.log` |
| Runtime full (OpenCode owner) | **122 pass / 4 skip / 0 fail** (273.29s; optional live/provider/browser smoke gates skipped) | `logs/runtime-final-context-review.jsonl` |
| Runtime targeted (context+response regressions subset) | **29 pass / 0 fail** | `logs/accepted-runtime-context-release.log` |
| Actual home + actual runtime runners | **9 pass / 0 fail** (101.6s serial; test-file concurrency 1, within-case child concurrency preserved) | `logs/accepted-home-runners-serial-release.log` |
| Setup/lifecycle/full-backup/crash-window/coordinator ALL | **99 pass / 0 fail** (229.8s) | `logs/accepted-setup-release.log` |
| Phone portable unit | **86 pass / 0 fail** (no native mount) | `logs/phone-activation-review.jsonl` + root exec observed 86 before real-services launch |
| Phone real (home+backend+client incl. activation/recovery + fake-provider push) | **2 pass / 0 fail** | `logs/accepted-phone-release.log` |
| Mobile official SDK type-mirror | **exit 0, 51 packages**, zero ambient stubs; NOT a native build | `logs/accepted-mobile-types-release.log` (empty, exit 0 recorded root exec) |
| Mobile syntax | **52 checked / 0 fail** (separate from semantic) | `logs/accepted-mobile-syntax-release.log` |
| Live model strict | **pass, 47.538s** — Meta Muse Spark 1.3 via actual SDK/remote opt-in, synthetic only: delegate→parent waits→child succeeds→5-byte ORBIT downloaded→answer English→parent final contains ORBIT+English→exactly 1 parent assistant; strict assertions, not fixture | `logs/live-response-extraction-fix.jsonl` |
| CI/system acceptance | YAML/input validation + upstream-source verification local only; results below are the local validation record — current remote PR check status not verified, see draft PR #1 checks; review-branch commits pushed, no merge to protected `main`, no deploy | local only |

Timing note: one overloaded concurrent independent run showed 7 pass + 2 polling-timeouts; both passed on focused rerun without source/assertion changes — final 9/9 serial acceptance unchanged. CI serializes home test files to avoid redundant interpreter-startup contention; within-case concurrency remains tested. Early live attempts surfaced a structured-content bug; the passing final is the response-block-extract fix with strict assertions.

## 2. Backend detail (this repo owns; B7 included)

- Dev auth: explicit local-dev bearer (loopback-only; wider binds refused). Hosted: real OIDC JWT via `jose` vs static issuer/audience/JWKS (asymmetric only); identity `acct_<sha256(iss,sub)>`; body identity `400`; remote JWKS from fixed server config only.
- Activation (B7): account-bound `POST /v1/homes/activation-tickets` (5-min TTL, 15 live/account cap, sha256 verifiers) + ticket-only `POST /v1/homes/activate` (no account JWT, exact `installationId`, `endpointHint` public `https://` or loopback-`http://` dev-only, `protocolVersion` 1–32, validate-before-consume, atomic persist with rollback). Private file exactly 7 keys incl `protocol_version` (`0600`, outside git). Credential fetches `redirect: 'error'` — never followed, even `https://`. Trust is TLS + locally-trusted pair URL; installation equality is correlation only.
- Compat B3 registration tickets unchanged; join tickets + membership + authorized discovery + heartbeat/status (`online` server-computed, `ME_BACKEND_STALE_AFTER_SECONDS` 30–3600 default 300) + revocation with owner promotion.
- Single-process `backend-state.json` (atomic temp+rename); one server per data dir. `__proto__` rejected, own-property lookups.
- NOT implemented: IdP provisioning, chat/message relay or payload storage, second scheduler, hosted tunnel/edge, native-app checks, app-layer crypto/second trust system.
- Hygiene: `python3 scripts/check_repository.py` pass (whitespace only; no heavy tests for docs).

## 3. Canonical privacy + scope limits

- Cloud carries NO private chat relay/storage — coordination (tickets/membership/heartbeat/discovery) only.
- Optional remote inference sends the scoped prompt/history/tool context to that provider (explicit `ME_RUNTIME_ALLOW_REMOTE=1` + key, even for localhost URLs); local Ollama default otherwise. Synthetic prompts only for live checks, never household data.
- Model memory = persisted conversation history + versioned run checkpoints scoped to owner/conversation/run (context 10 msg / 2k chars / 20k total, user+assistant only, resume-checkpoint only). No semantic-RAG / cross-conversation retrieval / MCP integrations / voice-calls production claims (calls stay simulated demo).
- No consumer-production / HA / 100% claims. Native SDK type-mirror (51 pkgs, exit 0) is a semantic graph check, not a native bundle. Docker code/browser images, local Ollama models, tunnel/DNS/IdP/push delivery are implementation with explicit manual provisions, not stubs — and not locally proven where parked below.

## 4. Local smoke (no valid real provider needed) + parked checks

Smoke (loopback + fixture, per `infra-server/docs/end-to-end-runbook.md` §§1–4 and `setup-infra/docs/home-coordination-activation.md`):
`node --version` (24.18.x) → start loopback home once so SQLite mints the REAL authoritative `installation_id` (initial reserved config UUID is NOT usable; `coordinator prepare`/`activate` require the real DB id — never publish a pre-start reserved-UUID flow) → `coordinator prepare` (local public URL, no network) → owner phone mints ticket → `coordinator activate < ticket.json` (STDIN only) → restart service → local `bootstrap --format pairing-v1` invitation → phone pair → task → clarify/children → artifact → opt-in push → `backup --scope full` on stopped service (DB + tasks + household files + private checkpoints; config/env/coordinator secrets excluded; workspace MAY hold private cookies/keys; WAL-journal rollback, not one atomic txn; restore revokes auth → fresh pair; A→B rebase pending resume test explicit).

Parked (manual gates, never CI — from marker):
full native Expo install/bundle + real device flows; actual Docker code+browser image builds/execution on provisioned hardware (earlier host-Chrome DOM synthetic smoke passed; Docker image not run locally); actual local Ollama inference; real named tunnel/domain/Cloudflare creds/DNS (+ optional Access policy; phone-ready default `home-pairing`); real hosted IdP/backend deploy + real Expo/APNs/FCM delivery; commit/push coordinated refs then dispatch pinned system acceptance.

## 5. Operator next steps

1. Review the coordinated draft PRs and merge after required checks; back up `backend-state.json` + home DB/tasks before destructive ops.
2. Provision the parked items above with provider tooling; setup records references only, never provisions.
3. Re-run each owner suite per runbook §6 on the release checkout, then dispatch the pinned system-acceptance workflow (shell inputs via ENV, validated 40-hex refs, no source interpolation) — current remote PR check status not verified, see draft PR #1 checks.
