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

    const agentTabs = this.agents.map(a => `
      <button type="button" class="agent-tab ${a.type === selectedAgent ? 'active' : ''}"
              data-agent="${esc(a.type)}">${esc(a.label)}</button>
    `).join('');

    const agentGroups = this.agents.map(a => {
      const stored = t.agentOptions?.byAgent?.[a.type] ?? {};
      const fieldsHtml = a.schema.length
        ? a.schema.map(f => this.renderFieldCompact(a.type, f, stored[f.key] ?? f.default ?? '', esc)).join('')
        : `<div class="agent-empty">No options to configure for this agent.</div>`;
      const hidden = a.type === selectedAgent ? '' : 'style="display:none"';
      return `<div class="agent-group" data-agent="${esc(a.type)}" ${hidden}>${fieldsHtml}</div>`;
    }).join('');

    const heroTone = isDone ? 'hero-done' : '';

    return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  *, *::before, *::after { box-sizing: border-box; }

  :root {
    --card-bg: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    --card-border: var(--vscode-editorWidget-border, var(--vscode-panel-border, rgba(127,127,127,0.18)));
    --hover-tint: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
    --soft-tint: color-mix(in srgb, var(--vscode-foreground) 3%, transparent);
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.06);
    --shadow-md: 0 4px 14px rgba(0,0,0,0.10), 0 2px 4px rgba(0,0,0,0.05);
    --radius-card: 12px;
    --radius-input: 7px;
    --radius-pill: 999px;
    --accent: var(--vscode-focusBorder, #007fd4);
  }

  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 0;
    -webkit-font-smoothing: antialiased;
  }

  /* ── Sticky toolbar ───────────────────────────────────────────────── */
  .toolbar {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 24px;
    background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--card-border);
    position: sticky; top: 0; z-index: 100;
  }
  .toolbar .spacer { flex: 1; }

  .btn {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 7px 16px;
    border: 1px solid transparent;
    border-radius: var(--radius-input);
    cursor: pointer;
    font: inherit; font-weight: 600; font-size: 13px;
    line-height: 1;
    transition: transform .12s ease, box-shadow .15s ease, background .15s, opacity .15s;
  }
  .btn:hover  { transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }
  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    box-shadow: var(--shadow-sm);
  }
  .btn-primary:hover {
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
    box-shadow: var(--shadow-md);
  }
  .btn-run {
    background: linear-gradient(135deg, #2ec55b, #1f9e48);
    color: #fff;
    box-shadow: 0 1px 2px rgba(46,197,91,0.30), 0 4px 14px rgba(46,197,91,0.18);
  }
  .btn-run:hover {
    box-shadow: 0 2px 4px rgba(46,197,91,0.40), 0 8px 20px rgba(46,197,91,0.28);
  }
  .btn svg { flex-shrink: 0; }

  .status-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 13px; border-radius: var(--radius-pill);
    font-size: 11.5px; font-weight: 700; letter-spacing: 0.3px;
    background: ${statusInfo.bg}; color: ${statusInfo.fg};
    ${isDone ? `box-shadow: 0 0 0 2px ${statusInfo.fg}33, 0 0 14px ${statusInfo.fg}55;` : ''}
  }

  /* ── Layout ───────────────────────────────────────────────────────── */
  .container {
    max-width: 880px;
    margin: 0 auto;
    padding: 28px 24px 60px;
    display: flex; flex-direction: column; gap: 18px;
  }

  /* ── Hero card ────────────────────────────────────────────────────── */
  .hero-card {
    display: flex; align-items: flex-start; gap: 18px;
    padding: 22px 24px;
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-sm);
  }
  .hero-card.hero-done {
    border-color: rgba(46,197,91,0.45);
    background: linear-gradient(135deg, var(--card-bg) 70%, rgba(46,197,91,0.06));
  }
  .hero-icon { flex-shrink: 0; }
  .hero-text { flex: 1; min-width: 0; }
  .hero-meta {
    display: flex; align-items: center; gap: 8px;
    font-size: 10.5px; color: var(--vscode-descriptionForeground);
    text-transform: uppercase; letter-spacing: 0.7px; font-weight: 700;
    margin-bottom: 6px;
  }
  .hero-meta .sep { opacity: 0.5; }

  .hero-title-input {
    width: calc(100% + 20px);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-input);
    padding: 6px 10px;
    margin: 0 -10px;
    font-family: var(--vscode-font-family);
    font-size: 22px; font-weight: 700;
    color: var(--vscode-foreground);
    line-height: 1.3;
    transition: background .15s, border-color .15s, box-shadow .15s;
  }
  .hero-title-input::placeholder { color: var(--vscode-input-placeholderForeground, color-mix(in srgb, var(--vscode-foreground) 40%, transparent)); }
  .hero-title-input:hover { background: var(--soft-tint); }
  .hero-title-input:focus {
    background: var(--vscode-input-background);
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
    outline: none;
  }

  .remote-ref {
    display: inline-flex; align-items: center; gap: 5px;
    margin-top: 10px;
    padding: 3px 10px;
    border-radius: var(--radius-pill);
    background: var(--soft-tint);
    font-size: 11.5px;
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
  }
  .remote-ref:hover { text-decoration: underline; }

  /* ── Section card ─────────────────────────────────────────────────── */
  .card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--radius-card);
    padding: 18px 22px;
    box-shadow: var(--shadow-sm);
  }
  .card-header {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 14px;
    font-size: 11.5px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.7px;
    color: var(--vscode-descriptionForeground);
  }
  .card-header .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 60%, transparent);
  }

  /* ── Form controls ───────────────────────────────────────────────── */
  input, textarea, select {
    width: 100%;
    padding: 9px 12px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: var(--radius-input);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    line-height: 1.4;
    transition: border-color .15s, box-shadow .15s;
    outline: none;
  }
  input:hover, textarea:hover, select:hover {
    border-color: color-mix(in srgb, var(--accent) 35%, var(--vscode-input-border, transparent));
  }
  input:focus, textarea:focus, select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  input[readonly] { opacity: 0.6; cursor: default; }
  textarea {
    min-height: 140px;
    font-family: var(--vscode-editor-font-family);
    line-height: 1.55;
    resize: vertical;
  }

  .field-label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
    letter-spacing: 0.2px;
  }

  /* ── Effort grid ──────────────────────────────────────────────────── */
  .field-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  @media (max-width: 640px) {
    .field-grid { grid-template-columns: 1fr; }
  }
  .effort-hint {
    display: flex; align-items: center; gap: 10px;
    margin-top: 12px; min-height: 22px;
  }
  .estimate-status {
    font-size: 11.5px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  .reasoning-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 11px; border-radius: var(--radius-pill);
    font-size: 11px; font-weight: 600;
  }

  /* ── Agent picker (segmented control) ─────────────────────────────── */
  .agent-tabs {
    display: inline-flex; flex-wrap: wrap;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--card-border));
    border-radius: var(--radius-input);
    padding: 3px;
    gap: 2px;
  }
  .agent-tab {
    padding: 7px 14px;
    font: inherit;
    font-size: 12.5px; font-weight: 500;
    color: var(--vscode-foreground);
    background: transparent;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    transition: background .15s, color .15s, transform .12s;
  }
  .agent-tab:hover { background: var(--hover-tint); }
  .agent-tab:active { transform: scale(0.98); }
  .agent-tab.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    box-shadow: var(--shadow-sm);
  }
  .agent-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .agent-options {
    margin-top: 16px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 14px;
  }
  .agent-group { display: contents; }
  .agent-field-label {
    display: block; font-size: 10.5px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground); margin-bottom: 6px;
  }
  .agent-empty {
    grid-column: 1 / -1;
    padding: 14px 16px;
    border-radius: var(--radius-input);
    background: var(--soft-tint);
    color: var(--vscode-descriptionForeground);
    font-size: 12.5px;
    font-style: italic;
    text-align: center;
  }
