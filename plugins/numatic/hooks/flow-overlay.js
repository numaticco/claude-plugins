#!/usr/bin/env node
/**
 * Inject the Numatic flow overlay at the joints of the Superpowers workflow.
 *
 * Runs as:
 *   - a PostToolUse hook matched on `Write|Skill`. Claude Code matches hooks on the
 *     TOOL NAME only (verified empirically - a matcher naming a skill never fires), so all
 *     real filtering happens here.
 *   - a SessionStart hook matched on `compact`, which re-injects pending tail state that
 *     compaction would otherwise erase.
 *
 * Injection points:
 *   Write <spec path>                                 -> run numatic:reviewing-specs
 *   Write <plan path>                                 -> run numatic:reviewing-plans
 *   Skill superpowers:subagent-driven-development     -> plan the tail of the flow
 *   Skill superpowers:executing-plans                 -> same tail (inline execution path)
 *   Skill superpowers:finishing-a-development-branch  -> guard the merge gate, from records
 *   SessionStart (compact)                            -> re-state the pending tail, if any
 *
 * State, not memory. The hook records which skills actually ran this session (marker files
 * under CLAUDE_PLUGIN_DATA), so the merge-gate check reports facts instead of asking a
 * post-compaction model to attest to history it cannot see.
 *
 * Advice fires at most once per session per subject, so applying review fixes to a plan
 * does not re-trigger the review that produced them. The merge-gate BLOCK is exempt: it
 * fires on every attempt, because retrying is exactly what a blocked agent does.
 *
 * Node, not python or jq: Claude Code runs on Node, so it is the only runtime guaranteed
 * to exist on a machine that can run this plugin at all.
 *
 * Silence is the default. A session that never touches the Superpowers workflow never
 * sees a single token from this hook.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Where specs and plans live. Superpowers' defaults; override per project if your team
// keeps them elsewhere. The plan pattern requires the YYYY-MM-DD prefix Superpowers uses,
// so a roadmap in docs/plans/ does not trigger a review that has no spec to review against.
const SPEC_PATTERN = new RegExp(process.env.NUMATIC_SPEC_PATTERN || '/specs?/.*-design\\.md$');
const PLAN_PATTERN = new RegExp(
  process.env.NUMATIC_PLAN_PATTERN || '/plans?/\\d{4}-\\d{2}-\\d{2}-.*\\.md$'
);

const SPEC_MESSAGE = `[numatic] A spec was just written. Before the human review gate, run the adversarial spec review:

    Skill(numatic:reviewing-specs) with the spec path

Superpowers' own spec self-review is the author grading their own work minutes after writing it. numatic:reviewing-specs dispatches a fresh-context reviewer that audits the content against a shared scenario taxonomy: coverage, ambiguity, decomposition, testability. A spec flaw found now costs one edit; found after planning it invalidates the whole plan.

Apply the findings, then present the reviewed spec to the human.`;

const PLAN_MESSAGE = `[numatic] A plan was just written. Before offering the execution handoff, run the adversarial plan review:

    Skill(numatic:reviewing-plans) with the plan path, its source spec, and the spec's \`## Scenarios\` list

This is the only step in the whole workflow that audits reuse. Task implementers are forbidden from restructuring code outside their task and task reviewers are forbidden from crawling the codebase, so if the plan says "create a new helper" when a 90%-suitable one already exists, nothing downstream will ever catch it. The planner has the full-codebase view. This is the last moment that view exists.

The review also sets the \`Cross-layer:\` flag in the plan's Global Constraints, which decides whether numatic:tracing-flows runs later.`;

const TAIL_MESSAGE = `[numatic] Plan execution is starting. The tail of this flow has two steps Superpowers does not know about. After the LAST task completes and BEFORE dispatching the final whole-branch review:

  1. Skill(numatic:simplifying-code) - folds duplication introduced across tasks, including duplication against code that already existed. This is a mutating step licensed to touch code outside the task boundary.
  2. Skill(numatic:tracing-flows) - only if the plan's Global Constraints contain \`Cross-layer: yes\` (treat a missing line as yes). Traces every scenario through every layer, dispatches one fixer for what is mechanically fixable, and re-traces the affected seams.

Order matters. Both run BEFORE the final review, so the review covers their changes and triages their residual findings. Nothing mutates the branch after the review closes.`;

// Skills whose invocation is recorded as a durable per-session fact.
const RECORDED_SKILLS = new Set([
  'numatic:reviewing-specs',
  'numatic:reviewing-plans',
  'numatic:simplifying-code',
  'numatic:tracing-flows',
  'superpowers:finishing-a-development-branch',
]);

// Skills that start a plan-execution tail (subagent or inline path).
const TAIL_START_SKILLS = new Set([
  'superpowers:subagent-driven-development',
  'superpowers:executing-plans',
]);

/**
 * Where marker files live. Never returns null.
 *
 * CLAUDE_PLUGIN_DATA is the right home when Claude Code provides it. When it does not, a
 * null here would silently disable every record and every check - and because the merge
 * gate is built out of those records, an unset variable would turn the plugin's only
 * enforcement point off while everything else still looked like it worked. Fail closed
 * instead: fall back to the temp dir.
 *
 * Every marker key is session-scoped (`<sessionId>.<name>`) and nothing reads a prior
 * session's markers, so the fallback only has to be stable for the life of one session.
 * os.tmpdir() is, and it does not write into ~/.claude behind the user's back.
 */
