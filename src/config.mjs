// Account identity configuration: explicit local-dev tokens AND/OR real
// hosted OIDC JWT verification (B2).
//
// Two modes (ME_BACKEND_AUTH_MODE, or auto: hosted when an OIDC issuer is
// configured, dev otherwise):
//   - dev:    ME_BACKEND_HOME_SETUP_TOKEN + ME_BACKEND_DEV_ACCOUNTS_JSON.
//             Loopback binds only; non-loopback binds are refused at startup.
//   - hosted: ME_BACKEND_OIDC_ISSUER/AUDIENCE/JWKS(+FILE)/ALGORITHMS.
//             DEV_ACCOUNTS_JSON is NOT required and SHOULD be absent in
//             production (accepted if present: transition/testing only).
// Client-supplied user/account IDs are never trusted as identity in either
// mode (see src/server.mjs); hosted identity derives from verified
// issuer+subject (see src/oidc.mjs).

import { readFileSync } from "node:fs";
import { parseCorsAllowedOrigins } from "./cors.mjs";
import {
  parseAlgorithms,
  validateJwks,
  validateJwksUrl,
  parseJwksTimeoutMs,
  isLoopbackHttpIssuer,
} from "./oidc.mjs";

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host);
}

// Refuse to serve explicit dev credentials on a non-loopback interface.
// Called at startup (not inside createBackend, so direct test harnesses
// with ephemeral loopback ports are unaffected).
export function assertSafeBind(config) {
  if (config.authMode === "dev" && !isLoopbackHost(config.host)) {
    throw new Error(
      `Refusing to bind authMode=dev to non-loopback host '${config.host}'. ` +
      "Dev credentials are loopback-only; use hosted OIDC mode for wider binds."
    );
  }
}

function parseStaleAfterSeconds(raw) {
  if (raw === undefined || raw === null || raw === "") return 300;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 30 || value > 3600) {
    throw new Error("ME_BACKEND_STALE_AFTER_SECONDS must be an integer 30..3600.");
  }
  return value;
}

function parseDevAccounts(rawAccounts) {
  if (!rawAccounts) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(rawAccounts);
  } catch {
    throw new Error("ME_BACKEND_DEV_ACCOUNTS_JSON is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ME_BACKEND_DEV_ACCOUNTS_JSON must be a JSON object of token -> accountId.");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw new Error("ME_BACKEND_DEV_ACCOUNTS_JSON must contain at least one token.");
  }
  const devAccounts = new Map();
  for (const [token, accountId] of entries) {
    if (typeof token !== "string" || token.length < 16) {
      throw new Error("Each dev account token must be a string of at least 16 characters.");
    }
    if (typeof accountId !== "string" || !ACCOUNT_ID_RE.test(accountId) || accountId === "__proto__") {
      throw new Error(`Invalid accountId for a dev token: ${String(accountId)}`);
    }
    if (devAccounts.has(token)) {
      throw new Error("Duplicate dev account token in ME_BACKEND_DEV_ACCOUNTS_JSON.");
    }
    devAccounts.set(token, accountId);
  }
  const accountIds = new Set(devAccounts.values());
  if (accountIds.size !== devAccounts.size) {
    throw new Error("Each dev token must map to a distinct accountId.");
  }
  return devAccounts;
}

function loadJwks(env) {
  const inline = env.ME_BACKEND_OIDC_JWKS ?? "";
  const file = env.ME_BACKEND_OIDC_JWKS_FILE ?? "";
  if (inline && file) {
    throw new Error("Set only one of ME_BACKEND_OIDC_JWKS / ME_BACKEND_OIDC_JWKS_FILE.");
  }
  const raw = inline || (file ? readFileSync(file, "utf8") : "");
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OIDC JWKS is not valid JSON.");
  }
  return validateJwks(parsed);
}

// Public mobile-login metadata (account-auth-v1). All values are public and
// safe to expose via GET /v1/auth/config: no secrets, no JWKS, no token maps.
// clientId MUST differ from the API audience: the backend verifies provider
// JWT access-tokens whose `aud` is the API audience, so reusing the client
// ID as audience would let an ID token pass as an API token.
function parseScopes(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return ["openid", "profile", "email"];
  }
  const list = String(raw).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0 || list.length > 10) {
    throw new Error("OIDC scopes must list 1-10 values (e.g. 'openid profile email').");
  }
  for (const scope of list) {
    if (!/^[A-Za-z0-9_:.~-]{1,64}$/.test(scope)) {
      throw new Error(`Invalid OIDC scope value: ${scope}`);
    }
  }
  return list;
}

