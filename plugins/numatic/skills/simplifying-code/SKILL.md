---
name: simplifying-code
description: Use after the last implementation task completes and BEFORE the final whole-branch code review, to fold duplication, delete dead code, and remove YAGNI leftovers that accumulated across tasks built in isolation. Also the backstop for code that duplicates utilities the repo already had. Dispatches the numatic:code-simplifier agent; the orchestrator never reads the branch diff. Triggers on "simplify this branch", "clean up before review", "reduce duplication", or the end of a subagent-driven-development run.
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
- To hunt bugs. That is the final review's job, and it runs next.

## You are the controller, not the simplifier

You dispatch one **`numatic:code-simplifier`** agent and route what comes back. You do not
read the branch diff, you do not judge candidates, and you do not apply edits. The whole
pass - find, judge, apply, verify, ledger - happens inside the agent's disposable context.

The reason is the same one that shapes every loop in this plugin: your context has to
survive the rest of the flow - the flow trace, the final review, the finishing - and the
whole-branch diff is the single largest read in the workflow. Everything the judgment
needs (spec, plan, progress ledger) lives in files the agent can read; anything you know
that it cannot is, by this plugin's own rules, state that should have been written down.

The agent sizes the work itself: on a large diff it fans out finder subagents internally,
one per category, and keeps the judging in one place. That decision belongs next to the
diff, not with you.

### Step 1 - Gather the inputs

No diff reading. Collect:

1. **Base and head refs** for the branch (`main` or `master` unless the run says otherwise).
2. **Plan and spec paths**, if this is an SDD run.
3. **The progress ledger path** - `.superpowers/sdd/<plan-basename>/progress.md` - if the
   workspace exists. The agent appends its ledger entry there.

### Step 2 - Dispatch the simplifier

Dispatch **`numatic:code-simplifier`** with those refs and paths. Its system prompt carries
the full contract - scope, categories, judgment tests, the out-of-diff licence, the test
discipline, the ledger format. Do not restate any of it in the dispatch; the brief is refs,
paths, and project context only.

One simplifier, one pass. There is no re-check dispatch: the final whole-branch review runs
next and reads the simplified code, so the independent check already exists downstream.

### Step 3 - Relay the report

The agent returns a five-section report (applied / outside-the-diff changes / skipped /
deferred / tests). Surface it in chat. Two sections need routing:

- **Files changed outside the branch diff** - when you later dispatch the final review,
  point it at the ledger entry in `progress.md` explicitly. The reviewer is diff-scoped
  and its git range does not contain those changes.
- **Deferred to final review** - suspected bugs and behavior questions the simplifier
  found but correctly did not touch. Same routing: name them to the final review.

If the agent reports a failed test suite it could not resolve by reverting, stop and put
that in front of your human partner before anything else runs.

### Step 4 - Decide what runs next

Read the plan's Global Constraints for the `Cross-layer:` line, which
`numatic:reviewing-plans` wrote there so it would survive compaction. Do not rely on
remembering the verdict.

- `Cross-layer: yes`, or **no line at all** -> run `numatic:tracing-flows` next. It traces
  the flow, fixes what is mechanically fixable, and re-traces, all before the review.
- `Cross-layer: no` -> dispatch the final whole-branch review directly.

Defaulting a missing flag to `yes` is deliberate: it usually means the plan review never
ran, and silently skipping the trace in that case is exactly the failure the flag exists to
prevent.

## What the simplifier does

The contract lives in `agents/code-simplifier.md` and only there - restating it here is how
the two copies drift. In one line each: duplication inside the diff, duplication against
pre-existing code (the gap-2 backstop, and one of only two licensed out-of-diff mutations
in the workflow - the other is the fix wave in `numatic:tracing-flows`), dead code, YAGNI
leftovers, abstraction altitude, and naming - each candidate judged before it is cut, every
change behavior-preserving, the full suite run before it returns.

## Red flags

| Thought | Reality |
|---|---|
| "I'll simplify after the review passes" | Then it ships unreviewed. The slot is before review, always. |
| "I'll read the diff and do this myself, dispatching is overhead" | The whole-branch diff is the largest read in the workflow, and your context still has the trace, the review, and the finishing ahead of it. Dispatch it. |
| "The agent should check back before applying" | The final review is the check, and it runs next. A round-trip here loads the candidates into the context the dispatch exists to protect. |
| "The branch is small, skip this" | Small branches still duplicate against existing code. That check is cheap. |
| "I'll summarize the out-of-diff list for the reviewer" | Point the reviewer at the ledger in `progress.md` instead. A summary in chat does not survive compaction; the file does. |

## Output

Relay the simplifier's report: what was applied by category, changes outside the branch
diff called out separately, what was skipped and why, anything deferred to the final
review, and the test result. Then state which step runs next and why (the `Cross-layer:`
verdict).

Keep it short. The next step is a review that reads the code itself.