function dataDir(kind) {
  const root = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'numatic-flow-overlay');
  return path.join(root, kind);
}

function safeKey(key) {
  return key.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** Record that a skill ran this session. Idempotent; never throws. */
function recordRan(sessionId, name) {
  const dir = dataDir('ran');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.${safeKey(name)}`), '');
  } catch {
    // Never let bookkeeping problems break the user's session.
  }
}

function hasRun(sessionId, name) {
  const dir = dataDir('ran');
  try {
    return fs.existsSync(path.join(dir, `${sessionId}.${safeKey(name)}`));
  } catch {
    return false;
  }
}

/**
 * One injection per session per subject. Returns true if this one is a repeat.
 *
 * Without this, numatic:reviewing-plans writing its fixes back into the plan file would
 * re-trigger numatic:reviewing-plans.
 */
function alreadyFired(sessionId, key) {
  const dir = dataDir('fired');
  const marker = path.join(dir, `${sessionId}.${safeKey(key)}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // wx makes create-if-absent atomic, so concurrent hooks cannot double-fire.
    fs.closeSync(fs.openSync(marker, 'wx'));
    return false;
  } catch (err) {
    if (err.code === 'EEXIST') return true;
    return false;
  }
}

/**
 * The merge-gate decision, generated from this session's records rather than asked of the
 * model's memory. Returns [dedupeKey, message], or null when there is nothing to say.
 *
 * The two branches get different dedupe treatment, and the difference is the point:
 *
 *   - The advisory branch asks a question the records cannot answer. Nothing it says will
 *     ever make it stop firing, because its premise is the ABSENCE of state. It gets a
 *     dedupe key, so a bugfix branch that was already told to ignore it is not told twice.
 *   - The enforcement branch names steps that demonstrably did not run. It gets a null key
 *     - never deduped - because the agent's response to a block IS to retry, and a gate
 *     that only blocks the first attempt does not block. It self-silences instead: once
 *     the missing steps run, their markers exist and this function returns null.
 *
 * The self-silencing has one hole, and it is deliberate rather than fixed. Under
 * `Cross-layer: no` the plan does not require `numatic:tracing-flows`, so its marker never
 * appears and the block repeats for the rest of the session. Closing it would mean parsing
 * the plan from a hook that has no reliable way to find it, to suppress a message that
 * already asks for exactly the answer the agent has: the plan scoped the step out.
 */
