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
runtime confirmation belongs to your project's own verification command and
`superpowers:test-driven-development`. It composes
`superpowers:dispatching-parallel-agents` for the fan-out.

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
  final whole-branch review, when the plan's **Global Constraints** contain
  `Cross-layer: yes`. Read that line from the plan file - `numatic:reviewing-plans` wrote
  it there so it survives compaction. Treat a missing line as `yes`.
- **Standalone:** before shipping any feature, after a change spanning layers, or when
  auditing a flow you did not fully trust.

**When NOT to use:**
- You have a known bug or symptom -> `superpowers:systematic-debugging`.
- You want runtime confirmation -> your project's test or verification command.
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

## The Five Phases

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

- **In the SDD flow, do not re-derive scenarios.** Read the numbered list under the spec's
  `## Scenarios` heading, written there by `numatic:reviewing-specs`. Read it from the spec
  file - by the time this skill runs, the conversation that agreed those scenarios has
  usually been compacted away. Those scenarios were agreed with the human and mapped to
  tasks, so your job is to verify each one actually landed in code at every layer it passes
  through. Re-deriving a different list means you verify scenarios nobody planned while
  missing ones they did. Add newly discovered scenarios to the list - do not silently
  replace it. If the spec genuinely has no `## Scenarios` section, say so in the report,
  then derive from the taxonomy.

  `N/A:` lines under the same heading are taxonomy classes the spec review cleared with a
  foreclosing property (no new writer, no new I/O, ...). Do not trace them as scenarios.
  Spot-check that the property still holds now that the code exists, and raise a finding
  only where implementation introduced exactly what the property said was absent.
- **Standalone**, derive the list from
  `${CLAUDE_PLUGIN_ROOT}/references/scenario-taxonomy.md`, plus flow-specific classes.

**Open decisions** - in the SDD flow, also read the plan's `## Open decisions` section,
written there by `numatic:reviewing-plans`. It records behavior questions the plan
deliberately left unsettled, and the human's answer where there is one.

This is not optional context. You run past compaction, so a question your human already
decided in chat reaches you as an unexplained silence in the code - which is exactly what
this skill is built to flag. Without the list you report a deliberate omission as a Critical
gap, and independent agents reason their way to opposite conclusions about the same
unspecified behavior.

So: an absence covered by an answered open decision is **not a finding** - state it in prose
as decided, and cite the decision. An absence covered by an `undecided` one is a finding
against the decision, not against the code: it goes to the `needs human decision` pile in
Phase E, never to a fixer. If the plan has no `## Open decisions` section, say so in the
report and treat every absence on its merits.

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
5. Append a short list of runtime checks worth running for the riskiest scenarios found -
   the trace is static, so anything that depends on real data or real timing is named here
   rather than claimed as verified.

### Phase E - Fix wave

This skill fixes what it finds. See "Who fixes these findings" below for why.

**1. Triage.** Split the findings:

- **Mechanical** - the spec says what should happen, or one side of a seam defines the
  contract and the other is wrong. A stranger with the flow map could execute it.
- **Needs human decision** - the finding describes behavior nothing specifies. Fixing it
  means inventing product behavior. These never reach a fixer.

**2. Dispatch one `numatic:flow-fixer`** with the complete mechanical findings list plus
the flow map. One fixer, all findings - not one fixer per finding. Per-finding fixers each
rebuild context and re-run the suite, and a fix wave that costs more than the trace defeats
the point.

The fixer is licensed to edit layers outside the branch diff, and returns a list of every
such change. Append that list - the fixer's "Changed Outside the Branch Diff" section,
verbatim - to the trace file (see Output). The final review reads it from there; kept only
in chat it does not survive compaction, and the review then never learns those files
changed.

**3. Scoped re-trace.** Re-run only the affected seams and scenario clusters, plus anything
downstream of a fixed break - `contingent` findings become real once their blocker is fixed.
This is the `--resume` mechanism, invoked here rather than waiting for a user.

**A diff review cannot verify a seam fix.** A seam has two sides and a diff shows one; that
is the whole reason this skill is flow-scoped. Only a re-trace verifies the fix, which is
why the re-check here is a re-trace and not a code review.

**4. One fix wave, one re-trace.** Anything still open after that goes to your human
partner, together with the `needs human decision` pile. Do not loop.

**5. Then the final review runs**, and covers the fixer's changes for free - the same reason
`numatic:simplifying-code` runs before it and not after.

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

