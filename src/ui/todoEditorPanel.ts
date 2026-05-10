import * as vscode from 'vscode';
import { TodoStore } from '../store/todoStore';
import { AgentDescriptor, AgentRegistry } from '../agents/agentRegistry';
import { EffortEstimator } from '../agents/effortEstimator';
import { AgentOptionField, AgentType, Todo, TodoAgentOptions, TodoStatus } from '../types';

export class TodoEditorPanel {
  private static panels = new Map<string, TodoEditorPanel>();

  static show(store: TodoStore, registry: AgentRegistry, todoId: string, estimator?: EffortEstimator): void {
    const existing = TodoEditorPanel.panels.get(todoId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const todo = store.get(todoId);
    if (!todo) return;
    new TodoEditorPanel(store, registry, todo, estimator);
  }

  private panel: vscode.WebviewPanel;
  private agents: AgentDescriptor[];

  private constructor(
    private store: TodoStore,
    private registry: AgentRegistry,
    private todo: Todo,
    private estimator?: EffortEstimator
  ) {
    this.agents = registry.describe();
    this.panel = vscode.window.createWebviewPanel(
      'djinn.editor',
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
        const agentOptions = this.parseAgentOptions(msg.agent, msg.agentOptions);
        await this.store.update(this.todo.id, {
          title: String(msg.title ?? this.todo.title),
          description: msg.description ? String(msg.description) : undefined,
          effort: total != null
            ? { ...this.todo.effort, total }
            : this.todo.effort,
          agentOptions
        });
        vscode.window.showInformationMessage('Todo saved.');
      } else if (msg.type === 'run') {
        const agentType = msg.agent as AgentType | undefined;
        const agentOptions = this.parseAgentOptions(msg.agent, msg.agentOptions);
        const resolvedType = agentType ?? this.todo.agentOptions?.selected ?? this.agents[0]?.type;
        const adapter = this.registry.get(resolvedType as AgentType);
        if (!adapter) {
          vscode.window.showWarningMessage('Selected agent is not available.');
          return;
        }
        const opts = agentOptions?.byAgent?.[resolvedType as AgentType];
        await adapter.run(this.todo, opts);
      } else if (msg.type === 'requestEstimate') {
        const tempTodo = {
          ...this.todo,
          title: String(msg.title ?? this.todo.title),
          description: msg.description ? String(msg.description) : undefined
        };
        if (!this.estimator) return;
        try {
          const hours = await this.estimator.estimate(tempTodo);
          this.panel.webview.postMessage({ type: 'setEstimate', hours });
        } catch {
          // silently ignore estimation failures
        }
      }
    });
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

  private render(): string {
    const t = this.todo;
    const esc = (s: string) =>
      s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

    const selectedAgent: AgentType =
      (t.agentOptions?.selected as AgentType | undefined)
      ?? (vscode.workspace.getConfiguration('djinn').get<AgentType>('defaultAgent', 'claude-code'))
      ?? this.agents[0]?.type;

    const statusInfo = STATUS_CONFIG[t.status] ?? STATUS_CONFIG['draft'];
    const isDone = t.status === 'done';
    const progressSvg = renderProgressSvg(t.status);

    const remoteRef = t.remoteId
      ? t.remoteUrl
        ? `<a href="${esc(t.remoteUrl)}" class="remote-ref">${esc(t.remoteProvider ?? 'remote')} #${esc(t.remoteId)}</a>`
        : `<span class="remote-ref">${esc(t.remoteProvider ?? 'remote')} #${esc(t.remoteId)}</span>`
      : '';

    const effortHours = t.effort?.total;
    const reasoningHint = effortHours != null ? renderReasoningHint(effortHours) : '';

    const agentSelect = `<select id="agent">
      ${this.agents.map(a =>
        `<option value="${esc(a.type)}" ${a.type === selectedAgent ? 'selected' : ''}>${esc(a.label)}</option>`
      ).join('')}
    </select>`;

    const agentGroups = this.agents.map(a => {
      const stored = t.agentOptions?.byAgent?.[a.type] ?? {};
      const fields = a.schema.map(f => this.renderFieldCompact(a.type, f, stored[f.key] ?? f.default ?? '', esc)).join('');
      const hidden = a.type === selectedAgent ? '' : 'style="display:none"';
      return `<div class="agent-group" data-agent="${esc(a.type)}" ${hidden}>${fields}</div>`;
    }).join('');

    const doneGlow = isDone
      ? 'box-shadow: 0 0 0 2px #27AE6044; border-color: #27AE6066;'
      : '';

    return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 0;
  }

