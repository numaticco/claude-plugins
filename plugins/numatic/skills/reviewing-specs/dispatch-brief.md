# Dispatch brief for the spec review

The review contract lives in `agents/spec-reviewer.md`, not here. This brief carries only
what changes per run: paths and context the agent cannot discover on its own.

**Do not restate the review instructions in the dispatch.** Two sources of instruction is
how severity vocabulary and review standards drift between runs.

Every `[BRACKETED]` slot below is filled in by you before dispatching. `[TAXONOMY_FILE]` is
the absolute path to `references/scenario-taxonomy.md`, which `SKILL.md` already gives you
resolved - copy it from there. Nothing expands variables in this file, so a literal
`${CLAUDE_PLUGIN_ROOT}` reaching the agent is a path it cannot read.

```
Agent(numatic:spec-reviewer):
  description: "Review spec (content)"
  prompt: |
    ## The Spec
    Read: [SPEC_FILE]

    ## Scenario Taxonomy
    Read: [TAXONOMY_FILE]

    Walk every class in it against this spec. This is your primary lens.

    ## Project Context
    [What this codebase is, which subsystem this touches, and any conventions a fresh
     reader would otherwise have to guess at. The reviewer has no session history, so
     anything it would otherwise assume belongs here.]
```

The reviewer returns: scenario coverage table, strengths, findings
(Critical/Important/Minor, some marked `needs author decision`), and an assessment.

Findings are applied by **you, in the main session** - see Step 3 of `SKILL.md` for why
this skill does not dispatch a fixer the way `numatic:reviewing-plans` does.
