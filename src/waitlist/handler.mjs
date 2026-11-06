// Waitlist HTTP handler (waitlist synthetic implementation, ticket W3).
//
// This module owns the HTTP behavior of POST /api/me/waitlist: execution
// order, input normalization, validation, consent handling, the honeypot
// branch, the exact response literals, and the error mapping. Storage is
// the boundary in src/waitlist/store.mjs; rate limiting is
// src/waitlist/rate-limit.mjs. Per the ruling, the storage test double
// implements none of this behavior, and this handler knows nothing about
// any concrete store.
//
// Source of the behavior (see docs/waitlist-migration.md for the full
// evidence record): artifacts/api-server/src/routes/me-waitlist.ts in the
// bridge clone at 453b5f2, plus the generated Zod schema in
// lib/api-zod/src/generated/api.ts:16-20:
//
//   JoinMeWaitlistBody = zod.object({
//     email:   zod.string().email().max(254),
//     consent: zod.literal(true),
//     website: zod.string().max(200).optional(),   // honeypot
//   })                                             // unknown keys ignored
//
// Execution order (load-bearing; preserved exactly):
//   1. Cache-Control: no-store is attached to EVERY response this handler
//      produces — it is set on the result object before any branch.
//   2. Limiter check-and-increment, keyed from the RAW body. Invalid,
//      consent-failing, honeypot, and storage-failing requests all consume
//      limiter capacity, because the increment precedes every later branch.
//   3. Normalization: for an object body, email is replaced by
//      email.trim().toLowerCase() when it is a string; other fields pass
//      through untouched; a non-object body passes through as-is.
//   4. Validation of the normalized input (schema rules above). Parse
//      failure OR consent !== true -> the single evidenced 400 body.
//   5. Honeypot: a truthy validated `website` returns the success receipt
//      with NO storage write.
//   6. Storage insert with the evidenced consent version; success (first
//      or repeat) returns the same receipt. A WaitlistStorageError is
//      logged via the injected logError and mapped to the evidenced 503;
//      any other error propagates (caller bugs must never reach the 503
//      path — see store.mjs).
//
// The receipt is preserved independently of the store's return value: a
// first signup, a repeat signup, and a honeypot submission are publicly
// indistinguishable, exactly as in the source.
//
// Validation implementation (Zod port, Codex ruling 01a1ae31 step 4,
// 2026-11-05): the schema rules are the generated source schema
// (lib/api-zod/src/generated/api.ts:16-20), implemented with the same Zod
// major version the source pins (zod 3.25.76), so the `.email()`
// acceptance boundary — including exotic address forms — is the
// library-defined one, exactly as in the source and in the frozen T5
// reference (branch waitlist-synthetic-t5 @ 7dfe91a). This supersedes the
// W3 pinned-regex decision: the hand-written pattern is gone, and exotic
// parity is now claimed only insofar as both sides use the same pinned
// Zod version and the same schema shape. The schema is exported so the
// email-boundary corpus (scripts/waitlist-email-corpus.mjs) can run the
// ported path against the T5 oracle.
//
// Framework shape: the handler is a pure async function of
// { ip, body } -> { status, headers, body }, so contract tests exercise
// the real handler without HTTP. `ip` is the request identity supplied by
// the caller (the HTTP layer passes the socket remote address; this
// service configures no trust-proxy anywhere, so forwarded headers are
// never honored — the deployed req.ip value in the source is likewise
// unknown, see docs). `body` is the already-parsed JSON body; body PARSING
// (malformed JSON, content type, size limit) remains the HTTP layer's
// existing behavior and is not reproduced here.

import { z } from "zod";
import { WaitlistStorageError } from "./store.mjs";
import { buildWaitlistLimiterKey } from "./rate-limit.mjs";

