import * as vscode from 'vscode';
import { AgentOptionField, Todo } from '../types';
import { AgentAdapter } from './agentRegistry';
import { TodoStore } from '../store/todoStore';
import { MetricsStore } from '../store/metricsStore';
import { buildWorkspaceContext } from './contextBuilder';

const MODE_CHOICES = [
  { value: 'agent', label: 'Agent' },
  { value: 'edit', label: 'Edit' },
  { value: 'ask', label: 'Ask' }
];

const COPILOT_MODEL_CHOICES = [
  { value: '', label: 'Default (Copilot picks)' },
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4.1', label: 'GPT-4.1' },
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { value: 'o3', label: 'o3' },
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' }
];

/**
 * Delegates to the GitHub Copilot extension's chat by opening Copilot Chat with
 * the todo as a prompt. Falls back gracefully if Copilot is not installed.
 */
export class CopilotAgent implements AgentAdapter {
  readonly type = 'copilot' as const;
  readonly label = 'GitHub Copilot agent';

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
      }
    ];
  }

  async run(todo: Todo, options?: Record<string, string>): Promise<void> {
    const opts = this.resolveOptions(options);
    const ctx = await buildWorkspaceContext(this.workspaceRoot);
    const modeSlash = `/${opts.mode || 'agent'}`;
    const modelHint = opts.model ? `(model: ${opts.model})\n` : '';
    const query = [
      `@workspace ${modeSlash} ${todo.title}`,
      modelHint + (todo.description ?? ''),
      '',
      ctx
    ].filter(Boolean).join('\n');

    await this.todos.update(todo.id, {
      status: 'in-progress',
      agent: { type: this.type, lastRunAt: new Date().toISOString(), lastOutputSnippet: query.slice(0, 500) }
    });
    await this.metrics.increment('agentRunsTriggered');

    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query });
    } catch (e) {
      vscode.window.showWarningMessage(`Could not open Copilot Chat: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private resolveOptions(options?: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.optionsSchema()) {
      out[f.key] = (options?.[f.key] ?? f.default ?? '').trim();
    }
    return out;
  }
}
