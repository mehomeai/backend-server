// PostgreSQL adapter for the waitlist storage boundary (ticket W5).
//
// *** UNVERIFIED against PostgreSQL ***
// This adapter has never been run against a real PostgreSQL database: no
// PostgreSQL exists on this machine and none may be provisioned (migration
// step 1 remains BLOCKED — see docs/waitlist-migration.md). Its only
// verification is static review plus mocked-driver tests
// (test/waitlist-postgres-store.test.mjs). Those tests do NOT verify
// PostgreSQL syntax, migrations, isolation behavior, or uniqueness
// enforcement. The promotion gates in docs/waitlist-migration.md list the
// evidence required before this label may be removed.
//
// The adapter implements the contract in src/waitlist/store.mjs:
// insert-or-return-existing keyed by the already-normalized email,
// returning the PERSISTED row; storage failures surface only as
// WaitlistStorageError with the underlying error as `cause`.
//
// Laziness (ruling change 3): importing this module creates no pool, loads
// no driver, reads no environment, and requests no credentials. The pool
// is constructed by an injected factory, invoked at most once, on the
// first actual storage operation — which can only happen behind enabled
// configuration that supplies the factory. Nothing in this repository's
// running configuration constructs this adapter today: the enabled-route
// integration (ticket W4) requires an injected store and fails closed
// without one, and no production wiring selects this adapter.
//
// Concurrency reasoning for the insert-or-return-existing shape
// (INSERT ... ON CONFLICT DO NOTHING RETURNING, then SELECT on no-row):
// - The INSERT is a single atomic statement. It never updates an existing
//   row, so the original consent_version and created_at can never be
//   overwritten by a repeat or concurrent submission — conflict handling
//   is DO NOTHING, and uniqueness is enforced by the database's UNIQUE
//   constraint on me_waitlist.email, not by application code.
// - Under PostgreSQL's default READ COMMITTED, if a concurrent
//   transaction has inserted the same email but not yet committed, the
//   INSERT waits for that transaction to finish. If it commits, this
//   statement skips the insert and returns zero rows, and the conflicting
//   row is committed and therefore visible to the follow-up SELECT (each
//   statement in autocommit mode reads a fresh snapshot). If it aborts,
//   the INSERT proceeds and returns the new row. Either way exactly one
//   row ever exists for an email and every caller ends up with the
//   persisted row.
// - The one residual anomaly — INSERT returns no row AND the SELECT finds
//   no row — would require the conflicting row to vanish between the two
//   statements (nothing in this system deletes waitlist rows). The
//   adapter treats it defensively: the insert-or-select cycle retries
//   once, and if the anomaly persists it surfaces a WaitlistStorageError
//   instead of manufacturing a row (which the contract forbids).
// - All values travel as bound parameters ($1, $2). No value is ever
//   interpolated into SQL text.

import { WaitlistStorageError, validateWaitlistInsert } from "./store.mjs";

export const WAITLIST_INSERT_SQL =
  "INSERT INTO me_waitlist (email, consent_version) VALUES ($1, $2) " +
  "ON CONFLICT (email) DO NOTHING " +
  "RETURNING email, consent_version, created_at";

export const WAITLIST_SELECT_BY_EMAIL_SQL =
  "SELECT email, consent_version, created_at FROM me_waitlist WHERE email = $1";

// One initial cycle + one retry of the insert-or-select cycle (see the
// concurrency note above).
const MAX_CYCLES = 2;

function mapPersistedRow(row) {
  const createdAt =
    row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString();
  return { email: row.email, consentVersion: row.consent_version, createdAt };
}

function toStorageError(action, cause) {
  if (cause instanceof WaitlistStorageError) return cause;
  return new WaitlistStorageError(`postgres waitlist store: ${action}`, { cause });
}

/**
 * Create the PostgreSQL WaitlistStore.
 *
 * @param {object} options
 * @param {() => (object|Promise<object>)} options.poolFactory Zero-argument
 *   factory returning a pool (or a promise of one). A pool is any object
 *   with `connect()` resolving to a client that exposes
 *   `query(text, values)` and `release()` — the `pg` Pool shape. The
 *   factory is invoked lazily, at most once, on the first storage
 *   operation; constructing the store invokes nothing.
 */
export function createPostgresWaitlistStore({ poolFactory } = {}) {
  if (typeof poolFactory !== "function") {
    throw new TypeError("postgres waitlist store: a poolFactory function is required.");
  }
  let poolPromise = null;
  const getPool = () => {
    if (poolPromise === null) {
      poolPromise = Promise.resolve().then(() => poolFactory());
    }
    return poolPromise;
  };

  return {
    // The WaitlistStore contract (see src/waitlist/store.mjs).
    async insertOrReturnExisting(input) {
      // Caller bugs throw TypeError before any pool work begins.
      const { email, consentVersion } = validateWaitlistInsert(input);

      let pool;
      try {
        pool = await getPool();
      } catch (err) {
        throw toStorageError("pool construction failed", err);
      }

      let client;
      try {
        client = await pool.connect();
      } catch (err) {
        throw toStorageError("could not acquire a client", err);
      }

      try {
        for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
          const insertResult = await client.query(WAITLIST_INSERT_SQL, [email, consentVersion]);
          if (insertResult.rows.length > 0) {
            return { inserted: true, row: mapPersistedRow(insertResult.rows[0]) };
          }
          // Conflict: the row already exists. Return the persisted row —
          // its consent_version and created_at come from the database,
          // never from this request.
          const selectResult = await client.query(WAITLIST_SELECT_BY_EMAIL_SQL, [email]);
          if (selectResult.rows.length > 0) {
            return { inserted: false, row: mapPersistedRow(selectResult.rows[0]) };
          }
          // No row inserted and no row visible: the residual anomaly from
          // the concurrency note. Retry the cycle once; a repeat means
          // something is deeply wrong, so fail loudly below.
        }
        throw new WaitlistStorageError(
          "postgres waitlist store: insert conflicted but no persisted row is visible",
          { cause: new Error("insert-or-select cycle found no row after conflict") },
        );
      } catch (err) {
        throw toStorageError("insert failed", err);
      } finally {
        // The client must return to the pool on every path. A release
        // failure must not mask the operation's own outcome, so it is
        // deliberately not propagated.
        try {
          client.release();
        } catch {
          // Ignored: see above.
        }
      }
    },

    // Adapter extra (NOT part of the WaitlistStore contract): end the pool
    // if — and only if — it was ever constructed. Used for orderly
    // shutdown by whatever operator wiring eventually enables this store.
    async close() {
      if (poolPromise === null) return;
      const pending = poolPromise;
      poolPromise = null;
      let pool;
      try {
        pool = await pending;
      } catch {
        return; // Construction failed earlier; there is no pool to end.
      }
      if (pool && typeof pool.end === "function") {
        try {
          await pool.end();
        } catch (err) {
          throw toStorageError("pool shutdown failed", err);
        }
      }
    },
  };
}

/**
 * Build a poolFactory backed by the real `pg` driver. The driver is
 * loaded with a dynamic import ONLY when the returned factory is first
 * invoked — importing this module, or creating the factory, loads nothing
 * and reads no credentials. The connection string is supplied explicitly
 * by the caller's configuration; this module never reads the environment.
 *
 * @param {object} options
 * @param {string} options.connectionString PostgreSQL connection string.
 */
export function createPgPoolFactory({ connectionString } = {}) {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new TypeError("postgres waitlist store: connectionString must be a non-empty string.");
  }
  return async function pgPoolFactory() {
    const { default: pg } = await import("pg");
    return new pg.Pool({ connectionString });
  };
}
