// Minimal hosted coordination API (B1 slice).
//
// What this service does:
//   - Home registration with a local-dev setup bootstrap token.
//   - Authenticated account-to-home membership via single-use join tickets
//     minted by the home credential holder (pairing coordination only).
//   - Authorized home discovery (accounts only see homes they belong to).
//   - Home heartbeat / status coordination and membership revocation.
//
// What this service deliberately does NOT do:
//   - No production OAuth, no impersonation of provider accounts.
//   - Never accepts a client-supplied account/user ID as identity; identity
//     always comes from the presented bearer credential mapped server-side.
//   - No private chat/message/content endpoints and no chat payload storage.
//   - No home task scheduler or second job manager (delivery plan requires
//     one durable authority per transition; the home owns task lifecycle).
//   - No definition of the home's private paired-device API. That contract is
//     owned by H1 (infra-server/contracts/home-api-v1.md, now published).
//     This service stores H1's installation_id verbatim for correlation and
//     carries endpointHint (the home's protected base URL) opaquely: never
//     fetched, never interpreted as a route. Backend join tickets bind an
//     account to a home; H1 pairing invitations enroll a device at the home;
//     the two credentials are never interchangeable (see docs/backend-handoff.md).
//   - Private home traffic stays direct (phone <-> protected home endpoint).
//     The backend coordinates accounts/homes/membership only.
//
// Auth model (B1 dev + B2 hosted):
//   - Account requests:  Authorization: Bearer <dev-account-token> (dev mode)
//     or Bearer <OIDC JWT> verified against the server-configured
//     issuer/audience/JWKS (hosted mode). Identity is always derived
//     server-side (dev map lookup, or verified issuer+subject); never from
//     request bodies.
//   - Home requests:      Authorization: Bearer <home-token> (issued once at
//                         registration; only a sha256 verifier is stored)
//   - Home registration:  dev mode: X-Me-Setup-Token (fleet bootstrap secret,
//                         explicit dev only). hosted mode: account-authorized
//                         one-time registration ticket binding the requesting
//                         identity + installation, atomically consumed.
//   - Join tickets: single-use, short-lived, home-scoped secrets. Only a
//     sha256 verifier is stored; the secret itself is shown once at mint time
//     and never logged.

import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { loadConfig, assertSafeBind } from "./config.mjs";
import { createOidcVerifier } from "./oidc.mjs";
import { loadState, saveState } from "./store.mjs";
import {
  parseCorsAllowedOrigins,
  corsMatchOrigin,
  handleCorsPreflight,
  applyCorsHeaders,
} from "./cors.mjs";

const HOME_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
// H1's installation identity is opaque to this service (a uuid in H1's
// contract). Stored verbatim so F1 can correlate backend home records with
// H1's /healthz installation_id. Printable ASCII, bounded length.
const INSTALLATION_ID_RE = /^[\x20-\x7E]{1,128}$/;
const MAX_BODY_BYTES = 64 * 1024;

