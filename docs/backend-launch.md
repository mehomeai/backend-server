# Backend launch and configuration guide (dev + hosted-auth readiness)

This service binds to loopback by default and stores coordination state on
local disk in a single-process JSON file (one server per data dir — not
horizontally scalable; see `docs/backend-handoff.md`). Two auth modes:
explicit local-dev bearer configuration, or hosted OIDC JWT verification
(B2 readiness; no IdP is provisioned here).

## Prerequisites

- Node 24.18 (`/Users/kgensupertramp/.nvm/versions/node/v24.18.0/bin/node` on
  this machine; `engines` enforces `>=24.18.0 <25`).
- One small dependency (`jose`, for OIDC verification): `npm install`.
  Everything else is Node builtins (`node:http`, `node:crypto`, `node:test`).

## Configure

Copy the example and fill in fresh secrets (never commit real secrets; `.env`
is gitignored and the hygiene check rejects tracked `.env` files):

```sh
cp .env.example .env
# dev: edit .env: set ME_BACKEND_HOME_SETUP_TOKEN and ME_BACKEND_DEV_ACCOUNTS_JSON
# hosted: set ME_BACKEND_AUTH_MODE=hosted plus the ME_BACKEND_OIDC_* variables
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `ME_BACKEND_AUTH_MODE` | auto (`hosted` if OIDC issuer set, else `dev`) | `dev` or `hosted`. |
| `ME_BACKEND_HOST` | `127.0.0.1` | Bind address. Dev mode refuses non-loopback binds at startup; hosted mode does not restrict the bind. |
| `ME_BACKEND_PORT` | `8787` | Listen port. |
| `ME_BACKEND_DATA_DIR` | `./data` | Directory holding `backend-state.json` (durable coordination state). Back it up before destructive operations. |
| `ME_BACKEND_STALE_AFTER_SECONDS` | `300` | Bounded 30–3600. Freshness window behind server-side `online` in `GET .../status`. |
| `ME_BACKEND_HOME_SETUP_TOKEN` | (required in dev, min 16 chars) | Bootstrap secret authorizing initial home registration only. Dev-only; never accepted in hosted mode. |
| `ME_BACKEND_DEV_ACCOUNTS_JSON` | (required in dev) | JSON object mapping dev bearer token → accountId, e.g. `{"dev-token-alice-…":"acct_alice"}`. Not required in hosted mode (accepted if present: transition/testing only — absent in production). |
| `ME_BACKEND_OIDC_ISSUER` | (required in hosted) | Expected `iss`, must be `https://` (loopback `http://` only with `ME_BACKEND_OIDC_ALLOW_INSECURE_ISSUER=1`, tests only). |
| `ME_BACKEND_OIDC_AUDIENCE` | (required in hosted) | Expected `aud`. |
| `ME_BACKEND_OIDC_JWKS` / `ME_BACKEND_OIDC_JWKS_FILE` | (one of static or URL required in hosted) | Static trusted JWKS (JSON object with non-empty `keys`). Never fetched, never taken from tokens. |
| `ME_BACKEND_OIDC_JWKS_URL` | (alternative to static) | Fixed trusted JWKS HTTPS URL (remote via `jose.createRemoteJWKSet`, timeout/cache/rotation). Loopback `http` only with test flag; remote `http` never allowed. Mutually exclusive with static JWKS. |
| `ME_BACKEND_OIDC_JWKS_TIMEOUT_MS` | `5000` | Bounded `1000..15000`. Remote JWKS fetch timeout. |
| `ME_BACKEND_OIDC_CLIENT_ID` | (required for login metadata) | Public mobile clientId. MUST differ from `ME_BACKEND_OIDC_AUDIENCE`. Missing → `GET /v1/auth/config` is `503 configure_not_ready` (verification still works). |
| `ME_BACKEND_OIDC_SCOPES` | `openid profile email` | Space/comma list (1–10). Minimal scope list published to phones. |
| `ME_BACKEND_OIDC_REDIRECT_URIS` | (required for login metadata) | Comma-separated exact redirect allowlist (max 10, no `*`). Missing/empty → `503`. |
| `ME_BACKEND_AUTH_APP_SCHEME` | unset | App scheme hint (e.g. `myapp`). |
| `ME_BACKEND_OIDC_EXTRA_AUDIENCES` | unset | Comma list (max 5). Provider extra-audience hint, server-controlled only. |
| `ME_BACKEND_OIDC_EXPECT_TOKEN_USE` | unset | E.g. `access`. When set, `token_use` must match (no ID-token fallback). |
| `ME_BACKEND_OIDC_ALGORITHMS` | `RS256` | Comma list; asymmetric only (`HS*`/`none` rejected). |
| `ME_BACKEND_OIDC_ALLOW_INSECURE_ISSUER` | unset | Set `1` only for loopback tests. |

The server fails fast with a clear message when required secrets are
missing or malformed. Generate tokens with, e.g.:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## Run

```sh
node src/server.mjs
# or: npm start
```

Expected output: `backend-server listening on http://127.0.0.1:8787 (data: ./data)`.

## Verify

```sh
node --test test/*.test.mjs
# or: npm test
python3 scripts/check_repository.py
```

The suite covers: anonymous/minimal health; rejected anonymous discovery;
setup-token enforcement on registration (dev); hidden existence for
non-members; rejected client-supplied account IDs; cross-home ticket/token
isolation; single-use and expiring tickets; revocation removing access;
full restart persistence (homes, memberships, consumed tickets, home
credentials, heartbeat status); hosted OIDC deny table (wrong
signature/issuer/audience, expired, missing exp/sub, `none` alg, unknown
key, garbage); account-bound registration tickets (replay/cross-account/
cross-installation/duplicate rejected, owner created, failed 409 burns
nothing); home-token-only endpoint updates; server-side stale availability;
per-account/per-home ticket caps (429) with long-expired pruning; dev
loopback-bind refusal and hosted config validation (incl. dev-map rejection
and loopback-only insecure issuer); account-auth-v1 login metadata
(dev honest / hosted ready / 503 when client metadata missing /
clientId≠audience / no secret leakage / remote-JWKS rotation /
token_use + `jku` denial / `GET /v1/account` verification). Full login
contract: `docs/account-auth-v1.md`.

## Operate (dev)

- State file: `<ME_BACKEND_DATA_DIR>/backend-state.json`, written atomically
  (temp file + rename). Restart the process to reload; no migration exists
  yet (`version: 1`).
- Logs: startup line only plus Node errors. Secrets (account/home tokens,
  ticket secrets, setup token) are never logged; only IDs and ticket IDs
  appear in error paths where needed.
- Reset dev state: stop the server and delete the data dir
  (`rm -rf ./data`). This is a dev-only operation; there is no production
  reset procedure in this slice.
- Redaction: `endpointHint` values are stored verbatim as opaque H1-owned
  placeholders; do not paste real credentials into them.
