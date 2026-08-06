---
name: reviewing-plans
description: Use immediately after an implementation plan is written and self-reviewed, before the execution handoff and before any task is dispatched. Dispatches a fresh-context reviewer to audit the plan against its spec, and critically to audit REUSE - whether each new file or function duplicates something the codebase already has - then a separate fixer to apply the findings. Triggers on "review the plan", "is this plan ready", "check the implementation plan", or a plan landing in docs/superpowers/plans/.
---

# Reviewing Plans

## Why this exists

Two reasons, and the second is the one that matters.

**The plan is the last artifact with a whole-codebase view.** Once execution starts,
every actor is deliberately narrowed. Implementers are told "don't restructure things
outside your task" and to escalate when work "involves restructuring existing code in ways
the plan didn't anticipate." Task reviewers are told "Do not crawl the broader codebase."
Those are correct safety properties and should not be relaxed.

But together they produce a specific, structural blind spot: **if the plan says "create a
new helper" when a 90%-suitable helper already exists two directories away, nothing
downstream can catch it.** The implementer is forbidden from going to look. The reviewer
is forbidden from crawling to where the original lives. The near-duplicate is not in the
diff, so it is invisible to every review that follows. It lands, and the codebase drifts.

The planner has the full view. This skill is the only gate that uses it.

**The plan also inherits every ambiguity in the spec.** A fresh reader with the spec and
the plan side by side catches requirements that silently evaporated between the two.

## When to Use

- Automatically: a plan was written to `docs/superpowers/plans/`, before execution handoff.
- Manually: `Skill(numatic:reviewing-plans)` on any plan, any time, including a re-run
  after edits.

**When NOT to use:**
- Reviewing the spec -> `numatic:reviewing-specs` (run that first; a spec flaw invalidates
  the plan wholesale, and fixing it after planning means rewriting the plan).
- Reviewing code -> `superpowers:requesting-code-review`.

## Three roles, three contexts

This skill mirrors the shape Superpowers uses for code: **review, apply, and re-check are
three separate fresh contexts, and you orchestrate them.** You are the controller. You do
not review the plan, you do not edit it, and you do not verify the edits.

Two reasons, and both are load-bearing here specifically:

**Quality.** A plan fix has an upstream source of truth - the spec - and the reuse findings
arrive as mechanical instructions (current signature, new signature, call sites, owning
task). Work with a source of truth can be handed to a stranger, and a stranger applies what
the finding says rather than what the author meant. The author's context, which watched the
plan being written, is exactly the bias the review exists to counter.

**Context economy.** Plan fixes are the largest edits in the whole workflow - rewriting
tasks from "create" to "extend" across a long document. Doing that inline loads the full
plan, the full findings, and every edit into the session that then has to run the entire
implementation. Compaction is this workflow's main failure mode, and this is the cheapest
place to avoid feeding it. You hold summaries; the subagents hold the documents.

```dot
digraph reviewing_plans {
    "Gather inputs" [shape=box];
    "Dispatch numatic:plan-reviewer" [shape=box];
    "Findings?" [shape=diamond];
    "Triage: mechanical vs human decision" [shape=box];
    "Dispatch numatic:plan-fixer" [shape=box];
    "Dispatch scoped re-check" [shape=box];
    "Escalate open decisions" [shape=box];
    "Record flag + open decisions" [shape=box];
    "Execution handoff" [shape=doublecircle];

    "Gather inputs" -> "Dispatch numatic:plan-reviewer";
    "Dispatch numatic:plan-reviewer" -> "Findings?";
    "Findings?" -> "Record flag + open decisions" [label="none"];
    "Findings?" -> "Triage: mechanical vs human decision" [label="yes"];
    "Triage: mechanical vs human decision" -> "Dispatch numatic:plan-fixer" [label="mechanical"];
    "Triage: mechanical vs human decision" -> "Escalate open decisions" [label="needs decision"];
    "Dispatch numatic:plan-fixer" -> "Dispatch scoped re-check";
    "Dispatch scoped re-check" -> "Record flag + open decisions";
    "Escalate open decisions" -> "Record flag + open decisions";
    "Record flag + open decisions" -> "Execution handoff";
}
```

### Step 1 - Gather the inputs

The reviewer needs three things:

1. **The plan** - absolute path.
2. **The spec it derives from** - absolute path. Without it the reviewer can only check
   internal consistency, which the author already did.
3. **The scenario list** - confirm the spec has a `## Scenarios` heading, written there by
   `numatic:reviewing-specs`. The reviewer reads the list from the spec file itself; do not
   paste a copy into the dispatch - the file is the source of truth, and a pasted copy can
   go stale against it. Do not re-derive a different list. If the heading is missing, say
   so explicitly in the dispatch and point the reviewer at
   `${CLAUDE_PLUGIN_ROOT}/references/scenario-taxonomy.md` to derive one.

### Step 2 - Dispatch the reviewer

Dispatch the **`numatic:plan-reviewer`** agent. Its system prompt carries the full audit
contract, the severity vocabulary, and the codebase-crawl licence, so your dispatch is just
the brief: see `dispatch-brief.md`.

Do not paste review instructions of your own. The agent definition is the contract; a
second set of instructions in the dispatch is how vocabulary and standards drift.

One reviewer, one round, by default.

### Step 3 - Triage the findings

Split what came back into two piles before dispatching anything:

**Mechanical** - the finding names the task, quotes what it says, and states what it must
say instead. A stranger could execute it. These go to the fixer.