| Rationalization | Reality |
|---|---|
| "First failure blocks everything downstream" | Assume it is fixed to spec and trace on. Downstream gaps are real work you would otherwise miss. |
| "I can't know downstream state past the break" | You can reason about it under the spec. Tag it `contingent on #N` and report it. |
| "I found the bug, my job is done" | Your job is ALL gaps, not the first one. |
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

**In the SDD flow, Phase E already runs this mechanism once**, automatically, to verify its
own fix wave. Manual `--resume` is for the standalone loop, or for a second round the human
explicitly asks for after reviewing what Phase E left open.

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

Both templates carry an **Open decisions** block, pasted verbatim from the plan. The agents
are the ones deciding what counts as a finding, so a list held only by the controller does
not stop them raising it. If the plan has no such section, say that in the block rather than
omitting it - "nothing was recorded" and "I did not paste it" have to look different from
inside the agent.

> Open decisions recorded in the plan (behavior deliberately left unsettled, with the human's
> answer where there is one):
> <the list, verbatim, or "The plan has no `## Open decisions` section.">
> An absence covered by an ANSWERED decision is not a finding - say in prose that it is
> decided, and cite the decision. An absence covered by an `undecided` one IS a finding, but
> against the decision rather than the code: mark it `needs human decision`.

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

**File (durability anchor):** full flow map plus all findings. After Phase E, also the fix
wave's outcome: the fixer's "Changed Outside the Branch Diff" section verbatim, and the
re-trace verdict per finding (Fixed / Still-open / New).

- **Standalone:** write to the **session scratchpad** as `tracing-flows-<flow-slug>.md`.
  Outside the repo - never write into the project, never commit it. On `--resume`, append
  to the same file.
- **SDD flow:** write to the SDD workspace as
  `.superpowers/sdd/<plan-basename>/flow-trace.md`, so the final reviewer can read it. That
  workspace is scratch and gets deleted when the run ends. **Never `git add` it.** If the
  repo does not ignore `.superpowers/`, write to the scratchpad instead and hand the
  reviewer the path.

Close with the runtime-check list: the checks worth running against a real environment for
the riskiest scenarios found. This skill is static, so anything depending on real data or
real timing is named here, not claimed as verified.

## Who fixes these findings

This skill owns its fix wave (Phase E). Deferring the findings to the final review's fix
wave was tried and fails: the handoff is voluntary and dropped findings just disappear, the
review's fixer never sees the flow map, and a diff cannot verify a seam fix - a seam has two
sides and a diff shows one. (Full history in the plugin repo's DESIGN.md.) The invariant
that matters is narrower than "one gate owns all mutations", and this skill keeps it:
**nothing mutates the branch after the final review closes.** Fixing before the review
satisfies that, and the review then covers the fixes for free.

## Handing the record to the final review

The final review still receives the trace, now as context and residual triage rather than as
the fix mechanism. When dispatching it, say:

> A flow trace ran before this review and its mechanical findings were fixed. Read
> `<path to flow-trace.md>` for the findings, and its "Changed Outside the Branch Diff"
> section for changes outside your diff range. Those changes are real and unreviewed - the
> trace is flow-scoped and you are diff-scoped, so your git range does not contain them.
> Review them as part of this branch, and triage the residual findings the trace could not
> fix.

Without that, the reviewer never learns that files outside its range were modified.

## Effort scaling

- `quick` - single-agent inline trace, no fan-out. Fast, less thorough. Mechanism 1 still applies.
- default (`auto`) - fan-out scaled to discovered seams and scenarios; light skeptic pass.
- `thorough` - full fan-out plus a full skeptic pass on every finding.

## Common mistakes

- **Stopping at the first blocker** - the number one failure. Mechanism 1 exists for this.
- **Re-deriving scenarios in the SDD flow** - read the spec's `## Scenarios` list from the
  file, then extend it. Do not trust the conversation to still hold it.
- **Skipping the plan's `## Open decisions`** - without it you report decisions your human
  already made as Critical gaps, and two agents argue opposite sides of the same silence.
- **Assuming the stack** - discover layers per project; do not hard-code names.
- **Reporting a gap with no evidence** - every finding cites what you read (file:line).
- **Auditing only changed code** - a flow includes unchanged layers a change now depends on.
- **Trying to run things** - this skill is static; name the runtime checks and hand them to
  your project's verification command.
- **Committing the report** - it is scratch, in the scratchpad or the SDD workspace.
- **Inventing a severity scale** - subagents drifting to HIGH/MEDIUM/LOW forces the main
  agent to normalize labels during synthesis. Enforce the exact vocabulary in every prompt.
