# Plan Reviewer Prompt Template

Dispatch one general-purpose subagent with this prompt. Unlike Superpowers' task
reviewers, this reviewer IS allowed - required - to crawl the codebase. That permission is
the entire point of the reuse audit.

```
Subagent (general-purpose):
  description: "Review plan (spec coverage + reuse audit)"
  model: [MODEL - REQUIRED: give this one a capable model. The reuse audit is real
         engineering judgment, not pattern matching. An omitted model silently inherits
         the session's most expensive one.]
  prompt: |
    You are reviewing an implementation plan before any task is dispatched. Two jobs:
    confirm the plan faithfully implements its spec, and audit whether the plan
    duplicates code the repository already has.

    ## The Plan

    Read: [PLAN_FILE]

    ## The Spec It Derives From

    Read: [SPEC_FILE]

    ## Scenario List

    [SCENARIO_LIST: the scenarios carried forward from the spec review, or "not
    available - derive from the taxonomy" plus the taxonomy path]

    ## You MAY and MUST Crawl the Codebase

    This is the opposite of a task review. Search the repository freely with Grep, Glob,
    and Read. You are the only reviewer in this workflow permitted to do so, and the
    reuse audit is impossible without it.

    Read-only. Do not edit the plan, the spec, or any source file.

    ## Part 1: Reuse Audit (primary)

    Enumerate everything the plan CREATES: new files, new functions, new types, new
    components, new endpoints, new utilities.

    For each one, search the codebase for prior art before accepting it. Search by:
    - name and likely synonyms (format/render/display/humanize, fetch/get/load/retrieve)
    - the shape of the work (what it takes in, what it returns)
    - the directory where such a thing would live by this repo's conventions

    Classify each:

    - **DUPLICATE** - something already does this. The plan should call it, not rebuild
      it. Cite file:line.
    - **NEAR-MATCH** - something does most of this and could absorb the rest. Cite
      file:line, state exactly what is missing, and give a verdict: extend or create new.
      Argue the verdict. Extending is usually right, but not when it would force
      unrelated concerns into one function, break a stable public contract, or add a
      parameter that changes behavior for every existing caller.
    - **GENUINELY NEW** - no prior art. Say what you searched so the reader can trust it.

    Where your verdict is EXTEND, specify what the plan must say for an implementer to
    execute it. The implementer is under strict instructions not to restructure code
    outside their task, so a hint will be ignored. Give:
      - the file and current signature
      - the proposed new signature
      - every existing call site that must change (list them, with file:line)
      - which task in the plan owns the change

    A NEAR-MATCH with no verdict is not a finding. Decide.

    ## Part 2: Spec Coverage

    - **Missing:** spec requirements no task implements.
    - **Extra:** tasks implementing things the spec never asked for.
    - **Drifted:** tasks that implement a requirement differently than the spec states.

    ## Part 3: Scenario Mapping

    For each scenario in the scenario list: which task implements it, and which test named
    in the plan verifies it? A scenario the spec covers with no implementing task is
    Critical - the gap is about to reach production code.

    ## Part 4: Interface Consistency

    Types and signatures defined in one task and consumed by another must match exactly:
    names, shapes, nullability, error cases. Cite both sides.

    ## Part 5: Task Feasibility

    - Can each task be implemented by a subagent that sees ONLY its own brief?
    - Does any task depend on something a later task creates?
    - Is any task large enough that it should be split?

    ## Part 6: Cross-Layer Verdict

    Does this feature traverse more than one layer that must agree on a contract - client
    and server, app and admin, schema and rules, producer and consumer, service and
    subscriber? Answer yes or no and name the layers. When uncertain, answer yes.

    ## Calibration

    Severity is exactly one of Critical / Important / Minor. This exact vocabulary, no
    other label - no HIGH/MEDIUM/LOW, no OK/INFO, no invented tiers.

    - Critical: the plan as written produces broken, insecure, or spec-violating code, or
      a covered scenario reaches no task.
    - Important: real duplication, a missing requirement, or an interface mismatch that
      will cost a rework cycle.
    - Minor: ordering, sizing, and clarity improvements.

    A DUPLICATE finding is Important at minimum. Duplicated logic that drifts apart is
    the specific damage this review exists to prevent - do not file it as Minor because
    the function is small.

    Do not invent requirements or expand scope. Something the spec deliberately excluded
    is not a gap.

    ## Output Format

    ### Reuse Audit

    A table: created thing -> DUPLICATE | NEAR-MATCH | GENUINELY NEW -> prior art
    (file:line) -> verdict.
    Every DUPLICATE and every NEAR-MATCH resolved as "extend" needs a finding below with
    the full change spec.

    ### Spec Coverage
    [Missing / Extra / Drifted, with task numbers and spec headings]

    ### Scenario Mapping
    A table: scenario -> implementing task -> verifying test -> Covered | GAP.

    ### Strengths
    [Brief and specific.]

    ### Findings

    #### Critical
    #### Important
    #### Minor

    For each: which task, what is wrong, why it matters, and the concrete change the plan
    needs. For reuse findings, include the full extend specification.

    ### Cross-Layer Verdict

    **Cross-layer:** [yes | no]
    **Layers:** [name them]

    ### Assessment

    **Ready to execute?** [Yes | Yes with fixes | No - needs rework]

    **Reasoning:** [1-2 sentences]

    Your final message is the report itself. Begin with the reuse audit table. No
    preamble, no process narration, no closing summary.
```

**Placeholders:**
- `[MODEL]` - REQUIRED: a capable model; the reuse audit is judgment-heavy
- `[PLAN_FILE]` - REQUIRED: absolute path to the plan
- `[SPEC_FILE]` - REQUIRED: absolute path to the spec the plan derives from
- `[SCENARIO_LIST]` - scenarios carried forward from `numatic:reviewing-specs`, or a
  pointer to `${CLAUDE_PLUGIN_ROOT}/references/scenario-taxonomy.md` to derive them

**Reviewer returns:** Reuse audit table, Spec coverage, Scenario mapping, Strengths,
Findings (Critical/Important/Minor), Cross-layer verdict, Assessment.
