// scripts/validate-run-flow.mjs
//
// End-to-end simulation of "user picks options in the form → clicks Run".
// Doesn't touch vscode (so it runs in plain node) but uses the SAME
// resolveOptions logic shipped in the agents — copied here verbatim — so
// changes there break this script first.
//
//   node scripts/validate-run-flow.mjs

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Mirror of TodoEditorPanel.parseAgentOptions ──────────────────────────
function parseAgentOptions(selected, raw) {
  const sel = typeof selected === 'string' ? selected : undefined;
  const byAgent = {};
  if (raw && typeof raw === 'object') {
    for (const [agent, fields] of Object.entries(raw)) {
      if (!fields || typeof fields !== 'object') continue;
      const out = {};
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'string' && v.length) out[k] = v;
      }
      if (Object.keys(out).length) byAgent[agent] = out;
    }
  }
  if (!sel && Object.keys(byAgent).length === 0) return undefined;
  return { selected: sel, byAgent: Object.keys(byAgent).length ? byAgent : undefined };
}

// ── Mirror of agent.resolveOptions (matches what the file contains) ──────
function resolveOptionsClaude(options) {
  const schema = [
    { key: 'model',     default: 'auto'    },
    { key: 'reasoning', default: 'none'    },
    { key: 'approvals', default: 'default' }
  ];
  const out = {};
  for (const f of schema) out[f.key] = (options?.[f.key] ?? f.default ?? '').trim();
  if (options) {
    for (const [k, v] of Object.entries(options)) {
      if (!(k in out) && typeof v === 'string') out[k] = v.trim();
    }
  }
  return out;
}
function resolveOptionsCopilot(options) {
  const schema = [
    { key: 'mode',      default: 'agent'   },
    { key: 'model',     default: ''        },
    { key: 'approvals', default: 'default' }
  ];
  const out = {};
  for (const f of schema) out[f.key] = (options?.[f.key] ?? f.default ?? '').trim();
  if (options) {
    for (const [k, v] of Object.entries(options)) {
      if (!(k in out) && typeof v === 'string') out[k] = v.trim();
    }
  }
  return out;
}

// ── Test fixtures: what the webview would post for a few picks ───────────
const SCENARIOS = [
  {
    name: 'GitHub Copilot, default mode, no sub-agent, default approvals',
    payload: {
      type: 'run',
      title: 'Implement provider picker',
      description: 'Wire up the dropdown',
      total: '2.5',
      agent: 'copilot',
      agentOptions: {
        copilot: { mode: 'agent', subAgent: '', model: '', approvals: 'default' }
      }
    }
  },
  {
    name: 'GitHub Copilot, sub-agent picked from .claude/agents/, autopilot approvals',
    payload: {
      type: 'run',
      agent: 'copilot',
      agentOptions: {
        copilot: { mode: 'agent', subAgent: 'provider-parity-checker', model: 'gpt-4o', approvals: 'autopilot' }
      }
    }
  },
  {
    name: 'GitHub Copilot, Plan mode',
    payload: {
      type: 'run',
      agent: 'copilot',
      agentOptions: {
        copilot: { mode: 'plan', subAgent: '', model: '', approvals: 'default' }
      }
    }
  },
  {
    name: 'Claude, sub-agent picked, model auto, plan approvals',
    payload: {
      type: 'run',
      agent: 'claude-code',
      agentOptions: {
        'claude-code': { subAgent: 'vscode-extension-reviewer', model: 'auto', reasoning: 'think-hard', approvals: 'plan' }
      }
    }
  },
  {
    name: 'Claude, model pinned, bypass approvals',
    payload: {
      type: 'run',
      agent: 'claude-code',
      agentOptions: {
        'claude-code': { subAgent: '', model: 'claude-opus-4-7', reasoning: 'think', approvals: 'bypassPermissions' }
      }
    }
  }
];

