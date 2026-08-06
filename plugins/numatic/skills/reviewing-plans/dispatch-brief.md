# Dispatch briefs for the plan review

The review contract lives in the agent definitions (`agents/plan-reviewer.md`,
`agents/plan-fixer.md`), not here. These briefs carry only what changes per run: paths and
context the agent cannot discover on its own.

**Do not restate the review instructions in a dispatch.** Two sources of instruction is how
severity vocabulary and audit standards drift between runs.

## 1. Reviewer

```
Agent(numatic:plan-reviewer):
  description: "Review plan (spec coverage + reuse audit)"
  prompt: |
    ## The Plan
    Read: [PLAN_FILE]

    ## The Spec It Derives From
    Read: [SPEC_FILE]

    ## Scenario List
    [The numbered list from the spec's `## Scenarios` section, pasted in full.
     If the spec has no `## Scenarios` section, say so here and add:
     "Derive scenarios from ${CLAUDE_PLUGIN_ROOT}/references/scenario-taxonomy.md."]

    ## Project Context
    [What this codebase is, which subsystem the plan touches, and any conventions a
     fresh reader would otherwise have to guess at. The reviewer has no session history.]
```

## 2. Fixer

Dispatched only for findings that are mechanical. Findings marked `needs human decision`
never reach this agent.

```
Agent(numatic:plan-fixer):
  description: "Apply plan review findings"
  prompt: |
    ## The Plan
    Edit: [PLAN_FILE]

    ## The Spec (source of truth, read-only)
    Read: [SPEC_FILE]

    ## Findings to Apply
    [The mechanical findings, VERBATIM - full text including every extend
     specification. Do not summarize; the fixer's fidelity depends on the detail.]

    ## Excluded
    [List findings withheld as `needs human decision` or judged wrong, so the fixer
     does not treat their absence as an oversight.]
```

## 3. Scoped re-check

A general-purpose subagent. Give it the applied findings and the edited sections only -
never the whole plan, or it re-reviews instead of re-checking.

```
Agent(general-purpose):
  description: "Re-check applied plan edits"
  prompt: |
    A plan review's findings were just applied to [PLAN_FILE] by a separate agent.
    Verify the application, nothing else. Do not conduct a new review, do not raise new
    findings about untouched sections, do not edit anything.

    ## Findings that were applied
    [verbatim]

    ## Sections the fixer reports it edited
    [list from the fixer's report]

    Answer three questions, citing the plan:

    1. Does each edit change what the task INSTRUCTS, or was it only reworded? A
       restatement is not a fix.
    2. Is every changed interface or signature reflected everywhere it appears in the
       plan? A changed signature usually touches more than one task.
    3. Did any edit contradict a section the fixer did not touch?

    Report per finding: RESOLVED | NOT RESOLVED (with what is still missing) |
    PARTIALLY RESOLVED (with what remains). Then any inconsistency the edits introduced.

    Your final message is the report. No preamble.
```