function finishMessage(sessionId) {
  const tailStarted = hasRun(sessionId, 'tail-started');
  const simplified = hasRun(sessionId, 'numatic:simplifying-code');
  const traced = hasRun(sessionId, 'numatic:tracing-flows');

  if (!tailStarted) {
    // No plan execution recorded in this session. The branch may still come from a
    // reviewed plan run in an EARLIER session, so ask - but scoped, so a quick bugfix
    // branch is explicitly told to ignore this.
    return [
      'finish-ask',
      `[numatic] Merge gate reached. This session has no record of a plan execution. If this branch was built from a reviewed plan (possibly in an earlier session), confirm before finishing: numatic:simplifying-code ran after the last task, numatic:tracing-flows ran if the plan's Global Constraints say \`Cross-layer: yes\` (treat a missing line as yes), and the final whole-branch review ran AFTER both. If a required step is missing, run it now and then re-run the final review. If this branch was not built from a reviewed plan, ignore this message and finish normally.`,
    ];
  }

  if (simplified && traced) return null;

  const missing = [];
  if (!simplified) missing.push('numatic:simplifying-code');
  if (!traced) {
    missing.push(
      "numatic:tracing-flows (required only if the plan's Global Constraints say `Cross-layer: yes`; treat a missing line as yes)"
    );
  }

  // null key: enforcement, never deduped. See the note on this function.
  return [
    null,
    `[numatic] Merge gate reached. Session records show these steps did NOT run:

  - ${missing.join('\n  - ')}

For each step that was actually required: run it now, then RE-RUN the final whole-branch review before finishing - late changes must not ship unreviewed. If a listed step was genuinely not required, say why and proceed.`,
  ];
}

/**
 * SessionStart(compact) re-injection: if a plan execution started and its tail has not
 * completed, the instruction issued at execution start may have just been compacted away.
 * Re-state only the pending part. Returns null when there is nothing pending.
 */
function compactMessage(sessionId) {
  if (!hasRun(sessionId, 'tail-started')) return null;
  if (hasRun(sessionId, 'superpowers:finishing-a-development-branch')) return null;

  const simplified = hasRun(sessionId, 'numatic:simplifying-code');
  const traced = hasRun(sessionId, 'numatic:tracing-flows');
  if (simplified && traced) return null;

  const pending = [];
  if (!simplified) pending.push('Skill(numatic:simplifying-code)');
  if (!traced) {
    pending.push(
      "Skill(numatic:tracing-flows) - only if the plan's Global Constraints say `Cross-layer: yes` (treat a missing line as yes)"
    );
  }

  return `[numatic] A plan execution started in this session and its tail is still pending. After the LAST task completes and BEFORE the final whole-branch review:

  - ${pending.join('\n  - ')}

Both run before the final review so the review covers their changes. Nothing mutates the branch after the review closes.`;
}

/**
 * Returns [dedupeKey, message] or null (nothing to inject). A dedupeKey of null means this
 * message is enforcement rather than advice and must fire on every occurrence.
 */
function decide(payload, sessionId) {
  const tool = payload.tool_name;
  const toolInput = payload.tool_input || {};

  if (tool === 'Write') {
    const posix = String(toolInput.file_path || '').replace(/\\/g, '/');
    if (SPEC_PATTERN.test(posix)) return [`spec:${path.posix.basename(posix)}`, SPEC_MESSAGE];
    if (PLAN_PATTERN.test(posix)) return [`plan:${path.posix.basename(posix)}`, PLAN_MESSAGE];
    return null;
  }

  if (tool === 'Skill') {
    const skill = String(toolInput.skill || '');
    if (TAIL_START_SKILLS.has(skill)) return ['tail', TAIL_MESSAGE];
    if (skill === 'superpowers:finishing-a-development-branch') {
      // finishMessage picks its own dedupe key: advisory is deduped, enforcement is not.
      return finishMessage(sessionId);
    }
    return null;
  }

  return null;
}

function emit(hookEventName, message) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext: message },
    })
  );
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

  const sessionId = payload.session_id || 'nosession';

  if (payload.hook_event_name === 'SessionStart') {
    const message = compactMessage(sessionId);
    if (message) emit('SessionStart', message);
    return;
  }

  // PostToolUse. Record durable facts first - recording is unconditional, deduping is not.
  if (payload.tool_name === 'Skill') {
    const skill = String((payload.tool_input || {}).skill || '');
    if (RECORDED_SKILLS.has(skill)) recordRan(sessionId, skill);
    if (TAIL_START_SKILLS.has(skill)) recordRan(sessionId, 'tail-started');
  }

  const decision = decide(payload, sessionId);
  if (!decision) return;

  const [key, message] = decision;
  if (!message) return;
  // A null key opts out of dedupe: the message enforces rather than advises, and it
  // self-silences by not being generated once the thing it enforces has happened.
  if (key !== null && alreadyFired(sessionId, key)) return;

  emit('PostToolUse', message);
}

// A crashing hook must never take the session down with it.
try {
  main();
} catch {
  /* ignore */
}
process.exit(0);
