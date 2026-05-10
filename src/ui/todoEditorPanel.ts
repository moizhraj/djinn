import * as vscode from 'vscode';
import { TodoStore } from '../store/todoStore';
import { AgentDescriptor, AgentRegistry } from '../agents/agentRegistry';
import { AgentOptionField, AgentType, Todo, TodoAgentOptions } from '../types';

export class TodoEditorPanel {
  private static panels = new Map<string, TodoEditorPanel>();

  static show(store: TodoStore, registry: AgentRegistry, todoId: string): void {
    const existing = TodoEditorPanel.panels.get(todoId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const todo = store.get(todoId);
    if (!todo) return;
    new TodoEditorPanel(store, registry, todo);
  }

  private panel: vscode.WebviewPanel;
  private agents: AgentDescriptor[];

  private constructor(private store: TodoStore, registry: AgentRegistry, private todo: Todo) {
    this.agents = registry.describe();
    this.panel = vscode.window.createWebviewPanel(
      'anvil.editor',
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
        const agentOptions = this.parseAgentOptions(msg.agent, msg.agentOptions);
        await this.store.update(this.todo.id, {
          title: String(msg.title ?? this.todo.title),
          description: msg.description ? String(msg.description) : undefined,
          effort: (total != null || remaining != null || completed != null)
            ? { total, remaining, completed }
            : undefined,
          agentOptions
        });
        vscode.window.showInformationMessage('Todo saved.');
      }
    });
  }

  private parseAgentOptions(
    selected: unknown,
    raw: unknown
  ): TodoAgentOptions | undefined {
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

  private render(): string {
    const t = this.todo;
    const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const selectedAgent: AgentType =
      (t.agentOptions?.selected as AgentType | undefined)
      ?? (vscode.workspace.getConfiguration('anvil').get<AgentType>('defaultAgent', 'claude-code'))
      ?? this.agents[0]?.type;

    const agentSelect = `
      <select id="agent">
        ${this.agents.map(a =>
          `<option value="${esc(a.type)}" ${a.type === selectedAgent ? 'selected' : ''}>${esc(a.label)}</option>`
        ).join('')}
      </select>`;

    const agentGroups = this.agents.map(a => {
      const stored = t.agentOptions?.byAgent?.[a.type] ?? {};
      const fields = a.schema.length
        ? a.schema.map(f => this.renderField(a.type, f, stored[f.key] ?? f.default ?? '', esc)).join('')
        : '<div class="meta">No options for this agent.</div>';
      const hidden = a.type === selectedAgent ? '' : 'style="display:none"';
      return `<div class="agent-group" data-agent="${esc(a.type)}" ${hidden}>${fields}</div>`;
    }).join('');

    return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
  label { display:block; margin-top:12px; font-weight:600; }
  input, textarea, select { width: 100%; box-sizing: border-box; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  textarea { min-height: 140px; font-family: var(--vscode-editor-font-family); }
  .row { display:flex; gap:12px; }
  .row > div { flex: 1; }
  button { margin-top:16px; padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:0; cursor: pointer; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
  fieldset { margin-top: 16px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 10px 14px; }
  legend { padding: 0 6px; font-weight: 600; }
</style></head><body>
  <h2>Edit Todo</h2>
  <div class="meta">Status: ${esc(t.status)}${t.remoteId ? ` · ${esc(t.remoteProvider ?? 'remote')} #${esc(t.remoteId)}` : ''}</div>

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
  <div class="row" style="margin-top:8px">
    <div><div class="meta">Agent time</div><input readonly value="${t.agentDurationMs != null ? formatDuration(t.agentDurationMs) : '—'}" style="background:var(--vscode-input-background);opacity:0.7;cursor:default" /></div>
  </div>

  <fieldset>
    <legend>Agent</legend>
    <label>Run with</label>
    ${agentSelect}
    ${agentGroups}
  </fieldset>

  <button id="save">Save</button>

  <script>
    const vscode = acquireVsCodeApi();
    const agentSel = document.getElementById('agent');
    const groups = Array.from(document.querySelectorAll('.agent-group'));

    function showSelectedGroup() {
      const v = agentSel.value;
      groups.forEach(g => g.style.display = g.dataset.agent === v ? '' : 'none');
    }
    agentSel.addEventListener('change', showSelectedGroup);

    function collectAgentOptions() {
      const out = {};
      groups.forEach(g => {
        const agent = g.dataset.agent;
        const fields = {};
        g.querySelectorAll('[data-opt-key]').forEach(el => {
          fields[el.dataset.optKey] = el.value;
        });
        out[agent] = fields;
      });
      return out;
    }

    document.getElementById('save').addEventListener('click', () => {
      vscode.postMessage({
        type: 'save',
        title: document.getElementById('title').value,
        description: document.getElementById('description').value,
        total: document.getElementById('total').value,
        remaining: document.getElementById('remaining').value,
        completed: document.getElementById('completed').value,
        agent: agentSel.value,
        agentOptions: collectAgentOptions()
      });
    });
  </script>
</body></html>`;
  }

  private renderField(
    agent: AgentType,
    field: AgentOptionField,
    value: string,
    esc: (s: string) => string
  ): string {
    const id = `opt-${agent}-${field.key}`;
    const desc = field.description ? `<div class="meta">${esc(field.description)}</div>` : '';
    if (field.type === 'select' && field.choices) {
      const options = field.choices.map(c =>
        `<option value="${esc(c.value)}" ${c.value === value ? 'selected' : ''}>${esc(c.label ?? c.value)}</option>`
      ).join('');
      return `
        <label for="${esc(id)}">${esc(field.label)}</label>
        <select id="${esc(id)}" data-opt-key="${esc(field.key)}">${options}</select>
        ${desc}`;
    }
    return `
      <label for="${esc(id)}">${esc(field.label)}</label>
      <input id="${esc(id)}" data-opt-key="${esc(field.key)}" value="${esc(value)}" />
      ${desc}`;
  }
}

function numOrUndef(v: unknown): number | undefined {
  if (v === '' || v == null) return undefined;
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
