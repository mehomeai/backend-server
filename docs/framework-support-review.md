# Framework / dependency support review (B5, read-only)

Date: 2026-11-03. Scope: verify the chosen foundation is actually supported and
current against primary maintainer sources — not model memory. No source edits,
no installs, no downloads; only PyPI/npm/GitHub/OSV metadata reads plus local
source inspection. This is a bounded review, not a security certification.

Exact pins under review: `agentic-framework/requirements.txt`
(langgraph 0.6.11, langgraph-prebuilt 0.6.5, langgraph-checkpoint-sqlite 3.1.3,
langgraph-checkpoint 4.3.1, langchain-core 1.7.4, langchain-openai 1.7.3,
langchain-ollama 1.1.0, langchain-anthropic 1.7.9, openai 3.42.1, ollama 0.6.3,
httpx 0.28.1, pillow 13.0.0), browser image
`mcr.microsoft.com/playwright/python:v1.64.1-noble`
(`agentic-framework/docker/browser/Dockerfile`), UI baseline Expo ~58 / RN 0.88
(`phone-app/apps/mobile/package.json`), backend `jose` 6.2.15
(`backend-server/package.json`), engines Node `>=24.18.0 <25`.

## 1. Currency vs primary latest (verified 2026-11-03)

| Pinned | Primary latest | Status |
| --- | --- | --- |
| langgraph 0.6.11 | 1.2.19 ([PyPI](https://pypi.org/pypi/langgraph/json), [releases](https://api.github.com/repos/langchain-ai/langgraph/releases?per_page=20)) | BEHIND, 1 major; 0.6.11 is the last 0.6.x (2025-10-21), 1.0.0 cut 2025-10-17, still releasing (1.2.19 on 2026-10-30) |
| langgraph-prebuilt 0.6.5 | 1.1.1 | BEHIND, same 1.x line gap |
| langgraph-checkpoint-sqlite 3.1.3 | 3.1.3 | current |
| langgraph-checkpoint 4.3.1 | 4.3.1 | current |
| langchain-core 1.7.4, langchain-openai 1.7.3, langchain-ollama 1.1.0, langchain-anthropic 1.7.9 | same | current (all four equal PyPI latest) |
| openai 3.42.1, ollama 0.6.3, httpx 0.28.1, pillow 13.0.0, playwright 1.64.1, anthropic 2.4.0, httpx2 2.16.0, aiosqlite 0.22.1, jiter 0.18.0 | same | current |
| npm `jose` 6.2.15 | 6.2.15 ([registry](https://registry.npmjs.org/jose/latest)) | current, lockfile-pinned |
| npm `expo` ~58.0.16 / `react-native` 0.88.0 | 58.0.22 / 0.88.1 | current line; one patch behind each (normal) |
| `@playwright/test` ^1.64.1 | 1.64.1 | current |
| Node engines `>=24.18.0 <25` | v24 LTS "Krypton", newest v24.22.2 ([index](https://nodejs.org/download/release/index.json)) | floor is inside the active LTS line; fine |

`httpx2==2.16.0` in requirements is legitimate, not stray: it is a declared
dependency of `anthropic 2.4.0` (`Requires-Dist: httpx2<3,>=2.0.0`, read from
local dist-info METADATA), pinned at latest.

## 2. Known advisories on pinned versions (OSV + GitHub primary)

OSV queried per pinned package; only two hits, both LangGraph-ecosystem:

**A. GHSA-g48c-2wqr-h844 / CVE-2026-28277 — unsafe msgpack checkpoint
deserialization (Moderate, CVSS 6.8). AFFECTS pinned `langgraph 0.6.11`.**
Primary: [advisory](https://github.com/langchain-ai/langgraph/security/advisories/GHSA-g48c-2wqr-h844).
Affected `<=1.0.9`, patched in `1.0.10` (2026-02-27); OSV range confirms
`introduced: 0, fixed: 1.0.10`. There is **no 0.6.x patch** — PyPI shows
0.6.11 as the final 0.6 release, so the fix requires the 0.6 → 1.x major
upgrade. Threat model (per the advisory itself): post-exploitation /
defense-in-depth — exploitation needs write access to checkpoint bytes at
rest, which in this deployment means the home host / `<workspace>/.me_runtime/graph.db`
is already compromised. Not remotely reachable in a correctly configured
deployment; no known exploitation in the wild.
Home relevance is therefore low-severity but real (runtime secrets live in the
same process), and the fix path is a planned migration, not an emergency.

Mitigation available WITHOUT the major upgrade (verified in the installed
0.6.11 tree: `langgraph/checkpoint/serde/jsonplus.py` + `_msgpack.py` already
honor it): set **`LANGGRAPH_STRICT_MSGPACK=true`** in the runtime environment
— allowlist-based strict deserialization, schema-derived for compiled graphs
per the advisory. Nothing in `agentic-framework` sets or documents it today
(grep for `STRICT_MSGPACK`/`LANGGRAPH` across src/scripts/docs/`.env.example`
is empty). See MUSTFIX 1.

**B. `langgraph-sdk` 0.6.x-line pin 0.2.15 — GHSA-fvww-7h3r-vfhp (fixed 0.4.4)
+ GHSA-w39p-vh2g-g8g5 (fixed 0.3.15). NOT REACHABLE here.** The runtime never
imports `langgraph_sdk` (grep over `src/me_runtime/**` shows only
`langgraph.prebuilt`, `langgraph.errors`, `langgraph.types`,
`langgraph.checkpoint.sqlite`); it is a transitive pin talking to no remote
endpoint in this design (local `SqliteSaver` only). No action beyond letting
the 1.x migration float it forward; do not chase separately.

Everything else queried is OSV-clean at pinned versions: langgraph-prebuilt
0.6.5, checkpoint 4.3.1, checkpoint-sqlite 3.1.3, langchain-core/openai/ollama/
anthropic adapters, openai, anthropic, ollama, pillow, httpx, httpx2,
httpcore2, aiosqlite, jiter, langchain-protocol, playwright, npm jose/expo/
react-native. Bounded note: clean today ≠ certified; re-query on upgrade.

`create_react_agent` deprecation check (the "old prebuilt API" question):
**not deprecated.** Upstream tags `prebuilt==1.1.1` and `1.2.19` still export
`create_react_agent` from `langgraph.prebuilt`
([1.1.1 source](https://raw.githubusercontent.com/langchain-ai/langgraph/prebuilt==1.1.1/libs/prebuilt/langgraph/prebuilt/__init__.py)),
and the 1.2.19 signature keeps `create_react_agent(model, tools, *,
prompt=...)`, matching the call in `agentic-framework/src/me_runtime/agent.py:94`.
The import path survives 1.x; behavior/keyword compat still needs the
codeowner's fixture-suite run, not blind trust.

## 3. Privacy transport: local Ollama proxy exposure — CONFIRMED, MUSTFIX

`models.py:85-90` builds `ChatOllama(base_url="http://127.0.0.1:11434")` with
no `client_kwargs`. Installed `langchain-ollama 1.1.0` forwards those into
`ollama-python 0.6.3` `Client/AsyncClient`, which forward `**kwargs` into
`httpx.Client` (`ollama/_client.py`, `BaseClient.__init__`). Installed
`httpx 0.28.1` defaults **`trust_env=True`** (`httpx/_client.py:201`), i.e.
`HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` are honored unless `NO_PROXY` covers
loopback — which a home host cannot assume. Result: with a proxy set in the
bridge environment, local prompt bytes addressed to loopback can leave the
home. Concrete fix (one line, no behavior change otherwise): pass
`sync_client_kwargs={"trust_env": False}, async_client_kwargs={"trust_env":
False}` (or `proxy=None`) for provider `local`. This is an inconsistency, not
a design decision: `tools/web.py:137-140` already strips all `*_PROXY` and
passes `--noproxy '*'` for curl fetches precisely because "a proxy would
bypass `--resolve` DNS pinning" — the Ollama path missed the same treatment.
Remote providers (`openai`/`anthropic`) are unaffected by this finding: they
require `ME_RUNTIME_ALLOW_REMOTE=1` plus an env-held key (`models.py:66-77`),
keys never travel in the request, and proxy use there is policy-consistent
because the traffic is explicitly remote.

## 4. Reuse justification, licenses, proprietary deps avoided

- One harness, no doubles: agent loop is owned by maintained
`langgraph-prebuilt.create_react_agent` (`agent.py:1-8,88-95`); no custom
planner, no manual `/chat/completions` parsing. Browser isolation reuses the
official Playwright Python image + SDK 1.64.1 (both current, §1) with
operator-built, `--pull never` Docker runs. Animation reuses Pillow 13.0.0
(current, OSV-clean). OIDC reuses npm `jose` 6.2.15 (current, OSV-clean, MIT).
- Upstream code reuse is vendored, not forked: OpenMuse worker+log helper at
immutable commit `a4944f4c…b521ab6` with SHA-256 inventory
(`infra-server/vendor/openmuse/upstream.json`) and original MIT `LICENSE`
preserved; compatibility CI + weekly candidate workflow documented in
`infra-server/docs/upstream-updates.md`. No blanket-clearance claims; matches
`agentic-framework/docs/reuse-audit.md` (OpenMuse donor / OpenClaw trial /
DeepAgents alternative framing stands).
- Python dep licenses (local dist-info METADATA): langgraph, prebuilt,
checkpoint, checkpoint-sqlite, langchain-*, ollama, langgraph-sdk = MIT;
openai = Apache-2.0; httpx = BSD-3-Clause; pillow = MIT-CMU; aiosqlite = MIT.
npm `jose` = MIT. Me repos are Apache-2.0. No copyleft in the runtime path.
- Proprietary dependencies avoided: local-first default (Ollama loopback, no
key); remote model use is explicit opt-in; no LangSmith/hosted control plane,
no vendor browser cloud, no proprietary DB (SQLite via aiosqlite).

## 5. Upstream-update coverage vs not-yet-public runs

- `agentic-framework`: Dependabot `pip` + `github-actions` weekly, PR
dependency-review (`fail-on-severity: high`), CI pins exact
`requirements.txt` and runs the offline fixture suite. Best coverage in the
fleet. Gap: nothing watches `browser` extra / base-image tag drift except the
manual 2026-11-03 verification comment in the Dockerfile.
- `backend-server`, `phone-app`, `setup-infra`, `infra-server`,
`feed-algorithm`, `web-app`: Dependabot covers **github-actions only — no
`npm` ecosystem entry anywhere**, so `jose`, Expo/RN, and web-app deps get no
automated update PRs (dependency-review still gates PRs that do arrive).
- `infra-server` additionally has the OpenMuse weekly candidate workflow, but
per its own docs the workflows are local until committed/pushed/merged and PR
creation needs repo permission — verify on GitHub that Actions actually ran
post-merge; nothing here proves a public run.

## 6. MUSTFIX (delegate to codeowner; no edits made by this review)

1. **Set `LANGGRAPH_STRICT_MSGPACK=true`** for the runtime bridge environment
(home service that spawns `me_runtime/bridge.py` + `.env.example`/docs), then
run the existing offline fixture suite to confirm checkpoint resume still
passes. Handles GHSA-g48c-2wqr-h844 blast radius without the major upgrade.
Owner: runtime/home-service owner.
2. **Pin Ollama loopback transport**: `trust_env=False` (or `proxy=None`) via
`sync/async_client_kwargs` in `build_chat_model` local branch
(`agentic-framework/src/me_runtime/models.py:85-90`); regression-test with a
proxy-set environment asserting loopback bypass. Owner: runtime owner.
3. **Plan langgraph 0.6.x → ≥1.0.10 migration** (current 1.2.19): only real fix
for GHSA-g48c-2wqr-h844. Evidence for low risk assembled here (import path +
signature survive in 1.x), but the codeowner must run CI + live-backend tests
before floating pins. Do NOT jump blindly; do NOT stay on 0.6.x indefinitely
(it is end-of-line). Owner: runtime owner.
4. **Add `npm` to Dependabot** in `backend-server`, `phone-app`,
`setup-infra`, `infra-server`, `feed-algorithm`, `web-app`
(`.github/dependabot.yml`); confirm Actions/Dependabot actually run on the
default branch post-merge. Owner: repo maintainers.

No other must-fix found. Optional, not required: react-native 0.88.0 → 0.88.1
and expo 58.0.16 → 58.0.22 patch floats; Node floor 24.18 stays valid inside
v24 LTS.
