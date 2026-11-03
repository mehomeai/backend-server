# Account auth v1 (phone login metadata + verification handoff)

Status: implemented. Protocol `account-auth-v1`. This is the contract the
phone worker (F7) implements against — backend is the source of truth for
metadata shape, verification rules, and errors.

Non-goals (explicit): the backend does NOT implement passwords, does NOT
proxy provider credentials, and does NOT mint or refresh provider tokens.
The phone performs PKCE directly against the trusted IdP with a maintained
SDK (e.g. Expo `expo-auth-session`). The backend only (a) publishes public
login metadata and (b) verifies the provider JWT access-token the phone
presents. No chat payload storage or relay.

## Endpoints

### `GET /v1/auth/config` — public, no auth

Returns how a phone must log in. No secrets are ever exposed (no client
secrets, no token maps, no JWKS public/private keys).

Dev mode (`authMode=dev`):

```json
{
  "protocol": "account-auth-v1",
  "authMode": "dev",
  "devOnly": true,
  "oauthConfigured": false,
  "message": "Local-dev identity only. Sign in with a dev account token; no OAuth provider is configured and no browser login applies."
}
```

Hosted mode, ready (`200`):

```json
{
  "protocol": "account-auth-v1",
  "authMode": "hosted",
  "issuer": "https://issuer.example.test",
  "audience": "me-backend-api",
  "clientId": "me-mobile-public-client",
  "scopes": ["openid", "profile", "email"],
  "redirectUris": ["myapp://auth/callback"],
  "appScheme": "myapp",
  "extraAudiences": ["extra-api-if-needed"],
  "expectedTokenUse": "access"
}
```

| Field | Meaning |
| --- | --- |
| `issuer` | Trusted HTTPS issuer. The backend verifies `iss` exactly. Loopback `http://` only in explicit test mode, never production. |
| `audience` | API audience. The backend verifies `aud` contains this value. Provider JWT **access-tokens** are required with `aud` = this API audience. |
| `clientId` | Public mobile client ID (no secret). MUST differ from `audience` so an ID token can never pass as an API access token. |
| `scopes` | Minimal scope list to request (default `openid profile email`). |
| `redirectUris` | Registered exact redirect allowlist. The phone MUST use one of these verbatim as the AuthSession redirect; arbitrary user-supplied redirects are never accepted. |
| `appScheme` | Optional app scheme hint (e.g. `myapp`) matching the custom-scheme redirect. |
| `extraAudiences` | Optional, only when the provider needs an extra `audience`/`resource` param. Controlled server config, never a phone-supplied value. |
| `expectedTokenUse` | Optional, e.g. `access`. When set, the backend rejects tokens whose `token_use` differs (no ID-token fallback). |

Hosted mode, metadata incomplete (`503`):

```json
{
  "protocol": "account-auth-v1",
  "authMode": "hosted",
  "error": "configure_not_ready",
  "message": "Hosted auth is verifying tokens, but public login metadata is not configured ...",
  "issuer": "https://issuer.example.test",
  "audience": "me-backend-api"
}
```

Returned when `ME_BACKEND_OIDC_CLIENT_ID` or
`ME_BACKEND_OIDC_REDIRECT_URIS` is missing. The operator must set them;
the backend never fakes a provider. Token verification itself still works
— only the public metadata is `503`.

Errors: `503 configure_not_ready` (above). No `401` here (public route).

### `GET /v1/account` — authenticated

Verifies the presented bearer credential with the current `jose` verifier
and returns the stable server-derived accountId. Never trusts client body
identity (there is no body contract; identity always comes from the
credential).

Dev: `Authorization: Bearer <dev-account-token>` → `200 { protocol,
authMode: "dev", accountId }`.

Hosted: `Authorization: Bearer <provider JWT access-token>` →

```json
{
  "protocol": "account-auth-v1",
  "authMode": "hosted",
  "accountId": "acct_<32 hex>",
  "issuer": "https://issuer.example.test",
  "claims": { "email": "a@example.test", "name": "A", "preferred_username": "a" }
}
```

- `accountId` = `acct_<sha256("oidc-v1" || iss || sub)[0:32 hex]>`, stable
  across restarts, stateless.
- `claims` is minimal and only present when the verified payload carries
  short-string `email`/`name`/`preferred_username` (+ boolean
  `email_verified`). Absent otherwise — callers MUST NOT require it.
- An invalid JWT (wrong signature/issuer/audience, expired, missing
  `exp`/`sub`, `alg=none`, unknown `kid`, attacker `jku`/`x5u`, wrong
  `token_use`) is NOT an account login: `401 { error: "Account
  authorization required." }`. Same `401` for missing/garbage tokens.

## Verification rules (backend)

- Maintained `jose` only. Algorithms: asymmetric allowlist (`RS*/PS*/ES*/EdDSA`);
  `HS*`/`none` rejected.
- Key set: EITHER static JWKS (`ME_BACKEND_OIDC_JWKS[_FILE]`) OR fixed
  trusted JWKS HTTPS URL (`ME_BACKEND_OIDC_JWKS_URL`) via
  `jose.createRemoteJWKSet` with bounded fetch timeout (default 5s,
  `1000..15000` ms), 2s cooldown, 10-min cache — rotation-safe. Tests
  retain the static path; remote is opt-in server config.
