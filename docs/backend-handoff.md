# Backend integration handoff (B1 slice + B2 hosted-auth readiness)

## What was built

Minimal hosted coordination API in this repository (`src/`, Node + one small
`jose` dependency): home registration under a local-dev setup bootstrap
secret (dev) or account-bound one-time registration tickets (hosted, no
fleet secret), authenticated account-to-home membership via single-use
home-scoped join tickets, authorized discovery (members see only their
homes), home heartbeat/status coordination with server-side `online`, and
membership revocation. State is durable
in `<data-dir>/backend-state.json` (atomic writes) and survives restarts.
Full API reference: `docs/backend-api-v1.md`; machine-readable endpoint
summary: `contracts/backend-coordination-v1.json`; launch/config:
`docs/backend-launch.md`; dev secret template: `.env.example`.

Deliberate boundaries: explicit dev bearer identity OR hosted OIDC JWT
verification (B2+B4; no IdP provisioned here — provider access-token JWTs
verified via `jose` against static JWKS or fixed trusted JWKS HTTPS URL)
— never client-supplied account/user IDs as identity (rejected with `400`);
no chat/message/content endpoints or payload storage (the backend
coordinates enrollment without relaying private traffic, per the
tunnel/direct-home design); no second home scheduler (the home owns task
lifecycle). Phone login contract: `docs/account-auth-v1.md`
(`GET /v1/auth/config` public metadata + `GET /v1/account` verification;
Expo AuthSession PKCE owned by F7).

## How to integrate

1. Home (H1): register with `POST /v1/homes/register` using the setup token
   (dev) or an account-bound registration ticket (hosted — see "Hosted
   enrollment steps" below; owner membership is created automatically),
   persist the returned `homeToken`, mint join tickets with
   `POST /v1/homes/:homeId/join-tickets`, deliver ticket secrets to phones
   out of band, and heartbeat with `POST /v1/homes/:homeId/heartbeat`.
2. Phone/client: authenticate with its dev account token, join with
   `POST /v1/homes/:homeId/members/join { ticketSecret }`, then discover via
   `GET /v1/homes` and check presence via `GET /v1/homes/:homeId/status`.
   Private traffic goes directly to the home over H1's protected route —
   never through this backend in this design.
3. Pairing UX mapping: this backend's `ticketSecret` is coordination-only
   (account↔home membership). It is not H1's one-time pairing invitation
   secret for device enrollment; the two must not be conflated or logged
   together. The home must still verify the paired device credential and
   household authorization on its own API.

## H1 contract alignment (published — reconciled)

H1 has published `infra-server/contracts/home-api-v1.md` plus
`infra-server/contracts/home-api-v1.openapi.json` (markdown authoritative).
Reconciliation, exact mapping:

- Backend `homeId` (coordination key, `^[a-z0-9][a-z0-9_-]{2,63}$`, generated
  as `home_<18 lowercase hex>` when omitted) correlates with H1's
  `installation_id` (uuid, from H1 `GET /healthz` / `POST /v1/pair` /
  `GET /v1/me`). Registration accepts `installationId` verbatim; heartbeat
  may set or update it; every home read returns it. Uniqueness is not
  enforced (reinstalls mint fresh installation IDs; no delete-home endpoint
  exists). F1 resolves `(homeId, installationId)` and treats a changed
  `installationId` on a known `homeId` as reinstallation.
- `endpointHint` now carries the home's protected base URL (tunnel URL + H1
  base path; `http://127.0.0.1:7070` in dev). Still opaque here: stored and
  returned verbatim, never fetched or interpreted.
- `protocolVersion` should be `"home-api-v1"` when the home speaks H1's
  contract.
- Credential separation confirmed against the real H1 field names: backend
  `ticketId`/`ticketSecret` (account↔home membership) vs H1
  `invitation_id`/`invitation_secret` (device enrollment at the home) vs
  backend `me_home_…` home token vs H1 `device_id`+`device_secret` /
  `ht1_…` session token. The backend never sees H1 device secrets or session
  tokens; the home never sees backend account tokens. The two invitation
  systems must not be conflated or logged together.
