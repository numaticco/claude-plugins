#!/usr/bin/env node
/**
 * Reconstruct and cost out a numatic-reviewed session from Claude Code's own transcripts.
 *
 * No new logging exists to add: the main session transcript and each dispatched subagent's
 * transcript (`<session>/subagents/agent-*.jsonl` + `.meta.json`) already carry everything
 * needed - full Write/Edit payloads, per-message token usage with timestamps, and each
 * subagent's `agentType`. This script replays those into the artifacts a paired before/after
 * evaluation needs (see docs/evaluations/2026-08-06-approach.md): spec/plan v0 and v1,
 * reviewer findings verbatim, a per-phase cost table, and objective contract checks.
 *
 * Usage:
 *   node tools/analyze-run.js <session-id-or-path-to-jsonl> [--out <dir>]
 *
 * <session-id-or-path> is either a bare session UUID (searched for across
 * ~/.claude/projects/*\/) or a direct path to a session .jsonl file.
 *
 * Reconstruction is verified, not assumed: for each target file still present on disk, the
 * replayed final content is hashed against the file's actual content. A mismatch means
 * something outside the recorded tool calls touched the file (a hand edit, a shell command)
 * and the reconstruction for that file is unsound - this is reported, not hidden.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SPEC_PATTERN = new RegExp(process.env.NUMATIC_SPEC_PATTERN || '/specs?/.*-design\\.md$');
const PLAN_PATTERN = new RegExp(
  process.env.NUMATIC_PLAN_PATTERN || '/plans?/\\d{4}-\\d{2}-\\d{2}-.*\\.md$'
);

const REVIEW_SKILL = {
  spec: 'numatic:reviewing-specs',
  plan: 'numatic:reviewing-plans',
};

const REVIEWER_AGENT = {
  spec: /^numatic:spec-reviewer$/,
  plan: /^numatic:plan-reviewer$/,
};

const FIXER_AGENT = /^numatic:plan-fixer$/;

// ---------- argument parsing ----------

function parseArgs(argv) {
  const args = { out: null, target: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      args.out = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  args.target = rest[0];
  return args;
}

// ---------- locating the session ----------

function findSessionFile(idOrPath) {
  if (idOrPath.endsWith('.jsonl') && fs.existsSync(idOrPath)) return idOrPath;

  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) throw new Error(`No ${root} - is this Claude Code?`);

  for (const projDir of fs.readdirSync(root)) {
    const candidate = path.join(root, projDir, `${idOrPath}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No session '${idOrPath}' found under ${root}/*/`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function tsMs(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// ---------- collecting subagents ----------

function loadSubagents(sessionDir) {
  const dir = path.join(sessionDir, 'subagents');
  if (!fs.existsSync(dir)) return [];

  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const metaPath = path.join(dir, f.replace(/\.jsonl$/, '.meta.json'));
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      /* meta is best-effort */
    }
    out.push({
      file: path.join(dir, f),
      agentType: meta.agentType || '?',
      description: meta.description || '',
      toolUseId: meta.toolUseId || null,
      lines: readJsonl(path.join(dir, f)),
    });
  }
  return out;
}

// ---------- mutation collection & replay ----------

/** Pull Write/Edit tool_use calls out of a transcript's assistant messages. */
function collectMutations(lines, sourceLabel) {
  const muts = [];
  for (const o of lines) {
    if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
    const t = tsMs(o.timestamp);
    if (t === null) continue;
    for (const c of o.message.content) {
      if (c.type !== 'tool_use' || !['Write', 'Edit'].includes(c.name)) continue;
      muts.push({ t, src: sourceLabel, name: c.name, input: c.input || {} });
    }
  }
  return muts;
}

/**
 * Replay a chronological mutation list for ONE file path into a series of checkpoints:
 * [{ t, content }] taken immediately after each mutation applies. Throws if an Edit's
 * old_string is not found (the transcript and the replay have diverged).
 */
function replayFile(mutations) {
  const checkpoints = [];
  let content = null;
  for (const m of mutations) {
    if (m.name === 'Write') {
      content = m.input.content || '';
    } else {
      if (content === null) throw new Error('Edit before any Write - cannot replay');
      const { old_string: oldStr, new_string: newStr, replace_all: replaceAll } = m.input;
      if (replaceAll) {
        if (!content.includes(oldStr)) throw new Error('Edit old_string not found (replace_all)');
        content = content.split(oldStr).join(newStr);
      } else {
        const i = content.indexOf(oldStr);
        if (i < 0) throw new Error('Edit old_string not found');
        content = content.slice(0, i) + newStr + content.slice(i + oldStr.length);
      }
    }
    checkpoints.push({ t: m.t, content });
  }
  return checkpoints;
}

/** Content as of the latest checkpoint with timestamp <= at (or < at if inclusive=false). */
function stateAt(checkpoints, at, inclusive) {
  let result = null;
  for (const cp of checkpoints) {
    if (inclusive ? cp.t <= at : cp.t < at) result = cp.content;
    else break;
  }
  return result;
}

// ---------- phases ----------

/** Skill invocations in the MAIN transcript only, in order, each opening a phase. */
function findPhases(mainLines) {
  const marks = [];
  for (const o of mainLines) {
    if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
    const t = tsMs(o.timestamp);
    if (t === null) continue;
    for (const c of o.message.content) {
      if (c.type === 'tool_use' && c.name === 'Skill') {
        marks.push({ t, skill: String((c.input || {}).skill || '') });
      }
    }
  }
  marks.sort((a, b) => a.t - b.t);

  const lastTs = Math.max(
    0,
    ...mainLines.map((o) => tsMs(o.timestamp)).filter((t) => t !== null)
  );

  return marks.map((m, i) => ({
    name: m.skill,
    from: m.t,
    to: i + 1 < marks.length ? marks[i + 1].t : lastTs + 1, // +1 so the last phase is inclusive
  }));
}

// ---------- cost table ----------

function mainUsageInWindow(mainLines, from, to) {
  let out = 0;
  let cacheCreate = 0;
  let cacheRead = 0;
  let n = 0;
  for (const o of mainLines) {
    if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
    const t = tsMs(o.timestamp);
    if (t === null || t < from || t >= to) continue;
    out += o.message.usage.output_tokens || 0;
    cacheCreate += o.message.usage.cache_creation_input_tokens || 0;
    cacheRead += o.message.usage.cache_read_input_tokens || 0;
    n++;
  }
  return { out, cacheCreate, cacheRead, messages: n };
}

function subagentSummaries(subagents) {
  return subagents.map((s) => {
    let out = 0;
    let cacheCreate = 0;
    let start = null;
    let end = null;
    for (const o of s.lines) {
      const t = tsMs(o.timestamp);
      if (t !== null) {
        start = start === null ? t : Math.min(start, t);
        end = end === null ? t : Math.max(end, t);
      }
      const u = o.message && o.message.usage;
      if (u) {
        out += u.output_tokens || 0;
        cacheCreate += u.cache_creation_input_tokens || 0;
      }
    }
    return { ...s, out, cacheCreate, start, end };
  });
}

function buildCostTable(phases, mainLines, subSummaries) {
  return phases.map((p) => {
    const main = mainUsageInWindow(mainLines, p.from, p.to);
    // A subagent belongs to the phase its dispatch (first timestamp) falls into.
    const mine = subSummaries.filter((s) => s.start !== null && s.start >= p.from && s.start < p.to);
    const subOut = mine.reduce((a, b) => a + b.out, 0);
    const subCacheCreate = mine.reduce((a, b) => a + b.cacheCreate, 0);
    return {
      phase: p.name,
      wallMs: p.to - p.from,
      mainOut: main.out,
      mainCacheCreate: main.cacheCreate,
      subOut,
      subCacheCreate,
      subagents: mine.map((s) => s.agentType),
    };
  });
}

// ---------- reviewer findings ----------

function finalText(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = lines[i];
    if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
    const text = o.message.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    if (text) return text;
  }
  return null;
}

// ---------- contract checks ----------

function contractChecks(specV1, planV1) {
  return {
    'spec has ## Scenarios': specV1 ? /^##\s+Scenarios\b/m.test(specV1) : null,
    'plan has Cross-layer: yes|no': planV1 ? /Cross-layer:\s*(yes|no)/i.test(planV1) : null,
    'plan has ## Open decisions': planV1 ? /^##\s+Open decisions\b/im.test(planV1) : null,
  };
}

// ---------- main ----------

function fmtMin(ms) {
  return (ms / 60000).toFixed(1) + 'm';
}

function hash(content) {
  if (content === null || content === undefined) return '(absent)';
  return crypto.createHash('sha1').update(content).digest('hex').slice(0, 10);
}

function writeIfPresent(outDir, name, content) {
  if (content === null || content === undefined) return null;
  const p = path.join(outDir, name);
  fs.writeFileSync(p, content);
  return p;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target) {
    console.error('Usage: node tools/analyze-run.js <session-id-or-path> [--out <dir>]');
    process.exit(1);
  }

  const sessionFile = findSessionFile(args.target);
  const sessionDir = sessionFile.slice(0, -'.jsonl'.length);
  const sessionId = path.basename(sessionDir);
  const outDir = args.out || path.join('docs', 'evaluations', sessionId);
  fs.mkdirSync(outDir, { recursive: true });

  const mainLines = readJsonl(sessionFile);
  const subagents = loadSubagents(sessionDir);
  const subSummaries = subagentSummaries(subagents);

  // Merge mutations from main + every subagent transcript, chronologically. Findings from
  // reviewers do not mutate files - only fixers do - but this still needs to include
  // subagent mutations because numatic:plan-fixer edits the plan from INSIDE its own
  // transcript; a main-transcript-only replay would miss all of them.
  let allMutations = collectMutations(mainLines, 'main');
  for (const s of subagents) {
    allMutations = allMutations.concat(collectMutations(s.lines, s.agentType));
  }
  allMutations.sort((a, b) => a.t - b.t);

  const phases = findPhases(mainLines);
  const costTable = buildCostTable(phases, mainLines, subSummaries);

  function reconstruct(kind, pattern) {
    const reviewPhase = phases.find((p) => p.name === REVIEW_SKILL[kind]);
    if (!reviewPhase) return null;

    const candidates = allMutations.filter((m) => pattern.test(String(m.input.file_path || '')));
    if (candidates.length === 0) return null;

    // The target file is whichever matching path was most recently touched at/before the
    // review phase opens - i.e. "the spec that exists when reviewing-specs starts".
    const beforeStart = candidates.filter((m) => m.t <= reviewPhase.from);
    const targetPath =
      beforeStart.length > 0
        ? beforeStart[beforeStart.length - 1].input.file_path
        : candidates[0].input.file_path;

    const fileMutations = candidates.filter((m) => m.input.file_path === targetPath);
    let checkpoints;
    let replayError = null;
    try {
      checkpoints = replayFile(fileMutations);
    } catch (err) {
      replayError = err.message;
      checkpoints = [];
    }

    const v0 = stateAt(checkpoints, reviewPhase.from, true);
    const v1 = stateAt(checkpoints, reviewPhase.to, false);

    const onDisk = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
    const finalReplayed = checkpoints.length ? checkpoints[checkpoints.length - 1].content : null;
    const soundness =
      onDisk === null
        ? 'file no longer on disk - not checked'
        : finalReplayed === onDisk
          ? 'MATCH (replay hash == disk hash)'
          : 'DIVERGED - something outside recorded tool calls touched this file';

    return { targetPath, v0, v1, replayError, soundness, hashReplayed: hash(finalReplayed), hashDisk: hash(onDisk) };
  }

  function findingsFor(kind, agentPattern) {
    const reviewPhase = phases.find((p) => p.name === REVIEW_SKILL[kind]);
    if (!reviewPhase) return [];
    return subagents
      .filter((s) => agentPattern.test(s.agentType))
      .filter((s) => {
        const first = s.lines.find((o) => tsMs(o.timestamp) !== null);
        const t = first ? tsMs(first.timestamp) : null;
        return t !== null && t >= reviewPhase.from && t < reviewPhase.to;
      })
      .map((s) => ({ agentType: s.agentType, description: s.description, text: finalText(s.lines) }));
  }

  const spec = reconstruct('spec', SPEC_PATTERN);
  const plan = reconstruct('plan', PLAN_PATTERN);
  const specFindings = findingsFor('spec', REVIEWER_AGENT.spec);
  const planFindings = findingsFor('plan', REVIEWER_AGENT.plan).concat(findingsFor('plan', FIXER_AGENT));

  const checks = contractChecks(spec && spec.v1, plan && plan.v1);

  // ---- write artifacts ----
  if (spec) {
    writeIfPresent(outDir, 'spec-v0.md', spec.v0);
    writeIfPresent(outDir, 'spec-v1.md', spec.v1);
  }
  if (plan) {
    writeIfPresent(outDir, 'plan-v0.md', plan.v0);
    writeIfPresent(outDir, 'plan-v1.md', plan.v1);
  }
  if (specFindings.length) {
    writeIfPresent(
      outDir,
      'spec-findings.md',
      specFindings.map((f) => `## ${f.agentType} - ${f.description}\n\n${f.text}`).join('\n\n---\n\n')
    );
  }
  if (planFindings.length) {
    writeIfPresent(
      outDir,
      'plan-findings.md',
      planFindings.map((f) => `## ${f.agentType} - ${f.description}\n\n${f.text}`).join('\n\n---\n\n')
    );
  }

  // ---- cost table (markdown + json) ----
  const costLines = [
    '| Phase | Wall clock | Main output tok | Main cache-create | Subagent output tok | Subagents |',
    '|---|---|---|---|---|---|',
    ...costTable.map(
      (r) =>
        `| ${r.phase} | ${fmtMin(r.wallMs)} | ${r.mainOut} | ${r.mainCacheCreate} | ${r.subOut} | ${r.subagents.join(', ') || '-'} |`
    ),
  ];
  writeIfPresent(outDir, 'cost-table.md', costLines.join('\n') + '\n');

  const record = {
    sessionId,
    sessionFile,
    generatedFrom: 'tools/analyze-run.js',
    costTable,
    reconstruction: {
      spec: spec && {
        targetPath: spec.targetPath,
        soundness: spec.soundness,
        replayError: spec.replayError,
        hashReplayed: spec.hashReplayed,
        hashDisk: spec.hashDisk,
      },
      plan: plan && {
        targetPath: plan.targetPath,
        soundness: plan.soundness,
        replayError: plan.replayError,
        hashReplayed: plan.hashReplayed,
        hashDisk: plan.hashDisk,
      },
    },
    contractChecks: checks,
    specFindingsCount: specFindings.length,
    planFindingsCount: planFindings.length,
  };
  writeIfPresent(outDir, 'run-record.json', JSON.stringify(record, null, 2));

  // ---- console summary ----
  console.log(`Session: ${sessionId}`);
  console.log(`Output:  ${outDir}\n`);
  console.log(costLines.join('\n'));
  console.log();
  if (spec) console.log(`spec (${spec.targetPath}): ${spec.soundness}`);
  if (plan) console.log(`plan (${plan.targetPath}): ${plan.soundness}`);
  console.log();
  for (const [k, v] of Object.entries(checks)) {
    if (v === null) continue;
    console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
  }
  if (!spec && !plan) {
    console.log('No numatic:reviewing-specs or numatic:reviewing-plans phase found in this session.');
  }
}

main();