**Needs human decision** - the reviewer marked it as such, or the "fix" would require
choosing between product or architecture options the spec does not settle. These do not go
to a fixer, which would invent an answer and write it into the plan with confidence.
Step 6 writes them into the plan and Step 7 puts them in front of your human partner.

Findings you believe are simply wrong stay with you: say so, with the reason, and do not
forward them.

### Step 4 - Dispatch the fixer

Dispatch the **`numatic:plan-fixer`** agent with the plan path, the spec path, and the
mechanical findings verbatim. Do not summarize the findings - the fixer's fidelity to the
plan depends on receiving the full text, including the extend specifications.

Never apply the findings yourself. Controller edits skip the re-check and reload the whole
plan into the context that still has an implementation run ahead of it.

### Step 5 - Dispatch the scoped re-check

One fresh subagent, given only: the applied findings and the sections the fixer reports it
edited. It answers three questions:

- Does each edit change what the task **instructs**, or was it reworded?
- Is a changed interface reflected everywhere it appears in the plan? A changed signature
  usually touches more than one task.
- Did the edits contradict anything the fixer did not touch?

**One apply round and one re-check. There is no second wave.** Anything still open after
the re-check goes to the human alongside the Step 3 escalations. A plan question that
survives an apply and a re-check is a judgment call, not a defect.

### Step 6 - Record the cross-layer flag and the open decisions

Two things get written into the plan file here, for the same reason: they are read hours
later by skills whose session no longer contains this conversation.

**a. The cross-layer flag.**

Decide whether this plan is **cross-layer**: does the feature traverse more than one layer
that must agree on a contract (client and server, app and admin, schema and rules, service
and consumer, producer and subscriber)? The reviewer returns a verdict; you own the final
call.

Write it into the plan's **Global Constraints**, verbatim:

```
Cross-layer: yes | no
```

The plan file is where this lives because the consumers read it hours later, past
compaction. `yes` means `numatic:tracing-flows` runs before the final review. `no` means it
is skipped. Default to `yes` when uncertain - a skipped trace on a flow that needed one is a
production bug, while an unnecessary trace costs one dispatch.

**b. The open decisions.**

Everything you are escalating to your human partner in Step 7 - the `needs human decision`
findings from Step 3 and anything the re-check left unresolved - also goes into the plan,
under its own heading:

```
## Open decisions

- <the question, in one line> - <the answer, once the human gives one, or `undecided`>
```

Write it whether or not the human has answered yet, and update the line when they do. If
there are none, write the heading with `- none`, so a later reader can tell "nothing was
escalated" from "nobody wrote this down."

This is the same durability argument as the scenario list and the cross-layer flag, and it
closes a specific failure: `numatic:tracing-flows` runs past compaction and, finding no
record, re-derives these questions from scratch. It then reports as a Critical gap something
your human already decided to leave out of scope, or worse, two of its agents reach opposite
conclusions about the same unspecified behavior. A decision that lives only in chat did not
survive. Note that this is the record for **behavior questions the plan deliberately leaves
open**, not a task list - implementation work belongs in tasks.

### Step 7 - Hand off

Report (see Output), put any escalations in front of your human partner, then proceed to the
normal Superpowers execution handoff.

## What the reviewer checks

The contract lives in `agents/plan-reviewer.md` and only there - restating it here is how
the two copies drift. In one line each, in priority order: the reuse audit (every created
thing classified DUPLICATE / NEAR-MATCH / GENUINELY NEW, each near-match argued to an
extend-or-create verdict with a full extend specification - the primary lens), spec
coverage, scenario mapping against the spec's `## Scenarios` list, interface consistency
across tasks, task feasibility and ordering, and the cross-layer verdict.

## Red flags

| Thought | Reality |
|---|---|
| "The plan's self-review already passed" | That was the author checking their own work minutes after writing it. It did not search the codebase. |
| "The implementer will notice the existing utility" | They are instructed not to look and to escalate if they do. That instruction is correct; work with it. |
| "The final code review will catch duplication" | Only if the original is in the diff. It is not - that is the whole problem. |
| "Adding a param to the existing function is refactoring, out of scope" | Extending one function with its call sites named IS the scope. Drift is the alternative. |
| "Reuse is a Minor / nice-to-have" | Duplicated logic that drifts is the defect this plugin exists for. Judge it on the damage. |
| "This plan is small, skip the review" | Small plans create small helpers, which are exactly the ones that duplicate silently. |
| "I'll note 'consider reusing X' in the task" | An implementer forbidden from restructuring will not act on a suggestion. Rewrite the task. |
| "I'll just apply these findings myself, dispatching is overhead" | Controller edits skip the re-check and load the whole plan into the context that still has to run the implementation. |
| "The scenario list is in our conversation already" | It is in the spec's `## Scenarios` section. Read it from the file - conversations get compacted. |
| "This finding needs a design call, I'll pick something sensible" | Then the plan records a decision nobody made. Escalate it. |
| "I escalated it, so it's handled" | Only if you wrote it into the plan's `## Open decisions`. Escalations made in chat do not survive compaction, and the trace re-raises them as findings. |

## Output

Report in chat:

- Verdict: ready to execute / needs fixes / needs rework.
- **Reuse decisions**, each one line: `Task N: extend src/lib/time.ts:44 instead of new
  formatDuration` or `Task N: new function justified - existing one is async-only`.
- Other findings applied, grouped by severity.
- Findings not applied, with reasoning.
- **Open for the human**: escalated decisions and anything the re-check left unresolved.
  These are also written into the plan's `## Open decisions`, not left in chat.
- The cross-layer verdict and what it means for the rest of the flow.

The plan file is the artifact. Do not write a separate review document.
