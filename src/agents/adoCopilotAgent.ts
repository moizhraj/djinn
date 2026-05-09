import * as vscode from 'vscode';
import { Todo } from '../types';
import { AgentAdapter } from './agentRegistry';
import { TodoStore } from '../store/todoStore';
import { MetricsStore } from '../store/metricsStore';
import { AdoConfigStore } from '../config/adoConfig';

/**
 * "Trigger" the ADO Copilot agent on the work item. Until ADO exposes a stable
 * API for that, this opens the work item in the browser where the user can hand
 * it off to ADO Copilot. Marked unavailable when the todo is not yet synced.
 */
export class AdoCopilotAgent implements AgentAdapter {
  readonly type = 'ado-copilot' as const;
  readonly label = 'Azure DevOps Copilot (open work item)';

  constructor(
    private workspaceRoot: vscode.Uri,
    private todos: TodoStore,
    private metrics: MetricsStore,
    private cfgStore: AdoConfigStore,
    private _secrets: vscode.SecretStorage
  ) {}

  async isAvailable(): Promise<boolean> {
    const cfg = await this.cfgStore.load();
    return !!cfg?.orgUrl && !!cfg?.project;
  }

  async run(todo: Todo): Promise<void> {
    const cfg = await this.cfgStore.load();
    if (!cfg) {
      vscode.window.showWarningMessage('ADO config missing.');
      return;
    }
    if (todo.adoWorkItemId == null) {
      vscode.window.showWarningMessage('Sync the todo to ADO before triggering ADO Copilot.');
      return;
    }
    const url = `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_workitems/edit/${todo.adoWorkItemId}`;
    await this.todos.update(todo.id, {
      status: 'in-progress',
      agent: { type: this.type, lastRunAt: new Date().toISOString(), lastOutputSnippet: `Opened ${url}` }
    });
    await this.metrics.increment('agentRunsTriggered');
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}
