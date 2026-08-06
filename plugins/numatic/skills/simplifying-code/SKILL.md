---
name: simplifying-code
description: Use after the last implementation task completes and BEFORE the final whole-branch code review, to fold duplication, delete dead code, and remove YAGNI leftovers that accumulated across tasks built in isolation. Also the backstop for code that duplicates utilities the repo already had. Triggers on "simplify this branch", "clean up before review", "reduce duplication", or the end of a subagent-driven-development run.
---

# Simplifying Code

## Why this exists, and why the slot matters

Subagent-driven development produces duplication as a direct consequence of how it
works. Each task is implemented by a subagent that sees only its own brief, cannot see
what its siblings built, and is instructed not to restructure anything outside its task.
That isolation is what makes the tasks independently reviewable. It also means three
tasks can each write their own date formatter and every task review will approve, because
each one is correct in isolation.

Nothing in the standard flow removes that. The final review runs once, produces one fix
wave, and then the branch is finished.

**The slot is the load-bearing part of this skill.** It runs after the last task and
before the final review, never after. Two reasons:

- The final review then reads the simplified code. What you produce here gets reviewed
  for free.
- Nothing mutates the branch after review closes. Simplifying afterward would ship
  unreviewed changes, and folding two functions into one is exactly the kind of change
  that can break a caller.

## When to Use

- Automatically: after the last task in a subagent-driven-development run, before
  dispatching the final whole-branch review.
- Manually: `Skill(numatic:simplifying-code)` on any branch before review.

**When NOT to use:**
- Mid-run, between tasks. Duplication is not visible until the tasks that create it exist.
- After the final review has already approved the branch. Re-review or leave it.
- To hunt bugs. That is the final review's job, and it runs next. If you find one, report
  it - do not fix it here, and do not go looking.

## Scope

**Primary scope: the branch diff.** Everything this branch added or changed, taken as a
whole for the first time.

**Secondary scope, and this one is deliberate: near-duplicates in code the branch did NOT
touch.** For each utility, helper, or type the branch introduced, check whether the repo
already had something equivalent.

This makes the skill the last line of defense for a gap that opens at plan time. Task
implementers cannot look outside their task; task reviewers are told not to crawl the
codebase; the final reviewer sees only the diff, where the pre-existing original does not
appear. `numatic:reviewing-plans` is supposed to catch this before a line is written. When
it misses one, this is the only remaining chance.

**This is one of only two steps in the workflow licensed to modify code outside the task
boundary** - the other is the fix wave in `numatic:tracing-flows`, for the same reason: a
gap whose two halves live on opposite sides of the diff cannot be closed from inside it.
Use the licence deliberately and account for every such change.

## Process

### Step 1 - Establish the diff

Get the branch's base and head. Read the whole diff at once. You are looking at code that
until now has only ever been reviewed in task-sized slices.

### Step 2 - Find the candidates

Work through these categories in order. Fan out to parallel subagents when the diff is
large; each returns candidates, and you decide.

**1. Duplication inside the diff.** The same logic implemented more than once across
tasks. Near-identical functions, parallel branches doing the same transformation,
copy-pasted blocks with one value changed.

**2. Duplication against existing code.** For each new utility or helper, search the repo
for prior art. Same discipline as the plan reuse audit: search by name, by synonym, by
shape, by convention. A hit here means folding new code into the existing function and
updating every caller.

**3. Dead code.** Anything built and never wired up: unused exports, unreferenced
branches, parameters nobody passes, config nobody reads. Common when a task's design
changed partway through implementation.

**4. YAGNI leftovers.** Generality nothing uses. An options object with one caller passing
one shape. An interface with a single implementation and no second one planned. An
abstraction introduced for a case the spec explicitly excluded.

**5. Abstraction altitude.** Indirection that costs more than it saves - a wrapper that
only forwards, a factory producing one type, a layer you have to read through to
understand anything.

