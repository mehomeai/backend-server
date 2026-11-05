// Waitlist storage boundary (waitlist synthetic implementation, ticket W2).
//
// This module defines ONLY the storage contract for POST /api/me/waitlist:
// how a signup row is persisted and what a caller gets back. It contains no
// HTTP behavior, no request validation, no email normalization, no consent
// check, no honeypot handling, and no rate limiting — those live in the
// handler and limiter (ticket W3), mirroring the source handler's shape,
// where storage was a single insert statement inside the route.
//
// Source of the semantics (see docs/waitlist-migration.md for the full
// evidence record): the evidenced Replit handler
// (artifacts/api-server/src/routes/me-waitlist.ts, bridge clone at 453b5f2)
// performs
//
//   db.insert(meWaitlistTable)
//     .values({ email, consentVersion: "launch-updates-v1" })
//     .onConflictDoNothing({ target: meWaitlistTable.email })
//
// against me_waitlist (email TEXT NOT NULL UNIQUE, consent_version TEXT NOT
// NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()). A repeat signup is
// a silent no-op: the original row is preserved exactly, and the public
// receipt is identical either way (receipt preservation is the handler's
// concern, independent of the return values defined here).
//
// ---------------------------------------------------------------------------
// The contract every waitlist store adapter must satisfy:
//
//   insertOrReturnExisting({ email, consentVersion })
//     -> Promise<{ inserted: boolean, row: WaitlistRow }>
//
// - `email` is the ALREADY NORMALIZED address. Normalization (trim, then
//   lowercase) is handler behavior performed before storage is called, per
//   the source's ordering. The store treats the supplied string as the
//   unique key verbatim and performs no normalization itself.
// - First insert: the row is persisted with the supplied consentVersion and
//   a store-generated createdAt. The result's `row` is the persisted row
//   and `inserted` is true.
// - Repeat insert for the same email: NO write happens. The result's `row`
//   is the ORIGINAL persisted row — its consentVersion and createdAt are the
//   values stored by the first insert, never values taken from the repeat
//   request — and `inserted` is false.
// - WaitlistRow is { email, consentVersion, createdAt }, where createdAt is
//   the persisted creation timestamp as an ISO 8601 string. Operational ids
//   (e.g. the source table's serial `id`) stay local to each store and are
//   never part of this contract; the migration payload is exactly
//   email + consent version + timestamp.
// - Failure: a storage failure rejects with WaitlistStorageError, with the
//   underlying error preserved as `cause`. An adapter must not swallow a
//   failure, return a success-shaped result, or return a partially
//   manufactured row. The handler maps WaitlistStorageError — and only
//   that — to the evidenced 503 response. The email-uniqueness conflict is
//   NOT a failure: it is the repeat-insert case above.
// - Caller bugs (missing or non-string email / consentVersion) throw
//   TypeError via validateWaitlistInsert. They are programming errors, not
//   storage failures, and must never reach the 503 path.
// ---------------------------------------------------------------------------
//
// Nothing in this module is constructed at import time: no pool, no
// connection, no credentials, no environment access. (The Replit source's
// lib/db throws at import when DATABASE_URL is unset; the port deliberately
// does NOT reproduce that — ruling change 3 forbids requesting credentials
// while the waitlist flag is disabled.) Adapters are constructed explicitly
// by their callers; the only implementation in this repository today is the
// deterministic in-memory fixture under test/fixtures/, which production
// configuration cannot select. The PostgreSQL adapter is ticket W5 and
// remains UNVERIFIED against PostgreSQL.

/**
 * @typedef {object} WaitlistRow
 * @property {string} email          Normalized email; the unique key.
 * @property {string} consentVersion Consent version as persisted.
 * @property {string} createdAt      Persisted creation time, ISO 8601.
 */

/**
 * @typedef {object} WaitlistInsertResult
 * @property {boolean} inserted      True only when this call created the row.
 * @property {WaitlistRow} row       The persisted row (original on repeats).
 */

/**
 * @typedef {object} WaitlistStore
 * @property {(input: { email: string, consentVersion: string }) =>
 *   Promise<WaitlistInsertResult>} insertOrReturnExisting
 */

// The one error type a waitlist store adapter may surface for a storage
// failure. Callers distinguish it from caller bugs (TypeError) and from
// unexpected programming errors by `instanceof WaitlistStorageError`.
export class WaitlistStorageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "WaitlistStorageError";
  }
}

// Shared caller-bug guard for adapters: enforces the input half of the
// contract identically everywhere, so a TypeError can never be mistaken for
// (or wrapped as) a storage failure downstream.
export function validateWaitlistInsert(input) {
  const { email, consentVersion } = input ?? {};
  if (typeof email !== "string" || email.length === 0) {
    throw new TypeError("waitlist store: email must be a non-empty string (already normalized by the caller).");
  }
  if (typeof consentVersion !== "string" || consentVersion.length === 0) {
    throw new TypeError("waitlist store: consentVersion must be a non-empty string.");
  }
  return { email, consentVersion };
}
