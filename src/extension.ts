import * as vscode from 'vscode';
import { TodoStore } from './store/todoStore';
import { MetricsStore } from './store/metricsStore';
import { WorkspaceConfigStore } from './config/workspaceConfig';
import { migrate } from './config/migration';
import { TodoEditorViewProvider } from './ui/todoEditorViewProvider';
import { MetricsPanel } from './ui/metricsPanel';
import { SyncService } from './providers/syncService';
import { createProvider } from './providers/factory';
import { EffortEstimator } from './agents/effortEstimator';
import { AgentRegistry } from './agents/agentRegistry';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
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
  const editorView = new TodoEditorViewProvider(todos, metrics, agents, estimator);
  const editorRegistration = vscode.window.registerWebviewViewProvider(
    TodoEditorViewProvider.viewId,
    editorView,
    { webviewOptions: { retainContextWhenHidden: true } }
  );

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

  // Provider name no longer needs to drive a tree-view title — it's already
  // visible in the status bar. Keeping a no-op so the rest of the file's
  // call sites compile without churn.
  const updateViewTitle = async () => { /* noop */ };
  void updateViewTitle;

  context.subscriptions.push(
    todos,
    editorRegistration,
    statusBar,

    vscode.commands.registerCommand('djinn.refresh', () => {
      // Tree is gone; the webview re-renders on store changes automatically.
      // The command is still registered so existing keybindings / palette
      // entries don't break — and we trigger a manual refresh by
      // re-loading the store from disk in case external edits were missed.
      void todos.init();
    }),

    vscode.commands.registerCommand('djinn.add', async () => {
      // The form *is* the create UI now: clear the editor and reveal it.
      editorView.setTodo(null);
      try {
        await vscode.commands.executeCommand('djinn.todoEditor.focus');
      } catch {
        // view may not have rendered yet; setTodo will apply on first resolve
      }
    }),

    vscode.commands.registerCommand('djinn.edit', async (arg: { todo?: { id: string } } | string | undefined) => {
      const id = typeof arg === 'string' ? arg : (arg && typeof arg === 'object' && arg.todo ? arg.todo.id : undefined);
      if (!id) return;
      editorView.setTodo(id);
      try {
        await vscode.commands.executeCommand('djinn.todoEditor.focus');
      } catch {
        // view not rendered yet — setTodo is cached and will apply on resolve
      }
    }),

    vscode.commands.registerCommand('djinn.delete', async (arg: { todo?: { id: string; title: string } } | string | undefined) => {
      // Still callable from the command palette; the in-panel rows route
      // through the webview's message handler instead.
      const id = typeof arg === 'string' ? arg : (arg && typeof arg === 'object' && arg.todo ? arg.todo.id : undefined);
      if (!id) return;
      const target = todos.list().find(t => t.id === id);
      if (!target) return;
      const yes = await vscode.window.showWarningMessage(`Delete "${target.title}"?`, { modal: true }, 'Delete');
      if (yes === 'Delete') await todos.remove(id);
    }),

    vscode.commands.registerCommand('djinn.sync', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Syncing todos…' },
        async () => {
          try {
            const result = await sync.sync();
            await refreshStatusBar();
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

    vscode.commands.registerCommand('djinn.runAgent', async (arg: { todo?: { id: string } } | string | undefined) => {
      const id = typeof arg === 'string' ? arg : (arg && typeof arg === 'object' && arg.todo ? arg.todo.id : undefined);
      if (!id) return;
      const target = todos.list().find(t => t.id === id);
      if (!target) return;
      const available = await agents.listAvailable();
      if (available.length === 0) {
        vscode.window.showWarningMessage('No agents available.');
        return;
      }
      const preselected = target.agentOptions?.selected;
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
        const opts = target.agentOptions?.byAgent?.[chosenType];
        await adapter.run(target, opts);
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
