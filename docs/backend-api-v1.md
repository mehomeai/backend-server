# Backend coordination API v1 (backend-owned surface only)

Status: implemented slice for local development, plus hosted-auth readiness
(B2). This document describes only the endpoints this repository owns. The
home's private paired-device API is owned by H1:
`infra-server/contracts/home-api-v1.md` plus
`infra-server/contracts/home-api-v1.openapi.json` (markdown authoritative).
This service does not define home device, session, conversation, or message
semantics.

## Auth modes

| Mode | Account identity | Registration auth | Bind restriction |
| --- | --- | --- | --- |
| `dev` (explicit local dev) | `ME_BACKEND_DEV_ACCOUNTS_JSON` bearer tokens (loopback binds only; wider binds refused at startup) | Fleet `X-Me-Setup-Token` (explicit dev only) | Loopback-only enforced |
| `hosted` | Real OIDC JWTs (`jose`), verified against configured issuer/audience/JWKS and allowed asymmetric algorithms; identity = `acct_<sha256(iss,sub)>` derived server-side | Account-bound one-time registration ticket (no fleet secret accepted) | No bind restriction from auth |

Mode is `ME_BACKEND_AUTH_MODE` (`dev`|`hosted`), or auto: hosted when
`ME_BACKEND_OIDC_ISSUER` is set, dev otherwise. Hosted mode does NOT require
`ME_BACKEND_DEV_ACCOUNTS_JSON` (accepted if present: transition/testing
only — absent in production). In both modes identity comes from the
presented credential; `accountId`/`userId` request fields are rejected
(`400`). JWT validation covers signature, `exp` (30s clock tolerance),
issuer, audience, and non-empty `sub`; allowed algorithms exclude
symmetric/`none`; optional `token_use` is enforced when
`ME_BACKEND_OIDC_EXPECT_TOKEN_USE` is set (no ID-token fallback). Key set
is static trusted JWKS or a fixed trusted server JWKS HTTPS URL (remote via
maintained `jose.createRemoteJWKSet` with timeout/cache/rotation); no JWKS
URLs are ever taken from tokens or phone input — fixed server config only.
Public login metadata and verification: `GET /v1/auth/config` +
`GET /v1/account` under protocol `account-auth-v1`; full contract:
`docs/account-auth-v1.md`.

## Identity mapping (backend homeId ↔ H1 installation_id)

| Side | Field | Format | Authority |
| --- | --- | --- | --- |
| Backend | `homeId` | `^[a-z0-9][a-z0-9_-]{2,63}$`; chosen by the registering home or generated as `home_<18 lowercase hex>` when omitted | This backend (coordination key) |
| H1 home | `installation_id` | uuid per H1's contract (`GET /healthz`, `POST /v1/pair`, `GET /v1/me`) | The home itself |

Correlation rule: registration accepts an optional `installationId` stored
verbatim and returned on every home read; heartbeat may set or update it
(useful when the setup tool registers before the home knows its
installation identity). `installationId` uniqueness is deliberately NOT
enforced — a reinstalled home gets a fresh `installation_id` and there is no
delete-home endpoint, so a uniqueness constraint would permanently block
re-registration. F1 resolves a home by `(homeId, installationId)` pair and
treats a changed `installationId` on a known `homeId` as reinstallation.
`endpointHint` carries the home's protected base URL (tunnel URL + H1 base
path, e.g. `http://127.0.0.1:7070` in dev). It is opaque here: stored and
returned verbatim, never fetched or interpreted as a route.

Credential separation (never interchangeable):

| Credential | Scope | Backend field | H1 field |
| --- | --- | --- | --- |
| Backend registration ticket | Authorizes ONE home registration for the bound account (+ optional installation); consumed atomically | `registrationTicket` / `registrationTicketId` | — |
| Backend join ticket | Binds an account to a home (membership) | `ticketId` / `ticketSecret` | — |
| H1 pairing invitation | Enrolls a device at the home | — | `invitation_id` / `invitation_secret` |
| Backend home token | Home authenticates to the backend | `me_home_…` bearer | — |
| H1 device credential/session | Device authenticates to the home | — | `device_id` + `device_secret` / `ht1_…` |

