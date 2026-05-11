import * as vscode from 'vscode';
import { TodoStore } from '../store/todoStore';
import { AgentRegistry } from '../agents/agentRegistry';
import { EffortEstimator } from '../agents/effortEstimator';
import { AgentType, Todo, TodoAgentOptions } from '../types';
import { AgentDescriptor, renderTodoEditorHtml } from './todoEditorView';
import { discoverSubAgents } from '../agents/subAgentDiscovery';
import { recordEstimatedEffort } from '../store/completion';
import { MetricsStore } from '../store/metricsStore';

/**
 * Renders the editor as a webview embedded in the activity-bar panel
 * (alongside the todo tree). Holds at most ONE active todo at a time:
 *   - `currentTodoId === null` → Create mode: empty form, "Create" button.
 *   - `currentTodoId === <id>` → Edit mode: fields populated from the store,
 *                                Save + Run buttons.
 *
 * Selection is driven externally — the tree's `onDidChangeSelection` calls
 * `setTodo(id)`, the activity-bar `+` button calls `setTodo(null)`.
 */
export class TodoEditorViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'djinn.todoEditor';

  private view?: vscode.WebviewView;
  private currentTodoId: string | null = null;
  private agentDescriptors: AgentDescriptor[];

  constructor(
    private store: TodoStore,
    private metrics: MetricsStore,
    private registry: AgentRegistry,
    private estimator: EffortEstimator | undefined
  ) {
    this.agentDescriptors = registry.describe();

    // Re-render on any external store change (file edits, sync writes, etc.)
    // and gracefully fall back to Create mode if the loaded todo was deleted.
    store.onDidChange(() => {
      if (!this.view) return;
      if (this.currentTodoId && !this.store.get(this.currentTodoId)) {
        this.currentTodoId = null;
      }
      this.refresh();
    });
  }

  /**
   * Switch what the form is bound to. `null` opens an empty Create form.
   * Safe to call before the view has been resolved — the value is cached
   * and applied on the next `resolveWebviewView`.
   */
  setTodo(id: string | null): void {
    this.currentTodoId = id;
    this.refresh();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.onDidDispose(() => { this.view = undefined; });
    view.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
    this.refresh();
  }

  private refresh(): void {
    if (!this.view) return;
    this.view.webview.html = this.renderHtml();
  }

  private currentTodo(): Todo {
    if (this.currentTodoId) {
      const t = this.store.get(this.currentTodoId);
      if (t) return t;
      this.currentTodoId = null;
    }
    return blankTodo();
  }

  private renderHtml(): string {
    const defaultAgentType =
      vscode.workspace.getConfiguration('djinn').get<AgentType>('defaultAgent', 'copilot')
      ?? this.agentDescriptors[0]?.type;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const subAgents = discoverSubAgents({ workspaceRoot });
    return renderTodoEditorHtml({
      todo: this.currentTodo(),
      agents: this.agentDescriptors,
      defaultAgentType,
      subAgents,
      mode: this.currentTodoId ? 'edit' : 'create',
      todos: this.store.list(),
      currentTodoId: this.currentTodoId ?? ''
    });
  }

  private async handleMessage(msg: { type?: string } & Record<string, unknown>): Promise<void> {
    if (msg.type === 'save') {
      await this.handleSave(msg);
    } else if (msg.type === 'run') {
      await this.handleRun(msg);
    } else if (msg.type === 'requestEstimate') {
      await this.handleEstimate(msg);
    } else if (msg.type === 'selectTodo') {
      const id = typeof msg.id === 'string' ? msg.id : null;
      this.setTodo(id);
    } else if (msg.type === 'deleteTodo') {
      const id = typeof msg.id === 'string' ? msg.id : '';
      if (!id) return;
      const target = this.store.get(id);
      if (!target) return;
      const choice = await vscode.window.showWarningMessage(
        `Delete "${target.title}"?`,
        { modal: true },
        'Delete'
      );
      if (choice !== 'Delete') return;
      await this.store.remove(id);
      if (this.currentTodoId === id) this.currentTodoId = null;
      this.refresh();
    } else if (msg.type === 'runTodo') {
      const id = typeof msg.id === 'string' ? msg.id : '';
      if (!id) return;
      const target = this.store.get(id);
      if (!target) return;
      const resolvedType = target.agentOptions?.selected ?? this.agentDescriptors[0]?.type;
      const adapter = this.registry.get(resolvedType as AgentType);
      if (!adapter) {
        vscode.window.showWarningMessage('Selected agent is not available.');
        return;
      }
      const opts = target.agentOptions?.byAgent?.[resolvedType as AgentType];
      await adapter.run(target, opts);
    }
  }

  private async handleSave(msg: Record<string, unknown>): Promise<void> {
    const title = String(msg.title ?? '').trim();
    const description = msg.description ? String(msg.description).trim() : undefined;
    const total = numOrUndef(msg.total);
    const agentOptions = this.parseAgentOptions(msg.agent, msg.agentOptions);

    if (!this.currentTodoId) {
      // ── Create flow ────────────────────────────────────────────────
      if (!title) {
        vscode.window.showWarningMessage('Give the todo a title before creating it.');
        return;
      }
      const created = await this.store.add(title);
      // Persist the rest of the picked fields immediately, then load the
      // new todo into the form so subsequent saves go through the edit path.
      await this.store.update(created.id, {
        description,
        effort: total != null ? { ...created.effort, total } : created.effort,
        agentOptions
      });
      this.currentTodoId = created.id;
      this.refresh();
      // Background AI estimate so the form picks up auto-effort if the
      // user didn't enter a value (matches the legacy djinn.add command).
      if (total == null && this.estimator) {
        void (async () => {
          try {
            const hours = await this.estimator!.estimate(created);
            await recordEstimatedEffort(this.store, this.metrics, created.id, hours);
          } catch {
            // estimation is best-effort
          }
        })();
      }
      vscode.window.showInformationMessage(`Created "${title}".`);
    } else {
      // ── Edit flow ──────────────────────────────────────────────────
      const existing = this.store.get(this.currentTodoId);
      if (!existing) return;
      await this.store.update(this.currentTodoId, {
        title: title || existing.title,
        description,
        effort: total != null ? { ...existing.effort, total } : existing.effort,
        agentOptions
      });
      vscode.window.showInformationMessage('Todo saved.');
    }
  }

  private async handleRun(msg: Record<string, unknown>): Promise<void> {
    if (!this.currentTodoId) {
      vscode.window.showWarningMessage('Save the todo first, then Run.');
      return;
    }
    const todo = this.store.get(this.currentTodoId);
    if (!todo) return;
    const agentType = typeof msg.agent === 'string' ? msg.agent as AgentType : undefined;
    const agentOptions = this.parseAgentOptions(msg.agent, msg.agentOptions);
    const resolvedType = agentType ?? todo.agentOptions?.selected ?? this.agentDescriptors[0]?.type;
    const adapter = this.registry.get(resolvedType as AgentType);
    if (!adapter) {
      vscode.window.showWarningMessage('Selected agent is not available.');
      return;
    }
    const opts = agentOptions?.byAgent?.[resolvedType as AgentType];
    await adapter.run(todo, opts);
  }

  private async handleEstimate(msg: Record<string, unknown>): Promise<void> {
    if (!this.estimator) return;
    const base = this.currentTodo();
    const tempTodo: Todo = {
      ...base,
      title: String(msg.title ?? base.title),
      description: msg.description ? String(msg.description) : undefined
    };
    try {
      const hours = await this.estimator.estimate(tempTodo);
      this.view?.webview.postMessage({ type: 'setEstimate', hours });
    } catch {
      // silently ignore estimation failures
    }
  }

  private parseAgentOptions(selected: unknown, raw: unknown): TodoAgentOptions | undefined {
    const sel = typeof selected === 'string' ? selected as AgentType : undefined;
    const byAgent: Record<string, Record<string, string>> = {};
    if (raw && typeof raw === 'object') {
      for (const [agent, fields] of Object.entries(raw as Record<string, unknown>)) {
        if (!fields || typeof fields !== 'object') continue;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
          if (typeof v === 'string' && v.length) out[k] = v;
        }
        if (Object.keys(out).length) byAgent[agent] = out;
      }
    }
    if (!sel && Object.keys(byAgent).length === 0) return undefined;
    return {
      selected: sel,
      byAgent: Object.keys(byAgent).length ? byAgent as TodoAgentOptions['byAgent'] : undefined
    };
  }
}

function blankTodo(): Todo {
  const now = new Date().toISOString();
  return {
    id: '',
    title: '',
    status: 'draft',
    createdAt: now,
    updatedAt: now
  };
}

function numOrUndef(v: unknown): number | undefined {
  if (v === '' || v == null) return undefined;
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}