// ── Run each scenario through the same path the panel uses ───────────────
let pass = 0, fail = 0;
const issues = [];

function expect(cond, msg) {
  if (cond) { pass++; }
  else      { fail++; issues.push('  ✗ ' + msg); }
}

for (const sc of SCENARIOS) {
  console.log(`\n━━━ ${sc.name}`);
  const parsed = parseAgentOptions(sc.payload.agent, sc.payload.agentOptions);
  console.log('parsed agentOptions =', JSON.stringify(parsed, null, 2));

  const resolvedType = parsed?.selected ?? 'copilot';
  const opts = parsed?.byAgent?.[resolvedType] ?? {};
  const finalOpts = resolvedType === 'claude-code'
    ? resolveOptionsClaude(opts)
    : resolveOptionsCopilot(opts);
  console.log('finalOpts after resolveOptions =', finalOpts);

  // What command/query would actually be emitted?
  if (resolvedType === 'copilot') {
    const subAgentMention = finalOpts.subAgent ? `@${finalOpts.subAgent} ` : '';
    const wsMention = finalOpts.subAgent ? '' : '@workspace ';
    const modeSlash = `/${finalOpts.mode || 'agent'}`;
    const query = `${subAgentMention}${wsMention}${modeSlash} <task>`;
    console.log('Copilot Chat query →', query);

    const inputSubAgent = sc.payload.agentOptions?.copilot?.subAgent ?? '';
    expect((finalOpts.subAgent ?? '') === inputSubAgent, `subAgent ('${inputSubAgent}') reached run()`);
    expect(finalOpts.approvals === sc.payload.agentOptions?.copilot?.approvals,
           `approvals ('${sc.payload.agentOptions?.copilot?.approvals}') reached run()`);
    if (inputSubAgent) {
      expect(query.startsWith(`@${inputSubAgent} `), 'sub-agent appears as @-mention in query');
    }
  } else if (resolvedType === 'claude-code') {
    const flags = [];
    if (finalOpts.model && finalOpts.model !== 'auto') flags.push(`--model ${finalOpts.model}`);
    if (finalOpts.approvals && finalOpts.approvals !== 'default') flags.push(`--permission-mode ${finalOpts.approvals}`);
    const subAgentLine = finalOpts.subAgent ? `Use the ${finalOpts.subAgent} subagent for this task.` : '';
    const command = `claude ${flags.join(' ')} "<prompt>"`;
    console.log('Claude CLI command →', command);
    if (subAgentLine) console.log('Prompt prefix      →', subAgentLine);

    const inputSubAgent = sc.payload.agentOptions?.['claude-code']?.subAgent ?? '';
    const inputModel    = sc.payload.agentOptions?.['claude-code']?.model ?? 'auto';
    const inputApprovals= sc.payload.agentOptions?.['claude-code']?.approvals ?? 'default';

    expect((finalOpts.subAgent ?? '') === inputSubAgent, `subAgent ('${inputSubAgent}') reached run()`);
    if (inputModel === 'auto') {
      expect(!flags.some(f => f.startsWith('--model ')), 'no --model flag when "auto"');
    } else {
      expect(flags.includes(`--model ${inputModel}`), `--model ${inputModel} flag emitted`);
    }
    if (inputApprovals === 'default') {
      expect(!flags.some(f => f.startsWith('--permission-mode ')), 'no --permission-mode when "default"');
    } else {
      expect(flags.includes(`--permission-mode ${inputApprovals}`), `--permission-mode ${inputApprovals} emitted`);
    }
    if (inputSubAgent) {
      expect(subAgentLine.includes(inputSubAgent), 'sub-agent name appears in prompt prefix');
    }
  }
}

console.log('\n========================================');
console.log(`Results: ${pass} passed, ${fail} failed`);
if (issues.length) {
  console.log('Failures:');
  for (const i of issues) console.log(i);
  process.exit(1);
}
process.exit(0);