</style></head><body>

<div class="toolbar">
  <button class="btn btn-primary" id="save" title="Save changes (Ctrl/Cmd+S)">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M13.5 1h-11C1.7 1 1 1.7 1 2.5v11c0 .8.7 1.5 1.5 1.5h11c.8 0 1.5-.7 1.5-1.5v-11C15 1.7 14.3 1 13.5 1zM8 13c-1.7 0-3-1.3-3-3s1.3-3 3-3 3 1.3 3 3-1.3 3-3 3zm3-8H4V3h7v2z"/>
    </svg>
    Save
  </button>
  <button class="btn btn-run" id="run" title="Run the selected agent on this todo">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3 2l10 6-10 6V2z"/>
    </svg>
    Run Agent
  </button>
  <div class="spacer"></div>
  <span class="status-pill" aria-label="Status: ${esc(statusInfo.label)}">
    ${statusInfo.dot} ${esc(statusInfo.label)}
  </span>
</div>

<div class="container">
  <!-- Hero -->
  <div class="hero-card ${heroTone}">
    <div class="hero-icon">${progressSvg}</div>
    <div class="hero-text">
      <div class="hero-meta">
        <span>Todo</span>
        ${remoteRef ? `<span class="sep">•</span>${remoteRef}` : ''}
      </div>
      <input id="title" class="hero-title-input" value="${esc(t.title)}" placeholder="Untitled todo" />
    </div>
  </div>

  <!-- Description -->
  <div class="card">
    <div class="card-header"><span class="dot"></span> Description</div>
    <textarea id="description" placeholder="Describe what needs to be done…">${esc(t.description ?? '')}</textarea>
  </div>

  <!-- Effort -->
  <div class="card">
    <div class="card-header"><span class="dot"></span> Effort</div>
    <div class="field-grid">
      <div>
        <label class="field-label" for="total">Total hours (human + agent)</label>
        <input id="total" type="number" min="0" step="0.5" value="${t.effort?.total ?? ''}" placeholder="—" />
      </div>
      <div>
        <label class="field-label">AI run time</label>
        <input readonly value="${t.agentDurationMs != null ? formatDuration(t.agentDurationMs) : '—'}" />
      </div>
    </div>
    <div class="effort-hint">
      <span id="estimate-status" class="estimate-status"></span>
      <span id="reasoning-badge">${reasoningHint}</span>
    </div>
  </div>

  <!-- Agent -->
  <div class="card">
    <div class="card-header"><span class="dot"></span> Agent</div>
    <div class="agent-tabs" role="tablist" aria-label="Choose an agent">${agentTabs}</div>
    <input type="hidden" id="agent" value="${esc(selectedAgent)}" />
    <div class="agent-options">
      ${agentGroups}
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const agentInput = document.getElementById('agent');
  const tabs = Array.from(document.querySelectorAll('.agent-tab'));
  const groups = Array.from(document.querySelectorAll('.agent-group'));

  function selectAgent(type) {
    agentInput.value = type;
    tabs.forEach(t => t.classList.toggle('active', t.dataset.agent === type));
    groups.forEach(g => {
      const show = g.dataset.agent === type;
      // .agent-group uses CSS 'display: contents' so its children participate
      // in the parent grid. Setting style.display to '' clears the inline
      // override and lets the class rule take effect; 'none' hides the entire
      // subtree.
      g.style.display = show ? '' : 'none';
    });
  }
  tabs.forEach(t => t.addEventListener('click', () => selectAgent(t.dataset.agent)));
  selectAgent(agentInput.value);

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
      agent: agentInput.value,
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

  // Ctrl/Cmd+S to save without leaving the form
  document.addEventListener('keydown', (e) => {
    const isSave = (e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S');
    if (isSave) {
      e.preventDefault();
      vscode.postMessage(buildPayload('save'));
    }
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