// Exact evidenced literals (me-waitlist.ts:10-11, 50-53; receipt text also
// in lib/api-spec/openapi.yaml's contract via the generated response
// schema). Do not edit without new evidence.
export const WAITLIST_CONSENT_VERSION = "launch-updates-v1";
export const WAITLIST_RECEIPT = Object.freeze({
  success: true,
  message: "You're on the list. We'll share Me launch updates with you.",
});
const ERROR_400 = Object.freeze({
  error: "Enter a valid email and agree to receive Me launch updates.",
});
const ERROR_429 = Object.freeze({ error: "Too many attempts. Please try again later." });
const ERROR_503 = Object.freeze({
  error: "We couldn't save your signup. Please try again shortly.",
});

const EMAIL_MAX_LENGTH = 254;
const WEBSITE_MAX_LENGTH = 200;

// The evidenced request schema (source lib/api-zod/src/generated/api.ts,
// Orval output from lib/api-spec/openapi.yaml; same shape as the frozen
// T5 reference): email is a Zod v3 email, max 254 chars; consent must be
// exactly `true`; website (honeypot) is an optional string of at most 200
// chars. Unknown keys are stripped (Zod default), as in the source.
export const JoinMeWaitlistBody = z.object({
  email: z.string().email().max(EMAIL_MAX_LENGTH),
  consent: z.literal(true),
  website: z.string().max(WEBSITE_MAX_LENGTH).optional(),
});

// Validate the NORMALIZED input against the evidenced schema.
// Returns { email, website } on success, null on any failure — the source
// maps every failure kind to the one 400 body, so no detail is returned.
// The consent check is belt-and-braces (the schema is already
// zod.literal(true), so it can never fire on a successful parse); kept to
// match the source line-for-line, as in the T5 reference.
function validateWaitlistInput(input) {
  const parsed = JoinMeWaitlistBody.safeParse(input);
  if (!parsed.success || parsed.data.consent !== true) return null;
  return { email: parsed.data.email, website: parsed.data.website };
}

export function createWaitlistHandler({ store, limiter, logError = () => {} } = {}) {
  if (!store || typeof store.insertOrReturnExisting !== "function") {
    throw new TypeError("waitlist handler: a store implementing insertOrReturnExisting is required.");
  }
  if (!limiter || typeof limiter.checkAndRecord !== "function") {
    throw new TypeError("waitlist handler: a limiter implementing checkAndRecord is required.");
  }
  if (typeof logError !== "function") {
    throw new TypeError("waitlist handler: logError must be a function.");
  }

  return async function handleWaitlistRequest({ ip, body } = {}) {
    // Cache-Control: no-store is attached before ALL response paths.
    const headers = { "cache-control": "no-store" };

    // Limiter first, keyed from the RAW body, before any validation.
    const verdict = limiter.checkAndRecord(buildWaitlistLimiterKey(ip, body));
    if (!verdict.allowed) {
      if (typeof verdict.retryAfterSeconds === "number") {
        headers["retry-after"] = String(verdict.retryAfterSeconds);
      }
      return { status: 429, headers, body: { ...ERROR_429 } };
    }

    // Normalization (source order: after the limiter, before validation).
    const input =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ...body, email: typeof body.email === "string" ? body.email.trim().toLowerCase() : body.email }
        : body;

    const valid = validateWaitlistInput(input);
    if (!valid) {
      return { status: 400, headers, body: { ...ERROR_400 } };
    }

    // Honeypot: truthy validated website -> receipt, no storage write.
    if (valid.website) {
      return { status: 200, headers, body: { ...WAITLIST_RECEIPT } };
    }

    try {
      await store.insertOrReturnExisting({ email: valid.email, consentVersion: WAITLIST_CONSENT_VERSION });
    } catch (err) {
      if (err instanceof WaitlistStorageError) {
        // The underlying error is logged server-side only, never returned.
        logError(err);
        return { status: 503, headers, body: { ...ERROR_503 } };
      }
      throw err;
    }
    return { status: 200, headers, body: { ...WAITLIST_RECEIPT } };
  };
}
