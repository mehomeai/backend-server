# Home activation v1 (home ↔ Me Backend one-time activation + recovery)

Status: implemented. Protocol `home-activation-v1` (wire) + `home-coordinator-v1`
(private credentials file). Backend is source of truth; home (H8), setup (S7),
and phone (F9) implement against this document. Existing B3
`POST /v1/homes/registration-tickets` + `POST /v1/homes/register` (account JWT
required at register time) is retained unchanged for compat. The activation
pair below is distinct: the home redeems with the ticket alone, no account
JWT ever leaves the phone.

Privacy rule (load-bearing): the cloud account can help a caller discover
*which* home record is theirs (coordinator metadata: `homeId`,
`installationId`, `endpointHint`, liveness), but it can NEVER mint, rotate,
or read HomeAPI private auth (H1 device secrets / session tokens). The
physical one-time setup invitation binds the URL; the cloud `endpointHint`
is a discovery hint only. Phone F8 MUST NOT auto-rebind device credentials
from a changed backend `endpointHint`; an endpoint change requires a fresh
local setup invitation from the trusted home. Old private-URL credentials
stay unchanged. Cloud account recovery therefore cannot capture family home
device secrets. No app-layer crypto or second server trust system is
invented here.

No brokered private chat storage, no SSH credentials, no provider secrets
anywhere in this flow. Trust boundary is TLS plus the locally-trusted pair
URL from the physical setup invitation; `installation_id` equality is
correlation only and never server authentication.

## Roles (activation flow only — separate phone↔home pairing path holds H1 device credentials)

| Side | Persistently holds | Transiently sees (verified then dropped, never logged/stored) | Never receives in this flow |
| --- | --- | --- | --- |
| Phone F9 (owner account) | Me account JWT (OIDC/dev), backend URL; H1 device credentials live in the separate local-pairing path, not this table | One-time activation JSON it minted (`ticketId`/`activationSecret`) for handoff to the operator | `homeToken` (F9 never calls activate, never receives it) |
| Home H8 / setup S7 | One-time ticket until redeem, then `homeToken` in the `0600` 7-key file | `activationSecret` in the single ticket-only POST | Me account JWT; opt-in provider keys may exist on the home outside activation and are out of scope here |
| Backend | Only sha256 verifiers (tickets + home tokens) plus membership/heartbeat metadata | Account JWT at mint (verified per B4) and `activationSecret` at redeem (timing-safe); generates `homeToken` once | Ticket secrets / homeTokens / account JWTs are never persistently stored, never logged; H1 device secrets / session tokens never reach the backend at all |

## 1. Mint: POST /v1/homes/activation-tickets (account auth)

Owner phone calls with its normal account bearer (dev token or OIDC JWT —
verified B4 path, identity derived server-side, body identity rejected
`400`).

Request:

```json
{
  "installationId": "123e4567-e89b-42d3-a456-426614174000",
  "displayName": "Cabin Home (optional, new-only)",
  "existingHomeId": "home_abc123 (optional, recovery-only)"
}
```

Rules:

- `installationId` required, printable ASCII 1–128 (H1 `installation_id`
  verbatim, e.g. uuid). Binds the ticket to that physical home.
- Omit `existingHomeId` → mode `new`. Optional `displayName` (1–100)
  stored for the to-be-created home.
- Present `existingHomeId` → mode `recovery`. Caller must currently be
  `owner` of that home (`404` if not a member to hide existence, `403` if
  member but not owner). Request `installationId` must match the home's
  stored `installationId` when set, else `403`.
- `homeId` / `accountId` / `ownerId` fields in the body are rejected `400`;
  `homeId` comes from the ticket (recovery) or is server-generated (new).
- Fixed TTL 5 minutes. Max 15 live tickets per account (`429` beyond).
  Expired (>1h past expiry) tickets are pruned; only sha256 verifiers are
  stored, secrets shown once and never logged. Ticket namespace is scoped
  and unique (`act_…`); join (`ticket_…`) and registration (`regticket_…`)
  secrets are never accepted here (conflation → `403`).

Response `201` (capability only — no `homeToken`, no other account data):

```json
{
  "ticketId": "act_…",
  "activationSecret": "<256-bit base64url, shown ONCE>",
  "installationId": "123e4567-…",
  "mode": "new | recovery",
  "homeId": "home_abc123 | null (new)",
  "expiresAt": "2026-…Z"
}
```

Display/copy for S7: F9 shows a one-time activation JSON containing
`{ backend_url, ticketId, activationSecret, installationId, mode,
homeId?, expiresAt }`. It includes the known backend URL, NEVER a provider
secret or account JWT.

## 2. Redeem: POST /v1/homes/activate (ticket ONLY, no account JWT)

Home/setup calls over HTTPS (protected transport) with NO `Authorization`
header. The ticket IS the authorization.

Request:

```json
{
  "ticketId": "act_…",
  "activationSecret": "<from mint step>",
  "installationId": "123e4567-e89b-42d3-a456-426614174000 (exact own)",
  "endpointHint": "https://home.example.test (public base URL)",
  "protocolVersion": "home-api-v1 (optional, default \"1\")"
}
```

(`ticketSecret` accepted as alias for `activationSecret`. `homeId`,
`existingHomeId`, `homeToken`, `accountId` fields rejected `400` — the
homeId comes from the ticket, never the request.)

Rules:

- Ticket must exist in the activation namespace, secret must verify
  (timing-safe), else `403`. Consumed/expired → `410`.
- `installationId` must exactly equal the ticket's bound installation,
  else `403`. Recovery additionally re-checks caller still owns the home
  and the home's stored installation still matches, else `403`.
