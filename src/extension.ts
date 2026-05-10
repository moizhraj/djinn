import * as vscode from 'vscode';
import { TodoStore } from './store/todoStore';
import { MetricsStore } from './store/metricsStore';
import { WorkspaceConfigStore } from './config/workspaceConfig';
import { migrate } from './config/migration';
import { TodoTreeProvider, TodoTreeItem } from './ui/todoTreeProvider';
import { TodoEditorPanel } from './ui/todoEditorPanel';
import { MetricsPanel } from './ui/metricsPanel';
import { SyncService } from './providers/syncService';
import { createProvider } from './providers/factory';
import { EffortEstimator } from './agents/effortEstimator';
import { AgentRegistry } from './agents/agentRegistry';
import { recordEstimatedEffort } from './store/completion';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    // Still register an empty tree so VS Code doesn't show "no provider".
    const empty: vscode.TreeDataProvider<never> = { getTreeItem: () => new vscode.TreeItem(''), getChildren: () => [] };
    context.subscriptions.push(vscode.window.createTreeView('djinn.todoTree', { treeDataProvider: empty }));
    vscode.window.showWarningMessage('Djinn: open a folder to use this extension.');
    return;
  }
  const root = folder.uri;

  const todos = new TodoStore(root);
  const metrics = new MetricsStore(root);
  const cfgStore = new WorkspaceConfigStore(root);
  const estimator = new EffortEstimator(root);
  const sync = new SyncService(todos, metrics, cfgStore, context.secrets, estimator);
  const agents = new AgentRegistry(root, todos, metrics, cfgStore, context.secrets);

  // ── Register UI + commands SYNCHRONOUSLY so the view always binds ──
  const treeProvider = new TodoTreeProvider(todos);
  const treeView = vscode.window.createTreeView('djinn.todoTree', { treeDataProvider: treeProvider });

  const version = context.extension.packageJSON.version as string;
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'djinn.configure';
  statusBar.text = `$(checklist) Djinn (${version})`;
  statusBar.tooltip = 'Click to configure a sync provider.';
  statusBar.show();

  const refreshStatusBar = async () => {
    try {
      const cfg = await cfgStore.load();
      if (cfg) {
        statusBar.text = `$(checklist) Djinn: ${cfg.provider} (${version})`;
        statusBar.tooltip = `Provider: ${cfg.provider}. Click to reconfigure.`;
      }
    } catch {
      // leave default
    }
  };

  const updateViewTitle = async () => {
    try {
      const cfg = await cfgStore.load();
      treeView.title = cfg ? `Todos (${cfg.provider})` : 'Todos';
    } catch {
      treeView.title = 'Todos';
    }
  };

  context.subscriptions.push(
    todos,
    treeView,
    statusBar,

    vscode.commands.registerCommand('djinn.refresh', () => treeProvider.refresh()),

    vscode.commands.registerCommand('djinn.add', async () => {
      try {
        const title = await vscode.window.showInputBox({ prompt: 'Todo title', ignoreFocusOut: true });
        if (!title) return;
        const created = await todos.add(title.trim());
        // Estimate effort in the background so totals/remaining/completed are
        // populated immediately without blocking the add UX.
        void (async () => {
          try {
            const total = await estimator.estimate(created);
            await recordEstimatedEffort(todos, metrics, created.id, total);
          } catch (e) {
            console.warn('Effort estimation failed:', e);
          }
        })();
      } catch (e) {
        vscode.window.showErrorMessage(`Add todo failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    vscode.commands.registerCommand('djinn.edit', async (arg: TodoTreeItem | string | undefined) => {
      const id = typeof arg === 'string' ? arg : arg?.todo.id;
      if (!id) return;
      TodoEditorPanel.show(todos, agents, id, estimator);
    }),

    vscode.commands.registerCommand('djinn.delete', async (item: TodoTreeItem) => {
      if (!item) return;
      const yes = await vscode.window.showWarningMessage(`Delete "${item.todo.title}"?`, { modal: true }, 'Delete');
      if (yes === 'Delete') await todos.remove(item.todo.id);
    }),

    vscode.commands.registerCommand('djinn.sync', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Syncing todos…' },
        async () => {
          try {
            const result = await sync.sync();
            await refreshStatusBar();
            await updateViewTitle();
            if (result.skipped > 0 && result.created === 0 && result.updated === 0 && result.failed === 0) {
              return;
            }
            const msg = `Synced. Created: ${result.created}, Updated: ${result.updated}, Failed: ${result.failed}.`;
            if (result.failed > 0) vscode.window.showWarningMessage(`${msg}\n${result.errors.join('\n')}`);
            else vscode.window.showInformationMessage(msg);
          } catch (e) {
            vscode.window.showErrorMessage(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      );
    }),

    vscode.commands.registerCommand('djinn.runAgent', async (item: TodoTreeItem) => {
      if (!item) return;
      const available = await agents.listAvailable();
      if (available.length === 0) {
        vscode.window.showWarningMessage('No agents available.');
        return;
      }
      const preselected = item.todo.agentOptions?.selected;
      const preferred = preselected && available.find(a => a.type === preselected);
      let chosenType = preferred?.type;
      if (!chosenType) {
        const pick = await vscode.window.showQuickPick(
          available.map(a => ({ label: a.label, type: a.type })),
          { placeHolder: 'Run with which agent?' }
        );
        if (!pick) return;
        chosenType = pick.type;
      }
      const adapter = agents.get(chosenType);
      if (adapter) {
        const opts = item.todo.agentOptions?.byAgent?.[chosenType];
        await adapter.run(item.todo, opts);
      }
    }),

    vscode.commands.registerCommand('djinn.openMetrics', async () => {
      await MetricsPanel.show(metrics, todos);
    }),

    vscode.commands.registerCommand('djinn.configure', async () => {
      try {
        const existing = await cfgStore.load();
        if (existing) {
          const options = existing.provider === 'ado'
            ? ['Keep current settings', 'Reconfigure ADO settings', 'Switch provider']
            : ['Keep current provider', 'Switch provider'];
          const reset = await vscode.window.showQuickPick(
            options,
            { placeHolder: `Current provider: ${existing.provider}` }
          );
          if (!reset) return;
          if (reset === 'Switch provider') {
            const { provider: _p, ...rest } = existing;
            void _p;
            await cfgStore.save(rest as never);
          } else if (reset === 'Reconfigure ADO settings') {
            const { orgUrl: _o, project: _proj, team: _t, areaPath: _a, iterationPath: _i, ...rest } = existing;
            void _o; void _proj; void _t; void _a; void _i;
            await cfgStore.save({ ...rest, provider: 'ado' });
          }
        }
        const cfg = await cfgStore.ensure();
        if (cfg) {
          const provider = createProvider(cfg, context.secrets);
          if (provider.canSync) await provider.ensureAuth();
          vscode.window.showInformationMessage(`Configured: ${provider.displayName}.`);
          await refreshStatusBar();
          await updateViewTitle();
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Configure failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );

  // ── Async setup AFTER the view is bound ──
  // None of the steps below should block the view from rendering or break it on failure.
  void (async () => {
    try {
      await migrate(root);
    } catch (e) {
      console.warn('Djinn migration failed:', e);
    }
    try {
      await todos.init();
    } catch (e) {
      console.warn('Djinn todoStore init failed:', e);
    }
    try {
      await metrics.load();
    } catch (e) {
      console.warn('Djinn metricsStore load failed:', e);
    }

    let detected;
    try {
      detected = await cfgStore.detect();
    } catch (e) {
      console.warn('Djinn provider detection failed:', e);
    }
    await refreshStatusBar();
    await updateViewTitle();

    if (detected && detected.provider !== 'local') {
      const connectKey = `connectPrompted:${root.fsPath}`;
      if (!context.workspaceState.get<boolean>(connectKey)) {
        let provider;
        try {
          provider = createProvider(detected, context.secrets);
        } catch (e) {
          console.warn('Djinn createProvider failed:', e);
          return;
        }
        void context.workspaceState.update(connectKey, true);
        const choice = await vscode.window.showInformationMessage(
          `Detected ${provider.displayName} repo. Connect to enable sync?`,
          'Connect',
          'Not now'
        );
        if (choice === 'Connect') {
          const ok = await provider.ensureAuth();
          if (ok) vscode.window.showInformationMessage(`${provider.displayName}: connected.`);
        }
      }
    }
  })();
}

export function deactivate(): void {
  // disposables cleaned up via context.subscriptions
}
