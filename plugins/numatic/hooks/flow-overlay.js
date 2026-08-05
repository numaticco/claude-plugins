#!/usr/bin/env node
/**
 * Inject the Numatic flow overlay at the joints of the Superpowers workflow.
 *
 * Runs as a PostToolUse hook matched on `Write|Skill`. Claude Code matches hooks on the
 * TOOL NAME only (verified empirically - a matcher naming a skill never fires), so all
 * real filtering happens here.
 *
 * Injection points:
 *   Write <spec path>                                -> run numatic:reviewing-specs
 *   Write <plan path>                                -> run numatic:reviewing-plans
 *   Skill superpowers:subagent-driven-development     -> plan the tail of the flow
 *   Skill superpowers:finishing-a-development-branch  -> guard the merge gate
 *
 * Every injection fires at most once per session per subject, so applying review fixes to
 * a plan does not re-trigger the review that produced them.
 *
 * Node, not python or jq: Claude Code runs on Node, so it is the only runtime guaranteed
 * to exist on a machine that can run this plugin at all.
 *
 * Silence is the default. A session that never touches the Superpowers workflow never
 * sees a single token from this hook.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Where specs and plans live. Superpowers' defaults; override per project if your team
// keeps them elsewhere.
const SPEC_PATTERN = new RegExp(process.env.NUMATIC_SPEC_PATTERN || '/specs?/.*-design\\.md$');
const PLAN_PATTERN = new RegExp(process.env.NUMATIC_PLAN_PATTERN || '/plans?/.*\\.md$');

const SPEC_MESSAGE = `[numatic] A spec was just written. Before the human review gate, run the adversarial spec review:

    Skill(numatic:reviewing-specs) with the spec path

Superpowers' own spec self-review is the author grading their own work and only checks form (placeholders, contradictions). numatic:reviewing-specs is a fresh-context subagent that checks content: scenario coverage, ambiguity, decomposition sanity. A spec flaw found now costs one edit; found after planning it invalidates the whole plan.

Apply the findings, then present the reviewed spec to the human.`;

const PLAN_MESSAGE = `[numatic] A plan was just written. Before offering the execution handoff, run the adversarial plan review:

    Skill(numatic:reviewing-plans) with the plan path and its source spec

This is the only step in the whole workflow that audits reuse. Task implementers are forbidden from restructuring code outside their task and task reviewers are forbidden from crawling the codebase, so if the plan says "create a new helper" when a 90%-suitable one already exists, nothing downstream will ever catch it. The planner has the full-codebase view. This is the last moment that view exists.

The review also sets the cross-layer flag that decides whether numatic:tracing-flows runs later.`;

const SDD_MESSAGE = `[numatic] Subagent-driven development is starting. The tail of this flow has two steps Superpowers does not know about. After the LAST task completes and BEFORE dispatching the final whole-branch review:

  1. Skill(numatic:simplifying-code) - folds duplication introduced across tasks, including duplication against code that already existed. This is the only mutating step licensed to touch code outside the task boundary.
  2. Skill(numatic:tracing-flows) - only if the plan review set the cross-layer flag. Traces every scenario through every layer, including layers this branch never modified.

Order matters. Both run BEFORE the final review, so the final review covers their output and their findings join its single fix wave. Nothing mutates the branch after the review closes.`;

const FINISH_MESSAGE = `[numatic] Merge gate reached. Confirm before finishing:

  - Did numatic:simplifying-code run after the last task?
  - If the plan review set the cross-layer flag, did numatic:tracing-flows run?
  - Did the final whole-branch review happen AFTER both?

If any answer is no, run the missing step now. Finishing the branch is the last point at which any of this is cheap.`;

const SKILL_TRIGGERS = {
  'superpowers:subagent-driven-development': ['sdd', SDD_MESSAGE],
  'superpowers:finishing-a-development-branch': ['finish', FINISH_MESSAGE],
};

/**
 * One injection per session per subject. Returns true if this one is a repeat.
 *
 * Without this, numatic:reviewing-plans writing its fixes back into the plan file would
 * re-trigger numatic:reviewing-plans.
 */
function alreadyFired(sessionId, key) {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) return false;

  const safeKey = key.replace(/[^A-Za-z0-9_.-]/g, '_');
  const marker = path.join(dataDir, 'fired', `${sessionId}.${safeKey}`);
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    // wx makes create-if-absent atomic, so concurrent hooks cannot double-fire.
    fs.closeSync(fs.openSync(marker, 'wx'));
    return false;
  } catch (err) {
    if (err.code === 'EEXIST') return true;
    // Never let bookkeeping problems break the user's session.
    return false;
  }
}

/** Returns [dedupeKey, message] or null. */
function decide(payload) {
  const tool = payload.tool_name;
  const toolInput = payload.tool_input || {};

  if (tool === 'Write') {
    const posix = String(toolInput.file_path || '').replace(/\\/g, '/');
    if (SPEC_PATTERN.test(posix)) return [`spec:${path.posix.basename(posix)}`, SPEC_MESSAGE];
    if (PLAN_PATTERN.test(posix)) return [`plan:${path.posix.basename(posix)}`, PLAN_MESSAGE];
    return null;
  }

  if (tool === 'Skill') {
    return SKILL_TRIGGERS[String(toolInput.skill || '')] || null;
  }

  return null;
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const decision = decide(payload);
  if (!decision) return;

  const [key, message] = decision;
  if (alreadyFired(payload.session_id || 'nosession', key)) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: message,
      },
    })
  );
}

// A crashing hook must never take the session down with it.
try {
  main();
} catch {
  /* ignore */
}
process.exit(0);
