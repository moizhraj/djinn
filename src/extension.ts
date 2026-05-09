import * as vscode from 'vscode';
import { TodoStore } from './store/todoStore';
import { MetricsStore } from './store/metricsStore';
import { AdoConfigStore } from './config/adoConfig';
import { TodoTreeProvider, TodoTreeItem } from './ui/todoTreeProvider';
import { TodoEditorPanel } from './ui/todoEditorPanel';
import { MetricsPanel } from './ui/metricsPanel';
import { SyncService } from './ado/sync';
import { EffortEstimator } from './agents/effortEstimator';
import { AgentRegistry } from './agents/agentRegistry';
import { ensurePat, setPat } from './config/secrets';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('ADO Todos: open a folder to use this extension.');
    return;
  }
  const root = folder.uri;

  const todos = new TodoStore(root);
  await todos.init();
  const metrics = new MetricsStore(root);
  await metrics.load();
  const cfgStore = new AdoConfigStore(root);
  const estimator = new EffortEstimator(root);
  const sync = new SyncService(todos, metrics, cfgStore, context.secrets, estimator);
  const agents = new AgentRegistry(root, todos, metrics, cfgStore, context.secrets);

  const treeProvider = new TodoTreeProvider(todos);
  const treeView = vscode.window.createTreeView('adoTodos.todoTree', { treeDataProvider: treeProvider });

  context.subscriptions.push(
    todos,
    treeView,

    vscode.commands.registerCommand('adoTodos.refresh', () => treeProvider.refresh()),

    vscode.commands.registerCommand('adoTodos.add', async () => {
      const title = await vscode.window.showInputBox({ prompt: 'Todo title', ignoreFocusOut: true });
      if (!title) return;
      await todos.add(title.trim());
    }),

    vscode.commands.registerCommand('adoTodos.edit', async (arg: TodoTreeItem | string | undefined) => {
      const id = typeof arg === 'string' ? arg : arg?.todo.id;
      if (!id) return;
      TodoEditorPanel.show(todos, id);
    }),

    vscode.commands.registerCommand('adoTodos.delete', async (item: TodoTreeItem) => {
      if (!item) return;
      const yes = await vscode.window.showWarningMessage(`Delete "${item.todo.title}"?`, { modal: true }, 'Delete');
      if (yes === 'Delete') await todos.remove(item.todo.id);
    }),

    vscode.commands.registerCommand('adoTodos.sync', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Syncing todos to Azure DevOps…' },
        async () => {
          const result = await sync.sync();
          const msg = `Synced. Created: ${result.created}, Updated: ${result.updated}, Failed: ${result.failed}.`;
          if (result.failed > 0) {
            vscode.window.showWarningMessage(`${msg}\n${result.errors.join('\n')}`);
          } else {
            vscode.window.showInformationMessage(msg);
          }
        }
      );
    }),

    vscode.commands.registerCommand('adoTodos.runAgent', async (item: TodoTreeItem) => {
      if (!item) return;
      const available = await agents.listAvailable();
      if (available.length === 0) {
        vscode.window.showWarningMessage('No agents available. Install Claude Code, GitHub Copilot, or sync to ADO first.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        available.map(a => ({ label: a.label, type: a.type })),
        { placeHolder: 'Run with which agent?' }
      );
      if (!pick) return;
      const adapter = agents.get(pick.type);
      if (adapter) await adapter.run(item.todo);
    }),

    vscode.commands.registerCommand('adoTodos.openMetrics', async () => {
      await MetricsPanel.show(metrics, todos);
    }),

    vscode.commands.registerCommand('adoTodos.configure', async () => {
      const cfg = await cfgStore.ensure();
      if (cfg) {
        await ensurePat(context.secrets, cfg.orgUrl);
        vscode.window.showInformationMessage(`ADO configured for ${cfg.project} @ ${cfg.orgUrl}.`);
      }
    }),

    vscode.commands.registerCommand('adoTodos.setPat', async () => {
      const cfg = await cfgStore.ensure();
      if (!cfg) return;
      const pat = await vscode.window.showInputBox({
        prompt: `PAT for ${cfg.orgUrl}`,
        password: true,
        ignoreFocusOut: true
      });
      if (pat) {
        await setPat(context.secrets, cfg.orgUrl, pat);
        vscode.window.showInformationMessage('PAT saved.');
      }
    })
  );
}

export function deactivate(): void {
  // disposables cleaned up via context.subscriptions
}