The backend never sees H1 device secrets or session tokens; the home never
sees backend account tokens. Registration tickets and H1 pairing
invitations are distinct single-use secrets for different sides of trust —
a phone needs BOTH, delivered separately, to go from "unknown" to "paired
member": the registration ticket enrolls the home under the owner's
account, the H1 invitation enrolls the phone's device at that home.

## Legitimate hosted enrollment workflow (exact)

Precondition: backend runs `authMode=hosted` with a configured IdP
(issuer/audience/static JWKS). No fleet setup secret exists in this mode.

1. Owner signs in with the IdP, obtains an access JWT.
2. Owner calls `POST /v1/homes/registration-tickets` with that JWT
   (optional `installationId` when the home already knows its H1 identity).
   Receives `{ ticketId, registrationTicket }` — shown once.
3. The ticket is conveyed to the home being set up (installer media, local
   operator entry — never baked into images or logs).
4. Home calls `POST /v1/homes/register` with `{ registrationTicket,
   registrationTicketId?, homeId?, installationId?, ... }`. No bearer
   account token is needed on this call: the ticket IS the account-bound
   authorization. On success the home receives `{ homeId, homeToken,
   membership: { role: "owner" } }` and persists `homeToken` server-side.
5. Any other use fails closed: unknown/consumed/expired ticket → `403`/`410`;
   ticket bound to account A used with account B's JWT → `403`; ticket bound
   to installation X presented for Y → `403`; re-registering an existing
   `homeId` → `409` without consuming the ticket (validate before consume),
   so the ticket remains usable for a different `homeId`.
6. From here the dev lifecycle applies unchanged with OIDC bearers instead
   of dev tokens: home mints join tickets, phones join, discovery/status
   follow. Endpoint changes (`endpointHint`, `installationId`) require the
   home token via heartbeat — registration can never overwrite a live home.

Base URL (loopback dev): `http://127.0.0.1:8787`

## Auth

| Caller | Header | Identity source |
| --- | --- | --- |
| Account (phone/user) | `Authorization: Bearer <dev-account-token>` (dev) or `<OIDC JWT>` (hosted) | Dev: server-side map token → accountId. Hosted: verified issuer+subject → `acct_<sha256>` (dev tokens never honored) |
| Home service | `Authorization: Bearer <home-token>` | Server-side sha256 verifier → homeId (token issued once at registration) |
| Home registration | `X-Me-Setup-Token` (dev only) or `{ registrationTicket }` body (hosted) | Dev: `ME_BACKEND_HOME_SETUP_TOKEN`. Hosted: consumed account-bound ticket |

Rules: unknown/missing credentials → `401`; valid credential without
permission → `403`, or `404` where existence itself must stay hidden
(account non-member reads). Request bodies that contain `accountId`,
`userId`, `account_id`, `user_id`, or `ownerId` are rejected with `400` —
identity always comes from the presented credential.

## Endpoints

- `GET /healthz` — anonymous. `{ ok, service, version }`. No sensitive data.
- `GET /v1/auth/config` — anonymous public login metadata (protocol
  `account-auth-v1`). Dev: honest dev-only payload, no OAuth. Hosted ready:
  `{ issuer, audience, clientId, scopes, redirectUris, appScheme?,
  extraAudiences?, expectedTokenUse? }` (public values only — never secrets,
  JWKS, or token maps). Hosted with missing `clientId`/redirect allowlist →
  `503 { error: "configure_not_ready" }`, never a faked provider. Full
  shape/errors/phone PKCE flow: `docs/account-auth-v1.md`.
- `GET /v1/account` — account auth. Verifies the bearer with the current
  `jose` verifier and returns `{ protocol, authMode, accountId, issuer?,
  claims? }` (`claims` minimal display subset when verified). Invalid JWT →
  `401` (not an account login); never trusts body identity.