**6. Naming.** Names that describe mechanism instead of purpose, names that drifted from
what the code ended up doing, and inconsistent vocabulary for one concept across tasks.

### Step 3 - Judge before you cut

Not every candidate should be acted on. Apply these tests:

- **Is the duplication real, or do the two sites just look alike?** Two functions with
  identical bodies that answer to different requirements will diverge later. Merging them
  creates a coupling that the next change has to undo. Similar code is not duplicate code
  unless it has one reason to change.
- **Does folding make the surviving function worse?** If absorbing the new case means a
  boolean parameter that switches behavior, or unrelated concerns in one body, keep them
  separate and say why.
- **Is the "dead" code actually dead?** Check for dynamic references, string-keyed
  lookups, framework conventions, and public API surface consumers depend on.
- **Would this change behavior?** If yes, it is not simplification. Route it to the final
  review as a finding.

Skipping a candidate for a stated reason is a good outcome. Record it.

### Step 4 - Apply

Make the changes. Keep them mechanical and behavior-preserving.

When folding new code into a pre-existing function, update **every** call site, including
ones this branch never touched, and keep a list. That list is not optional bookkeeping -
it is what lets the final reviewer evaluate a change whose other half is outside the diff
it was given.

Never weaken a test to make a simplification pass. If a test fails, the simplification is
wrong or the test caught a real behavior change. Both mean stop.

### Step 5 - Verify

Run the full test suite. It must pass, and the output must be pristine - no new warnings,
no new noise.

If a test fails, revert that specific simplification rather than fixing forward. You are
between the last task and the final review; leaving a half-applied refactor here is worse
than leaving the duplication.

### Step 6 - Record and hand off

Append a ledger entry to the SDD workspace if one exists
(`.superpowers/sdd/<plan-basename>/progress.md`), then report. The entry must include:

```
## Simplification pass
Applied:
  - <what, where, why>
Files changed outside the branch diff:
  - <file:line> - <which pre-existing function absorbed new behavior, and which callers moved>
Skipped:
  - <candidate> - <why leaving it is correct>
Deferred to final review:
  - <suspected bugs or behavior questions found but not acted on>
Tests: <command, result, pristine yes/no>
```

The "outside the branch diff" section is the important one. Hand it to the final reviewer
explicitly, because those changes are the ones its diff-scoped view will not show it.

Then decide what runs next by **reading the plan's Global Constraints for the
`Cross-layer:` line**, which `numatic:reviewing-plans` wrote there so it would survive
compaction. Do not rely on remembering the verdict.

- `Cross-layer: yes`, or **no line at all** -> run `numatic:tracing-flows` next. It traces
  the flow, fixes what is mechanically fixable, and re-traces, all before the review.
- `Cross-layer: no` -> dispatch the final whole-branch review directly.

Defaulting a missing flag to `yes` is deliberate: it usually means the plan review never
ran, and silently skipping the trace in that case is exactly the failure the flag exists to
prevent.

## Red flags

| Thought | Reality |
|---|---|
| "I'll simplify after the review passes" | Then it ships unreviewed. The slot is before review, always. |
| "This looks like a bug, let me fix it" | Report it, do not fix it. The review runs next and is built for it. |
| "These two functions look similar, merge them" | Similar is not duplicate. Merge only what has one reason to change. |
| "The test broke, I'll adjust the test" | The test caught you. Revert the simplification. |
| "I should check the whole codebase for cleanup opportunities" | Scope is this branch, plus prior art for what this branch added. Not a repo-wide refactor. |
| "Folding into the old function means touching files outside the diff" | Yes. That is licensed here, and only here. List every one. |
| "The branch is small, skip this" | Small branches still duplicate against existing code. That check is cheap. |

## Output

- What was simplified, grouped by category, one line each.
- Changes outside the branch diff, called out separately with their call sites.
- What was skipped and why.
- Anything deferred to the final review.
- Test result.

Keep it short. The next step is a review that reads the code itself.
