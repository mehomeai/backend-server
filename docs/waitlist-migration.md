# Waitlist migration — evidence and scope record (ticket W1)

Status of everything in this document: **implemented, synthetic verification
only** — never complete, never production-ready. This file is the scope and
evidence record for the synthetic waitlist implementation on branch
`feat/waitlist-synthetic`, authorized by the Codex ruling of 2026-11-05
("ACCEPT WITH CHANGES", session 01a1ae11; full text:
`CODEX-RULING-WAITLIST-SYNTHETIC-2026-11-05.md` in the integration records).
Migration-plan step 1 (PostgreSQL availability) remains **BLOCKED**; see
"Blocked step-1 evidence" below.

Terminology, per ruling change 1: the tests for this work are
**source-derived contract tests**. They pin behavior copied from the
evidenced Replit source below. They are NOT differential tests: they do not
execute the original Replit handler, which cannot be run locally from the
available source without deployment access. Differential verification is
pending.

## Source evidence

- **Source revision:** the Replit workspace as mirrored in the bridge clone
  `~/workspace/bridge-seed/replit-workspace` at commit
  `453b5f2c6709a4cfe248b1cfadc0fdfbcf78fc34` ("docs: record reconciliation in
  BRIDGE.md"). Every literal in this document was read from that revision.
- **Handler:** `artifacts/api-server/src/routes/me-waitlist.ts` (mounted by
  `artifacts/api-server/src/routes/index.ts`; app prefix `/api` at
  `artifacts/api-server/src/app.ts:29`; route `router.post("/me/waitlist")`
  at `me-waitlist.ts:13`). The whole behavior contract lives in that one
  61-line file.
- **Validation schema (generated):** `lib/api-zod/src/generated/api.ts:11-22`
  (Orval output; the route validates with the Zod v3 request schema).
- **API contract:** `lib/api-spec/openapi.yaml` — `POST /me/waitlist`,
  operationId `joinMeWaitlist`, `servers: [{url: /api}]`, responses
  200/400/429/503.
- **Storage schema:** `lib/db/src/schema/me-waitlist.ts` (Drizzle `pgTable`,
  the only table in the tree). Connection: Drizzle over a `pg` Pool from env
  `DATABASE_URL`; that module throws at import time if `DATABASE_URL` is
  unset (the port deliberately does not reproduce this; see flag semantics).
- **Only caller:** `artifacts/me-website/src/pages/signup.tsx`
  (`useJoinMeWaitlist`); the mobile app never calls the endpoint.
- **Evidence records:** `WAITLIST-BEHAVIOR-MATRIX.md` and
  `REPLIT-BACKEND-INVENTORY.md` (integration records, same evidence base).
  Line citations below are to the bridge clone at `453b5f2`.

## Behavior matrix (source-proven)

### Execution order

The handler's order is load-bearing and any port must preserve it:

1. `Cache-Control: no-store` is set first (`me-waitlist.ts:15`), before any
   branch — it is present on every response (200, 400, 429, 503).
2. Limiter expiry sweep: entries with `resetAt <= now` are deleted (lazy,
   per-request, no timer; the boundary is inclusive).
3. Limiter key is built from the RAW request body, before any validation.
4. Limit check and increment (see limiter parameters); invalid requests,
   consent failures, and honeypot requests all consume limiter capacity.
5. Input normalization: if the body is an object, the email is replaced by
   `email.trim().toLowerCase()` (only when it is a string); other fields
   pass through untouched; a non-object body is passed to the parser as-is.
6. Validation: `JoinMeWaitlistBody.safeParse(input)`.
7. 400 branch: parse failure OR `consent !== true`.
8. Honeypot branch: a truthy parsed `website` returns the success receipt
   with no DB write and no further work.
9. DB insert with conflict-ignore on email; any throw is logged and mapped
   to 503.

### Field rules

| Field | Rule |
|---|---|
| `email` | Required. String, valid email (Zod), max 254 chars — the max applies to the NORMALIZED value (trim, then lowercase, then length check). Non-string email fails validation (400). |
| `consent` | Required. Must be exactly `true` (Zod `zod.literal(true)`); no coercion — `"true"`, `1`, `"yes"` all fail with 400. |
| `website` | Optional honeypot. String, max 200 chars; never normalized. Truthy (including whitespace-only `" "`) → honeypot path; `""` or absent → normal flow; over 200 chars → validation fails (400) before the honeypot branch is reached. |
| Unknown fields | Not rejected by the schema. |

Normalization ordering detail: the limiter key uses
`trim().toLowerCase().slice(0, 254)` — the same normalization PLUS a
254-char truncation. The stored/validated email is never truncated; only
the key is. Client-side, the signup page sends `v.email.trim()` (trim only,
no lowercasing); lowercasing happens only server-side, and the stored value
is always the lowercased form.

### Responses — exact literals

All bodies are JSON. The receipt text is exact and constant:

| Case | Status | Body (exact) | Headers |
|---|---|---|---|
| Success — first signup | 200 | `{"success": true, "message": "You're on the list. We'll share Me launch updates with you."}` | `Cache-Control: no-store` |
| Success — duplicate email | 200 | identical receipt (indistinguishable from a first signup) | `Cache-Control: no-store` |
| Success — honeypot | 200 | identical receipt, no row written | `Cache-Control: no-store` |
| Invalid email or consent | 400 | `{"error": "Enter a valid email and agree to receive Me launch updates."}` — one message covers both failure kinds | `Cache-Control: no-store` |
| Rate-limited (count) | 429 | `{"error": "Too many attempts. Please try again later."}` | `Cache-Control: no-store` + `Retry-After: <seconds>` = `Math.ceil((resetAt - now) / 1000)` |
| Rate-limited (map full) | 429 | same 429 body | `Cache-Control: no-store`, **no `Retry-After`** |
| Storage failure | 503 | `{"error": "We couldn't save your signup. Please try again shortly."}` — the underlying error is logged server-side only, never returned | `Cache-Control: no-store` |

Consent version written on insert: **`"launch-updates-v1"`** (constant,
`me-waitlist.ts:50-53`).

### Rate limiter parameters

- Module-level in-memory `Map<string, {count, resetAt}>`; process-local, no
  persistence, resets on every process restart. A multi-process deployment
  would enforce a separate budget per process. The migration plan therefore
  serves this route through ONE backend process initially.
- Window: `15 * 60 * 1000` ms (15 minutes), FIXED window — `resetAt` is set
  once when the entry is created and increments do not move it.
- Limit: a request is rejected when the stored count is already ≥ 15, so
  attempts 1–15 are admitted and attempt 16 is the first 429.
- Key: `` `${req.ip ?? "unknown"}:${emailKey}` ``, where `emailKey` is the
  raw body's `email.trim().toLowerCase().slice(0, 254)` when `email` is a
  string, else the literal `"invalid"`.
- Map cap: when the map already holds 10,000 keys and a NEW key arrives, the
  request is rejected 429 WITHOUT `Retry-After`. Existing keys keep
  incrementing even when the map is full.
- Honeypot requests consume limiter capacity: YES (the increment runs before
  validation and before the honeypot branch). Failed requests (400, 503)
  consume capacity too.

### Storage

`me_waitlist` (the only table):

| Column | Type / constraint |
|---|---|
| `id` | `serial` PK |
| `email` | `text` NOT NULL UNIQUE |
| `consent_version` | `text` NOT NULL |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() |

The route inserts `{email: <normalized>, consentVersion: "launch-updates-v1"}`
with `onConflictDoNothing({target: email})`. A repeat signup is a silent
no-op: there is no update of `consent_version` or `created_at` on conflict.
`id` and `created_at` are DB-generated; operational IDs stay local to each
DB. The migration payload per row is exactly
`{email, consent_version, created_at}`. Schema management in the source is
`drizzle-kit push`; no migration SQL files exist in the source tree. There
are no seed/demo rows and no other tables.

The storage boundary for the port is defined in `src/waitlist/store.mjs`
(ticket W2): normalized-email insert-or-return-existing; a successful or
conflict insert returns the PERSISTED row's `consent_version` and
`created_at`, never values manufactured from the repeat request; storage
failures surface only as `WaitlistStorageError`. The deterministic
in-memory implementation lives under `test/fixtures/` only, implements
storage semantics only (no validation, rate limiting, consent, or honeypot
logic), and cannot be selected by production configuration.

Related source facts: no auth, session, or cookie middleware exists on the
route; logging does not capture request bodies or emails; the artifact's
health route (`GET /api/healthz`) is NOT migrated — backend-server keeps
its own health endpoints.

## Literals that are NOT evidenced (blocked claims)

Per ruling change 5, anything not in the evidence is recorded here as
unavailable rather than invented. Each item blocks only the specific claim
named:

- **Flag configuration key name: not evidenced — fixed as a W4
  IMPLEMENTATION DECISION (recorded under "W3/W4 implementation record"
  below).** The migration plan (step 5) and the ruling specify an
  "initially disabled deployment flag" and its semantics only. No
  environment-variable or config key name for the flag appears in any
  evidence source. The name in use (`ME_WAITLIST_ENABLED`) is a decision
  of this port, NOT evidence, and must never be cited as source behavior.
- **Email-format acceptance boundary: NOT source-defined.** The schema uses
  Zod v3's built-in `.email()` check with no custom regex (workspace pins
  `zod: ^3.25.76`); which exotic addresses pass is library-defined, not an
  evidenced literal. W3 pinned the port's rule explicitly (see "W3/W4
  implementation record"): the handler implements the evidenced schema
  rules in plain code with a pinned email pattern and does NOT claim
  parity for exotic address forms.
