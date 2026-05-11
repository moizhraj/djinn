import * as vscode from 'vscode';
import { AgentOptionField, Todo } from '../types';
import { AgentAdapter } from './agentRegistry';
import { TodoStore } from '../store/todoStore';
import { MetricsStore } from '../store/metricsStore';
import { buildWorkspaceContext } from './contextBuilder';

const MODE_CHOICES = [
  { value: 'agent', label: 'Agent' },
  { value: 'ask',   label: 'Ask'   },
  { value: 'plan',  label: 'Plan'  }
];

const COPILOT_MODEL_CHOICES = [
  { value: '', label: 'Auto' },
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4.1', label: 'GPT-4.1' },
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { value: 'o3', label: 'o3' },
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' }
];

const COPILOT_APPROVAL_CHOICES = [
  { value: 'default',   label: 'Default Approvals' },
  { value: 'bypass',    label: 'Bypass Approvals' },
  { value: 'autopilot', label: 'Autopilot (Preview)' }
];

/**
 * Delegates to the GitHub Copilot extension's chat by opening Copilot Chat with
 * the todo as a prompt. Falls back gracefully if Copilot is not installed.
 */
export class CopilotAgent implements AgentAdapter {
  readonly type = 'copilot' as const;
  readonly label = 'GitHub Copilot';

  constructor(
    private workspaceRoot: vscode.Uri,
    private todos: TodoStore,
    private metrics: MetricsStore
  ) {}

  async isAvailable(): Promise<boolean> {
    return !!vscode.extensions.getExtension('GitHub.copilot-chat')
      || !!vscode.extensions.getExtension('GitHub.copilot');
  }

  optionsSchema(): AgentOptionField[] {
    const cfg = vscode.workspace.getConfiguration('djinn');
    return [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        choices: MODE_CHOICES,
        default: cfg.get<string>('copilot.mode', 'agent')
      },
      {
        key: 'model',
        label: 'Model',
        type: 'select',
        choices: COPILOT_MODEL_CHOICES,
        default: cfg.get<string>('copilot.model', ''),
        description: 'Preferred model to hint in the prompt. Copilot ultimately picks based on its own settings.'
      },
      {
        key: 'approvals',
        label: 'Approvals',
        type: 'select',
        choices: COPILOT_APPROVAL_CHOICES,
        default: cfg.get<string>('copilot.approvals', 'default'),
        description: 'How aggressively Copilot auto-approves tool calls.'
      }
    ];
  }

  async run(todo: Todo, options?: Record<string, string>): Promise<void> {
    const opts = this.resolveOptions(options);
    const ctx = await buildWorkspaceContext(this.workspaceRoot);

    // Picking a sub-agent in the form sets `mode = 'agent'` automatically.
    // Inject it as an @-mention so VS Code's Copilot Chat routes the prompt
    // to that custom agent. Skip @workspace when targeting a sub-agent —
    // the agent owns its own context.
    const subAgentMention = opts.subAgent ? `@${opts.subAgent} ` : '';
    const workspaceMention = opts.subAgent ? '' : '@workspace ';
    const modeSlash = `/${opts.mode || 'agent'}`;
    const modelHint = opts.model ? `(model: ${opts.model})\n` : '';

    // Approvals isn't directly settable through the chat-open command — the
    // VS Code Copilot Chat API has no programmatic flag for it today. We
    // surface the user's choice in the prompt as a hint so they (or the
    // agent) can react, and warn once per non-default selection.
    const approvalsHint =
      opts.approvals === 'bypass'    ? '(approvals: bypass — auto-approve all tool calls)\n'
      : opts.approvals === 'autopilot' ? '(approvals: autopilot — iterate autonomously)\n'
      : '';

    const query = [
      `${subAgentMention}${workspaceMention}${modeSlash} ${todo.title}`,
      approvalsHint + modelHint + (todo.description ?? ''),
      '',
      ctx
    ].filter(Boolean).join('\n');

    await this.todos.update(todo.id, {
      status: 'in-progress',
      agent: { type: this.type, lastRunAt: new Date().toISOString(), lastOutputSnippet: query.slice(0, 500) }
    });
    await this.metrics.increment('agentRunsTriggered');

    if (opts.approvals && opts.approvals !== 'default') {
      vscode.window.showInformationMessage(
        `Copilot Chat doesn't expose '${opts.approvals}' approvals as a programmatic flag — set it manually in Copilot if needed.`
      );
    }

    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query });
    } catch (e) {
      vscode.window.showWarningMessage(`Could not open Copilot Chat: ${e instanceof Error ? e.message : String(e)}`);
    }
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
