// Email-boundary corpus runner for the waitlist Zod validation port
// (Codex ruling 01a1ae31 step 4, 2026-11-05).
//
// Compares the T5 frozen-branch oracle schema against the ported W
// schema on every case in waitlist-email-corpus.json. The oracle is the
// expectation: any mismatch is a failure (exit 1). Both paths receive
// the same input: the handler's normalization (trim, then lowercase, for
// string emails) applied first, then safeParse({ email, consent: true })
// against the identical schema shape (zod 3.25.76).
//
// Usage:
//   node scripts/waitlist-email-corpus.mjs [path-to-t5-waitlist.mjs]
// The oracle path defaults to the frozen-reference worktree
// /tmp/waitlist-t5-oracle/src/waitlist.mjs (branch waitlist-synthetic-t5
// @ 7dfe91a, read-only). The W schema is imported from this repo's
// src/waitlist/handler.mjs, so run from the port branch.
//
// The T5 worktree needs `zod` resolvable from its own location; a
// node_modules symlink to this repo's node_modules is sufficient
// (zod 3.25.76 is a dependency of this repo after the port).

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { JoinMeWaitlistBody as WSchema } from "../src/waitlist/handler.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const oraclePath =
  process.argv[2] ?? "/tmp/waitlist-t5-oracle/src/waitlist.mjs";
const { JoinMeWaitlistBody: OracleSchema } = await import(
  pathToFileURL(oraclePath).href
);

const { cases } = JSON.parse(
  readFileSync(join(here, "waitlist-email-corpus.json"), "utf8"),
);

// Mirror the handler's normalization step exactly (handler.mjs):
// for an object body, a string email is replaced by trim().toLowerCase()
// before validation; anything else passes through untouched.
function normalize(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : email;
}

let mismatches = 0;
for (const [i, { email, note, source }] of cases.entries()) {
  const input = { email: normalize(email), consent: true };
  const oracle = OracleSchema.safeParse(input).success;
  const ported = WSchema.safeParse(input).success;
  const match = oracle === ported;
  if (!match) mismatches += 1;
  console.log(
    `${match ? "MATCH  " : "MISMATCH"} #${String(i + 1).padStart(2)} oracle=${oracle ? "valid  " : "invalid"} ported=${ported ? "valid  " : "invalid"} ${JSON.stringify(email)} — ${note} [${source}]`,
  );
}
console.log(
  `\n${cases.length - mismatches}/${cases.length} cases match; ${mismatches} mismatch(es).`,
);
if (mismatches > 0) {
  console.error("CORPUS FAILED: ported validation differs from the T5 oracle.");
  process.exit(1);
}
console.log("CORPUS PASSED: ported validation matches the T5 oracle on every case.");