- **Express framework defaults: NOT stated in source.** Malformed-JSON
  error shape/status from `express.json()`, the default JSON body size
  limit, and related framework behaviors are not evidenced and must not be
  presented as contract behavior.
- **Deployed `req.ip` value: UNKNOWN.** No `trust proxy` setting exists
  anywhere in the source tree (grep-verified). Whether the deployed routing
  sets it — and therefore whether the limiter key's IP portion is the
  end-user IP or a shared proxy IP — cannot be established from source.

## Flag semantics (ruling change 3)

- The waitlist feature flag **defaults to disabled when absent**. Only an
  explicit enable registers anything.
- When disabled: the route `POST /api/me/waitlist` is left UNREGISTERED, so
  backend-server's normal unmatched-route behavior applies. Nothing about
  the route exists in the running server.
- When disabled: zero storage/pool initialization, no credentials are
  requested, and no database is contacted. Constructing the storage adapter
  happens only behind explicit enablement, lazily.
- Synthetic work honors this today: nothing in the W-series enables the
  flag anywhere, and the in-memory fixture is reachable only from tests.

## W3/W4 implementation record (decisions, not evidence)

Everything in this section is an implementation decision of this port,
made under the ruling where the evidence runs out. None of it is source
behavior and none of it may be cited as such.

