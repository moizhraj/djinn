import * as vscode from 'vscode';
import { MetricsStore } from '../store/metricsStore';
import { TodoStore } from '../store/todoStore';

export class MetricsPanel {
  private static current?: MetricsPanel;

  static async show(metrics: MetricsStore, todos: TodoStore): Promise<void> {
    if (MetricsPanel.current) {
      MetricsPanel.current.panel.reveal();
      MetricsPanel.current.refresh();
      return;
    }
    await metrics.load();
    MetricsPanel.current = new MetricsPanel(metrics, todos);
  }

  private panel: vscode.WebviewPanel;

  private constructor(private metrics: MetricsStore, private todos: TodoStore) {
    this.panel = vscode.window.createWebviewPanel(
      'anvil.metrics',
      'Anvil · Metrics',
      vscode.ViewColumn.One,
      { enableScripts: false }
    );
    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => (MetricsPanel.current = undefined));

    const sub = todos.onDidChange(() => this.refresh());
    this.panel.onDidDispose(() => sub.dispose());
  }

  private async refresh() {
    await this.metrics.load();
    this.panel.webview.html = this.render();
  }

  private render(): string {
    const m = this.metrics.get();
    const items = this.todos.list();
    const draft = items.filter(t => t.status === 'draft').length;
    const synced = items.filter(t => t.status === 'synced').length;
    const inProgress = items.filter(t => t.status === 'in-progress').length;
    const done = items.filter(t => t.status === 'done').length;
    const failed = items.filter(t => t.status === 'failed').length;

    const card = (label: string, value: string | number) => `
      <div class="card"><div class="value">${value}</div><div class="label">${label}</div></div>`;

    return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 24px; color: var(--vscode-foreground); }
  h2 { margin-top: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  .card { padding: 16px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; }
  .value { font-size: 28px; font-weight: 700; }
  .label { color: var(--vscode-descriptionForeground); margin-top: 4px; }
</style></head><body>
  <h1>Anvil · Metrics</h1>

  <h2>Activity</h2>
  <div class="grid">
    ${card('Tasks created', m.tasksCreated)}
    ${card('Tasks completed', m.tasksCompleted)}
    ${card('Agent runs triggered', m.agentRunsTriggered)}
  </div>

  <h2>Hours</h2>
  <div class="grid">
    ${card('Estimated', m.totalEstimatedHours.toFixed(1))}
    ${card('Completed', m.totalCompletedHours.toFixed(1))}
    ${card('Saved', m.hoursSaved.toFixed(1))}
  </div>

  <h2>Tokens</h2>
  <div class="grid">
    ${card('Total tokens used', (m.totalTokensUsed ?? 0).toLocaleString())}
  </div>

  <h2>Pipeline (current)</h2>
  <div class="grid">
    ${card('Draft', draft)}
    ${card('Synced', synced)}
    ${card('In progress', inProgress)}
    ${card('Done', done)}
    ${card('Failed', failed)}
  </div>
</body></html>`;
  }
}
