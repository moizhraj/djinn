import * as vscode from 'vscode';
import { Todo } from '../types';
import { AgentAdapter } from './agentRegistry';
import { TodoStore } from '../store/todoStore';
import { MetricsStore } from '../store/metricsStore';
import { buildWorkspaceContext } from './contextBuilder';

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

  async run(todo: Todo): Promise<void> {
    const ctx = await buildWorkspaceContext(this.workspaceRoot);
    const query = [
      `@workspace /agent ${todo.title}`,
      todo.description ?? '',
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
}
