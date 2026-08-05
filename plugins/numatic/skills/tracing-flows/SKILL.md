---
name: tracing-flows
description: Use to confirm a feature or flow is wired end-to-end across every layer it touches (app, admin, data model, security rules, backend functions, events, permissions) before shipping - proactively, with no known bug. Runs automatically before the final code review on cross-layer branches. Triggers on "trace the whole flow", "check end to end", "make sure nothing is missed", "did we update all sides", cross-layer consistency, missing pieces, unhandled scenarios. Static audit only, no runtime.
---

# Tracing Flows - end-to-end consistency audit

## Overview

Statically trace ONE flow through **every layer it touches** and report where a piece is
missing, two layers disagree on a contract, or a scenario is unhandled - proactively,
before anything breaks.

**Core principle:** A flow fails at its weakest seam. Find every seam and every scenario,
confirm each is handled, and report the whole tree of gaps in one pass, not the first leaf.

This skill is **static-only** (read and reason). It does not run the app or the tests -
runtime confirmation belongs to `/verify` and `superpowers:test-driven-development`. It
composes `superpowers:dispatching-parallel-agents` for the fan-out.

## Why it finds things code review does not

Every review in the Superpowers workflow is **diff-scoped**. Task reviewers are told not
to crawl the codebase; the final reviewer reads a git range. That is correct for judging
whether a change is well made.

But a flow includes layers this branch never modified and now depends on. A new required
field lands in the model and the task review approves it, correctly - and the security
rule that validates writes, unchanged for a year, never learns the field exists. It is not
in the diff, so no diff-scoped reviewer can see it.

This skill is **flow-scoped**. The two scopes are orthogonal, which is why running this
after a clean code review still finds real defects. That is expected, not a review failure.

## When to Use

- **In the SDD flow:** automatically, after `numatic:simplifying-code` and before the
  final whole-branch review, when `numatic:reviewing-plans` set `Cross-layer: yes`.
- **Standalone:** before shipping any feature, after a change spanning layers, or when
  auditing a flow you did not fully trust.

**When NOT to use:**
- You have a known bug or symptom -> `superpowers:systematic-debugging`.
- You want runtime confirmation -> `/verify`.
- You are judging a diff's quality -> `superpowers:requesting-code-review`.

## Arguments and scope resolution

`Skill(numatic:tracing-flows)` with optional: free text, `--branch X`, `--resume`,
`quick` | `thorough`.

Resolve **what to trace** in this precedence:

1. **SDD context available** - an SDD workspace exists at
   `.superpowers/sdd/<plan-basename>/`. Trace the flow the plan implements, using the
   plan and spec as the source of truth. This is the automatic path.
2. **Free-text argument** - trace the described flow. Overrides everything.
3. **Neither** - infer from the current branch (`git diff <base>...HEAD`, base = `main` or
   `master`) plus the task under discussion in the current chat.
4. **`--branch X`** - diff against branch X instead of the default base.
5. **`--resume`** - re-trace mode (Mechanism 2 below).

Always emit one crisp **"Flow under trace"** statement first: entry points, the user or
data journey, and the expected end state. Every subagent is anchored to it.

## The Four Phases

### Phase A - Resolve scope

Apply the precedence above. Write the "Flow under trace" statement. Confirm it is the right
flow before spending fan-out.

### Phase B - Map the flow

Discover the project's layers **generically** - repo structure, docs index, build and
manifest files, conventions. Do not assume a stack. Then produce two artifacts:

**Flow map** - each hop, the data shape at that hop, events emitted and their reactions,
persistence reads and writes, permission and authz gates, and the **seams** (hand-offs
between layers).

**Scenario list** - and here the SDD path differs from standalone:

- **In the SDD flow, do not re-derive scenarios.** Take the list from the spec and the
  plan review. Those scenarios were agreed with the human and mapped to tasks. Your job is
  to verify each one actually landed in code at every layer it passes through. Re-deriving
  a different list means you verify scenarios nobody planned while missing ones they did.
  Add newly discovered scenarios to the list - do not silently replace it.
- **Standalone**, derive the list from
  `${CLAUDE_PLUGIN_ROOT}/references/scenario-taxonomy.md`, plus flow-specific classes.

