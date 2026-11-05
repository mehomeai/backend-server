// Deterministic in-memory WaitlistStore — TEST FIXTURE ONLY.
//
// This is the test double for the storage boundary defined in
// src/waitlist/store.mjs. It implements storage semantics ONLY:
// insert-or-return-existing keyed by the supplied (already normalized)
// email, returning the persisted row verbatim on repeats. It performs NO
// email-shape validation, NO normalization, NO consent rule, NO honeypot
// handling, and NO rate limiting — those behaviors belong to the handler
// and limiter, and per the ruling the storage double must not duplicate
// them.
//
// Selection: this module is imported directly by tests under test/. It
// cannot be selected by production configuration — nothing under src/
// imports it, and no environment variable or config key references it.
//
// Determinism: row timestamps come from the injected `now` clock (default:
// the real clock). Tests inject fixed/stepping clocks so createdAt values
// are exact and reproducible.

import { WaitlistStorageError, validateWaitlistInsert } from "../../src/waitlist/store.mjs";

export function createMemoryWaitlistStore({ now = () => new Date() } = {}) {
  const rowsByEmail = new Map();
  let armedFailure = null;

  return {
    // The WaitlistStore contract (see src/waitlist/store.mjs).
    async insertOrReturnExisting(input) {
      const { email, consentVersion } = validateWaitlistInsert(input);
      if (armedFailure !== null) {
        const cause = armedFailure;
        armedFailure = null;
        throw new WaitlistStorageError("in-memory waitlist store: injected storage failure", { cause });
      }
      const existing = rowsByEmail.get(email);
      if (existing) {
        // Repeat insert: no write; return the persisted row, never values
        // manufactured from the repeat request. A copy is returned so a
        // caller mutating the result cannot corrupt persisted state.
        return { inserted: false, row: { ...existing } };
      }
      const row = {
        email,
        consentVersion,
        createdAt: new Date(now()).toISOString(),
      };
      rowsByEmail.set(email, row);
      return { inserted: true, row: { ...row } };
    },

    // --- Test-only surface below: NOT part of the WaitlistStore contract. ---

    // Number of persisted rows.
    size() {
      return rowsByEmail.size;
    },

    // Copies of all persisted rows, in insertion order.
    rows() {
      return [...rowsByEmail.values()].map((row) => ({ ...row }));
    },

    // Arm a one-shot storage failure: the next insert rejects with a
    // WaitlistStorageError whose `cause` is the given error, and writes
    // nothing. Later inserts behave normally again.
    failNextInsert(error = new Error("injected storage failure")) {
      armedFailure = error;
    },
  };
}
