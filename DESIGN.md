# Design record - the `numatic` plugin

Why this plugin is shaped the way it is. The README says what it does; this says why, what
was measured rather than assumed, and where it is coupled to things outside our control.

Read this before changing the hook or the review loops. Several parts that look like they
could be simplified are load-bearing, and the reasons are not visible from the code.

House rule since 0.3.4: **skills and agents carry the contract; this file carries the
rationale.** Each contract lives in exactly one place - the agent file for review contracts,
the SKILL.md for orchestration - and other files point at it rather than restating it. When
a fix needs a why longer than a sentence or two, the why lands here. The 0.3.2 N/A change
had to be patched into three files in lockstep; that sync cost is what this rule removes.

Status: built and validated. Verified against Superpowers 6.2.0.

---

## The problem

Superpowers runs a strong loop: brainstorm a spec, write a plan, execute it with subagents,
review the code, finish the branch. Four gaps show up in real use. None is a bug in
Superpowers - three fall directly out of design choices that are correct on their own terms.

### Gap 1 - specs and plans are reviewed by their author; only code gets a stranger

6.2.0 has a self-review for both the spec (brainstorming, checklist item 7) and the plan
(writing-plans, "Self-Review"). Those checklists are not empty - they cover placeholders,
contradictions, scope, and ambiguity.

The gap is not *which questions get asked*. It is **who asks them**. An author checking
their own spec for ambiguity reads every sentence with the intended meaning already in mind,
which is exactly the state in which a second reading is invisible. Code, by contrast, gets a
fresh-context reviewer told `Do Not Trust the Report` (task-reviewer-prompt.md). And no
self-review run from memory walks a scenario taxonomy.

> Do not restate this as "Superpowers only checks form." It is inaccurate against the 6.2.0
> sources and reads as strawmanning to anyone who checks. The honest claim is fresh context
> plus a taxonomy.

### Gap 2 - plans duplicate code instead of extending it

Structural, and produced by three separate constraints that are each individually correct:

- the implementer prompt forbids restructuring outside the task and requires escalation
  (implementer-prompt.md)
- the task reviewer flags out-of-plan changes as "Extra", a spec violation
  (task-reviewer-prompt.md)
- the task reviewer is diff-scoped: "Do not crawl the broader codebase", so a near-duplicate
  in an unchanged file is invisible to it

So when a plan says "create a new helper" and a 90%-suitable helper exists two directories
away: the implementer is forbidden from looking, the reviewer is forbidden from crawling,
and the original is not in the diff. Nothing downstream can catch it.

**Do not fix this at the implementer or reviewer level.** Those constraints are safety
properties - they are what make tasks independently reviewable. The fix belongs at plan
time, because the planner is the last actor with a whole-codebase view.

### Gap 3 - simplification has no slot

`/simplify` is a Claude Code built-in, not a Superpowers skill, so Superpowers does not know
it exists. The SDD flow runs final review -> one fix wave -> finishing. Tasks built in
isolation by subagents that cannot see each other produce duplication by construction, and
nothing removes it.

### Gap 4 - flow tracing happens after review, if at all

Every Superpowers review is diff-scoped; a flow trace is flow-scoped. The scopes are
orthogonal, so a trace finding real defects after a clean code review is expected, not a
review failure. But by then the fixes land after the last gate.

---

## Confirmed decisions

1. The duplication pain is **within-feature reuse of the existing codebase**, not cross-plan
   drift. A plan-time reuse audit is the fix.
2. Spec review is **separate from plan review and runs first**. The plan derives from the
   spec, so a spec flaw invalidates the whole plan, and planning is the most expensive
   authoring step in the workflow.
3. Superpowers-style gerund naming; the plugin is named `numatic`, so skills read
   `numatic:reviewing-specs`.
4. Distribution by company GitHub marketplace with opt-in auto-update. Do **not** fork
   Superpowers: upstream moves fast (6.2.0 added the self-reviews), there is no
   skill-shadowing mechanism, and plugin cache edits are wiped on update. A companion plugin
   plus instruction injection is the only durable mechanism.
5. Reviews follow the SDD shape - review, apply, re-check in separate contexts - with one
   deliberate exception, below.

---

## Verified, not assumed

Everything here was established by running it, on 2026-08-05/06. Where a source disagrees
with intuition, the measurement wins.