- `endpointHint` required: public `https://` in production; plain `http://`
  accepted ONLY for loopback hosts (`127.0.0.1`, `localhost`, `::1`) for
  explicit dev/test. Anything else → `400`. The backend NEVER fetches this
  URL — stored opaquely as a discovery hint.
- `protocolVersion` 1–32 chars. Invalid shape → `400`.
- Invalid requests NEVER burn the ticket: validation runs before consume,
  so a `400`/`403` leaves the ticket usable. Only a persisted success (or
  a correctly reported `410` replay) consumes.
- Atomicity: consume + home create/rotate + membership + verifier update
  are applied in memory then persisted once. Persist failure rolls back
  every in-memory mutation (ticket un-consumed, no half home, old
  verifiers restored) and surfaces `500`.
- New: fresh server-generated `homeId` (`home_<18 lowercase hex>`),
  `installationId` from ticket, `displayName` from ticket, `endpointHint` /
  `protocolVersion` from redeem body; owner membership created for the
  minting account.
- Recovery: SAME `homeId` from the ticket; old `me_home_…` verifiers for
  that home are invalidated, a fresh `homeToken` is issued, endpointHint
  (coordinator metadata only) is updated. Owner membership preserved /
  re-asserted. HomeAPI private auth is untouched.

Response `201` (shown ONCE — persist to the private file, never to git):

```json
{
  "homeId": "home_…",
  "installationId": "123e4567-…",
  "homeToken": "me_home_…",
  "endpointHint": "https://…",
  "protocolVersion": "home-api-v1",
  "mode": "new | recovery"
}
```

## 3. Private credentials file (H8 reads, S7 writes)

Path: outside git, outside shared config, mode `0600`, e.g.
`~/.me-home/coordinator.json` (operator-chosen, secret-separated).

```json
{
  "protocol": "home-coordinator-v1",
  "backend_url": "https://backend.example.test",
  "home_id": "home_…",
  "installation_id": "123e4567-…",
  "home_token": "me_home_…",
  "endpoint_hint": "https://home.example.test",
  "protocol_version": "home-api-v1"
}
```

Exact 7 keys (schema frozen in `infra-server/contracts/home-coordination-v1.md`).

Defaults: all absent until activation succeeds (no defaults that fake a
home). H8 starts disabled without this file.

S7 flow: redeem over HTTPS with `redirect: 'error'` — credential requests NEVER follow redirects, not even to `https://` (a redirect is a failure, never retried with credentials there); send NO account JWT from the home, write the file `0600`
outside git, never log the secret, never ship it to the phone. The phone
gets coordinator discovery reads with its own account credential — never
this file.

## 4. Existing HomeToken API (exact contract the activated home uses)

Unchanged behavior, documented here so H8/S7 don't guess:

- `POST /v1/homes/:homeId/heartbeat` — home-self auth ONLY
  (`Authorization: Bearer <homeToken>` for that exact `homeId`).
  Body `{ status?: "online"|"degraded"|"offline", endpointHint?,
  installationId? }`. Account bearers → `403`; missing creds → `401`;
  wrong home's token → `403`. Updates `lastSeenAt`/`lastStatus`, optionally
  rebinds `endpointHint` / `installationId`. Returns
  `{ ok, homeId, lastSeenAt, lastStatus }`. `endpointHint` here stays
  opaque ≤500 chars (legacy compat); the `https://` strictness applies at
  activation time.
- `GET /v1/homes/:homeId/status` — member (account) or home-self.
  Returns `{ homeId, lastSeenAt, lastStatus, online, staleAfterSeconds }`.
  `online` is computed server-side (heartbeat within
  `ME_BACKEND_STALE_AFTER_SECONDS`, default 300s, bounded 30–3600s).
  Never-heartbeated / stale homes report `online:false`; clients MUST NOT
  infer liveness from `lastStatus` alone.
- Endpoint updates require the home token for the SAME home — registration
  can never overwrite a live home (`409` on duplicate `homeId` without
  burning any ticket). Auth failure returns no home data (`401` anonymous,
  `403` wrong credential, `404` non-member to hide existence).

## 5. Failure handling (unknown activate outcome)

If S7 gets a transport error / timeout after `POST …/activate` with an
unknown server outcome, it MUST NOT retry with the same ticket (replay
would correctly report `410` without revealing whether the first attempt
persisted a credential S7 never saw). Instead:

1. Phone (owner account) discovers the home record via `GET /v1/homes`
   (members-only) to confirm `homeId`.
2. Owner mints a FRESH recovery ticket
   (`POST /v1/homes/activation-tickets { installationId, existingHomeId }`).
3. Home redeems the fresh ticket once, persists the fresh `homeToken`.

NEVER recover a `homeToken` by replaying an old ticket. Rotations always
invalidate prior verifiers.

## 6. Errors

`400` validation / body identity / `homeId` smuggled into activation
bodies (never consumed); `401` missing account (mint) credential;
`403` wrong secret / wrong installation / cross-home / non-owner recovery
mint / conflated old ticket type (never consumed); `404` unknown home
(non-member view); `409` n/a here (new homeIds server-generated);
`410` expired/consumed replay (consumed); `429` per-account cap;
`500` persist failure (rolled back, ticket NOT burned).

## 7. Non-goals

No private chat/message storage or relay. No SSH credentials. No
user/provider credential resources. No app-layer crypto beyond the
one-time ticket + `me_home_…` bearer over HTTPS. No second server trust
system — the physical setup invitation binds the URL; the cloud is a
discovery hint.