function parseRedirectUris(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  const list = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length > 10) {
    throw new Error("Redirect allowlist must contain at most 10 exact URIs.");
  }
  const seen = new Set();
  for (const uri of list) {
    let url;
    try {
      url = new URL(uri);
    } catch {
      throw new Error(`Invalid redirect URI in allowlist: ${uri}`);
    }
    if (!url.protocol || url.protocol === ":") {
      throw new Error(`Invalid redirect URI in allowlist: ${uri}`);
    }
    if (uri.includes("*")) {
      throw new Error("Redirect allowlist must be exact URIs, no wildcards.");
    }
    if (seen.has(uri)) {
      throw new Error("Redirect allowlist must not contain duplicates.");
    }
    seen.add(uri);
  }
  return list;
}

function parseExtraAudiences(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  const list = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length > 5) {
    throw new Error("Extra audiences must contain at most 5 values.");
  }
  for (const aud of list) {
    if (aud.length === 0 || aud.length > 256) {
      throw new Error("Invalid extra audience value.");
    }
  }
  return list;
}

function loadLoginMetadata(env, { audience }) {
  const clientId = (env.ME_BACKEND_OIDC_CLIENT_ID ?? "").trim();
  if (clientId && clientId === audience) {
    throw new Error(
      "ME_BACKEND_OIDC_CLIENT_ID must differ from ME_BACKEND_OIDC_AUDIENCE. " +
      "The client ID identifies the mobile app; the audience identifies this API. " +
      "Reusing one value would let an ID token pass as an API access token."
    );
  }
  const scopes = parseScopes(env.ME_BACKEND_OIDC_SCOPES ?? "");
  const redirectUris = parseRedirectUris(env.ME_BACKEND_OIDC_REDIRECT_URIS ?? "");
  const appScheme = (env.ME_BACKEND_AUTH_APP_SCHEME ?? "").trim();
  if (appScheme && !/^[a-z][a-z0-9+.-]{1,63}$/i.test(appScheme)) {
    throw new Error("ME_BACKEND_AUTH_APP_SCHEME must be a valid app scheme (e.g. 'mehome').");
  }
  const extraAudiences = parseExtraAudiences(env.ME_BACKEND_OIDC_EXTRA_AUDIENCES ?? "");
  const expectedTokenUse = (env.ME_BACKEND_OIDC_EXPECT_TOKEN_USE ?? "").trim();
  if (expectedTokenUse && !/^[A-Za-z0-9_:-]{1,64}$/.test(expectedTokenUse)) {
    throw new Error("ME_BACKEND_OIDC_EXPECT_TOKEN_USE must be a short token string (e.g. 'access').");
  }
  return {
    clientId: clientId || null,
    scopes,
    redirectUris,
    appScheme: appScheme || null,
    extraAudiences,
    expectedTokenUse: expectedTokenUse || null,
  };
}