  /* ── Action bar ── */
  .action-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, #3333);
    position: sticky; top: 0; z-index: 10;
  }
  .action-bar .spacer { flex: 1; }

  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px;
    border: none; border-radius: 4px;
    cursor: pointer;
    font-family: var(--vscode-font-family); font-size: 13px;
    font-weight: 500; transition: opacity 0.15s;
  }
  .btn:hover { opacity: 0.85; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-run { background: #27AE60; color: #fff; }
  .btn svg { flex-shrink: 0; }

  /* ── Status badge ── */
  .status-badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 12px; border-radius: 20px;
    font-size: 12px; font-weight: 600; white-space: nowrap;
    background: ${statusInfo.bg}; color: ${statusInfo.fg};
    ${isDone ? 'box-shadow: 0 0 8px ' + statusInfo.bg + '88;' : ''}
  }

  /* ── Main content ── */
  .content { padding: 20px 24px 40px; max-width: 860px; }

  /* ── Header ── */
  .header { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 24px; }
  .header .progress-icon { flex-shrink: 0; margin-top: 2px; }
  .header-text { flex: 1; }
  .header-text h2 {
    margin: 0 0 4px;
    font-size: 18px; font-weight: 700;
    color: var(--vscode-foreground);
    ${isDone ? 'color: #27AE60;' : ''}
  }
  .remote-ref {
    font-size: 12px; color: var(--vscode-textLink-foreground);
    text-decoration: none;
  }
  .remote-ref:hover { text-decoration: underline; }

  /* ── Field labels ── */
  .field-label {
    display: block;
    font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.6px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 5px; margin-top: 18px;
  }

  input, textarea, select {
    width: 100%;
    padding: 8px 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #3333);
    border-radius: 4px;
    font-family: var(--vscode-font-family); font-size: 13px;
    transition: border-color 0.15s;
    outline: none;
  }
  input:focus, textarea:focus, select:focus {
    border-color: var(--vscode-focusBorder, #007fd4);
  }
  input[readonly] {
    opacity: 0.6; cursor: default;
    background: var(--vscode-input-background);
  }
  textarea { min-height: 130px; font-family: var(--vscode-editor-font-family); resize: vertical; }

  /* ── Effort row ── */
  .effort-row { display: flex; gap: 12px; align-items: flex-end; }
  .effort-row > .ef-total { flex: 1; }
  .effort-row > .ef-agent { flex: 0 0 140px; }
  .effort-hint { display: flex; align-items: center; gap: 8px; margin-top: 6px; min-height: 20px; }
  .estimate-status { font-size: 11px; color: var(--vscode-descriptionForeground); }

  .reasoning-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 9px; border-radius: 10px;
    font-size: 11px; font-weight: 600;
  }

  /* ── Agent section ── */
  .agent-section { margin-top: 18px; }
  .agent-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .agent-row .agent-select-wrap { flex: 0 0 170px; }
  .agent-group { display: contents; }
  .agent-field { flex: 1; min-width: 110px; }
  .agent-field-label {
    display: block; font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground); margin-bottom: 5px;
  }
  .no-options {
    font-size: 12px; color: var(--vscode-descriptionForeground);
    padding: 8px 0; align-self: center;
  }

  /* ── Done celebration ── */
  ${isDone ? `
  .content { border-top: 3px solid #27AE60; }
  ` : ''}
</style></head><body>

<div class="action-bar">
  <button class="btn btn-primary" id="save">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.5 1h-11C1.7 1 1 1.7 1 2.5v11c0 .8.7 1.5 1.5 1.5h11c.8 0 1.5-.7 1.5-1.5v-11C15 1.7 14.3 1 13.5 1zM8 13c-1.7 0-3-1.3-3-3s1.3-3 3-3 3 1.3 3 3-1.3 3-3 3zm3-8H4V3h7v2z"/>
    </svg>
    Save
  </button>
  <button class="btn btn-run" id="run">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3 2l10 6-10 6V2z"/>
    </svg>
    Run Agent
  </button>
  <div class="spacer"></div>
  <span class="status-badge">
    ${statusInfo.dot} ${esc(statusInfo.label)}
  </span>