- **Files (W3):** `src/waitlist/handler.mjs` (execution order,
  normalization, validation, consent, honeypot, exact literals, error
  mapping) and `src/waitlist/rate-limit.mjs` (fixed-window limiter and
  raw-body key construction). Store, limiter, and the storage-error
  logger are injected; the handler is a pure function of `{ ip, body }`,
  and the HTTP layer supplies the socket remote address as `ip`.
- **Files (W4):** the route `POST /api/me/waitlist` is registered inside
  `createBackend` (`src/server.mjs`) only when `config.waitlistEnabled`
  is true, reusing the existing CORS layer and `readJsonBody` unchanged,
  and consulting no credential (outside OIDC/dev-token enforcement, as in
  the source). No trust-proxy configuration was added anywhere.
- **Flag key name (W4 decision): `ME_WAITLIST_ENABLED`** (parsed in
  `src/config.mjs` into `config.waitlistEnabled`). Naming follows the
  `ME_*` feature-env convention of `ME_CORS_ALLOWED_ORIGINS`;
  enablement is strict — only the exact value `"1"` enables, the same
  convention as `ME_BACKEND_OIDC_ALLOW_INSECURE_ISSUER`. Absent or any
  other value = disabled.
- **Store injection (W4 decision):** an enabled backend takes its store
  from `config.waitlistStoreFactory()` (preferred; lets tests count
  constructions) or `config.waitlistStore`. The factory is invoked
  exactly once at backend construction when enabled, and NEVER when
  disabled or absent — zero storage/pool initialization in the disabled
  state, per ruling change 3. Enabling with no store injected throws at
  construction (fail closed): no production store exists until the W5
  PostgreSQL adapter, and a route that cannot persist must not register.
  A clock may be injected for the limiter via `config.waitlistNow`
  (tests only).
- **Validation pin (W3 decision):** the evidenced schema rules
  (`email` string + format + max 254 on the normalized value, `consent`
  exactly `true`, optional `website` string max 200, unknown keys
  ignored) are implemented in plain code; the email format check is the
  pinned pattern in `src/waitlist/handler.mjs` (dot-atom local part,
  dot-separated domain labels, alphabetic TLD ≥ 2). No dependency was
  added. Parity with Zod's library-defined acceptance for EXOTIC address
  forms is explicitly NOT claimed (see the blocked-claims list above).
- **Body parsing:** the route reuses backend-server's existing
  `readJsonBody`, so malformed JSON, non-object bodies, wrong content
  type, and oversize bodies keep this server's existing 400/415/413
  behavior. Those framework behaviors are not evidenced source behavior
  (see blocked claims) and are not asserted as contract.