export function loadConfig(env = process.env) {
  const host = env.ME_BACKEND_HOST ?? "127.0.0.1";
  const portRaw = env.ME_BACKEND_PORT ?? "8787";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ME_BACKEND_PORT: ${portRaw}`);
  }
  const dataDir = env.ME_BACKEND_DATA_DIR ?? "./data";
  const staleAfterSeconds = parseStaleAfterSeconds(env.ME_BACKEND_STALE_AFTER_SECONDS);
  // Exact-origin CORS allowlist (src/cors.mjs). Unset = no CORS headers.
  const corsAllowedOrigins = parseCorsAllowedOrigins(env.ME_CORS_ALLOWED_ORIGINS);
  // Waitlist route flag (ticket W4). The key name is an implementation
  // decision, not source evidence — the evidenced Replit source has no
  // such flag; see docs/waitlist-migration.md. Naming follows the ME_*
  // feature-env convention of ME_CORS_ALLOWED_ORIGINS, and enablement is
  // strict — only the exact value "1" enables, the same convention as
  // ME_BACKEND_OIDC_ALLOW_INSECURE_ISSUER. Absent or any other value =
  // disabled: the route stays unregistered and no waitlist store is
  // constructed (ruling change 3).
  const waitlistEnabled = env.ME_WAITLIST_ENABLED === "1";

  const oidcIssuer = (env.ME_BACKEND_OIDC_ISSUER ?? "").trim();
  const explicitMode = (env.ME_BACKEND_AUTH_MODE ?? "").trim();
  if (explicitMode && explicitMode !== "dev" && explicitMode !== "hosted") {
    throw new Error("ME_BACKEND_AUTH_MODE must be 'dev' or 'hosted' (or unset for auto).");
  }
  const authMode = explicitMode || (oidcIssuer ? "hosted" : "dev");

  const devAccounts = parseDevAccounts(env.ME_BACKEND_DEV_ACCOUNTS_JSON ?? "");

  if (authMode === "dev") {
    const setupToken = env.ME_BACKEND_HOME_SETUP_TOKEN ?? "";
    if (!setupToken || setupToken.length < 16) {
      throw new Error(
        "ME_BACKEND_HOME_SETUP_TOKEN must be set to a secret of at least 16 characters. " +
          "This is a local-dev bootstrap secret only, not a production credential."
      );
    }
    if (devAccounts.size === 0) {
      throw new Error(
        "ME_BACKEND_DEV_ACCOUNTS_JSON must be set, e.g. " +
          `'{"dev-token-alice":"acct_alice"}'. ` +
          "Local-dev account tokens only; never use production OAuth tokens here."
      );
    }
    return { host, port, dataDir, staleAfterSeconds, authMode, setupToken, devAccounts, oidc: null, corsAllowedOrigins, waitlistEnabled };
  }

  // Hosted mode: real OIDC account verification. No fleet-wide setup secret,
  // no required dev accounts. Fail closed: an accidental dev token map is a
  // configuration error, not a silent backdoor — reject it loudly.
  const oidcAudience = (env.ME_BACKEND_OIDC_AUDIENCE ?? "").trim();
  if (!oidcIssuer) {
    throw new Error("Hosted mode requires ME_BACKEND_OIDC_ISSUER.");
  }
  if (!oidcAudience) {
    throw new Error("Hosted mode requires ME_BACKEND_OIDC_AUDIENCE.");
  }
  if (devAccounts.size > 0) {
    throw new Error(
      "Hosted mode must not configure ME_BACKEND_DEV_ACCOUNTS_JSON. Static dev " +
      "tokens are never honored in hosted mode; remove the variable."
    );
  }
  const jwks = loadJwks(env);
  const jwksUrlRaw = (env.ME_BACKEND_OIDC_JWKS_URL ?? "").trim();
  if (jwks && jwksUrlRaw) {
    throw new Error("Set only one of static JWKS (ME_BACKEND_OIDC_JWKS[_FILE]) or ME_BACKEND_OIDC_JWKS_URL.");
  }
  if (!jwks && !jwksUrlRaw) {
    throw new Error("Hosted mode requires ME_BACKEND_OIDC_JWKS, ME_BACKEND_OIDC_JWKS_FILE, or ME_BACKEND_OIDC_JWKS_URL.");
  }
  const insecureIssuerAllowed = (env.ME_BACKEND_OIDC_ALLOW_INSECURE_ISSUER ?? "") === "1";
  if (!oidcIssuer.startsWith("https://")) {
    if (!insecureIssuerAllowed || !isLoopbackHttpIssuer(oidcIssuer)) {
      throw new Error(
        "ME_BACKEND_OIDC_ISSUER must be https://. Plain http is permitted only " +
        "for explicit loopback test issuers with " +
        "ME_BACKEND_OIDC_ALLOW_INSECURE_ISSUER=1 (tests only)."
      );
    }
  }
  let jwksUrl = null;
  let jwksTimeoutMs = 5000;
  if (jwksUrlRaw) {
    // Hosted-safe: https only; loopback http only with the explicit test
    // flag (same rule as issuer). No override ever permits remote http.
    jwksUrl = validateJwksUrl(jwksUrlRaw, insecureIssuerAllowed);
    jwksTimeoutMs = parseJwksTimeoutMs(env.ME_BACKEND_OIDC_JWKS_TIMEOUT_MS ?? "");
  }
  const algorithms = parseAlgorithms(env.ME_BACKEND_OIDC_ALGORITHMS ?? "");
  const login = loadLoginMetadata(env, { audience: oidcAudience });
  return {
    host,
    port,
    dataDir,
    staleAfterSeconds,
    authMode,
    setupToken: null,
    devAccounts,
    corsAllowedOrigins,
    waitlistEnabled,
    oidc: {
      issuer: oidcIssuer,
      audience: oidcAudience,
      jwks,
      jwksUrl,
      jwksTimeoutMs,
      algorithms,
      insecureIssuerAllowed,
      clientId: login.clientId,
      scopes: login.scopes,
      redirectUris: login.redirectUris,
      appScheme: login.appScheme,
      extraAudiences: login.extraAudiences,
      expectedTokenUse: login.expectedTokenUse,
    },
  };
}

export const LOCAL_DEV_NOTICE =
  "Dev auth mode is local-development identity only (loopback binds " +
  "exclusively; non-loopback binds are refused). Hosted mode verifies real " +
  "OIDC JWTs against server-configured issuer/audience/JWKS-or-JWKS-URL. " +
  "Neither mode trusts client-supplied account IDs.";