- No token-derived key URLs: `jku`/`x5u`/`jwk` headers are never honored;
  keys come only from server config. No phone-supplied URL is ever fetched.
- `clockTolerance: 30s`; required claims `exp`, `sub`; `sub` non-empty ≤256 chars.
- `aud` MUST be the API audience (not the clientId). `clientId !== audience`
  is enforced at startup.
- Optional `ME_BACKEND_OIDC_EXPECT_TOKEN_USE` (e.g. `access`): when set,
  only tokens with matching `token_use` verify. ID tokens without it are
  rejected — there is no ID-token fallback.

## Phone flow contract (F7 implements from this section)

Use a maintained SDK (Expo `expo-auth-session` `AuthRequest` with PKCE,
`useAutoDiscovery` against `issuer` or the configured endpoints). Do NOT
hand-roll the code verifier/challenge, do NOT embed a client secret in the
app (public client only), and do NOT send the authorization code to the
backend — exchange it directly with the IdP.

```
1. GET <backend>/v1/auth/config (no auth)
   - devOnly → dev flow: paste/attach the dev account token, skip OAuth.
   - 503 configure_not_ready → surface "sign-in unavailable, operator
     action needed"; do not guess a provider or fallback to dev.
   - 200 hosted → continue with issuer/clientId/scopes/redirectUris.
2. Login: AuthSession with PKCE
   - clientId from config; scopes from config; redirect = first
     config.redirectUris entry that matches this app build (exact match).
   - extra params: include `audience=<config.audience>` (plus any
     config.extraAudiences as the provider documents) so the IdP returns
     a JWT access-token with aud = this API. Requesting only an ID token
     will fail verification.
3. Callback: SDK exchanges `code` + `code_verifier` at the IdP token
   endpoint directly (no backend involvement, no secret).
4. Verify: GET <backend>/v1/account with
   `Authorization: Bearer <IdP access_token>`.
   - 200 → persist { accountId, access_token, refresh_token? (IdP-issued,
     if any) } in SecureStore; use access_token as the backend bearer.
   - 401 → NOT logged in. Show "sign-in failed", discard the token, do
     not retry silently.
5. Refresh: use the IdP refresh flow (SDK `refreshAsync` or equivalent)
   to obtain a new access-token, then re-verify via GET /v1/account.
   The backend never sees the refresh_token and never proxies refresh.
```

SecureStore guidance: store tokens in `expo-secure-store` (or platform
equivalent), keyed per accountId; clear on sign-out and on repeated `401`.
Never log tokens, codes, or verifiers; never put tokens in URLs after the
callback.

Backend password/proxy statement: this backend has no password database
and no `/token` proxy. Any password or code-to-token proxying belongs to
the IdP, not here. If a provider requires a confidential client, that flow
is out of scope for this mobile public-client contract.

## Configuration (operator)

| Variable | Meaning |
| --- | --- |
| `ME_BACKEND_OIDC_ISSUER` | Trusted `iss`, `https://` (loopback `http` only with `ALLOW_INSECURE=1`, tests). |
| `ME_BACKEND_OIDC_AUDIENCE` | API audience verified on `aud`. MUST differ from clientId. |
| `ME_BACKEND_OIDC_JWKS` / `_FILE` | Static trusted JWKS (one of static or URL required). |
| `ME_BACKEND_OIDC_JWKS_URL` | Fixed trusted JWKS HTTPS URL (alternative to static). Loopback `http` only with test flag; remote `http` never allowed even with override. |
| `ME_BACKEND_OIDC_JWKS_TIMEOUT_MS` | Remote fetch timeout, `1000..15000`, default `5000`. |
| `ME_BACKEND_OIDC_CLIENT_ID` | Public mobile clientId. Missing → `/v1/auth/config` is `503`, verification still works. |
| `ME_BACKEND_OIDC_SCOPES` | Space/comma list, default `openid profile email`. |
| `ME_BACKEND_OIDC_REDIRECT_URIS` | Comma-separated exact allowlist (max 10, no `*`, no duplicates). Missing/empty → `503`. |
| `ME_BACKEND_AUTH_APP_SCHEME` | App scheme hint, e.g. `mehome`. |
| `ME_BACKEND_OIDC_EXTRA_AUDIENCES` | Comma list (max 5), provider extra audience hint. |
| `ME_BACKEND_OIDC_EXPECT_TOKEN_USE` | e.g. `access`. When set, `token_use` must match. |
| `ME_BACKEND_OIDC_ALGORITHMS` | Asymmetric allowlist, default `RS256`. |
| `ME_BACKEND_OIDC_ALLOW_INSECURE_ISSUER` | `1` only for loopback tests. |

Do NOT set vendor or app credentials in the repo (`.env.example` keeps
placeholders). Do NOT configure `ME_BACKEND_DEV_ACCOUNTS_JSON` in hosted
mode (rejected loudly).

## Known parked checks

Provider-credential provisioning and real-IdP user-login E2E remain parked
(no IdP is provisioned by this repo; `docs/final-validation.md` gates
manual review). What IS real here: `jose` verification, JWKS rotation via
ephemeral fixtures, account-denial table, and the metadata contract above.
