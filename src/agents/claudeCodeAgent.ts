import * as vscode from 'vscode';
import { exec } from 'child_process';
import { AgentOptionField, Todo } from '../types';
import { AgentAdapter } from './agentRegistry';
import { TodoStore } from '../store/todoStore';
import { MetricsStore } from '../store/metricsStore';
import { spawnAgentTerminal } from '../util/terminalCapture';
import { buildWorkspaceContext } from './contextBuilder';
import { markTodoCompleted } from '../store/completion';
import { ensureDjinnStopHook, sentinelUri } from '../util/claudeStopHook';

const MODEL_CHOICES = [
  { value: 'auto', label: 'Auto' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
];

const REASONING_CHOICES = [
  { value: 'none', label: 'None' },
  { value: 'think', label: 'Think' },
  { value: 'think-hard', label: 'Think hard' },
  { value: 'ultrathink', label: 'Ultrathink' }
];

const APPROVAL_CHOICES = [
  { value: 'default', label: 'Default (prompt per tool)' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan only' },
  { value: 'bypassPermissions', label: 'Bypass (yolo)' }
];

export class ClaudeCodeAgent implements AgentAdapter {
  readonly type = 'claude-code' as const;
  readonly label = 'Claude';

  constructor(
    private workspaceRoot: vscode.Uri,
    private todos: TodoStore,
    private metrics: MetricsStore
  ) {}

  async isAvailable(): Promise<boolean> {
    const cmd = vscode.workspace.getConfiguration('djinn').get<string>('claudeCodeCommand', 'claude');
    return new Promise(resolve => {
      const which = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
      exec(which, err => resolve(!err));
    });
  }

  optionsSchema(): AgentOptionField[] {
    const cfg = vscode.workspace.getConfiguration('djinn');
    return [
      {
        key: 'model',
        label: 'Model',
        type: 'select',
        choices: MODEL_CHOICES,
        default: cfg.get<string>('claudeCode.model', 'auto')
      },
      {
        key: 'reasoning',
        label: 'Reasoning',
        type: 'select',
        choices: REASONING_CHOICES,
        default: cfg.get<string>('claudeCode.reasoning', 'none')
      },
      {
        key: 'approvals',
        label: 'Approvals',
        type: 'select',
        choices: APPROVAL_CHOICES,
        default: cfg.get<string>('claudeCode.approvals', 'default')
      }
    ];
  }

  async run(todo: Todo, options?: Record<string, string>): Promise<void> {
    const cmd = vscode.workspace.getConfiguration('djinn').get<string>('claudeCodeCommand', 'claude');
    const opts = this.resolveOptions(options);

    const ctx = await buildWorkspaceContext(this.workspaceRoot);
    const reasoningPrefix = reasoningHint(opts.reasoning);
    // If the user picked a sub-agent in the form, route the prompt to that
    // subagent. Claude Code's convention is to ask the agent by name; the
    // CLI's planner will dispatch to the matching `.claude/agents/<name>.md`
    // when the request explicitly mentions it.
    const subAgentLine = opts.subAgent
      ? `Use the ${opts.subAgent} subagent for this task.`
      : '';
    const prompt = [
      ctx,
      '',
      subAgentLine,
      `Task: ${todo.title}`,
      todo.description ? `Details: ${todo.description}` : '',
      reasoningPrefix
    ].filter(Boolean).join('\n');

    const escaped = prompt.replace(/"/g, '\\"');
    const flags: string[] = [];
    // 'auto' is the form default — let Claude pick the model rather than
    // pinning a specific one.
    if (opts.model && opts.model !== 'auto') flags.push(`--model ${opts.model}`);
    if (opts.approvals && opts.approvals !== 'default') flags.push(`--permission-mode ${opts.approvals}`);
    const command = `${cmd} ${flags.join(' ')} "${escaped}"`.replace(/\s+/g, ' ');

    const startedAt = Date.now();
    await this.todos.update(todo.id, {
      status: 'in-progress',
      agent: { type: this.type, lastRunAt: new Date(startedAt).toISOString(), lastOutputSnippet: prompt.slice(0, 500) }
    });
    await this.metrics.increment('agentRunsTriggered');

    // Install the Stop-hook sentinel writer once per workspace. Each run
    // gets its own sentinel path so the first turn that completes marks the
    // task done — no need to wait for the user to exit the CLI session.
    await ensureDjinnStopHook(this.workspaceRoot);
    const runId = `${todo.id}-${Date.now()}`;
    const sentinel = sentinelUri(this.workspaceRoot, runId);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceRoot, `.djinn/completion/${runId}.done`)
    );

    const { done, getOutput } = spawnAgentTerminal(
      `Claude Code · ${todo.title}`,
      this.workspaceRoot,
      command,
      { DJINN_DONE_FILE: sentinel.fsPath }
    );

    let settled = false;
    const finish = async (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      watcher.dispose();
      try { await vscode.workspace.fs.delete(sentinel); } catch { /* may not exist */ }
      if (succeeded) {
        const tokensUsed = parseTokensUsed(getOutput());
        const durationMs = Date.now() - startedAt;
        await markTodoCompleted(this.todos, this.metrics, todo.id, { tokensUsed, durationMs });
      } else {
        await this.todos.update(todo.id, { status: 'failed' });
      }
    };

    watcher.onDidCreate(() => { void finish(true); });
    done.then(({ exitCode }) => {
      const succeeded = exitCode == null || exitCode === 0;
      void finish(succeeded);
    });
  }

  private resolveOptions(options?: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    // Apply schema defaults first.
    for (const f of this.optionsSchema()) {
      out[f.key] = (options?.[f.key] ?? f.default ?? '').trim();
    }
    // Then pass through any extra keys not in the schema (e.g. `subAgent`,
    // which is rendered by a custom chip rather than a schema field).
    if (options) {
      for (const [k, v] of Object.entries(options)) {
        if (!(k in out) && typeof v === 'string') out[k] = v.trim();
      }
    }
    return out;
  }
}

function parseTokensUsed(output: string): number | undefined {
  if (!output) return undefined;
  // Strip ANSI/CSI sequences so terminal styling doesn't break the regex.
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
  const matches = [...plain.matchAll(/(\d[\d,]*)\s*tokens?\b/gi)];
  if (matches.length === 0) return undefined;
  const last = matches[matches.length - 1][1].replace(/,/g, '');
  const n = parseInt(last, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function reasoningHint(level: string | undefined): string {
  switch (level) {
    case 'think': return 'think';
    case 'think-hard': return 'think hard';
    case 'ultrathink': return 'ultrathink';
    default: return '';
  }
}