- `POST /v1/homes/register` — dev: setup-token auth (explicit dev only).
  Hosted: account auth + body `{ registrationTicket, registrationTicketId? }`;
  the ticket is atomically consumed, the requesting account becomes `owner`,
  and a ticket minted for account A (or installation X) can never register
  for B (or Y) — mismatch → `403`, consumed/expired → `410`.
  Body otherwise: `{ homeId?, installationId?, displayName?, endpointHint?,
  protocolVersion? }`.
  `homeId` matches `^[a-z0-9][a-z0-9_-]{2,63}$` and `__proto__` is rejected;
  when omitted the server generates `home_<18 lowercase hex>`, which always
  satisfies the pattern. `installationId` is printable ASCII, max 128 chars
  (H1's uuid fits). `endpointHint` is a string, max 500 chars (the home's
  protected base URL; opaque, never fetched).
  `protocolVersion` should be `"home-api-v1"` when the home speaks H1's
  contract. Duplicate `homeId` → `409` — registration is create-only, so a
  re-register can never overwrite a live home; endpoint changes require the
  existing home token via heartbeat. Returns `201` with
  `{ homeId, installationId, homeToken, membership, createdAt }`;
  `homeToken` is shown once.
- `POST /v1/homes/registration-tickets` — account auth. Mints a single-use,
  short-lived ticket (TTL 60–1800s, default 300s) binding the caller's own
  identity (+ optional `installationId`). Returns `201` with
  `{ ticketId, registrationTicket, accountId, installationId, expiresAt }`;
  the secret is shown once (only a sha256 verifier is stored, never logged).
- `GET /v1/homes` — account auth. Authorized discovery: only homes the
  caller belongs to. `{ homes: [...] }`.
- `GET /v1/homes/:homeId` — account member or the home itself. Home reads
  include `installationId`. Non-members get `404`; another home's credential
  gets `403`.
- `POST /v1/homes/:homeId/heartbeat` — home-self auth only. Body
  `{ status?: "online"|"degraded"|"offline", endpointHint?, installationId? }`.
  Updates `lastSeenAt`/`lastStatus` and optionally the endpoint/identity
  binding. Returns `{ ok, homeId, lastSeenAt, lastStatus }`.
- `GET /v1/homes/:homeId/status` — member or home self. `{ homeId,
  lastSeenAt, lastStatus, online, staleAfterSeconds }`. `online` is computed
  server-side (heartbeat within `ME_BACKEND_STALE_AFTER_SECONDS`, default
  300s, bounded 30–3600s). Clients treat stale/absent heartbeats as
  offline; the backend never claims liveness it has not observed.
- `POST /v1/homes/:homeId/join-tickets` — home-self auth only. Body
  `{ ttlSeconds? (2–86400, default 900), label? }`. Returns `201` with
  `{ ticketId, ticketSecret, homeId, expiresAt }`; the secret is shown once
  (only a sha256 verifier is stored, never logged).
- `POST /v1/homes/:homeId/members/join` — account auth + body
  `{ ticketSecret, ticketId? }`. The derived accountId (from the bearer
  token) is bound to the ticket's home; the ticket is atomically consumed.
  Invalid ticket for this home → `403`; consumed/expired → `410`; already a
  member → `409`. First member becomes `owner`, later members `member`.
- `GET /v1/homes/:homeId/members` — member or home self. `{ homeId, members:
  [{ accountId, role, joinedAt }] }` ordered by join time.
- `DELETE /v1/homes/:homeId/members/:accountId` — home self (any member) or
  self-removal. Removes the membership; if the owner is removed, the
  earliest-joined remaining member is promoted. After removal the account
  loses all access (discovery returns `[]`, direct reads return `404`).
  Reserved member references (`__proto__`) and malformed percent-encoding
  are rejected (`404` / `400`); they never resolve to a membership.

## Storage notes

State lives in `<data-dir>/backend-state.json`, written atomically
(temp file + rename). Single-process only: run one server per data dir;
concurrent writers can lose updates (last rename wins). No production
database concurrency is claimed. All externally-keyed record reads use
own-property lookups and `__proto__` is rejected as a key, so
prototype-named IDs (e.g. `constructor`) behave as ordinary records.

## Explicit non-goals (not implemented, no endpoints)

- No chat/conversation/message/task/content endpoints; no private payload
  storage or relay. Pairing coordination metadata (membership, tickets,
  heartbeats) is the only persisted coordination state.
- No home task scheduler, worker, or retry/dispatch authority. The home owns
  task lifecycle; this service keeps no copy of it.
- No production OAuth or provider account impersonation. `config.mjs`
  documents the local-dev identity model and fails fast without explicit
  secrets.

## Errors

JSON `{ error }` with `400` (validation/identity field), `401`, `403`,
`404`, `409`, `410` (ticket gone), `413`, `415`, `405` (via `404` for
unknown routes), `500` (no stack/secret leakage).
