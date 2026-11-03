// Hosted account authentication: real OIDC JWT verification (B2+B4).
//
// Uses the maintained `jose` library against a server-configured key set:
// either a STATIC JWKS object, or a FIXED trusted server JWKS HTTPS URL via
// `jose.createRemoteJWKSet` (caching/rotation/timeout handled by jose).
// There is deliberately no token-derived key URL (no `jku`/`x5u` trust, no
// phone-supplied URL): issuer, audience, JWKS-or-JWKS-URL, and allowed
// algorithms are fixed in trusted server configuration. Verified claims:
// signature, exp, issuer, audience, subject (+ optional `token_use` when the
// operator configures an expectation, e.g. `access`). Account identity is
// derived server-side from issuer+subject (stable across restarts,
// stateless); request bodies are never a source of identity.

import { createHash } from "node:crypto";
import * as jose from "jose";

// The insecure-issuer escape hatch exists for loopback tests only: it
// permits plain-http issuers exclusively on loopback hosts, never an
// arbitrary remote. Applies to every entry point (config loader and direct
// verifier construction alike).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHttpIssuer(issuer) {
  let url;
  try {
    url = new URL(issuer);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(host);
}

// Symmetric/shared-secret algorithms must never authenticate accounts
// against a static local JWKS in this service. Asymmetric only.
const ALLOWED_ALGORITHMS = new Set([
  "RS256", "RS384", "RS512",
  "PS256", "PS384", "PS512",
  "ES256", "ES384", "ES512",
  "EdDSA",
]);

export function parseAlgorithms(raw, fallback = ["RS256"]) {
  const list = raw === undefined || raw === null || raw === ""
    ? [...fallback]
    : String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) {
    throw new Error("OIDC algorithms list must not be empty (e.g. RS256).");
  }
  for (const alg of list) {
    if (!ALLOWED_ALGORITHMS.has(alg)) {
      throw new Error(
        `OIDC algorithm '${alg}' is not permitted. Asymmetric algorithms only; ` +
        "symmetric (HS256/HS384/HS512) and 'none' are rejected."
      );
    }
  }
  return list;
}

export function validateJwks(jwks) {
  if (jwks === null || typeof jwks !== "object" || Array.isArray(jwks)) {
    throw new Error("OIDC JWKS must be a JSON object with a non-empty keys array.");
  }
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new Error("OIDC JWKS must contain a non-empty keys array.");
  }
  return jwks;
}

// Fixed trusted JWKS URL validation: https only, except explicit loopback
// http test issuers (same rule as issuer). Never accepts an arbitrary
// phone-supplied or token-derived URL — only server configuration.
export function validateJwksUrl(raw, insecureAllowed = false) {
  if (typeof raw !== "string" || !raw) {
    throw new Error("OIDC JWKS URL must be a non-empty string.");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OIDC JWKS URL must be a valid absolute URL.");
  }
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && insecureAllowed && isLoopbackHttpIssuer(raw)) {
    return url.href;
  }
  throw new Error(
    "OIDC JWKS URL must be https://. Plain http is permitted only for " +
    "explicit loopback test URLs with insecureIssuerAllowed (tests only); " +
    "arbitrary remote http JWKS URLs are never accepted."
  );
}

export function parseJwksTimeoutMs(raw, fallback = 5000) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000 || value > 15000) {
    throw new Error("OIDC JWKS timeout must be an integer 1000..15000 ms.");
  }
  return value;
}

// Minimal display claims safe to echo back to the already-authenticated
// owner of the token. Only short strings; never secrets.
export function pickDisplayClaims(payload) {
  const claims = {};
  for (const key of ["email", "name", "preferred_username"]) {
    const value = payload?.[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 320) {
      claims[key] = value;
    }
  }
  if (typeof payload?.email_verified === "boolean") {
    claims.email_verified = payload.email_verified;
  }
  return claims;
}