- Private traffic stays direct (phone ↔ protected home endpoint, H1
  `Authorization: Bearer <session-token>`); the backend coordinates
  accounts/homes/membership only and relays nothing.

## Hosted enrollment steps (phone/setup, next iteration)

No IdP is provisioned by this slice; the steps below are the integration
contract for whoever provisions one (account team / setup-infra):

1. Provision an OIDC issuer + audience for the backend; publish the JWKS to
   the backend operator as static config (`ME_BACKEND_OIDC_JWKS[_FILE]`,
   issuer, audience, algorithms). No JWKS URL is ever read from tokens.
2. Phone signs in with the IdP, calls `POST /v1/homes/registration-tickets`
   with its access token, and delivers the returned `registrationTicket` to
   the home being set up (out of band, with the H1 pairing material — the
   two secrets stay separate).
3. Home (setup tooling) calls `POST /v1/homes/register` with the ticket;
   the requesting account becomes `owner` automatically. The home persists
   the returned `homeToken` and heartbeats as before.
4. Phones join via home-minted join tickets as before; discovery/status
   reads use the account's OIDC token. `GET .../status` now reports
   server-side `online` — display that rather than inferring liveness.

Dev flow compatibility is unchanged: existing dev clients/servers keep
working with `ME_BACKEND_DEV_ACCOUNTS_JSON` + setup token on loopback.

## Storage and scale limits (explicit)

Single-process JSON store (`<data-dir>/backend-state.json`, atomic
temp-file + rename). One server per data dir — concurrent writers can lose
updates (last rename wins). This is not presented as horizontally scalable;
a multi-instance deployment needs a real database with transactions, which
is out of scope for this slice.

## F1 integration lifecycle (dev flow reference; hosted equivalents noted)

```text
setup/home side (setup token + home token):
  1. Read H1 installation_id:  GET <home>/healthz  -> { installation_id }
  2. Register home:            POST /v1/homes/register
       { homeId?, installationId, endpointHint, protocolVersion: "home-api-v1" }
     -> { homeId, homeToken }              (persist homeToken server-side)
     hosted: replace the setup token with a registration ticket minted by
     the owner's account (POST /v1/homes/registration-tickets); the owner
     membership is created automatically.
  3. Mint join ticket:         POST /v1/homes/:homeId/join-tickets
     -> { ticketId, ticketSecret }         (deliver secret out of band, once)
  4. Steady state heartbeat:   POST /v1/homes/:homeId/heartbeat
       { status, endpointHint?, installationId? }   (loop; staleness = offline)

account/phone side (dev account token; hosted: OIDC access token instead):
  5. Join home:                POST /v1/homes/:homeId/members/join
       { ticketSecret }                    (ticket consumed atomically)
  6. Discover:                 GET /v1/homes               (members only)
  7. Presence:                 GET /v1/homes/:homeId/status (stale = offline)
  8. Pair device at home:      POST <home>/v1/pair          (H1 contract;
       { invitation_id, invitation_secret, installation_id } — direct to home,
       never through this backend)
  9. Private traffic:          <home>/v1/... with H1 session token (direct)

Revocation: DELETE /v1/homes/:homeId/members/:accountId (home credential or
self) removes backend access; H1 device revocation (POST
/v1/devices/:id/revoke) is separate and happens at the home.
```

Review fixes in this pass: auto-generated homeIds now always satisfy
`HOME_ID_RE` (lowercase-hex generation; regression test registers without
`homeId` 12×); dictionary/prototype-key handling uses own-property lookups
with `__proto__` rejected (`constructor`-named homes work normally;
reserved/malformed member references are rejected); the durable JSON store
is documented single-process with no production database claims.

No other worker's repository was edited. No commits or pushes were made;
all work is uncommitted in `/Users/kgensupertramp/Desktop/me/backend-server`.
