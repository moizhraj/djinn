import * as vscode from 'vscode';
import { AgentOptionField, Todo } from '../types';
import { AgentAdapter } from './agentRegistry';
import { TodoStore } from '../store/todoStore';
import { MetricsStore } from '../store/metricsStore';
import { WorkspaceConfigStore } from '../config/workspaceConfig';

/**
 * Opens the synced remote issue in a browser. Useful as a "handoff" step —
 * e.g. trigger ADO Copilot, GitHub Copilot, or any provider-side automation
 * the user has wired up on the issue itself.
 */
export class OpenIssueAgent implements AgentAdapter {
  readonly type = 'open-issue' as const;
  readonly label = 'Cloud';

  constructor(
    private todos: TodoStore,
    private metrics: MetricsStore,
    private cfgStore: WorkspaceConfigStore
  ) {}

  async isAvailable(): Promise<boolean> {
    const cfg = await this.cfgStore.load();
    return !!cfg && cfg.provider !== 'local';
  }

  optionsSchema(): AgentOptionField[] {
    return [];
  }

  async run(todo: Todo, _options?: Record<string, string>): Promise<void> {
    if (!todo.remoteUrl && !todo.remoteId) {
      vscode.window.showWarningMessage('Sync this todo first so an issue exists to open.');
      return;
    }
    const url = todo.remoteUrl;
    if (!url) {
      vscode.window.showWarningMessage('Remote URL unknown. Re-sync the todo.');
      return;
    }
    await this.todos.update(todo.id, {
      status: 'in-progress',
      agent: { type: this.type, lastRunAt: new Date().toISOString(), lastOutputSnippet: `Opened ${url}` }
    });
    await this.metrics.increment('agentRunsTriggered');
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}