| Claim | How it was established |
|---|---|
| Hook matchers match the **tool name only** | Probe plugin with three competing matchers and distinct tokens. `Write` fired, `Skill` fired, `probe:hello` did **not**. Script-side filtering is mandatory. |
| `hookSpecificOutput.additionalContext` reaches the model | Both probe tokens appeared verbatim in the reply. |
| `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` are exported into the script environment | Probe read them from `process.env`, not from command-string substitution. |
| `${CLAUDE_PLUGIN_ROOT}` also resolves inside **SKILL.md body text** | Headless run resolved it to a real absolute path and read the referenced file back. |
| `CLAUDE_PLUGIN_DATA` is populated even under `--plugin-dir` dev mode | Dedupe worked in a `--plugin-dir` session; had it been unset, the second write would have re-fired. |
| Per-session dedupe works end to end | One session, three writes (same plan twice, then a spec): injection counts 1, 0, 1. |
| `writing-plans` writes plans via the `Write` tool to `docs/superpowers/plans/` | Read the skill; no bundled script and no heredoc bypasses the tool. |
| `.claude-plugin/plugin.json` lives at **plugin root**, components do not | Inspected real installs. Corrects earlier research that placed it at the plugin root bare. |
| The plugin `name` field namespaces skills; the repo name never does | Same inspection. Repo can only be renamed at the cost of every teammate re-adding the marketplace. |

**PostToolUse stdin payload keys:** `session_id`, `transcript_path`, `cwd`, `prompt_id`,
`permission_mode`, `effort`, `hook_event_name`, `tool_name`, `tool_input`, `tool_response`,
`tool_use_id`, `duration_ms`. For `Write`, `tool_input.file_path`; for `Skill`,
`tool_input.skill` in `plugin:skill-name` form.

---

## Why the hook is shaped this way

### Trigger on artifacts, not on skill starts

Matching `PostToolUse` on `superpowers:brainstorming` would fire when brainstorming
*starts* - dozens of turns before a spec exists - so the injected instruction would have to
survive the entire skill to matter. Matching the `Write` of the spec fires at the decision
point instead, and couples to artifact paths (stable) rather than skill internals.

### The hook carries state, because the model's memory does not

The first version asked the model at the merge gate: "did simplifying-code run? did
tracing-flows run?" That was unanswerable by construction. The only durable evidence - the
simplification ledger and `flow-trace.md` - lives in the SDD workspace, **which Superpowers
deletes before `finishing-a-development-branch` is invoked**. After a compaction the model
had neither memory nor artifact, and was being asked to attest to history it could not see.

The hook already observes every `Skill` call. It now records which numatic skills actually
ran (marker files under `CLAUDE_PLUGIN_DATA`) and generates the merge-gate message from
those records. The check reports facts.

The same state powers a `SessionStart(compact)` re-injection: if a plan execution started
and its tail has not completed, the pending steps are re-stated after the compaction that
would otherwise have erased them. Superpowers itself re-bootstraps this way.

### The tail message must also say "re-run the review"

A backstop that says "run the missing step now" without saying "then re-review" steers a
compliant model into shipping unreviewed mutations - the precise failure the slot design
exists to prevent.

### Path patterns are narrow on purpose

`PLAN_PATTERN` requires the `YYYY-MM-DD-` prefix Superpowers uses. A bare `/plans?/.*\.md$`
fires on product roadmaps, templates, and meeting notes, and each false positive demands a
plan review with no spec to review against.

---

## Why the loops differ from each other

### reviewing-plans splits review / apply / re-check. reviewing-specs does not.

This asymmetry is deliberate and it is the most likely thing to be "cleaned up" by someone
who has not read this file.

**A plan fix has an upstream source of truth.** The spec settles what is correct, and reuse
findings arrive mechanical (current signature, new signature, call sites, owning task). Work
with a source of truth can be handed to a stranger, and a stranger applies what the finding
says rather than what the author meant. Plan fixes are also the largest edits in the
workflow, and doing them inline loads the whole plan into the session that still has an
entire implementation ahead of it. Compaction is this workflow's main failure mode; this is
the cheapest place to avoid feeding it.

**A spec fix has no upstream source of truth.** "The spec is silent on what happens when the
record does not exist" has its answer in the brainstorming conversation and in the author's
head - not in the spec, not in the codebase, not in the finding. A fresh fixer would not
apply that fix; it would invent a design decision and write it in with confidence, which is
worse than author bias. The independent check a split would buy already exists: the human
gate is the very next step.

