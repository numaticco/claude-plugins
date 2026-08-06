# Numatic Claude Plugins

Claude Code plugins for Numatic Ventures engineering.

This repo is a **plugin marketplace**. Adding it once gives you every plugin listed here,
and updates arrive by pulling the repo.

| Plugin | What it does |
|---|---|
| `numatic` | Extends the [Superpowers](https://github.com/obra/superpowers) workflow with fresh-context spec and plan review, a plan-time reuse audit, a simplification pass, and end-to-end flow tracing. |

## Install

```bash
claude plugin marketplace add numaticco/claude-plugins
claude plugin install numatic@numatic
```

Or from inside a Claude Code session: `/plugin marketplace add numaticco/claude-plugins`,
then `/plugin install numatic@numatic`.

Private repo, so you need git access to `numaticco` - SSH keys or a credential helper. If
`git clone` works, so does this.

**Requires the `superpowers` plugin.** The `numatic` plugin layers onto that workflow and
does nothing useful without it.

```bash
claude plugin install superpowers@claude-plugins-official
```

### Updates

```bash
claude plugin marketplace update numatic
```

Auto-update is off by default for third-party marketplaces. Turn it on once per machine in
`/plugin`, under the marketplace's settings, and you stop thinking about it.

### Recommending it to a project

Check this into a project's `.claude/settings.json` and teammates get prompted to install
on their next session:

```json
{
  "extraKnownMarketplaces": {
    "numatic": {
      "source": {
        "source": "github",
        "repo": "numaticco/claude-plugins"
      }
    }
  },
  "enabledPlugins": {
    "numatic@numatic": true
  }
}
```

This recommends, it does not silently install. Each person still confirms.

---

# The `numatic` plugin

## What problem it solves

Superpowers runs a strong loop: brainstorm a spec, write a plan, execute it with subagents,
review the code, finish the branch. Four gaps show up in real use. None is a bug in
Superpowers - three of them fall directly out of design choices that are correct on their
own terms.

**1. Specs and plans are reviewed by their author; only code gets a stranger.** Superpowers
6.2 has a spec self-review and a plan self-review, and those checklists are not shallow -
they cover placeholders, contradictions, scope, and ambiguity. The gap is not which
questions get asked. It is **who asks them**. An author checking their own spec for
ambiguity reads every sentence with the intended meaning already in mind, which is exactly
the state in which a second reading is invisible. Code, by contrast, gets a fresh-context
reviewer told `Do Not Trust the Report`. And no checklist run from memory walks a scenario
taxonomy, so a spec can be free of placeholders, internally perfect, and still silent about
what happens when the record is missing.

**2. Plans duplicate code instead of extending it.** This one is structural. Implementers
are told "don't restructure things outside your task." Task reviewers are told "Do not
crawl the broader codebase." So when a plan says "create a new helper" and a 90%-suitable
helper already exists two directories away, the implementer is forbidden from looking, the
reviewer is forbidden from crawling to where the original lives, and the original is not in
the diff. Nothing downstream can catch it. The codebase drifts, one small helper at a time.

**3. Simplification has no slot.** The built-in `/simplify` exists, but Superpowers does not
know about it, so the flow goes from the last task straight to review and then to the merge
prompt. Tasks built in isolation by subagents that cannot see each other produce duplication
by construction, and nothing removes it.

**4. Flow tracing happens too late, if at all.** Every Superpowers review is diff-scoped. A
flow includes layers the branch never touched and now depends on - the security rule that
does not know about the new field, the admin screen that never learned the new state. No
diff-scoped reviewer can see them.

## What it adds

```
brainstorm
  -> spec self-review (superpowers)
  -> numatic:reviewing-specs          <- NEW: fresh-context content review
  -> human spec gate
  -> writing-plans
  -> plan self-review (superpowers)
  -> numatic:reviewing-plans          <- NEW: spec coverage + REUSE AUDIT + cross-layer flag
  -> subagent-driven development      (unchanged)
  -> numatic:simplifying-code         <- NEW: fold duplication, incl. against existing code
  -> numatic:tracing-flows            <- NEW: end-to-end trace + its own fix wave, if cross-layer
  -> final whole-branch review        (now covers all of the above)
  -> finishing-a-development-branch
```

Two placement decisions carry most of the value:

- **`reviewing-specs` runs before planning**, not alongside it. The plan derives from the
  spec, so a spec flaw invalidates the whole plan. Planning is the most expensive authoring
  step in the workflow; catching spec problems first is what stops it being paid twice.
- **`simplifying-code` and `tracing-flows` run before the final review**, never after. The
  review then covers their output for free, and nothing mutates the branch after the last
  gate closes.

## The skills

Each is invocable on its own at any time, so you can re-run one without re-running the flow.

### `numatic:reviewing-specs`

Dispatches the `numatic:spec-reviewer` agent to review the spec's *content*: scenario
coverage against a shared taxonomy, ambiguity (could this be read two ways?), decomposition,
and testability. The findings come back, **you apply them in the main session**, and a
scoped re-read confirms they landed. The human then reviews a spec that already survived an
adversarial read.

Before handing off, the agreed scenario list is written into the spec under a `## Scenarios`
heading. Both downstream skills read it from there.

### `numatic:reviewing-plans`

The important one, and the only three-role loop in the plugin: `numatic:plan-reviewer`
finds, `numatic:plan-applier` fixes, and a scoped re-check confirms. All three are separate
contexts; the orchestrator keeps the triage and the human handoff.

The reviewer is **explicitly permitted to crawl the codebase**, unlike every other reviewer
in the workflow, and audits:

- **Reuse.** For every file, function, and type the plan creates: does prior art exist? Each
  is classified `DUPLICATE`, `NEAR-MATCH`, or `GENUINELY NEW`, and near-matches get an
  argued extend-or-create verdict. Where the verdict is extend, the plan is rewritten to say
  so concretely: current signature, new signature, every call site that changes, and which
  task owns it. A hint would not survive contact with an implementer who is instructed not
  to restructure.
- Spec coverage, scenario-to-task mapping, interface consistency, task feasibility.
- Whether the feature is **cross-layer**, recorded as `Cross-layer: yes|no` in the plan's
  Global Constraints. That line decides whether `tracing-flows` runs later, and lives in the
  file so it survives compaction.

Findings that require a decision nothing specifies are never handed to the applier. They go
to your human partner.

### `numatic:simplifying-code`

Runs after the last task, before the final review. Folds duplication introduced across
tasks, and duplication against code that already existed - the backstop for gap 2 when the
plan review missed one. Also removes dead code, YAGNI leftovers, and needless indirection.

This is one of two steps in the workflow licensed to modify code outside the task boundary,
so it lists every out-of-diff change it made and hands that list to the final reviewer,
whose diff-scoped view would not otherwise show it.

### `numatic:tracing-flows`

Statically traces one flow through every layer it touches, fanning out one subagent per seam
and one per scenario cluster. Its defining rule is **never stop at the first failure**: a
broken hop is recorded, then tracing continues under the assumption that it is repaired, so
one pass returns the whole tree of gaps instead of the first leaf.

It then **fixes what it found**. One `numatic:flow-fixer` takes all mechanically-fixable
findings plus the flow map - both sides of every seam - and a scoped re-trace verifies the
result. One wave, then anything still open goes to the human. A diff review cannot verify a
seam fix, because a seam has two sides and a diff shows one; that is why the check here is a
re-trace and not a code review.

In the SDD flow it takes its scenario list from the spec's `## Scenarios` heading rather
than re-deriving one. Standalone, it keeps a `--resume` mode for re-tracing after fixes.

## The agents

Reviewers and appliers are plugin agents, not prompts pasted into a generic subagent. The
frontmatter binds model and tool policy; the system prompt holds the review contract and the
severity vocabulary. A skill that pastes a prompt only requests those things, and the drift
shows up as reviewers inventing their own severity scales.

| Agent | Role |
|---|---|
| `numatic:spec-reviewer` | Reviews spec content. Read-only plus search. |
| `numatic:plan-reviewer` | Reviews the plan and runs the reuse audit. Read-only plus search, capable model. |
| `numatic:plan-applier` | Applies plan-review findings. Edits the plan document only, never source. |
| `numatic:flow-fixer` | Applies flow-trace findings. Licensed to edit outside the branch diff, and reports every such change. |

Dispatch briefs carry paths and project context only. The contract lives in the agent.

**Why `reviewing-plans` splits apply out and `reviewing-specs` does not:** a plan fix has an
upstream source of truth (the spec settles what is correct, and reuse findings arrive
mechanical), so a stranger can execute it. A spec fix does not - "the spec is silent on what
happens when the record is missing" has its answer in the brainstorming conversation and in
your head, and a fresh applier would invent a design decision rather than apply one. The
independent check a split would buy is already there: the human gate is the next step.

## How it runs automatically

A hook watches for a few moments and injects a short instruction at each.

| Trigger | Injected |
|---|---|
| A spec is written to `**/specs/*-design.md` | Run `numatic:reviewing-specs` before the human gate |
| A plan is written to `**/plans/YYYY-MM-DD-*.md` | Run `numatic:reviewing-plans` before execution handoff |
| `superpowers:subagent-driven-development` or `executing-plans` is invoked | Plan the tail: simplify, then trace, then review |
| `superpowers:finishing-a-development-branch` is invoked | Backstop: name the tail steps that did not run |
| A compaction happens with tail work still pending | Re-state the pending steps |

The hook **records which numatic skills actually ran**, per session, as marker files under
the plugin's data directory. That is what makes the last two rows work. The alternative -
asking the model at the merge gate whether the tail ran - is unanswerable by construction:
the only durable evidence lives in the SDD workspace, and Superpowers deletes that before
`finishing-a-development-branch` is invoked. After a compaction the model would have neither
memory nor artifact. The hook reports facts instead.

The backstop also says to re-run the whole-branch review after any missing step, because a
step that mutates the branch after the review closes is the failure the slot design exists
to prevent.

Each injection fires **once per session per subject**, so applying review fixes to a plan
does not re-trigger the review that produced them.

The hook is silent otherwise. A session that never touches this workflow never sees a token
from it.

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `NUMATIC_SPEC_PATTERN` | `/specs?/.*-design\.md$` | Where specs live, if your team differs |
| `NUMATIC_PLAN_PATTERN` | `/plans?/\d{4}-\d{2}-\d{2}-.*\.md$` | Where plans live |

The plan pattern requires the date prefix Superpowers uses. A bare `/plans?/.*\.md$` fires
on roadmaps, templates, and meeting notes, and every false positive asks for a plan review
with no spec to review against.

To keep the skills but turn the automation off, disable the plugin and invoke the skills by
hand. Do not delete `hooks/hooks.json` from the installed copy - the next marketplace update
restores it, and a half-edited plugin cache is worse than either state.

## Development

```
claude-plugins/
├── .claude-plugin/
│   └── marketplace.json          # the registry; lists plugins[]
├── DESIGN.md                     # why it is shaped this way; read before changing the hook
├── plugins/
│   └── numatic/
│       ├── .claude-plugin/
│       │   └── plugin.json       # only the manifest lives here
│       ├── agents/
│       │   ├── spec-reviewer.md
│       │   ├── plan-reviewer.md
│       │   ├── plan-applier.md
│       │   └── flow-fixer.md
│       ├── hooks/
│       │   ├── hooks.json
│       │   └── flow-overlay.js   # Node: the one runtime Claude Code guarantees
│       ├── references/
│       │   └── scenario-taxonomy.md
│       └── skills/
│           ├── reviewing-specs/
│           ├── reviewing-plans/
│           ├── simplifying-code/
│           └── tracing-flows/
└── README.md
```

Components (`skills/`, `agents/`, `hooks/`) live at the plugin root. Only `plugin.json` goes
inside `.claude-plugin/`.

The plugin's `name` field namespaces both skills and agents, so `numatic` yields
`numatic:reviewing-plans` and `numatic:plan-reviewer`. The repo name never appears in a
namespace.

Validate before pushing:

```bash
claude plugin validate ./plugins/numatic
claude plugin validate .
```

Test a change without installing:

```bash
claude --plugin-dir ./plugins/numatic
```

Bump `version` in both `plugin.json` and the marketplace entry when publishing. Without a
version bump Claude Code falls back to the commit SHA and treats every commit as a new
release.

**Read [DESIGN.md](DESIGN.md) before changing the hook or the review loops.** Several parts
that look simplifiable are load-bearing, and it also lists the Superpowers skill names and
path conventions this plugin hard-codes - the things to check first when Superpowers ships a
major release.

## Adding another plugin

Add a directory under `plugins/` with its own `.claude-plugin/plugin.json`, then add an
entry to `plugins[]` in the marketplace manifest.

Split only when someone needs one plugin without the other - enabling is per-plugin, so the
plugin is the unit of "who gets this."
