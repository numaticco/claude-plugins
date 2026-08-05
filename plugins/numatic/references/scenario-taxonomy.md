# Scenario taxonomy

The single source of truth for "what could happen" across `numatic:reviewing-specs`,
`numatic:reviewing-plans`, and `numatic:tracing-flows`. One list, three consumers, so a
scenario named at spec time is the same scenario verified in code later.

Each skill uses it at a different depth:

| Skill | Question it asks of each class |
|---|---|
| `reviewing-specs` | Does the spec say what should happen here, or is it silent? |
| `reviewing-plans` | Does some task actually implement it, and is it testable? |
| `tracing-flows` | Does the shipped code handle it at every layer it passes through? |

## The classes

**1. Happy path.** The intended journey with valid input and an authorized actor. Always
in scope. If a spec only covers this one, that is itself the finding.

**2. Empty and missing data.** No records yet, an optional field absent, a nullable
relation unset, a first-run account, an empty list rendering. The most commonly
under-specified class, and the cheapest to get wrong.

**3. Invalid input.** Wrong type, out of range, malformed identifier, oversized payload,
unexpected encoding. Ask where validation happens and what the caller receives back.

**4. Error and failure.** A dependency times out, returns 5xx, or returns success with a
body that does not parse. Covers retries, backoff, and what surfaces to the user. A spec
that says "handle errors" without saying what the user sees has not covered this.

**5. Permission denied.** An actor authenticated but not authorized. Check both that the
action is blocked and that the block leaks nothing: absent items should be
indistinguishable from forbidden ones where that matters.

**6. Unauthenticated and expired.** No session, expired token, mid-flow session loss.
Distinct from class 5 and frequently conflated with it.

**7. Legacy and migrated data.** Records written before this change existed. New required
field, new enum value, changed shape. Ask what the code does when it reads a row written
by last month's version. Migrations that backfill are a scenario; so is choosing not to.

**8. Concurrency and idempotency.** Two writers on one record, a double-submitted form, a
webhook delivered twice, a retried job. Ask what makes the operation safe to repeat.

**9. Partial failure.** A multi-step operation that succeeds through step 3 and fails at
step 4. Ask what rolls back, what is left behind, and whether the user can retry cleanly.
Anything writing to two systems without a transaction lives here.

**10. Boundary and scale.** Pagination edges, the 1001st item, a very long string, a date
crossing a timezone or DST boundary, an empty vs single-element collection.

## Flow-specific classes

The ten above are the floor, not the ceiling. Derive extra classes from what the flow
actually touches:

- Money -> rounding, currency, refunds, partial captures, chargebacks
- Files -> wrong MIME type, zero bytes, size cap, virus scan pending
- Scheduling -> timezone, DST, recurrence exceptions, past-dated input
- Multi-tenant -> cross-tenant leakage, per-tenant configuration divergence
- Real time -> reconnection, out-of-order delivery, missed events while offline
- Third-party -> rate limits, sandbox vs production divergence, deprecated fields

## Calling a class out of scope

Out of scope is a legitimate answer and often the right one. It has to be explicit and
justified in the spec, not silent. "Concurrency: out of scope, this is a single-writer
admin action" is complete. Saying nothing about concurrency is a gap, because the reader
cannot tell whether it was considered and dismissed or never considered.

## Severity vocabulary

All three skills report with exactly these three labels. No synonyms, no invented tiers,
no `HIGH` / `MEDIUM` / `LOW` / `OK` / `INFO`.

- **Critical** - the flow breaks, data is lost, or authorization is bypassable.
- **Important** - a scenario is mishandled but the damage is recoverable.
- **Minor** - an inconsistency with no current break.

Something verified safe is not a finding. Say so in prose; never give it a number and a
severity.