</div>

<div class="content">
  <div class="header">
    <div class="progress-icon">${progressSvg}</div>
    <div class="header-text">
      <h2>Edit Todo</h2>
      ${remoteRef ? `<div>${remoteRef}</div>` : ''}
    </div>
  </div>

  <label class="field-label" for="title">Title</label>
  <input id="title" value="${esc(t.title)}" style="${doneGlow}" />

  <label class="field-label" for="description">Description</label>
  <textarea id="description">${esc(t.description ?? '')}</textarea>

  <label class="field-label">Effort (hours)</label>
  <div class="effort-row">
    <div class="ef-total">
      <div class="agent-field-label">Total (human + agent)</div>
      <input id="total" type="number" min="0" step="0.5" value="${t.effort?.total ?? ''}" />
    </div>
    <div class="ef-agent">
      <div class="agent-field-label">AI run time</div>
      <input readonly value="${t.agentDurationMs != null ? formatDuration(t.agentDurationMs) : '—'}" />
    </div>
  </div>
  <div class="effort-hint">
    <span id="estimate-status" class="estimate-status"></span>
    <span id="reasoning-badge">${reasoningHint}</span>
  </div>

  <div class="agent-section">
    <label class="field-label">Agent</label>
    <div class="agent-row">
      <div class="agent-select-wrap">
        <div class="agent-field-label">Run with</div>
        ${agentSelect}
      </div>
      ${agentGroups}
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const agentSel = document.getElementById('agent');
  const groups = Array.from(document.querySelectorAll('.agent-group'));

  function showSelectedGroup() {
    const v = agentSel.value;
    groups.forEach(g => {
      const show = g.dataset.agent === v;
      Array.from(g.children).forEach(el => el.style.display = show ? '' : 'none');
    });
  }
  agentSel.addEventListener('change', showSelectedGroup);
  showSelectedGroup();

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

  function buildPayload(type) {
    return {
      type,
      title: document.getElementById('title').value,
      description: document.getElementById('description').value,
      total: document.getElementById('total').value,
      agent: agentSel.value,
      agentOptions: collectAgentOptions()
    };
  }

  function requestEstimate() {
    document.getElementById('estimate-status').textContent = 'Estimating effort…';
    document.getElementById('reasoning-badge').innerHTML = '';
    vscode.postMessage({
      type: 'requestEstimate',
      title: document.getElementById('title').value,
      description: document.getElementById('description').value
    });
  }

  function reasoningBadgeHtml(hours) {
    if (hours == null || isNaN(hours)) return '';
    if (hours < 1) return '<span class="reasoning-badge" style="background:#1a6b3c22;color:#27AE60">&#9889; Low reasoning</span>';
    if (hours <= 4) return '<span class="reasoning-badge" style="background:#1a3a6b22;color:#4A90E2">&#9670; Medium reasoning</span>';
    return '<span class="reasoning-badge" style="background:#6b1a1a22;color:#E74C3C">&#128293; High reasoning</span>';
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'setEstimate') {
      document.getElementById('total').value = msg.hours;
      document.getElementById('estimate-status').textContent = 'Auto-estimated by AI (✓ editable)';
      document.getElementById('reasoning-badge').innerHTML = reasoningBadgeHtml(Number(msg.hours));
    }
  });

  document.getElementById('title').addEventListener('blur', requestEstimate);
  document.getElementById('description').addEventListener('blur', requestEstimate);

  document.getElementById('save').addEventListener('click', () => {
    vscode.postMessage(buildPayload('save'));
  });

  document.getElementById('run').addEventListener('click', () => {
    vscode.postMessage(buildPayload('run'));
  });

  // Init reasoning badge from existing value
  const existingHours = parseFloat(document.getElementById('total').value);
  if (!isNaN(existingHours)) {
    document.getElementById('reasoning-badge').innerHTML = reasoningBadgeHtml(existingHours);
  }