The general rule the two cases share: **dispatch what has a source of truth; never dispatch
what requires intent.** Both loops therefore triage findings into mechanical vs
`needs human/author decision`, and only the mechanical pile is ever handed to a fixer.

### tracing-flows owns its fix wave

The first version deferred its findings to the final whole-branch review's fix wave, on the
principle that one gate should own all mutations before merge. That was wrong for four
reasons that compound:

1. **The handoff is voluntary.** The final reviewer's own template (`code-reviewer.md`)
   hands it a git range and diff-shaped checks. Asking it to adopt an external flow-scoped
   findings file fights its template, and nothing reconciles what was handed over against
   what comes back. A dropped finding just disappears.
2. **The fixer loses the map.** Superpowers dispatches one fixer with the reviewer's
   findings. That fixer never sees the flow map, so it fixes one side of a seam.
3. **The verification is structurally blind.** The scoped re-review reads the fix-range
   diff. A seam has two sides; a diff shows one. Only a re-trace can verify a seam fix.
4. **The invariant was already gone.** `numatic:simplifying-code` mutates before the final
   review and the review covers it. Deferring here was inconsistency dressed up as
   discipline.

The real invariant is narrower, and every skill keeps it: **nothing mutates the branch after
the final review closes.** Fixing before the review satisfies that, and the review covers the
fixes for free.

### simplifying-code dispatches one agent that owns find, judge, AND apply

Until 0.4.0 this was the outlier: the orchestrator read the whole branch diff, judged the
candidates, and applied the edits itself. That contradicted the plugin's own cost rule
(below) at the worst possible moment - the whole-branch diff is the single largest read in
the workflow, and it landed in the session that still had the flow trace, the final review,
and the finishing ahead of it.

The `numatic:code-simplifier` agent now owns the entire pass, and the shape differs from
both sibling loops on purpose:

- **No separate fixer, no re-check dispatch.** The review/apply/re-check split exists to
  put a stranger between a finding and its application. Here the independent check already
  exists downstream: the final whole-branch review runs immediately after and reads the
  simplified code. This is the same "the checker is the very next step" argument that lets
  `reviewing-specs` apply its own findings - splitting find from apply would just pay the
  diff twice.
- **Judging can leave the main session** because, unlike a spec fix, it requires no intent
  that lives only in the author's head. Everything the judgment needs - spec, plan,
  progress ledger - is file-borne state. Anything the orchestrator knows that the agent
  cannot read is, by the files-not-chat rule, a durability bug to fix at the source.
- **The agent sizes its own fan-out.** Subagents can nest (three levels deep before the
  Agent tool is withheld), so on a large diff the simplifier dispatches per-category
  finder subagents itself and keeps the cross-category judging in one context. The sizing
  decision lives next to the diff instead of forcing the controller to stat it.

What stays in the main session is exactly the routing: pointing the final review at the
ledger's out-of-diff list, forwarding deferred bug reports, and the `Cross-layer:` branch.

### Reviewers are plugin agents, not pasted prompts

`agents/spec-reviewer.md`, `agents/plan-reviewer.md`, `agents/plan-fixer.md`, and
`agents/flow-fixer.md` bind model, tool policy, and severity vocabulary in frontmatter and a
system prompt. A skill that pastes a prompt file into a generic subagent only *requests*
those things, and drift between runs shows up as reviewers inventing HIGH/MEDIUM/LOW scales
that the orchestrator then has to normalize.

Skills stay as the orchestrators. They hold the loop, the triage, and the human handoff -
work that must stay visible in the main session.

**Consequence:** dispatch briefs carry paths and project context only. Never restate the
review contract in a dispatch; two sources of instruction is how standards drift.

---

## Cross-skill state lives in files, never in the conversation

These handoffs cross a compaction boundary, so each is written to disk and **every
consumer names the location it reads from**:

