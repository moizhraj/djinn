import * as vscode from 'vscode';
import { TodoStore } from '../store/todoStore';
import { Todo } from '../types';

export class TodoEditorPanel {
  private static panels = new Map<string, TodoEditorPanel>();

  static show(store: TodoStore, todoId: string): void {
    const existing = TodoEditorPanel.panels.get(todoId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const todo = store.get(todoId);
    if (!todo) return;
    new TodoEditorPanel(store, todo);
  }

  private panel: vscode.WebviewPanel;

  private constructor(private store: TodoStore, private todo: Todo) {
    this.panel = vscode.window.createWebviewPanel(
      'adoTodos.editor',
      `Todo: ${todo.title.slice(0, 40)}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    TodoEditorPanel.panels.set(todo.id, this);

    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => TodoEditorPanel.panels.delete(todo.id));

    const sub = store.onDidChange(() => {
      const updated = store.get(this.todo.id);
      if (updated) {
        this.todo = updated;
        this.panel.webview.html = this.render();
      }
    });
    this.panel.onDidDispose(() => sub.dispose());

    this.panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'save') {
        const total = numOrUndef(msg.total);
        const remaining = numOrUndef(msg.remaining);
        const completed = numOrUndef(msg.completed);
        await this.store.update(this.todo.id, {
          title: String(msg.title ?? this.todo.title),
          description: msg.description ? String(msg.description) : undefined,
          effort: (total != null || remaining != null || completed != null)
            ? { total, remaining, completed }
            : undefined
        });
        vscode.window.showInformationMessage('Todo saved.');
      }
    });
  }

  private render(): string {
    const t = this.todo;
    const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
  label { display:block; margin-top:12px; font-weight:600; }
  input, textarea { width: 100%; box-sizing: border-box; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  textarea { min-height: 140px; font-family: var(--vscode-editor-font-family); }
  .row { display:flex; gap:12px; }
  .row > div { flex: 1; }
  button { margin-top:16px; padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:0; cursor: pointer; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
</style></head><body>
  <h2>Edit Todo</h2>
  <div class="meta">Status: ${esc(t.status)}${t.adoWorkItemId ? ` · ADO #${t.adoWorkItemId}` : ''}</div>

  <label>Title</label>
  <input id="title" value="${esc(t.title)}" />

  <label>Description</label>
  <textarea id="description">${esc(t.description ?? '')}</textarea>

  <label>Effort (hours)</label>
  <div class="row">
    <div><div class="meta">Total</div><input id="total" type="number" min="0" step="0.5" value="${t.effort?.total ?? ''}" /></div>
    <div><div class="meta">Remaining</div><input id="remaining" type="number" min="0" step="0.5" value="${t.effort?.remaining ?? ''}" /></div>
    <div><div class="meta">Completed</div><input id="completed" type="number" min="0" step="0.5" value="${t.effort?.completed ?? ''}" /></div>
  </div>

  <button id="save">Save</button>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('save').addEventListener('click', () => {
      vscode.postMessage({
        type: 'save',
        title: document.getElementById('title').value,
        description: document.getElementById('description').value,
        total: document.getElementById('total').value,
        remaining: document.getElementById('remaining').value,
        completed: document.getElementById('completed').value
      });
    });
  </script>
</body></html>`;
  }
}

function numOrUndef(v: unknown): number | undefined {
  if (v === '' || v == null) return undefined;
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}