</script>
</body></html>`;
  }

  private renderFieldCompact(
    agent: AgentType,
    field: AgentOptionField,
    value: string,
    esc: (s: string) => string
  ): string {
    const id = `opt-${agent}-${field.key}`;
    const label = `<div class="agent-field-label">${esc(field.label)}</div>`;
    if (field.type === 'select' && field.choices) {
      const options = field.choices.map(c =>
        `<option value="${esc(c.value)}" ${c.value === value ? 'selected' : ''}>${esc(c.label ?? c.value)}</option>`
      ).join('');
      return `<div class="agent-field">
        ${label}
        <select id="${esc(id)}" data-opt-key="${esc(field.key)}">${options}</select>
      </div>`;
    }
    return `<div class="agent-field">
      ${label}
      <input id="${esc(id)}" data-opt-key="${esc(field.key)}" value="${esc(value)}" />
    </div>`;
  }
}

type StatusInfo = { bg: string; fg: string; dot: string; label: string };

const STATUS_CONFIG: Record<TodoStatus, StatusInfo> = {
  'draft':       { bg: '#55555533', fg: 'var(--vscode-descriptionForeground)', dot: '○', label: 'Draft' },
  'synced':      { bg: '#1a5faa33', fg: '#4A90E2', dot: '⟳', label: 'Synced' },
  'in-progress': { bg: '#b8620033', fg: '#E67E22', dot: '◐', label: 'In Progress' },
  'done':        { bg: '#1a6b3c33', fg: '#27AE60', dot: '✓', label: 'Done' },
  'failed':      { bg: '#8b1a1a33', fg: '#E74C3C', dot: '✗', label: 'Failed' },
};

function renderProgressSvg(status: TodoStatus): string {
  const size = 48;
  const cx = 24, cy = 24, r = 20, stroke = 3;

  const configs: Record<TodoStatus, string> = {
    draft: `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#888" stroke-width="${stroke}" stroke-dasharray="4 3" opacity="0.6"/>
      <circle cx="${cx}" cy="${cy}" r="6" fill="#888" opacity="0.4"/>`,
    synced: `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#1a5faa22" stroke="#4A90E2" stroke-width="${stroke}"/>
      <path d="M16 24a8 8 0 0 1 8-8" fill="none" stroke="#4A90E2" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M32 24a8 8 0 0 1-8 8" fill="none" stroke="#4A90E2" stroke-width="2.5" stroke-linecap="round"/>
      <polyline points="14,21 16,24 19,22" fill="none" stroke="#4A90E2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="34,27 32,24 29,26" fill="none" stroke="#4A90E2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    'in-progress': `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#b8620011" stroke="#E67E22" stroke-width="${stroke}" stroke-dasharray="62.8 0" opacity="0.3"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#E67E22" stroke-width="${stroke}"
        stroke-dasharray="${Math.round(0.65 * 2 * Math.PI * r)} ${Math.round(2 * Math.PI * r)}"
        stroke-dashoffset="${Math.round(0.25 * 2 * Math.PI * r)}" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="5" fill="#E67E22" opacity="0.8"/>`,
    done: `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#1a6b3c33" stroke="#27AE60" stroke-width="${stroke}"/>
      <polyline points="15,24 21,30 33,18" fill="none" stroke="#27AE60" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
    failed: `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#8b1a1a22" stroke="#E74C3C" stroke-width="${stroke}"/>
      <line x1="17" y1="17" x2="31" y2="31" stroke="#E74C3C" stroke-width="3" stroke-linecap="round"/>
      <line x1="31" y1="17" x2="17" y2="31" stroke="#E74C3C" stroke-width="3" stroke-linecap="round"/>`,
  };

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    ${configs[status] ?? configs['draft']}
  </svg>`;
}

function renderReasoningHint(hours: number): string {
  if (hours < 1) {
    return '<span class="reasoning-badge" style="background:#1a6b3c22;color:#27AE60">&#9889; Low reasoning</span>';
  }
  if (hours <= 4) {
    return '<span class="reasoning-badge" style="background:#1a3a6b22;color:#4A90E2">&#9670; Medium reasoning</span>';
  }
  return '<span class="reasoning-badge" style="background:#6b1a1a22;color:#E74C3C">&#128293; High reasoning</span>';
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
