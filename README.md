# backend-server

Backend services and APIs for Me Home AI.

Part of [Me Home AI](https://github.com/mehomeai), a privacy-first home agentic system.
Learn about the vision at [Me — Your intelligence. Yours.](https://mehomeai.replit.app/me/).

## Status

Implemented locally (not shipped; all changes uncommitted). Coordination
service (loopback dev + hosted-auth readiness): home registration/discovery,
account-to-home membership, one-time registration/join/activation tickets
(B7 ticket-only activate, 7-key `0600` file, `redirect: 'error'` never
followed), heartbeats with server-side `online`, and revocation against a
single-process JSON store. Household data and execution stay on the home
host; the hosted backend coordinates accounts/home access only — no private
chat relay or payload storage. Verified (final): `node --test
test/*.test.mjs` — **39 pass / 0 fail**. Overall cross-repo evidence:
`docs/final-validation.md` (overall report with the full result table).
This is not a provisioned IdP, tunnel/edge, or production install — see the
manual gates there. Phone login handoff: `docs/account-auth-v1.md`
(`GET /v1/auth/config` + `GET /v1/account`).

## Scope

Application APIs, authentication, authorization, and service integration.

## Coordination API (dev slice + hosted-auth readiness)

Minimal hosted coordination for home registration/discovery and
authenticated account-to-home membership: `docs/backend-api-v1.md`
(reference), `contracts/backend-coordination-v1.json` (machine-readable
endpoint summary), `docs/backend-launch.md` (run/configure), and
`docs/backend-handoff.md` (integration and H1 dependency). Auth modes:
explicit local-dev bearer identity (loopback-only), or hosted OIDC JWT
verification via `jose` against static trusted issuer/audience/JWKS (B2;
no IdP provisioned). No chat payload storage or relay.

## Contributing

Start with the [contribution guide](https://github.com/mehomeai/.github/blob/main/CONTRIBUTING.md),
[code of conduct](https://github.com/mehomeai/.github/blob/main/CODE_OF_CONDUCT.md), and
[governance](https://github.com/mehomeai/.github/blob/main/GOVERNANCE.md).
Discuss substantial changes in an issue before implementing them. Pull requests
should include relevant tests and documentation once application code exists.

For questions and cross-project planning, use [community discussions](https://github.com/mehomeai/.github/discussions).
Report vulnerabilities privately through this repository's **Security → Report a vulnerability**;
see the [security policy](https://github.com/mehomeai/.github/blob/main/SECURITY.md).

## License

[Apache License 2.0](LICENSE). Third-party code, model weights, and datasets may
have their own terms and must be reviewed before inclusion.