// Own-property-safe record access. State records are plain objects parsed
// from JSON (Object.prototype in the chain), and homeId / accountId /
// targetId values are externally influenced, so bare `record[key]` reads
// can return inherited properties (e.g. "constructor"). All reads of
// externally-keyed records go through getOwn; "__proto__" is rejected as a
// key everywhere because assignment would hit the prototype setter.
function getOwn(obj, key) {
  if (obj === null || typeof obj !== "object") return undefined;
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function isSafeKey(key) {
  return typeof key === "string" && key !== "__proto__";
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqualText(a, b) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function newToken(prefix, bytes = 32) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

// Generated homeIds must satisfy HOME_ID_RE (lowercase only). base64url
// output contains uppercase, so generation uses lowercase hex instead.
function newHomeId() {
  return `home_${randomBytes(9).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj) + "\n";
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? match[1].trim() : null;
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Body too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text) return {};
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json."), { status: 415 });
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Body must be a JSON object.");
    }
    return parsed;
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
}

async function resolveAccountId(req, config, oidcVerifier) {
  const token = bearerToken(req);
  if (!token) return null;
  // Fail closed: hosted mode never honors static dev tokens, even if a
  // direct config object carries a devAccounts map by mistake. Dev tokens
  // only resolve in explicit dev mode.
  const authMode = config.authMode ?? "dev";
  if (authMode !== "hosted") {
    const devHit = config.devAccounts?.get(token);
    if (devHit) return devHit;
  }
  if (oidcVerifier) {
    return (await oidcVerifier.verifyAccountToken(token)) ?? null;
  }
  return null;
}

function resolveHomeId(req, state) {
  const token = bearerToken(req);
  if (!token) return null;
  return getOwn(state.homeTokenVerifiers, sha256Hex(token)) ?? null;
}

// Identity fields must never be accepted from the request body as identity.
// Any endpoint that binds identity derives it from the presented credential.
const FORBIDDEN_IDENTITY_FIELDS = ["accountId", "userId", "account_id", "user_id", "ownerId"];

function rejectIdentityFields(body) {
  for (const field of FORBIDDEN_IDENTITY_FIELDS) {
    if (Object.hasOwn(body, field)) {
      throw Object.assign(
        new Error(`Field '${field}' is not accepted; identity comes from the presented credential.`),
        { status: 400 }
      );
    }
  }
}

function memberRole(state, homeId, accountId) {
  const members = getOwn(state.members, homeId);
  return getOwn(members, accountId)?.role ?? null;
}

// Bounded ticket storage: tickets are single-use and short-lived, but an
// authenticated caller could otherwise mint without limit. Minting prunes
// tickets expired over an hour ago and refuses beyond a per-scope cap on
// live tickets (429). Consumed tickets are kept for replay semantics
// (identified replay reports 410 gone rather than 403 invalid).
const TICKET_PRUNE_AFTER_MS = 60 * 60 * 1000;
const MAX_ACTIVE_JOIN_TICKETS_PER_HOME = 100;
const MAX_ACTIVE_REG_TICKETS_PER_ACCOUNT = 20;
// Home activation v1 (docs/home-activation-v1.md): one-time account-bound
// capability that lets a home self-enroll WITHOUT ever seeing a reusable
// account credential. Distinct ticket namespace from join/registration
// tickets; fixed short TTL; tight per-account cap.
const MAX_ACTIVE_ACTIVATION_TICKETS_PER_ACCOUNT = 15;
const ACTIVATION_TTL_MS = 5 * 60 * 1000;

function isLoopbackHostname(hostname) {
  const h = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

// Activation endpointHint policy: production must be public https://.
// Plain http:// is accepted ONLY for loopback hosts (explicit dev/test).
// The backend never fetches this URL; it is stored opaquely as a discovery
// hint. This validator applies ONLY to the activation path; legacy
// register/heartbeat endpointHint stays opaque (max 500 chars) for compat.
export function isAllowedActivationEndpointHint(hint) {
  if (typeof hint !== "string" || hint.length === 0 || hint.length > 500) return false;
  let url;
  try {
    url = new URL(hint);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopbackHostname(url.hostname);
  return false;
}

export function pruneTickets(collection, nowMs = Date.now()) {
  if (collection === null || typeof collection !== "object") return 0;
  let pruned = 0;
  for (const id of Object.keys(collection)) {
    if (!isSafeKey(id)) {
      delete collection[id];
      pruned++;
      continue;
    }
    const ticket = collection[id];
    if (!ticket || typeof ticket !== "object") {
      delete collection[id];
      pruned++;
      continue;
    }
    if (Date.parse(ticket.expiresAt) <= nowMs - TICKET_PRUNE_AFTER_MS) {
      delete collection[id];
      pruned++;
    }
  }
  return pruned;
}

function countActiveTickets(collection, predicate, nowMs = Date.now()) {
  let count = 0;
  for (const ticket of Object.values(collection ?? {})) {
    if (ticket && typeof ticket === "object" && !ticket.consumedAt &&
        Date.parse(ticket.expiresAt) > nowMs && predicate(ticket)) {
      count++;
    }
  }
  return count;
}

// Atomically consume an account-bound registration ticket. The ticket binds
// the requesting identity (and optionally one installation); a ticket minted
// for account A can never register a home for account B, and a consumed or
// expired ticket can never register a second home.
function consumeRegistrationTicket(state, { secret, ticketId, accountId, installationId }) {
  const candidates = Object.values(state.regTickets ?? {});
  const ticket = ticketId
    ? candidates.find((t) => t.ticketId === ticketId) ?? null
    : candidates.find((t) => !t.consumedAt && safeEqualText(sha256Hex(secret), t.verifier)) ?? null;
  if (ticket && ticketId && !safeEqualText(sha256Hex(secret), ticket.verifier)) {
    return { ok: false, status: 403, error: "Invalid registration ticket." };
  }
  if (!ticket) {
    return { ok: false, status: 403, error: "Invalid registration ticket." };
  }
  if (ticket.consumedAt || Date.parse(ticket.expiresAt) <= Date.now()) {
    return { ok: false, status: 410, error: "Registration ticket is expired or already used." };
  }
  if (ticket.accountId !== accountId) {
    return { ok: false, status: 403, error: "Registration ticket is bound to a different account." };
  }
  if (ticket.installationId && installationId !== undefined && ticket.installationId !== installationId) {
    return { ok: false, status: 403, error: "Registration ticket is bound to a different installation." };
  }
  ticket.consumedAt = nowIso();
  return { ok: true, installationId: ticket.installationId };
}

function publicHome(state, home, accountId = null) {
  const members = getOwn(state.members, home.homeId) ?? {};
  return {
    homeId: home.homeId,
    installationId: home.installationId ?? null,
    displayName: home.displayName,
    endpointHint: home.endpointHint,
    protocolVersion: home.protocolVersion,
    membershipRole: accountId ? (getOwn(members, accountId)?.role ?? null) : null,
    memberCount: Object.keys(members).length,
    lastSeenAt: home.lastSeenAt,
    lastStatus: home.lastStatus,
    createdAt: home.createdAt,
    updatedAt: home.updatedAt,
  };
}

// Public login metadata (protocol account-auth-v1). Dev mode is honest:
// no OAuth, no issuer, no secrets. Hosted mode exposes only the trusted
// server-configured public values (HTTPS issuer, API audience, public
// mobile clientId, scopes, exact redirect allowlist, app scheme, optional
// extra audience hint). Never exposes JWKS, secrets, or token maps. When
// hosted client metadata is incomplete (no public clientId or no redirect
// allowlist), the endpoint fails closed with 503 configure_not_ready rather
// than inventing a provider — token verification itself still works.
function buildAuthConfig(config) {
  const authMode = config.authMode ?? "dev";
  if (authMode !== "hosted" || !config.oidc) {
    return {
      status: 200,
      body: {
        protocol: "account-auth-v1",
        authMode: "dev",
        devOnly: true,
        oauthConfigured: false,
        message:
          "Local-dev identity only. Sign in with a dev account token; " +
          "no OAuth provider is configured and no browser login applies.",
      },
    };
  }
  const oidc = config.oidc;
  const ready = Boolean(oidc.clientId) && Array.isArray(oidc.redirectUris) && oidc.redirectUris.length > 0;
  if (!ready) {
    return {
      status: 503,
      body: {
        protocol: "account-auth-v1",
        authMode: "hosted",
        error: "configure_not_ready",
        message:
          "Hosted auth is verifying tokens, but public login metadata is " +
          "not configured (ME_BACKEND_OIDC_CLIENT_ID and " +
          "ME_BACKEND_OIDC_REDIRECT_URIS are required). Operator action needed; " +
          "no provider is faked.",
        issuer: oidc.issuer,
        audience: oidc.audience,
      },
    };
  }
  const body = {
    protocol: "account-auth-v1",
    authMode: "hosted",
    issuer: oidc.issuer,
    // API audience: the `aud` the backend verifies on provider JWT
    // access-tokens. Distinct from the mobile clientId below.
    audience: oidc.audience,
    clientId: oidc.clientId,
    scopes: oidc.scopes ?? ["openid", "profile", "email"],
    redirectUris: oidc.redirectUris,
  };
  if (oidc.appScheme) body.appScheme = oidc.appScheme;
  if (oidc.extraAudiences && oidc.extraAudiences.length > 0) {
    body.extraAudiences = oidc.extraAudiences;
  }
  if (oidc.expectedTokenUse) body.expectedTokenUse = oidc.expectedTokenUse;
  return { status: 200, body };
}

export function createBackend(config) {
  // Backward compatible with direct B1 test configs
  // {host, port, dataDir, setupToken, devAccounts}: absent fields default to
  // explicit-dev behavior.
  const authMode = config.authMode ?? "dev";
  // Exact-origin CORS allowlist; absent config = no CORS (fail-closed).
  const corsAllowedOrigins = parseCorsAllowedOrigins(config.corsAllowedOrigins);
  const staleAfterSeconds =
    Number.isInteger(config.staleAfterSeconds) ? config.staleAfterSeconds : 300;
  const oidcVerifier = config.oidc ? createOidcVerifier(config.oidc) : null;
  const state = loadState(config.dataDir);
  state.activationTickets ??= {};
  // persistFn injection is test-only (atomicity test forces a persist
  // failure to prove in-memory rollback). Production always uses saveState.
  const persist = typeof config.persistFn === "function"
    ? () => config.persistFn(config.dataDir, state)
    : () => saveState(config.dataDir, state);

  // Server-side availability: a home counts as online only with a heartbeat
  // fresher than the configured bounded threshold. Phones must not infer
  // liveness from lastStatus alone.
  function computeOnline(home) {
    if (!home.lastSeenAt) return false;
    const ageMs = Date.now() - Date.parse(home.lastSeenAt);
    if (!Number.isFinite(ageMs) || ageMs < 0) return false;
    return ageMs <= staleAfterSeconds * 1000;
  }

  async function handler(req, res) {
    try {
      // CORS outermost layer: preflights are answered here; for an
      // allowlisted origin the grant headers are stamped before routing so
      // every response — including 401/403/404 errors — carries them.
      if (handleCorsPreflight(req, res, corsAllowedOrigins)) return;
      applyCorsHeaders(res, corsMatchOrigin(req, corsAllowedOrigins));

      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: "backend-server", version: 1 });
        return;
      }

      // GET /v1/auth/config — public login metadata (protocol
      // account-auth-v1). No auth required; exposes only public values.
      if (req.method === "GET" && url.pathname === "/v1/auth/config") {
        const { status, body } = buildAuthConfig(config);
        sendJson(res, status, body);
        return;
      }

      // GET /v1/account — verifies the presented bearer credential with the
      // current jose verifier and returns the stable server-derived
      // accountId plus minimal display claims when verified. Never trusts
      // client body identity (GET has no body contract; any identity
      // fields would be ignored and this route rejects them if sent as
      // query — identity always comes from the credential).
      if (req.method === "GET" && url.pathname === "/v1/account") {
        if (authMode !== "hosted" || !oidcVerifier) {
          const token = bearerToken(req);
          const accountId = token ? config.devAccounts?.get(token) ?? null : null;
          if (!accountId) {
            sendJson(res, 401, { error: "Account authorization required." });
            return;
          }
          sendJson(res, 200, { protocol: "account-auth-v1", authMode: "dev", accountId });
          return;
        }
        const token = bearerToken(req);
        const verified = token ? await oidcVerifier.verifyAccount(token) : null;
        if (!verified) {
          sendJson(res, 401, { error: "Account authorization required." });
          return;
        }
        const body = {
          protocol: "account-auth-v1",
          authMode: "hosted",
          accountId: verified.accountId,
          issuer: verified.issuer,
        };
        if (verified.claims && Object.keys(verified.claims).length > 0) {
          body.claims = verified.claims;
        }
        sendJson(res, 200, body);
        return;
      }

      // POST /v1/homes/register.
      // Dev mode: fleet setup bootstrap token (explicit dev only; retained
      // for the current dev flow and its tests).
      // Hosted mode: the fleet-wide setup secret is NOT accepted. Registration
      // requires an account-authorized one-time registration ticket binding
      // the requesting identity (+ optional installation); the ticket is
      // atomically consumed and the requesting account becomes owner.
      // Re-registration can only create new records (duplicate homeId -> 409);
      // endpoint updates always require the existing home token, so a
      // re-register can never overwrite or hijack a live home.
      if (req.method === "POST" && parts.length === 3 && parts[0] === "v1" && parts[1] === "homes" && parts[2] === "register") {
        const body = await readJsonBody(req);
        rejectIdentityFields(body);
        let { homeId, installationId, displayName, endpointHint, protocolVersion } = body;
        if (homeId === undefined) {
          homeId = newHomeId();
        }
        if (typeof homeId !== "string" || !isSafeKey(homeId) || !HOME_ID_RE.test(homeId)) {
          sendJson(res, 400, { error: "Invalid homeId. Use [a-z0-9_-], 3-64 chars." });
          return;
        }
        // Validate-then-consume ordering: a duplicate homeId is rejected
        // BEFORE any registration ticket is consumed, so a failed 409 can
        // neither burn a single-use ticket nor leave partial state. The
        // consume + record creation below run synchronously with a single
        // persist and no awaits between them (single-process atomicity).
        if (getOwn(state.homes, homeId)) {
          sendJson(res, 409, { error: "A home with this homeId is already registered." });
          return;
        }
        // installationId is H1's installation identity (a uuid per
        // infra-server/contracts/home-api-v1.md). Opaque here: stored
        // verbatim so F1 can correlate this record with H1's /healthz.
        // Uniqueness is NOT enforced: a reinstalled home gets a fresh
        // installation_id and there is no delete-home endpoint, so a
        // uniqueness constraint would permanently block re-registration.
        if (installationId !== undefined && (typeof installationId !== "string" || !INSTALLATION_ID_RE.test(installationId))) {
          sendJson(res, 400, { error: "Invalid installationId (printable ASCII, 1-128 chars)." });
          return;
        }
        if (displayName !== undefined && (typeof displayName !== "string" || displayName.length === 0 || displayName.length > 100)) {
          sendJson(res, 400, { error: "Invalid displayName (1-100 chars)." });
          return;
        }
        // endpointHint carries the home's protected base URL once H1's
        // route exists (tunnel URL + H1 base path). Opaque to this service:
        // stored and returned verbatim, never fetched or validated as a route.
        if (endpointHint !== undefined && (typeof endpointHint !== "string" || endpointHint.length > 500)) {
          sendJson(res, 400, { error: "Invalid endpointHint (string, max 500 chars)." });
          return;
        }
        if (protocolVersion !== undefined && (typeof protocolVersion !== "string" || protocolVersion.length === 0 || protocolVersion.length > 32)) {
          sendJson(res, 400, { error: "Invalid protocolVersion (1-32 chars)." });
          return;
        }
        // Authorization branch. The duplicate-homeId check above already ran,
        // so reaching the consume step below means creation will proceed.
        let ownerAccountId = null;
        if (authMode === "hosted") {
          // No fleet-wide setup secret here: the caller proves account
          // identity with a verified credential and redeems a one-time
          // registration ticket bound to that identity.
          const accountId = await resolveAccountId(req, config, oidcVerifier);
          if (!accountId) {
            sendJson(res, 401, { error: "Account authorization required." });
            return;
          }
          const { registrationTicket, registrationTicketId } = body;
          if (typeof registrationTicket !== "string" || registrationTicket.length === 0) {
            sendJson(res, 400, { error: "registrationTicket is required." });
            return;
          }
          const consumed = consumeRegistrationTicket(state, {
            secret: registrationTicket,
            ticketId: registrationTicketId,
            accountId,
            installationId,
          });
          if (!consumed.ok) {
            sendJson(res, consumed.status, { error: consumed.error });
            return;
          }
          if (consumed.installationId && installationId === undefined) {
            installationId = consumed.installationId;
          }
          ownerAccountId = accountId;
        } else {
          // Explicit dev only: the fleet bootstrap secret authorizes
          // registration. Retained for the current dev flow and its tests.
          const setup = req.headers["x-me-setup-token"];
          if (typeof setup !== "string" || typeof config.setupToken !== "string" || !safeEqualText(setup, config.setupToken)) {
            sendJson(res, 401, { error: "Setup authorization required." });
            return;
          }
        }
        const homeToken = newToken("me_home");
        const now = nowIso();
        state.homes[homeId] = {
          homeId,
          installationId: installationId ?? null,
          displayName: displayName ?? null,
          endpointHint: endpointHint ?? null,
          protocolVersion: protocolVersion ?? "1",
          lastSeenAt: null,
          lastStatus: null,
          createdAt: now,
          updatedAt: now,
        };
        state.homeTokenVerifiers[sha256Hex(homeToken)] = homeId;
        // Invariant: every home owns its members record as an own property.
        // (Plain `??=` would keep an inherited value for keys like
        // "constructor" and write memberships onto the wrong object.)
        let homeMembers = getOwn(state.members, homeId);
        if (!homeMembers) {
          homeMembers = {};
          state.members[homeId] = homeMembers;
        }
        // Hosted registration makes the requesting account the owner at
        // creation time. Dev registration creates no membership; the owner
        // joins later via a home-minted join ticket.
        let membership = null;
        if (ownerAccountId) {
          homeMembers[ownerAccountId] = { accountId: ownerAccountId, role: "owner", joinedAt: now };
          membership = { ...homeMembers[ownerAccountId], homeId };
        }
        persist();
        sendJson(res, 201, { homeId, installationId: installationId ?? null, homeToken, membership, createdAt: now });
        return;
      }

      // POST /v1/homes/registration-tickets (account auth).
      // Hosted enrollment step 1: an authenticated account mints a
      // single-use, short-lived ticket binding its own identity (+ optional
      // installation) for exactly one home registration. The ticket, not a
      // shared setup secret, authorizes POST /v1/homes/register.
      if (req.method === "POST" && parts.length === 3 && parts[0] === "v1" && parts[1] === "homes" && parts[2] === "registration-tickets") {
        const accountId = await resolveAccountId(req, config, oidcVerifier);
        if (!accountId) {
          sendJson(res, 401, { error: "Account authorization required." });
          return;
        }
        const body = await readJsonBody(req);
        rejectIdentityFields(body);
        let { installationId, ttlSeconds = 300, label } = body;
        if (installationId !== undefined && (typeof installationId !== "string" || !INSTALLATION_ID_RE.test(installationId))) {
          sendJson(res, 400, { error: "Invalid installationId (printable ASCII, 1-128 chars)." });
          return;
        }
        if (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 1800) {
          sendJson(res, 400, { error: "Invalid ttlSeconds (60-1800)." });
          return;
        }
          if (label !== undefined && (typeof label !== "string" || label.length > 100)) {
            sendJson(res, 400, { error: "Invalid label (max 100 chars)." });
            return;
          }
          pruneTickets(state.regTickets);
          if (countActiveTickets(state.regTickets, (t) => t.accountId === accountId) >= MAX_ACTIVE_REG_TICKETS_PER_ACCOUNT) {
            sendJson(res, 429, { error: "Too many active registration tickets for this account; use or let them expire." });
            return;
          }
          const ticketId = `regticket_${randomBytes(12).toString("base64url")}`;
        const ticketSecret = randomBytes(24).toString("base64url");
        state.regTickets[ticketId] = {
          ticketId,
          accountId,
          installationId: installationId ?? null,
          verifier: sha256Hex(ticketSecret),
          expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
          consumedAt: null,
          label: label ?? null,
        };
        persist();
        sendJson(res, 201, {
          ticketId,
          registrationTicket: ticketSecret,
          accountId,
          installationId: installationId ?? null,
          expiresAt: state.regTickets[ticketId].expiresAt,
        });
        return;
      }

      // POST /v1/homes/activation-tickets (account auth) — home-activation-v1.
      // One-time account-bound capability for actual home<->cloud activation
      // WITHOUT forwarding reusable account credentials (no Me JWT / SSH /
      // provider secrets leave the phone). The phone (owner) mints; the home
      // redeems via POST /v1/homes/activate with NO account JWT.
      // Body: { installationId (required), existingHomeId? (recovery),
      // displayName? }. Recovery requires caller still be owner of
      // existingHomeId and installation match. Fixed 5-minute TTL, max 15
      // live tickets per account, hashed-only storage, distinct namespace
      // from join/registration tickets. Response is capability-only:
      // { ticketId, activationSecret, installationId, mode, homeId, expiresAt }
      // — never a homeToken, never other account data. Body identity is never
      // trusted (rejectIdentityFields).
      if (req.method === "POST" && parts.length === 3 && parts[0] === "v1" && parts[1] === "homes" && parts[2] === "activation-tickets") {
        const accountId = await resolveAccountId(req, config, oidcVerifier);
        if (!accountId) {
          sendJson(res, 401, { error: "Account authorization required." });
          return;
        }
        const body = await readJsonBody(req);
        rejectIdentityFields(body);
        if (Object.hasOwn(body, "homeId") || Object.hasOwn(body, "accountId")) {
          sendJson(res, 400, { error: "Use existingHomeId for recovery; homeId is never accepted here." });
          return;
        }
        const { installationId, existingHomeId, displayName } = body;
        if (typeof installationId !== "string" || !INSTALLATION_ID_RE.test(installationId)) {
          sendJson(res, 400, { error: "Invalid installationId (printable ASCII, 1-128 chars)." });
          return;
        }
        if (displayName !== undefined && (typeof displayName !== "string" || displayName.length === 0 || displayName.length > 100)) {
          sendJson(res, 400, { error: "Invalid displayName (1-100 chars)." });
          return;
        }
        let mode = "new";
        let homeId = null;
        if (existingHomeId !== undefined) {
          if (typeof existingHomeId !== "string" || !isSafeKey(existingHomeId) || !HOME_ID_RE.test(existingHomeId)) {
            sendJson(res, 400, { error: "Invalid existingHomeId." });
            return;
          }
          const existing = getOwn(state.homes, existingHomeId);
          if (!existing) {
            sendJson(res, 404, { error: "Home not found." });
            return;
          }
          const callerRole = memberRole(state, existingHomeId, accountId);
          if (!callerRole) {
            sendJson(res, 404, { error: "Home not found." });
            return;
          }
          if (callerRole !== "owner") {
            sendJson(res, 403, { error: "Only the home owner can mint a recovery ticket." });
            return;
          }
          if (existing.installationId && existing.installationId !== installationId) {
            sendJson(res, 403, { error: "Recovery ticket installation does not match the home installation." });
            return;
          }
          mode = "recovery";
          homeId = existingHomeId;
        }
        state.activationTickets ??= {};
        pruneTickets(state.activationTickets);
        if (countActiveTickets(state.activationTickets, (t) => t.accountId === accountId) >= MAX_ACTIVE_ACTIVATION_TICKETS_PER_ACCOUNT) {
          sendJson(res, 429, { error: "Too many active activation tickets for this account; use or let them expire." });
          return;
        }
        let ticketId = `act_${randomBytes(12).toString("base64url")}`;
        while (getOwn(state.activationTickets, ticketId)) {
          ticketId = `act_${randomBytes(12).toString("base64url")}`;
        }
        // 256-bit secret, shown once.
        const ticketSecret = randomBytes(32).toString("base64url");
        state.activationTickets[ticketId] = {
          ticketId,
          verifier: sha256Hex(ticketSecret),
          accountId,
          installationId,
          mode,
          homeId,
          displayName: displayName ?? null,
          expiresAt: new Date(Date.now() + ACTIVATION_TTL_MS).toISOString(),
          consumedAt: null,
        };
        persist();
        sendJson(res, 201, {
          ticketId,
          activationSecret: ticketSecret,
          installationId,
          mode,
          homeId,
          expiresAt: state.activationTickets[ticketId].expiresAt,
        });
        return;
      }

      // POST /v1/homes/activate (ticket ONLY, no account JWT) —
      // home-activation-v1 redemption. The home proves possession of the
      // one-time capability plus its exact installationId and publishes its
      // public endpointHint. Atomically consumes the ticket and either
      // registers a fresh home (mode=new, owner=minting account) or rotates
      // the home credential (mode=recovery, same homeId from the ticket —
      // never request-supplied). Invalid requests never burn the ticket;
      // persist failures roll back in-memory mutation (no half-consumed
      // state). Old homeToken verifiers are invalidated on rotation.
      if (req.method === "POST" && parts.length === 3 && parts[0] === "v1" && parts[1] === "homes" && parts[2] === "activate") {
        const body = await readJsonBody(req);
        rejectIdentityFields(body);
        if (Object.hasOwn(body, "homeId") || Object.hasOwn(body, "existingHomeId") || Object.hasOwn(body, "homeToken")) {
          sendJson(res, 400, { error: "homeId is never accepted here; it comes from the activation ticket." });
          return;
        }
        const ticketId = body.ticketId;
        const secret = body.activationSecret ?? body.ticketSecret;
        const { installationId, endpointHint } = body;
        let { protocolVersion } = body;
        if (typeof ticketId !== "string" || ticketId.length === 0) {
          sendJson(res, 400, { error: "ticketId is required." });
          return;
        }
        if (typeof secret !== "string" || secret.length === 0) {
          sendJson(res, 400, { error: "activationSecret is required." });
          return;
        }
        if (typeof installationId !== "string" || !INSTALLATION_ID_RE.test(installationId)) {
          sendJson(res, 400, { error: "Invalid installationId (printable ASCII, 1-128 chars)." });
          return;
        }
        if (typeof endpointHint !== "string" || !isAllowedActivationEndpointHint(endpointHint)) {
          sendJson(res, 400, { error: "Invalid endpointHint. Production requires public https://; plain http:// only for loopback dev/test. Backend never fetches this URL." });
          return;
        }
        if (protocolVersion === undefined) protocolVersion = "1";
        if (typeof protocolVersion !== "string" || protocolVersion.length === 0 || protocolVersion.length > 32) {
          sendJson(res, 400, { error: "Invalid protocolVersion (1-32 chars)." });
          return;
        }
        state.activationTickets ??= {};
        pruneTickets(state.activationTickets);
        const ticket = isSafeKey(ticketId) ? getOwn(state.activationTickets, ticketId) ?? null : null;
        if (!ticket) {
          sendJson(res, 403, { error: "Invalid activation ticket." });
          return;
        }
        if (!safeEqualText(sha256Hex(secret), ticket.verifier)) {
          sendJson(res, 403, { error: "Invalid activation ticket." });
          return;
        }
        if (ticket.consumedAt || Date.parse(ticket.expiresAt) <= Date.now()) {
          sendJson(res, 410, { error: "Activation ticket is expired or already used." });
          return;
        }
        if (ticket.installationId !== installationId) {
          sendJson(res, 403, { error: "Activation ticket is bound to a different installation." });
          return;
        }
        // Resolve target home + pre-validate before mutating (so invalid
        // requests never burn the ticket).
        let targetHomeId = null;
        let isRecovery = ticket.mode === "recovery";
        if (isRecovery) {
          targetHomeId = ticket.homeId;
          const existing = isSafeKey(targetHomeId) ? getOwn(state.homes, targetHomeId) ?? null : null;
          if (!existing || !isSafeKey(targetHomeId)) {
            sendJson(res, 410, { error: "Activation home is no longer available." });
            return;
          }
          if (memberRole(state, targetHomeId, ticket.accountId) !== "owner") {
            sendJson(res, 403, { error: "Recovery ticket owner no longer owns this home." });
            return;
          }
          if (existing.installationId && existing.installationId !== installationId) {
            sendJson(res, 403, { error: "Activation ticket is bound to a different installation." });
            return;
          }
        } else {
          // New registration: allocate a fresh unique homeId server-side.
          do {
            targetHomeId = newHomeId();
          } while (getOwn(state.homes, targetHomeId));
        }
        // Mutate + persist atomically with rollback on persist failure.
        const now = nowIso();
        const ticketConsumedBefore = ticket.consumedAt;
        let createdHome = false;
        let createdVerifierHash = null;
        let removedVerifierHashes = null;
        let homeBefore = null;
        let membersBefore = null;
        try {
          ticket.consumedAt = now;
          const homeToken = newToken("me_home");
          const verifierHash = sha256Hex(homeToken);
          if (!isRecovery) {
            state.homes[targetHomeId] = {
              homeId: targetHomeId,
              installationId,
              displayName: ticket.displayName ?? null,
              endpointHint,
              protocolVersion,
              lastSeenAt: null,
              lastStatus: null,
              createdAt: now,
              updatedAt: now,
            };
            createdHome = true;
            state.homeTokenVerifiers[verifierHash] = targetHomeId;
            createdVerifierHash = verifierHash;
            state.members[targetHomeId] = {
              [ticket.accountId]: { accountId: ticket.accountId, role: "owner", joinedAt: now },
            };
          } else {
            const existing = getOwn(state.homes, targetHomeId);
            homeBefore = { ...existing };
            const curMembers = getOwn(state.members, targetHomeId) ?? {};
            membersBefore = { ...curMembers };
            removedVerifierHashes = Object.keys(state.homeTokenVerifiers).filter(
              (k) => getOwn(state.homeTokenVerifiers, k) === targetHomeId
            );
            for (const k of removedVerifierHashes) delete state.homeTokenVerifiers[k];
            state.homeTokenVerifiers[verifierHash] = targetHomeId;
            createdVerifierHash = verifierHash;
            existing.installationId = installationId;
            existing.endpointHint = endpointHint;
            existing.protocolVersion = protocolVersion;
            existing.updatedAt = now;
            let homeMembers = getOwn(state.members, targetHomeId);
            if (!homeMembers) {
              homeMembers = {};
              state.members[targetHomeId] = homeMembers;
            }
            if (!getOwn(homeMembers, ticket.accountId)) {
              homeMembers[ticket.accountId] = { accountId: ticket.accountId, role: "owner", joinedAt: now };
            } else {
              homeMembers[ticket.accountId].role = "owner";
            }
          }
          persist();
          sendJson(res, 201, {
            homeId: targetHomeId,
            installationId,
            homeToken,
            endpointHint,
            protocolVersion,
            mode: isRecovery ? "recovery" : "new",
          });
          return;
        } catch (persistErr) {
          // Roll back every in-memory mutation: no half-consumed state.
          ticket.consumedAt = ticketConsumedBefore;
          if (createdVerifierHash) delete state.homeTokenVerifiers[createdVerifierHash];
          if (!isRecovery && createdHome) {
            delete state.homes[targetHomeId];
            delete state.members[targetHomeId];
          }
          if (isRecovery) {
            if (removedVerifierHashes) {
              for (const k of removedVerifierHashes) state.homeTokenVerifiers[k] = targetHomeId;
            }
            if (homeBefore) state.homes[targetHomeId] = homeBefore;
            if (membersBefore !== null) state.members[targetHomeId] = membersBefore;
          }
          throw persistErr;
        }
      }

      // GET /v1/homes (authorized discovery: members only)
      if (req.method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "homes") {
        const accountId = await resolveAccountId(req, config, oidcVerifier);
        if (!accountId) {
          sendJson(res, 401, { error: "Account authorization required." });
          return;
        }
        const homes = Object.values(state.homes)
          .filter((home) => memberRole(state, home.homeId, accountId))
          .map((home) => publicHome(state, home, accountId));
        sendJson(res, 200, { homes });
        return;
      }

      // Routes scoped to /v1/homes/:homeId/...
      if (parts.length >= 3 && parts[0] === "v1" && parts[1] === "homes") {
        const homeId = parts[2];
        const home = isSafeKey(homeId) ? getOwn(state.homes, homeId) : undefined;
        const accountId = await resolveAccountId(req, config, oidcVerifier);
        const authedHomeId = resolveHomeId(req, state);
        const isHomeSelf = authedHomeId === homeId;
        const role = accountId ? memberRole(state, homeId, accountId) : null;

        // GET /v1/homes/:homeId
        if (req.method === "GET" && parts.length === 3) {
          if (isHomeSelf) {
            sendJson(res, 200, { home: publicHome(state, home, null) });
            return;
          }
          if (accountId && role) {
            sendJson(res, 200, { home: publicHome(state, home, accountId) });
            return;
          }
          if (!accountId && !authedHomeId) {
            sendJson(res, 401, { error: "Authorization required." });
            return;
          }
          // Valid credential without membership: hide existence.
          if (!home) {
            sendJson(res, 404, { error: "Home not found." });
            return;
          }
          if (authedHomeId && !isHomeSelf) {
            sendJson(res, 403, { error: "Home credential is not authorized for this home." });
            return;
          }
          sendJson(res, 404, { error: "Home not found." });
          return;
        }

        // POST /v1/homes/:homeId/heartbeat (home credential only)
        if (req.method === "POST" && parts.length === 4 && parts[3] === "heartbeat") {
          if (!home) {
            sendJson(res, 404, { error: "Home not found." });
            return;
          }
          if (!isHomeSelf) {
            const status = !authedHomeId && !accountId ? 401 : 403;
            sendJson(res, status, { error: "Home authorization required." });
            return;
          }
          const body = await readJsonBody(req);
          rejectIdentityFields(body);
          const { status, endpointHint, installationId } = body;
          if (status !== undefined && !["online", "degraded", "offline"].includes(status)) {
            sendJson(res, 400, { error: "Invalid status." });
            return;
          }
          if (endpointHint !== undefined && (typeof endpointHint !== "string" || endpointHint.length > 500)) {
            sendJson(res, 400, { error: "Invalid endpointHint." });
            return;
          }
          if (installationId !== undefined && (typeof installationId !== "string" || !INSTALLATION_ID_RE.test(installationId))) {
            sendJson(res, 400, { error: "Invalid installationId." });
            return;
          }
          home.lastSeenAt = nowIso();
          home.lastStatus = status ?? "online";
          if (endpointHint !== undefined) home.endpointHint = endpointHint;
          if (installationId !== undefined) home.installationId = installationId;
          home.updatedAt = home.lastSeenAt;
          persist();
          sendJson(res, 200, { ok: true, homeId, lastSeenAt: home.lastSeenAt, lastStatus: home.lastStatus });
          return;
        }

        // GET /v1/homes/:homeId/status (member or home self)
        if (req.method === "GET" && parts.length === 4 && parts[3] === "status") {
          if (!home) {
            sendJson(res, 404, { error: "Home not found." });
            return;
          }
          if (!(isHomeSelf || role)) {
            if (!accountId && !authedHomeId) {
              sendJson(res, 401, { error: "Authorization required." });
              return;
            }
            sendJson(res, authedHomeId ? 403 : 404, { error: "Home not found." });
            return;
          }
          sendJson(res, 200, {
            homeId,
            lastSeenAt: home.lastSeenAt,
            lastStatus: home.lastStatus,
            // Computed server-side: never claim liveness the backend has not
            // observed within the configured bounded threshold.
            online: computeOnline(home),
            staleAfterSeconds,
          });
          return;
        }

        // POST /v1/homes/:homeId/join-tickets (home credential only)
        if (req.method === "POST" && parts.length === 4 && parts[3] === "join-tickets") {
          if (!home) {
            sendJson(res, 404, { error: "Home not found." });
            return;
          }
          if (!isHomeSelf) {
            const status = !authedHomeId && !accountId ? 401 : 403;
            sendJson(res, status, { error: "Home authorization required." });
            return;
          }
          const body = await readJsonBody(req);
          rejectIdentityFields(body);
          let { ttlSeconds = 900, label } = body;
          if (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds) || ttlSeconds < 2 || ttlSeconds > 86400) {
            sendJson(res, 400, { error: "Invalid ttlSeconds (2-86400)." });
            return;
          }
          if (label !== undefined && (typeof label !== "string" || label.length > 100)) {
            sendJson(res, 400, { error: "Invalid label (max 100 chars)." });
            return;
          }
          pruneTickets(state.tickets);
          if (countActiveTickets(state.tickets, (t) => t.homeId === homeId) >= MAX_ACTIVE_JOIN_TICKETS_PER_HOME) {
            sendJson(res, 429, { error: "Too many active join tickets for this home; use or let them expire." });
            return;
          }
          const ticketId = `ticket_${randomBytes(12).toString("base64url")}`;
          const ticketSecret = randomBytes(24).toString("base64url");
          const now = Date.now();
          state.tickets[ticketId] = {
            ticketId,
            homeId,
            verifier: sha256Hex(ticketSecret),
            expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
            consumedAt: null,
            label: label ?? null,
          };
          persist();
          sendJson(res, 201, {
            ticketId,
            ticketSecret,
            homeId,
            expiresAt: state.tickets[ticketId].expiresAt,
          });
          return;
        }

        // POST /v1/homes/:homeId/members/join (account + ticket secret)
        if (req.method === "POST" && parts.length === 5 && parts[3] === "members" && parts[4] === "join") {
          if (!home) {
            sendJson(res, 404, { error: "Home not found." });
            return;
          }
          if (!accountId) {
            sendJson(res, 401, { error: "Account authorization required." });
            return;
          }
          const body = await readJsonBody(req);
          rejectIdentityFields(body);
          const { ticketSecret, ticketId } = body;
          if (typeof ticketSecret !== "string" || ticketSecret.length === 0) {
            sendJson(res, 400, { error: "ticketSecret is required." });
            return;
          }
          const candidates = Object.values(state.tickets).filter((t) => t.homeId === homeId);
          const ticket = ticketId
            ? candidates.find((t) => t.ticketId === ticketId) ?? null
            : candidates.find((t) => !t.consumedAt && safeEqualText(sha256Hex(ticketSecret), t.verifier)) ?? null;
          if (ticket && ticketId && !safeEqualText(sha256Hex(ticketSecret), ticket.verifier)) {
            sendJson(res, 403, { error: "Invalid join ticket." });
            return;
          }
          if (!ticket) {
            // A ticket for another home must not enroll here.
            const elsewhere =
              Object.values(state.tickets).find(
                (t) => !t.consumedAt && safeEqualText(sha256Hex(ticketSecret), t.verifier)
              ) ?? null;
            if (elsewhere) {
              sendJson(res, 403, { error: "Join ticket is not valid for this home." });
              return;
            }
            sendJson(res, 403, { error: "Invalid join ticket." });
            return;
          }
          if (ticket.consumedAt || Date.parse(ticket.expiresAt) <= Date.now()) {
            sendJson(res, 410, { error: "Join ticket is expired or already used." });
            return;
          }
          if (memberRole(state, homeId, accountId)) {
            sendJson(res, 409, { error: "Account is already a member of this home." });
            return;
          }
          ticket.consumedAt = nowIso();
          let homeMembers = getOwn(state.members, homeId);
          if (!homeMembers) {
            homeMembers = {};
            state.members[homeId] = homeMembers;
          }
          const isFirst = Object.keys(homeMembers).length === 0;
          homeMembers[accountId] = {
            accountId,
            role: isFirst ? "owner" : "member",
            joinedAt: nowIso(),
          };
          persist();
          sendJson(res, 201, {
            membership: { ...homeMembers[accountId], homeId },
          });
          return;
        }

        // GET /v1/homes/:homeId/members (member or home self)
        if (req.method === "GET" && parts.length === 4 && parts[3] === "members") {
          if (!home) {
            sendJson(res, 404, { error: "Home not found." });
            return;
          }
          if (!(isHomeSelf || role)) {
            if (!accountId && !authedHomeId) {
              sendJson(res, 401, { error: "Authorization required." });
              return;
            }
            sendJson(res, authedHomeId ? 403 : 404, { error: "Home not found." });
            return;
          }
          const members = Object.values(getOwn(state.members, homeId) ?? {}).sort((a, b) =>
            a.joinedAt.localeCompare(b.joinedAt)
          );
          sendJson(res, 200, { homeId, members });
          return;
        }

        // DELETE /v1/homes/:homeId/members/:accountId (home self, or self-removal)
        if (req.method === "DELETE" && parts.length === 5 && parts[3] === "members") {
          let targetId;
          try {
            targetId = decodeURIComponent(parts[4]);
          } catch {
            sendJson(res, 400, { error: "Invalid member reference." });
            return;
          }
          if (!isSafeKey(targetId)) {
            sendJson(res, 404, { error: "Membership not found." });
            return;
          }
          if (!home) {
            sendJson(res, 404, { error: "Home not found." });
            return;
          }
          const selfRemoval = accountId !== null && accountId === targetId;
          if (!(isHomeSelf || selfRemoval)) {
            if (!accountId && !authedHomeId) {
              sendJson(res, 401, { error: "Authorization required." });
              return;
            }
            sendJson(res, authedHomeId ? 403 : 404, { error: "Home not found." });
            return;
          }
          const existing = getOwn(getOwn(state.members, homeId), targetId);
          if (!existing) {
            sendJson(res, 404, { error: "Membership not found." });
            return;
          }
          delete state.members[homeId][targetId];
          const remaining = Object.values(state.members[homeId]);
          if (existing.role === "owner" && remaining.length > 0) {
            remaining.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
            remaining[0].role = "owner";
          }
          persist();
          sendJson(res, 200, { ok: true, homeId, removed: targetId });
          return;
        }
      }

      sendJson(res, 404, { error: "Not found." });
    } catch (err) {
      const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
      // Never echo secrets or stack traces to clients.
      sendJson(res, status, { error: status === 500 ? "Internal error." : String(err.message) });
    }
  }

  return { handler, state, persist };
}

export function startFromEnv(env = process.env) {
  const config = loadConfig(env);
  assertSafeBind(config);
  const { handler } = createBackend(config);
  const server = createServer(handler);
  server.listen(config.port, config.host, () => {
    console.log(`backend-server listening on http://${config.host}:${config.port} (data: ${config.dataDir})`);
  });
  return server;
}

const invokedAsMain = (process.argv[1] ?? "").endsWith("src/server.mjs") || (process.argv[1] ?? "").endsWith("server.mjs");
if (invokedAsMain) {
  try {
    startFromEnv();
  } catch (err) {
    console.error(`Failed to start backend-server: ${err.message}`);
    process.exit(1);
  }
}