- **Differential verification: PENDING.** One-line reason: the original
  handler cannot be executed locally without deployment access — it is
  TypeScript/Express hardwired to a Drizzle/`pg` Pool (its db module
  throws at import when `DATABASE_URL` is unset), exposes no store or
  clock injection points, and no PostgreSQL exists on this machine to
  point it at. All W3/W4 tests are therefore source-derived contract
  tests, per ruling change 1.

## Blocked step-1 evidence

Migration-plan step 1 is an evidence gate: the endpoint's production store
must be a dedicated managed PostgreSQL on existing approved infrastructure
(separate restricted credential; never the backend JSON store, never
infra-server's SQLite), with a recorded target DB, operator,
backup/restore story, and deployment topology (no credentials recorded).

Evidence, probed 2026-11-04 23:31 PT and re-probed 2026-11-05:

- NO PostgreSQL on this VM or on existing infra: no PostgreSQL binaries, no
  5432 listener, no Docker, no `DATABASE_URL`/PG environment, and no
  PostgreSQL references in backend-server.
- The only PostgreSQL anywhere on existing infrastructure is the upstream
  OpenBot platform's own, inside its Docker-gated deployment — not a
  managed PostgreSQL available to backend-server.

Result: the step-1 gate is NOT satisfied and the PostgreSQL home is
UNDECIDED (owner decision queued: where should backend-server's production
PostgreSQL live?). No new hosting has been provisioned. Step 1 stays
BLOCKED until that decision exists; W-series completion does not change it.

## Unknowns — stated plainly

Production topology, deployed behavior, and the live row count remain
UNKNOWN. Specifically, none of the following can be established from the
available source, and all require authorized Replit deployment access:

- Live row count in the production Replit Postgres (and distinct-email
  count, consent-version distribution, timestamp range). Whether any real
  signup ever landed is unknown.
- Whether the deployed build matches bridge revision `453b5f2` (the
  published app was deployed from an earlier state of a different
  workspace).
- The deployed `DATABASE_URL` identity — which Postgres instance the
  deployed endpoint actually writes to.
- Deployed trust-proxy behavior and deployed edge proxy/CORS/header
  behavior; live response headers were never observed.
- Process topology of the deployment (one process or several), which
  decides whether the 15/15-min limiter budget is effectively per-process.
- Consent/compliance expectations for any live rows (privacy notice,
  permitted use of existing consent, retention/deletion expectations,
  authorized data operators, approved export/backup handling) — owner
  decisions required by plan step 3, not derivable from code.
- Whether any consumer outside the website `/signup` page ever called the
  endpoint.

The existing server-side test baseline in the source is ZERO tests (the
only waitlist-adjacent tests are 3 mocked Playwright UI tests on the
client); the source-derived contract tests in this repo start from zero.

## Promotion gates for the PostgreSQL adapter (W5)

The PostgreSQL adapter (ticket W5) is written label-first as **UNVERIFIED
against PostgreSQL**: static checks and mocked-driver tests only, no
database connection attempted. To promote it from UNVERIFIED to verified,
the ruling requires ALL of the following evidence:

- **Reopened step-1 gate:** owner-approved PostgreSQL home on approved
  infrastructure, named operator, database identity, backend deployment
  topology and connectivity, TLS requirements, backup retention, and a
  documented, demonstrated restore procedure.
- **Restricted credentials:** separate runtime identity with only necessary
  table privileges; migration privileges handled separately; credential
  delivery and rotation documented without exposing secrets.
- **Real PostgreSQL execution:** apply the migration to an authorized
  isolated database on the selected service/version; inspect the resulting
  schema and unique constraint; run the adapter contract suite against it.
- **Concurrency proof:** simultaneous same-email submissions return the
  same persisted metadata, create exactly one row, and do not overwrite
  consent. Test the adapter's actual transaction/isolation strategy.
- **Failure and lifecycle proof:** unavailable database, query/connection
  failure, timeouts, recovery, and pool shutdown behave correctly; HTTP
  failures preserve the exact evidenced 503 body and `no-store` header.
- **Backend integration proof:** run the real endpoint against that
  isolated PostgreSQL database and pass the complete applicable contract
  suite and backend regression checks.

Adapter verification does NOT authorize production enablement or data
migration. Those still require the outstanding authorized Replit
deployment evidence, live row-count evidence, the plan step-3 owner
decisions, and the remaining original migration gates.