// Stable, safe account identity for a verified (issuer, subject) pair.
// Hex charset fits the members-record key rules; derivation is stateless
// so the same IdP identity maps to the same account across restarts.
export function deriveAccountId(issuer, subject) {
  const digest = createHash("sha256")
    .update("oidc-v1", "utf8")
    .update("\0", "utf8")
    .update(issuer, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
  return `acct_${digest.slice(0, 32)}`;
}

export function createOidcVerifier({
  issuer,
  audience,
  jwks = null,
  jwksUrl = null,
  jwksTimeoutMs = 5000,
  algorithms,
  insecureIssuerAllowed = false,
  expectedTokenUse = null,
}) {
  if (typeof issuer !== "string" || !issuer) {
    throw new Error("OIDC issuer must be a non-empty string.");
  }
  if (!issuer.startsWith("https://")) {
    if (!insecureIssuerAllowed || !isLoopbackHttpIssuer(issuer)) {
      throw new Error(
        "OIDC issuer must be https://. Plain http is permitted only for " +
        "explicit loopback test issuers with insecureIssuerAllowed " +
        "(tests only); arbitrary remote http issuers are never accepted."
      );
    }
  }
  if (typeof audience !== "string" || !audience) {
    throw new Error("OIDC audience must be a non-empty string.");
  }
  if (jwks && jwksUrl) {
    throw new Error("Set only one of static JWKS or JWKS URL, not both.");
  }
  if (!jwks && !jwksUrl) {
    throw new Error("OIDC key set requires static JWKS or a trusted JWKS URL.");
  }
  if (expectedTokenUse !== null && expectedTokenUse !== undefined && expectedTokenUse !== "") {
    if (typeof expectedTokenUse !== "string" || !/^[A-Za-z0-9_:-]{1,64}$/.test(expectedTokenUse)) {
      throw new Error("OIDC expected token_use must be a short token string (e.g. 'access').");
    }
  }
  const tokenUse = expectedTokenUse || null;
  const algs = parseAlgorithms(algorithms);
  let keySet;
  let mode = "static";
  if (jwks) {
    keySet = jose.createLocalJWKSet(validateJwks(jwks));
  } else {
    const href = validateJwksUrl(jwksUrl, insecureIssuerAllowed);
    // Maintained jose RemoteJWKSet: built-in caching, key rotation via
    // cache headers / cooldown retry, and a bounded fetch timeout. No
    // `jku`/`x5u`/embedded-JWK trust: verification keys come only from this
    // fixed server-configured URL.
    keySet = jose.createRemoteJWKSet(new URL(href), {
      timeoutDuration: parseJwksTimeoutMs(jwksTimeoutMs),
      // Short cooldown (2s) so key rotation is picked up quickly while
      // still rate-limiting attacker-triggered refetches; cache stays
      // 10 min for the steady state.
      cooldownDuration: 2_000,
      cacheMaxAge: 600_000,
    });
    mode = "remote";
  }

  async function verifyPayload(token) {
    if (typeof token !== "string" || !token) return null;
    let payload;
    try {
      // jose ignores `jku`/`x5u`/`jwk` header parameters unless an
      // explicit option opts in (we never opt in), so a token pointing at
      // an attacker URL still verifies only against the trusted set.
      ({ payload } = await jose.jwtVerify(token, keySet, {
        issuer,
        audience,
        algorithms: algs,
        clockTolerance: 30,
        requiredClaims: ["exp", "sub"],
      }));
    } catch {
      return null;
    }
    if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 256) {
      return null;
    }
    // Scoped provider claim: when the operator pins an expectation (e.g.
    // `access` for provider access-tokens), any other value — including an
    // ID token without that claim — is rejected. No ID-token fallback.
    if (tokenUse && payload.token_use !== tokenUse) {
      return null;
    }
    return payload;
  }

  return {
    issuer,
    audience,
    algorithms: algs,
    keySetMode: mode,
    jwksUrl: mode === "remote" ? String(jwksUrl) : null,
    expectedTokenUse: tokenUse,
    async verifyAccountToken(token) {
      const payload = await verifyPayload(token);
      if (!payload) return null;
      return deriveAccountId(issuer, payload.sub);
    },
    // Full verification for GET /v1/account: stable accountId plus minimal
    // display claims from the verified payload. Null when invalid.
    async verifyAccount(token) {
      const payload = await verifyPayload(token);
      if (!payload) return null;
      return {
        accountId: deriveAccountId(issuer, payload.sub),
        issuer,
        subject: payload.sub,
        claims: pickDisplayClaims(payload),
      };
    },
  };
}
