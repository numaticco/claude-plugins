# Numatic Claude Plugins

Claude Code plugins for Numatic Ventures engineering.

This repo is a **plugin marketplace**. Adding it once gives you every plugin listed here,
and updates arrive by pulling the repo.

| Plugin | What it does |
|---|---|
| `numatic` | Extends the [Superpowers](https://github.com/obra/superpowers) workflow with adversarial spec and plan review, a plan-time reuse audit, a simplification pass, and end-to-end flow tracing. |

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

**1. Specs and plans are reviewed cooperatively; only code is reviewed adversarially.**
Superpowers 6.2 does have a spec self-review and a plan self-review, but both are the
author grading their own work minutes after writing it, and both check *form* - placeholders,
contradictions, type consistency. Code, by contrast, gets a fresh-context reviewer told
`Do Not Trust the Report`. A spec can be free of placeholders and perfectly consistent and
still be silent about what happens when the record is missing.

**2. Plans duplicate code instead of extending it.** This one is structural. Implementers
are told "don't restructure things outside your task." Task reviewers are told "Do not
crawl the broader codebase." So when a plan says "create a new helper" and a 90%-suitable
helper already exists two directories away, the implementer is forbidden from looking, the
reviewer is forbidden from crawling to where the original lives, and the original is not
in the diff. Nothing downstream can catch it. The codebase drifts, one small helper at a
time.

**3. Simplification has no slot.** The built-in `/simplify` exists, but Superpowers does
not know about it, so the flow goes from the last task straight to review and then to the
merge prompt. Tasks built in isolation by subagents that cannot see each other produce
duplication by construction, and nothing removes it.

**4. Flow tracing happens too late, if at all.** Every Superpowers review is diff-scoped.
A flow includes layers the branch never touched and now depends on - the security rule
that does not know about the new field, the admin screen that never learned the new state.
No diff-scoped reviewer can see them.

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
  -> numatic:tracing-flows            <- NEW: end-to-end trace, if cross-layer
  -> final whole-branch review        (now covers both, in its single fix wave)
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

Each is invocable on its own at any time, so you can re-run one without re-running the
flow.

### `numatic:reviewing-specs`

A fresh-context subagent reviews the spec's *content*: scenario coverage against a shared
taxonomy, ambiguity (could this be read two ways?), decomposition, testability, and
unstated assumptions about the existing system. Findings are applied to the spec, then
re-checked. The human then reviews a spec that already survived an adversarial read.

### `numatic:reviewing-plans`

The important one. A fresh-context subagent - **explicitly permitted to crawl the
codebase**, unlike every other reviewer in the workflow - audits:

- **Reuse.** For every file, function, and type the plan creates: does prior art exist?
  Each is classified `DUPLICATE`, `NEAR-MATCH`, or `GENUINELY NEW`, and near-matches get an
  argued extend-or-create verdict. Where the verdict is extend, the plan is rewritten to
  say so concretely: current signature, new signature, every call site that changes, and
  which task owns it. A hint would not survive contact with an implementer who is
  instructed not to restructure.
- Spec coverage, scenario-to-task mapping, interface consistency, task feasibility.
- Whether the feature is **cross-layer**, which decides if `tracing-flows` runs later.

### `numatic:simplifying-code`

Runs after the last task, before the final review. Folds duplication introduced across
tasks, and duplication against code that already existed - the backstop for gap 2 when the
plan review missed one. Also removes dead code, YAGNI leftovers, and needless indirection.

This is the only step in the workflow licensed to modify code outside the task boundary,
so it lists every out-of-diff change it made and hands that list to the final reviewer,
whose diff-scoped view would not otherwise show it.

### `numatic:tracing-flows`

Statically traces one flow through every layer it touches, fanning out one subagent per
seam and one per scenario cluster. Its defining rule is **never stop at the first
failure**: a broken hop is recorded, then tracing continues under the assumption that it
is repaired, so one pass returns the whole tree of gaps instead of the first leaf.

In the SDD flow it takes its scenario list from the spec rather than re-deriving one, and
its findings feed the final review's fix wave.

Standalone, it keeps a `--resume` mode for re-tracing after fixes.

## How it runs automatically

A `PostToolUse` hook watches for four moments and injects a short instruction at each:

| Trigger | Injected |
|---|---|
| A spec is written to `**/specs/*-design.md` | Run `numatic:reviewing-specs` before the human gate |
| A plan is written to `**/plans/*.md` | Run `numatic:reviewing-plans` before execution handoff |
| `superpowers:subagent-driven-development` is invoked | Plan the tail: simplify, then trace, then review |
| `superpowers:finishing-a-development-branch` is invoked | Backstop: did those actually run? |

The last one matters most. It fires at the exact gate it guards, so it does not depend on
an instruction issued hours earlier surviving a long implementation run.

Each injection fires **once per session per subject**, so applying review fixes to a plan
does not re-trigger the review that produced them.

The hook is silent otherwise. A session that never touches this workflow never sees a
token from it.

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `NUMATIC_SPEC_PATTERN` | `/specs?/.*-design\.md$` | Where specs live, if your team differs |
| `NUMATIC_PLAN_PATTERN` | `/plans?/.*\.md$` | Where plans live |

To turn the automation off but keep the skills, disable the plugin's hook by removing
`hooks/hooks.json` from your local install, or just disable the plugin and invoke the
skills by hand.

## Development

```
claude-plugins/
├── .claude-plugin/
│   └── marketplace.json          # the registry; lists plugins[]
├── plugins/
│   └── numatic/
│       ├── .claude-plugin/
│       │   └── plugin.json       # only the manifest lives here
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

Components (`skills/`, `hooks/`) live at the plugin root. Only `plugin.json` goes inside
`.claude-plugin/`.

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

## Adding another plugin

Add a directory under `plugins/` with its own `.claude-plugin/plugin.json`, then add an
entry to `plugins[]` in the marketplace manifest. The plugin's `name` field is what
namespaces its skills, so a plugin named `numatic-infra` yields `numatic-infra:*`.

Split only when someone needs one plugin without the other - enabling is per-plugin, so
the plugin is the unit of "who gets this."
