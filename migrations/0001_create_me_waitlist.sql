-- Migration 0001: create me_waitlist (waitlist synthetic implementation, ticket W5).
--
-- *** UNVERIFIED against PostgreSQL ***
-- This migration has never been applied to a real PostgreSQL database: no
-- PostgreSQL exists on this machine and none may be provisioned (migration
-- step 1 remains BLOCKED — see docs/waitlist-migration.md). It is verified
-- by static review only. The promotion gates in docs/waitlist-migration.md
-- require applying it to an authorized isolated database and inspecting
-- the resulting schema and unique constraint before this label may be
-- removed.
--
-- Convention: this repository had no migration convention before this
-- file (backend-server historically persists to a JSON store). This file
-- establishes the convention: a top-level migrations/ directory of
-- sequentially numbered, descriptively named .sql files, applied in
-- filename order. Future migrations continue the numbering.
--
-- Schema source: the evidenced Replit storage schema
-- (lib/db/src/schema/me-waitlist.ts, Drizzle pgTable, bridge clone at
-- 453b5f2; full record in docs/waitlist-migration.md):
--   id            serial PRIMARY KEY
--   email         text NOT NULL UNIQUE  (the normalized email; uniqueness
--                                        is enforced here, by the database)
--   consent_version text NOT NULL
--   created_at    timestamptz NOT NULL DEFAULT now()
-- There is no update path for this table from the waitlist route: repeat
-- signups are conflict-ignored, and the original consent_version and
-- created_at are preserved.

CREATE TABLE me_waitlist (
    id serial PRIMARY KEY,
    email text NOT NULL UNIQUE,
    consent_version text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