For large maps, use a couple of Explore agents to discover layers in parallel.

### Phase C - Fan-out audit

Dispatch **independent subagents concurrently**, two kinds:

**Seam agents** - one per contract or hand-off. Verify producer and consumer agree on
field names, types, nullability, enum and string values, id formats, and timing or
ordering. This is what catches "model field added, but rules, function, and admin never
updated."

**Scenario agents** - one per scenario cluster. Trace that scenario through the *whole*
flow and confirm every layer handles it, or flag the gap.

Scale the agent count to (#seams + #scenario-clusters). Prompt templates below.

### Phase D - Verify, rank, report

1. Dedup findings across agents.
2. Skeptic pass to cut false positives (full pass in `thorough`, scaled down in `quick`).
3. Rank Critical / Important / Minor.
4. Emit the chat summary and write the full record (see Output).
5. Append a short "runtime checks worth running via `/verify`" list for the riskiest
   scenarios found.

## Exhaustiveness - never stop at the first failure

This is the rule the skill exists to enforce. Two mechanisms.

### Mechanism 1 - Continue under assumed-repair

**A finding is recorded, never a stop condition.** When any agent hits a broken hop, it
logs the finding **and keeps tracing downstream by assuming that piece is repaired to
spec.** Findings discovered past a break are tagged `contingent on #N`.

**Every subagent prompt MUST contain this instruction verbatim:**

> Do NOT stop at the first problem. Record it, assume it is fixed as intended, and continue
> tracing the rest of your unit to the very end. Return ALL findings. Mark any finding that
> depends on an earlier one as `contingent on #N`.

**Red flags - stop, you are about to under-report:**

- "This break blocks the rest, so I'll report it and wait for a fix" -> No. Assume the fix, keep going.
- "The flow can't proceed past here" -> It can *on paper*. Trace under assumed-repair.
- "I found the bug, my job is done" -> Your job is ALL gaps, not the first one.
- "Reporting one clear blocker is cleaner" -> One blocker hides five. Report all five.

| Rationalization | Reality |
|---|---|
| "First failure blocks everything downstream" | Assume it is fixed to spec and trace on. Downstream gaps are real work you would otherwise miss. |
| "I can't know downstream state past the break" | You can reason about it under the spec. Tag it `contingent on #N` and report it. |
| "User will re-run after fixing this" | That is the slow N-cycle loop this skill removes. One pass = whole tree. |
| "Stopping early is safer, less noise" | Under-reporting is the failure mode. Completeness with contingency tags beats a truncated report. |

### Mechanism 2 - `--resume` re-trace

Some gaps are only reachable once a fix lands, because a fix changes a data shape and
opens a new seam. The report file is the **state carrier** between iterations. On
`--resume`:

1. Read the prior trace report.
2. Diff the working tree since that run to see which findings were touched.
3. Re-run the affected seams and scenarios **plus their downstream** - previously
   `contingent` findings become real now - plus a **regression pass**, so a fix that
   introduced a new break is caught.
4. Reclassify every prior finding as **Fixed / Still-open / New**. Append a new dated
   section to the same file, preserving iteration history.

Loop: trace -> user reviews and fixes -> `--resume` -> repeat until a clean pass. Do not
auto-loop; resume is user-driven.

**In the SDD flow, `--resume` is usually unnecessary.** Findings go into the final review's
single fix wave, and that review verifies its own fixes. Use resume when a finding is
severe enough to warrant a dedicated round before review.

## Findings schema

Each finding, in chat and in the file:

```
[#N] <SEVERITY> - <one-line summary>
  layer:      <which layer or component>
  location:   <file:line> (+ the other side of a seam if applicable)
  evidence:   <what you actually read that proves the gap>
  why breaks: <the concrete scenario or input -> wrong outcome>
  fix:        <direction, not a full patch>
  contingent: <#M, or ->
  scenario:   <which scenario from the list, or "newly discovered">
```

Severity is **exactly one of** `Critical` / `Important` / `Minor`. No other label, no
synonyms (not `HIGH`, `MEDIUM`, `LOW`, `OK`, `INFO`), no invented tiers. This is the ONLY
vocabulary; subagents must not substitute their own scale.

- **Critical** - flow breaks, data loss, or an auth hole.
- **Important** - a scenario is mishandled, but recoverable.
- **Minor** - an inconsistency exists, with no current break.

A finding that is not a real gap is not a finding. Do not emit an "OK/INFO" entry - state
verified-safe items in prose.

## Subagent prompt templates

**Seam agent:**

> Flow under trace: <statement>. Flow map: <relevant slice>.
> Your unit: the seam between <producer> and <consumer>.
> Verify they agree on field names, types, nullability, enum and string values, id formats,
> and timing or ordering. Read both sides - cite file:line.
> Do NOT stop at the first problem. Record it, assume it is fixed as intended, and continue
> to the end of this seam. Return ALL findings in the findings schema. Mark dependents as
> `contingent on #N`.
> Severity MUST be exactly one of Critical / Important / Minor - this exact vocabulary,
> no other label (no HIGH/MEDIUM/LOW/OK/INFO, no invented tiers). If something is verified
> safe, say so in prose - do not give it a severity or a finding number.

**Scenario agent:**

> Flow under trace: <statement>. Flow map: <full>.
> Your unit: the "<scenario>" scenario. It came from the spec, so it is a requirement, not
> a hypothesis - if no layer handles it, that is a finding regardless of how unlikely it looks.
> Trace it through EVERY layer. At each layer confirm it is handled or flag the gap. Assume
> nothing - verify by reading code (cite file:line).
> Do NOT stop at the first problem. Record it, assume it is fixed as intended, and continue
> to the end of the flow. Return ALL findings in the findings schema. Mark dependents as
> `contingent on #N`.
> Severity MUST be exactly one of Critical / Important / Minor - this exact vocabulary,
> no other label (no HIGH/MEDIUM/LOW/OK/INFO, no invented tiers). If something is verified
> safe, say so in prose - do not give it a severity or a finding number.

## Output

**Chat (primary):** ranked findings, each self-contained enough to act on ("fix #3")
without re-investigating. Group by severity.

**File (durability anchor):** full flow map plus all findings.

- **Standalone:** write to the **session scratchpad** as `tracing-flows-<flow-slug>.md`.
  Outside the repo - never write into the project, never commit it. On `--resume`, append
  to the same file.
- **SDD flow:** write to the SDD workspace as
  `.superpowers/sdd/<plan-basename>/flow-trace.md`, so the final reviewer can read it. That
  workspace is scratch and gets deleted when the run ends. **Never `git add` it.** If the
  repo does not ignore `.superpowers/`, write to the scratchpad instead and hand the
  reviewer the path.

Close with the `/verify` runtime-check pointer.

## Handing findings to the final review

In the SDD flow this skill does not fix anything. Findings join the final whole-branch
review's single fix wave, which keeps one gate responsible for everything that changes
before merge.

When dispatching the final review, tell it explicitly:

> A flow trace ran before this review. Read `<path to flow-trace.md>`. Its findings are
> part of what you are reviewing. Some concern files outside your diff range - that is
> expected, because the trace is flow-scoped and you are diff-scoped. Treat its Critical
> and Important findings as your own unless you can show they are wrong.

Without that instruction the reviewer will disregard anything outside its diff, and the
findings die there.

## Effort scaling

- `quick` - single-agent inline trace, no fan-out. Fast, less thorough. Mechanism 1 still applies.
- default (`auto`) - fan-out scaled to discovered seams and scenarios; light skeptic pass.
- `thorough` - full fan-out plus a full skeptic pass on every finding.

## Common mistakes

- **Stopping at the first blocker** - the number one failure. Mechanism 1 exists for this.
- **Re-deriving scenarios in the SDD flow** - use the spec's list, then extend it.
- **Assuming the stack** - discover layers per project; do not hard-code names.
- **Reporting a gap with no evidence** - every finding cites what you read (file:line).
- **Auditing only changed code** - a flow includes unchanged layers a change now depends on.
- **Trying to run things** - this skill is static; hand runtime to `/verify`.
- **Committing the report** - it is scratch, in the scratchpad or the SDD workspace.
- **Inventing a severity scale** - subagents drifting to HIGH/MEDIUM/LOW forces the main
  agent to normalize labels during synthesis. Enforce the exact vocabulary in every prompt.