| State | Written by | Where | Read by |
|---|---|---|---|
| Scenario list | `numatic:reviewing-specs` | the spec's `## Scenarios` heading | `numatic:reviewing-plans`, `numatic:tracing-flows` |
| N/A classes | `numatic:reviewing-specs` | `N/A: <class> - <foreclosing property>` lines under `## Scenarios` | `numatic:reviewing-plans` (skips them), `numatic:tracing-flows` (spot-checks the property still holds) |
| Cross-layer verdict | `numatic:reviewing-plans` | the plan's Global Constraints, as `Cross-layer: yes \| no` | `numatic:simplifying-code`, `numatic:tracing-flows`, the hook's messages |
| Open decisions | `numatic:reviewing-plans` | the plan's `## Open decisions` heading | `numatic:tracing-flows` |
| Out-of-diff fix list | `numatic:tracing-flows` Phase E (from the flow-fixer's report) | `flow-trace.md`, "Changed Outside the Branch Diff" | the final whole-branch review |

The scenario-list entries are concrete behaviors (situation -> expected outcome), not
taxonomy class names - `tracing-flows` dispatches one agent per entry, so an abstract entry
produces an abstract trace. The N/A lines exist because a reviewer verdict that lives only
in the review conversation cannot be distinguished, post-compaction, from a class nobody
considered - the same failure `## Open decisions` closes for plan escalations.

A missing `Cross-layer:` line is treated as `yes`. It usually means the plan review never
ran, and silently skipping the trace in that case is exactly the failure the flag exists to
prevent.

Open decisions are the behavior questions a plan deliberately leaves unsettled, with the
human's answer where there is one. `numatic:tracing-flows` needs them because it runs past
compaction and cannot otherwise distinguish a deliberate omission from a gap: without the
list it reports a decision the human already made as a Critical finding, and independent
agents reason to opposite conclusions about the same silence. An **answered** decision turns
a matching absence into prose, not a finding. An **undecided** one is a finding against the
decision rather than the code, and goes to the human pile rather than to a fixer.

Each row is one place a producer and a consumer must agree, which makes them the rows to
check first when a skill starts behaving as if a step upstream never ran.

Writing the location into the producer is not enough. If a consumer only says "the scenario
list carried forward from the spec review," a post-compaction run falls back to deriving its
own list and verifies scenarios nobody agreed to.

---

## Coupling to Superpowers

**Expect to touch this on major Superpowers releases, roughly once or twice a year.** The
failure mode is silent: if a name or path changes, the hook simply stops firing.

Hard-coded in `hooks/flow-overlay.js`:

- `superpowers:subagent-driven-development`, `superpowers:executing-plans` - tail triggers
- `superpowers:finishing-a-development-branch` - merge-gate backstop
- spec path convention `**/specs/*-design.md`
- plan path convention `**/plans/YYYY-MM-DD-*.md`

Referenced in skill text: `.superpowers/sdd/<plan-basename>/` workspace layout,
`progress.md`, the single-fix-wave shape of the final review.

When upgrading Superpowers, check those five strings first.

---

## Cost guardrails

- **reviewing-specs / reviewing-plans** - never gated. They prevent the expensive loops. The
  plan reviewer gets a capable model deliberately; its reuse audit is judgment, not pattern
  matching.
- **tracing-flows** - gated by the cross-layer flag; `quick` mode for small flows. Its fix
  wave is one fixer for all findings, never one per finding: per-finding fixers each rebuild
  context and re-run the suite.
- **simplifying-code** - always runs (it is the Gap 2 backstop) but is scoped to the branch
  diff plus prior art for what the branch added. The whole pass runs inside the dispatched
  `code-simplifier`; the orchestrator never reads the diff.
- **Main-session context is the scarce resource, not subagent tokens.** Subagent contexts are
  disposable; the orchestrator's context has to survive the whole flow. Every choice to
  dispatch rather than inline is spending the cheap currency to protect the expensive one.

---

## Deliberately not done

- **Forking Superpowers** - see decision 4.
- **A reuse-inventory instruction at plan-authoring time.** The gap analysis proposed it, and
  the `superpowers:writing-plans` trigger is still unused. It would make the review verify
  rather than discover, and cut fix-round cost on the most expensive artifact. Worth doing;
  not done yet.
- **Pruning old dedupe markers.** `CLAUDE_PLUGIN_DATA` accumulates empty marker files. Cheap,
  but unbounded.
- **A Windows `.cmd` shim.** `hooks.json` uses `"shell": "bash"`. Superpowers ships a shim;
  this does not. Fine while the team is macOS.
- **A one-time warning when Superpowers is absent or renamed.** Would convert the silent
  coupling decay above into a visible notice.
