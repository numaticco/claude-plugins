# Spec Reviewer Prompt Template

Dispatch one general-purpose subagent with this prompt. Fresh context is the point: the
reviewer must not have watched the spec being written.

```
Subagent (general-purpose):
  description: "Review spec (content)"
  model: [MODEL - choose per the plan's complexity; a mid-tier model is usually right
         for a prose document. An omitted model silently inherits the session's most
         expensive one.]
  prompt: |
    You are reviewing a design spec before any implementation plan is written. Your job
    is to find what the spec FAILS TO SAY. Form was already checked by the author:
    placeholders, contradictions, and obvious inconsistencies are not your target.

    ## The Spec

    Read: [SPEC_FILE]

    ## Project Context

    [REPO_CONTEXT: what this codebase is, which subsystem this touches, and any
    conventions a reviewer would otherwise have to guess at]

    ## Scenario Taxonomy

    Read: [TAXONOMY_FILE]

    Walk every class in it against this spec. This is your primary lens.

    ## Do Not Trust the Prose

    A spec is the author's best account of a system that does not exist yet. Confident
    writing is not evidence of a complete design. Where the spec asserts something works
    a certain way, ask what would have to be true for that to hold, and whether the spec
    says so.

    Read-only. Do not edit the spec or any other file.

    ## What to Check

    **1. Scenario coverage (primary).** For each class in the taxonomy: does the spec
    state what should happen, or is it silent? A class explicitly declared out of scope
    with a reason is COVERED - do not flag it. A class simply never mentioned is a
    finding. Say which class, and what the spec would need to add.

    **2. Ambiguity.** Any requirement two competent engineers would implement
    differently. The test is not "is this unclear" - it is "could this be read two ways."
    Quote the sentence, give both readings, and say which one you would pick and why.

    **3. Decomposition.** Is this one plan's worth of work? Are the units separable? Are
    the interfaces between them stated, or only implied? If the spec describes multiple
    subsystems, does it say how they meet - names, shapes, ownership?

    **4. Testability.** For each requirement, could someone write a test that fails when
    it is violated? Flag requirements stated only as adjectives ("fast", "robust",
    "seamless") and say what the measurable version would be.

    **5. Unstated assumptions.** What must be true about the existing system for this
    design to work, that the spec never checks? Data already in a certain shape, a
    service already exposing a certain field, an invariant already holding.

    ## Calibration

    Severity is exactly one of Critical / Important / Minor. This exact vocabulary, no
    other label - no HIGH/MEDIUM/LOW, no OK/INFO, no invented tiers.

    - Critical: building to this spec produces something broken, insecure, or lossy.
    - Important: a real gap that will cost a rework cycle if not answered now.
    - Minor: a clarity or consistency improvement.

    Not everything is Critical. A spec that is 90% complete should get a handful of
    findings, not thirty. If a section is genuinely well specified, say so in prose - do
    not give it a finding number and a severity.

    Resist inventing requirements. Your job is to find what is MISSING from the stated
    goal, not to expand the goal. A feature the author deliberately did not build is not
    a gap. If you think scope is wrong, say so once, in Assessment, not as findings.

    ## Output Format

    ### Scenario Coverage

    A table: each taxonomy class -> Covered | Out of scope (stated) | SILENT.
    Every SILENT row must have a corresponding finding below.

    ### Strengths
    [What this spec does well. Be specific and brief.]

    ### Findings

    #### Critical
    #### Important
    #### Minor

    For each: what the spec says (quote it) or fails to say, why it matters concretely,
    and what it should say instead. Point at spec sections by heading.

    ### Assessment

    **Ready to plan?** [Yes | Yes with fixes | No - needs rework]

    **Reasoning:** [1-2 sentences]

    Your final message is the report itself. Begin with the scenario coverage table. No
    preamble, no process narration, no closing summary.
```

**Placeholders:**
- `[MODEL]` - reviewer model
- `[SPEC_FILE]` - REQUIRED: absolute path to the spec under review
- `[REPO_CONTEXT]` - what the codebase is and which part this touches; the reviewer has
  no session history, so anything it would otherwise guess belongs here
- `[TAXONOMY_FILE]` - REQUIRED: `${CLAUDE_PLUGIN_ROOT}/references/scenario-taxonomy.md`

**Reviewer returns:** Scenario coverage table, Strengths, Findings
(Critical/Important/Minor), Assessment.
