// src/ui/todoEditorView.ts
//
// Pure HTML renderer for the todo editor webview. NO vscode imports — safe
// to call from the dev preview server (scripts/preview-server.mjs) AND from
// the real WebviewPanel wrapper in todoEditorPanel.ts.

import { AgentOptionField, AgentType, Todo, TodoStatus } from '../types';

export interface AgentDescriptor {
  type: AgentType;
  label: string;
  schema: AgentOptionField[];
}

export interface ViewSubAgent {
  provider: 'claude-code' | 'copilot';
  name: string;
  source: 'global' | 'repo' | 'extension';
  description?: string;
  extensionId?: string;
}

export interface RenderTodoEditorOptions {
  todo: Todo;
  agents: AgentDescriptor[];
  /** Fallback selection when the todo has no `agentOptions.selected`. */
  defaultAgentType?: AgentType;
  /** Discovered sub-agents (per provider) for the Agent picker chip. */
  subAgents?: ViewSubAgent[];
  /**
   * 'edit' (default) renders the form bound to an existing todo.
   * 'create' renders an empty form for a new todo: hides the Run button,
   * relabels Save → "Create", suppresses status / remote-ref pills and
   * the AI run-time footer.
   */
  mode?: 'create' | 'edit';
  /** All todos to render in the in-panel list below the form. */
  todos?: Todo[];
  /** Currently active todo id (for highlighting in the list). Empty in create mode. */
  currentTodoId?: string;
}

export function renderTodoEditorHtml(opts: RenderTodoEditorOptions): string {
  const t = opts.todo;
  const agents = opts.agents;
  const subAgents = opts.subAgents ?? [];
  const isCreate = (opts.mode ?? 'edit') === 'create';
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const selectedAgent: AgentType =
      (t.agentOptions?.selected as AgentType | undefined)
      ?? opts.defaultAgentType
      ?? agents[0]?.type;

    const statusInfo = STATUS_CONFIG[t.status] ?? STATUS_CONFIG['draft'];
    const isDone = t.status === 'done';

    const remoteRef = t.remoteId
      ? t.remoteUrl
        ? `<a href="${esc(t.remoteUrl)}" class="remote-ref">${esc(t.remoteProvider ?? 'remote')} #${esc(t.remoteId)}</a>`
        : `<span class="remote-ref">${esc(t.remoteProvider ?? 'remote')} #${esc(t.remoteId)}</span>`
      : '';

    const effortHours = t.effort?.total;
    const reasoningHint = effortHours != null ? renderReasoningHint(effortHours) : '';

    const aiRunTime = t.agentDurationMs != null ? formatDuration(t.agentDurationMs) : '';

    const agentGroups = agents.map(a => {
      const stored = t.agentOptions?.byAgent?.[a.type] ?? {};
      // Pick the right "Agent" chip for this provider:
      //   - copilot     → merged Mode + Agent chip (modes at top, agents below),
      //                   matches VS Code's Copilot Chat picker. The provider's
      //                   `mode` schema field is rendered by this chip and
      //                   skipped from the regular schema loop below.
      //   - claude-code → simple Agent chip (Claude has no Copilot-style modes).
      //   - cloud       → no Agent chip; it just hands off to a remote issue.
      let agentChip = '';
      const skipKeys = new Set<string>();
      if (a.type === 'copilot') {
        const modeField = a.schema.find(f => f.key === 'mode');
        const modeChoices = (modeField?.type === 'select' && modeField.choices)
          ? modeField.choices.map(c => ({ value: c.value, label: c.label ?? c.value }))
          : [
              { value: 'agent', label: 'Agent' },
              { value: 'ask',   label: 'Ask'   },
              { value: 'plan',  label: 'Plan'  }
            ];
        const modeValue = stored.mode ?? modeField?.default ?? modeChoices[0]?.value ?? 'agent';
        agentChip = renderModeAgentChip(
          a.type, modeChoices, modeValue, stored.subAgent ?? '', subAgents, esc
        );
        if (modeField) skipKeys.add('mode');
      } else if (a.type === 'claude-code') {
        agentChip = renderSubAgentChip(a.type, stored.subAgent ?? '', subAgents, esc);
      }

      // Approvals chip — VS Code-style picker with description per item.
      let approvalsChip = '';
      if (a.type === 'copilot' || a.type === 'claude-code') {
        const approvalsField = a.schema.find(f => f.key === 'approvals');
        const approvalsValue = stored.approvals ?? approvalsField?.default ?? 'default';
        approvalsChip = renderApprovalsChip(a.type, approvalsValue, esc);
        if (approvalsField) skipKeys.add('approvals');
      }

      const fieldsHtml = a.schema.length
        ? a.schema
            .filter(f => !skipKeys.has(f.key))
            .map(f => renderOptionChip(a.type, f, stored[f.key] ?? f.default ?? '', esc))
            .join('')
        : ((agentChip || approvalsChip) ? '' : `<span class="option-empty">No options for this agent.</span>`);
      const hidden = a.type === selectedAgent ? '' : 'style="display:none"';
      return `<div class="agent-group" data-agent="${esc(a.type)}" ${hidden}>${agentChip}${fieldsHtml}${approvalsChip}</div>`;
    }).join('');

    const agentItems = agents.map(a => ({
      value: a.type,
      label: a.label,
      icon: agentIcon(a.type)
    }));
    const currentAgentLabel =
      (agents.find(a => a.type === selectedAgent) ?? agents[0])?.label ?? selectedAgent;
    const agentItemsAttr = encodeURIComponent(JSON.stringify(agentItems));

    return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  *, *::before, *::after { box-sizing: border-box; }

  :root {
    --accent: var(--vscode-focusBorder, #4FC3F7);
    --line: color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
    --line-soft: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    --label: color-mix(in srgb, var(--vscode-foreground) 78%, transparent);
    --muted: color-mix(in srgb, var(--vscode-foreground) 55%, transparent);
    --hint: color-mix(in srgb, var(--vscode-foreground) 38%, transparent);
    --hover-tint: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
    --radius-pill: 999px;
  }

  body {
    font-family: var(--vscode-font-family);
    font-size: 14px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 16px clamp(12px, 3vw, 28px);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  /* ── Composer (the chat-style input) ─────────────────────────── */
  .composer {
    width: 100%;
    background: var(--vscode-input-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-input-border, var(--line));
    border-radius: 10px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: border-color .15s, box-shadow .15s;
  }
  .composer:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .composer-context {
    display: flex; align-items: center; flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }
  .composer-context:empty { display: none; }

  .status-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px;
    border-radius: var(--radius-pill);
    font-size: 10.5px; font-weight: 700; letter-spacing: 0.4px;
    text-transform: uppercase;
    background: ${statusInfo.bg}; color: ${statusInfo.fg};
    ${isDone ? `box-shadow: 0 0 0 2px ${statusInfo.fg}33, 0 0 12px ${statusInfo.fg}55;` : ''}
  }
  .status-pill.new-pill {
    background: color-mix(in srgb, var(--accent) 25%, transparent);
    color: var(--accent);
  }

  .remote-ref {
    display: inline-flex; align-items: center; gap: 5px;
    max-width: 240px;
    padding: 3px 10px;
    border-radius: var(--radius-pill);
    background: var(--hover-tint);
    font-size: 10.5px; font-weight: 700;
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
    letter-spacing: 0.3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remote-ref:hover { text-decoration: underline; }

  .composer-title {
    width: 100%;
    background: transparent;
    border: 0;
    padding: 0;
    font-family: inherit;
    font-size: 18px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--vscode-foreground);
    outline: none;
  }
  .composer-title::placeholder {
    color: var(--hint);
    font-weight: 600;
  }

  .composer-input {
    width: 100%;
    min-height: 110px;
    background: transparent;
    border: 0;
    padding: 0;
    font-family: var(--vscode-editor-font-family, inherit);
    font-size: 14px;
    line-height: 1.55;
    color: var(--vscode-foreground);
    outline: none;
    resize: vertical;
  }
  .composer-input::placeholder { color: var(--hint); }

  .composer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    padding-top: 8px;
    border-top: 1px solid var(--line-soft);
  }
  .composer-actions-left,
  .composer-actions-right {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .divider-vert {
    display: inline-block;
    width: 1px; height: 16px;
    background: var(--line);
    margin: 0 4px;
    flex-shrink: 0;
  }

  /* Inline pill button (used inside the composer action row) */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    border-radius: 6px;
    background: transparent;
    border: 0;
    font-family: inherit;
    font-size: 12.5px;
    color: var(--vscode-foreground);
    cursor: pointer;
    transition: background .15s;
  }
  .pill:hover { background: var(--hover-tint); }
  .pill svg { flex-shrink: 0; opacity: 0.75; }
  .pill .chevron { width: 10px; height: 10px; opacity: 0.6; }

  .pill input {
    background: transparent;
    border: 0;
    font: inherit;
    color: inherit;
    padding: 0; margin: 0;
    outline: none;
  }
  .pill .pill-num {
    width: 44px;
    text-align: right;
    -moz-appearance: textfield;
  }
  .pill .pill-num::-webkit-inner-spin-button,
  .pill .pill-num::-webkit-outer-spin-button {
    -webkit-appearance: none; margin: 0;
  }

  /* Buttons that act as menu triggers (replace native <select>) */
  .menu-trigger {
    cursor: pointer;
    user-select: none;
  }
  .menu-trigger[aria-expanded="true"] {
    background: var(--hover-tint);
  }
  .menu-trigger .menu-text {
    font-weight: 500;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
  }
  .menu-trigger .trigger-icon {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    opacity: 0.85;
  }
  .menu-trigger .trigger-icon svg { display: block; }

  /* Popup menu (positioned by JS) */
  .menu-popup {
    position: fixed;
    z-index: 1000;
    min-width: 180px;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-input-background)));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--line)));
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.18);
    padding: 4px;
    font-family: var(--vscode-font-family);
    font-size: 13px;
  }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px 10px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }
  .menu-item:hover,
  .menu-item:focus-visible {
    background: var(--vscode-menu-selectionBackground, var(--hover-tint));
    color: var(--vscode-menu-selectionForeground, inherit);
    outline: none;
  }
  .menu-item .menu-icon {
    display: inline-flex;
    align-items: center; justify-content: center;
    width: 16px; height: 16px;
    flex-shrink: 0;
    opacity: 0.85;
  }
  .menu-item .menu-icon:empty { width: 0; }
  .menu-item .menu-label { flex: 1; }
  .menu-item .menu-check {
    margin-left: 12px;
    visibility: hidden;
    opacity: 0.75;
    font-size: 11px;
  }
  .menu-item.selected .menu-check { visibility: visible; }
  .menu-separator {
    height: 1px;
    margin: 4px 6px;
    background: var(--vscode-menu-separatorBackground, var(--line-soft));
  }
  .menu-section-label {
    padding: 6px 10px 2px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: var(--muted);
  }
  /* Menu items with a description (Approvals chip): two-line layout. */
  .menu-item.with-desc {
    align-items: flex-start;
    padding: 8px 10px;
  }
  .menu-item.with-desc .menu-icon {
    margin-top: 1px;
  }
  .menu-item-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .menu-desc {
    font-size: 11px;
    color: var(--muted);
    white-space: normal;
    line-height: 1.35;
  }
  .menu-item.with-desc:hover .menu-desc,
  .menu-item.with-desc:focus-visible .menu-desc {
    color: inherit;
    opacity: 0.85;
  }

  .meta-text {
    font-size: 11.5px;
    color: var(--muted);
    display: inline-flex; align-items: center;
    white-space: nowrap;
    padding: 0 4px;
  }
  .meta-text:empty { display: none; }
  #reasoning-badge:empty { display: none; }
  .reasoning-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 9px; border-radius: var(--radius-pill);
    font-size: 11px; font-weight: 600;
  }

  /* Square icon button (Save) */
  .icon-btn {
    display: inline-flex;
    align-items: center; justify-content: center;
    width: 28px; height: 28px;
    background: transparent;
    border: 0; border-radius: 6px;
    color: var(--vscode-foreground);
    cursor: pointer;
    opacity: 0.8;
    padding: 0;
    transition: background .15s, opacity .15s;
  }
  .icon-btn:hover { background: var(--hover-tint); opacity: 1; }
  .icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  /* Primary action (Run Agent) */
  .primary-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    background: var(--vscode-button-background, var(--accent));
    color: var(--vscode-button-foreground, #fff);
    border: 0;
    border-radius: 6px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: background .15s, transform .12s;
  }
  .primary-btn:hover {
    background: var(--vscode-button-hoverBackground, var(--accent));
  }
  .primary-btn:active { transform: scale(0.97); }
  .primary-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ── Below-composer secondary chips (per-agent options) ─────── */
  .option-chips {
    display: flex; flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
    padding: 0 4px;
    min-height: 24px;
  }
  /* Let chips inside .agent-group participate in the parent flex */
  .agent-group { display: contents; }

  .option-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--line);
    border-radius: var(--radius-pill);
    font-family: inherit;
    font-size: 12px;
    color: var(--label);
    cursor: pointer;
    transition: background .15s, border-color .15s;
  }
  .option-chip:hover {
    background: var(--hover-tint);
    border-color: color-mix(in srgb, var(--vscode-foreground) 38%, transparent);
  }
  .option-chip svg { flex-shrink: 0; opacity: 0.75; }
  .option-chip .chip-label {
    font-weight: 600;
    opacity: 0.7;
  }
  .option-chip input {
    background: transparent;
    border: 0;
    font: inherit;
    color: inherit;
    padding: 0; margin: 0;
    outline: none;
    min-width: 60px;
  }
  .option-chip .chevron { width: 10px; height: 10px; opacity: 0.5; }
  .option-empty {
    font-size: 11.5px;
    color: var(--muted);
    font-style: italic;
    padding: 4px 4px;
  }

  /* Footer line */
  .meta-footer {
    margin-top: 10px;
    padding: 0 4px;
    font-size: 11.5px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }
  .meta-footer:empty { display: none; }

  /* ── Todo list (below the form, in the same panel) ───────────── */
  .todo-list-section {
    margin-top: 18px;
    border-top: 1px solid var(--line-soft);
    padding-top: 14px;
  }
  .todo-list-header {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: var(--muted);
    padding: 0 4px 6px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .todo-list-empty {
    padding: 16px 4px;
    font-size: 12.5px;
    color: var(--muted);
    font-style: italic;
    text-align: center;
  }
  .todo-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .todo-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    border-left: 2px solid transparent;
    transition: background .12s, border-color .12s;
    min-width: 0;
  }
  .todo-row:hover {
    background: var(--hover-tint);
  }
  .todo-row.active {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-left-color: var(--accent);
  }
  .todo-row .row-icon {
    flex-shrink: 0;
    width: 14px; height: 14px;
    display: inline-flex;
    align-items: center; justify-content: center;
  }
  .todo-row .row-main {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column;
    gap: 1px;
  }
  .todo-row .row-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .todo-row.done .row-title { text-decoration: line-through; opacity: 0.65; }
  .todo-row .row-meta {
    font-size: 10.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .todo-row .row-actions {
    display: flex; gap: 2px;
    opacity: 0;
    transition: opacity .12s;
  }
  .todo-row:hover .row-actions,
  .todo-row.active .row-actions {
    opacity: 1;
  }
  .row-action {
    display: inline-flex;
    align-items: center; justify-content: center;
    width: 22px; height: 22px;
    border: 0; padding: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    opacity: 0.75;
  }
  .row-action:hover { background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); opacity: 1; }
  .row-action.danger:hover { background: color-mix(in srgb, #E74C3C 30%, transparent); color: #fff; opacity: 1; }
</style></head><body>

<div class="composer">
  <div class="composer-context">
    ${isCreate ? '' : remoteRef}
    ${isCreate
      ? `<span class="status-pill new-pill" aria-label="New todo">NEW</span>`
      : `<span class="status-pill" aria-label="Status: ${esc(statusInfo.label)}">${statusInfo.dot} ${esc(statusInfo.label)}</span>`}
  </div>

  <input id="title" class="composer-title" value="${esc(t.title)}" placeholder="${isCreate ? 'New todo title…' : 'Untitled todo'}" />

  <textarea id="description" class="composer-input" placeholder="Describe what needs to be done…">${esc(t.description ?? '')}</textarea>

  <div class="composer-actions">
    <div class="composer-actions-left">
      <button id="agent" type="button" class="pill menu-trigger" title="Provider"
              value="${esc(selectedAgent)}"
              data-items="${esc(agentItemsAttr)}"
              aria-haspopup="menu" aria-expanded="false" aria-label="Select provider">
        <span class="menu-icon trigger-icon">${agentIcon(selectedAgent)}</span>
        <span class="menu-text">${esc(currentAgentLabel)}</span>
        <svg class="chevron" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
          <path d="M2 4l3 3 3-3z"/>
        </svg>
      </button>

      <span class="divider-vert"></span>

      <label class="pill" title="Total hours">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6"/>
          <polyline points="8,5 8,8 10,9.5"/>
        </svg>
        <input id="total" class="pill-num" type="number" min="0" step="0.5"
               value="${t.effort?.total ?? ''}" placeholder="auto" aria-label="Total hours" />
        <span>h</span>
      </label>

      <span id="estimate-status" class="meta-text"></span>
      <span id="reasoning-badge">${reasoningHint}</span>
    </div>

    <div class="composer-actions-right">
      ${isCreate
        ? `<button class="primary-btn" id="save" title="Create todo">
             <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
               <path d="M7 1h2v6h6v2H9v6H7V9H1V7h6z"/>
             </svg>
             Create
           </button>`
        : `<button class="icon-btn" id="save" title="Save (Ctrl/Cmd+S)" aria-label="Save changes">
             <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
               <path d="M13.5 1h-11C1.7 1 1 1.7 1 2.5v11c0 .8.7 1.5 1.5 1.5h11c.8 0 1.5-.7 1.5-1.5v-11C15 1.7 14.3 1 13.5 1zM8 13c-1.7 0-3-1.3-3-3s1.3-3 3-3 3 1.3 3 3-1.3 3-3 3zm3-8H4V3h7v2z"/>
             </svg>
           </button>
           <button class="primary-btn" id="run" title="Run the selected agent on this todo">
             <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
               <path d="M3 2l10 6-10 6V2z"/>
             </svg>
             Run
           </button>`}
    </div>
  </div>
</div>

<div class="option-chips" id="option-chips" aria-label="Agent options">
  ${agentGroups}
</div>

<div class="meta-footer">
  ${(!isCreate && aiRunTime) ? `<span>Last AI run: ${esc(aiRunTime)}</span>` : ''}
</div>

${renderTodoList(opts.todos ?? [], opts.currentTodoId ?? '', esc)}

<script>
  const vscode = acquireVsCodeApi();
  const agentTrigger = document.getElementById('agent');
  const groups = Array.from(document.querySelectorAll('.agent-group'));

  function selectAgent(type) {
    groups.forEach(g => {
      // .agent-group uses CSS 'display: contents' so children participate
      // in the parent flex. style.display='' restores that; 'none' hides
      // the whole subtree.
      g.style.display = g.dataset.agent === type ? '' : 'none';
    });
  }
  agentTrigger.addEventListener('change', () => selectAgent(agentTrigger.value));
  selectAgent(agentTrigger.value);

  // ── Custom popup menu (replaces native <select> for chat-form look) ──
  let activeMenu = null;

  function closeMenu() {
    if (!activeMenu) return;
    const { popup, trigger } = activeMenu;
    popup.remove();
    trigger.setAttribute('aria-expanded', 'false');
    activeMenu = null;
  }

  function buildMenu(trigger) {
    let items = [];
    try {
      items = JSON.parse(decodeURIComponent(trigger.dataset.items || '[]')) || [];
    } catch { items = []; }
    const popup = document.createElement('div');
    popup.className = 'menu-popup';
    popup.setAttribute('role', 'menu');
    const currentValue = trigger.value;

    items.forEach(it => {
      if (it && it.separator) {
        // If a 'label' is provided, render an uppercase section header in
        // place of the plain hairline divider (used for "Repo" / "Global"
        // groupings in the sub-agent menu).
        if (typeof it.label === 'string' && it.label) {
          const header = document.createElement('div');
          header.className = 'menu-section-label';
          header.textContent = it.label;
          popup.appendChild(header);
        } else {
          const sep = document.createElement('div');
          sep.className = 'menu-separator';
          sep.setAttribute('role', 'separator');
          popup.appendChild(sep);
        }
        return;
      }
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'menu-item' + (it.value === currentValue ? ' selected' : '');
      el.setAttribute('role', 'menuitemradio');
      el.setAttribute('aria-checked', String(it.value === currentValue));
      el.dataset.value = it.value ?? '';

      const iconEl = document.createElement('span');
      iconEl.className = 'menu-icon';
      // Icons come from our own renderer, not user input — safe to inline as SVG.
      if (typeof it.icon === 'string' && it.icon) iconEl.innerHTML = it.icon;
      el.appendChild(iconEl);

      const labelEl = document.createElement('span');
      labelEl.className = 'menu-label';
      labelEl.textContent = String(it.label ?? it.value ?? '');

      // If the item has a description (e.g. approvals chip), wrap label + desc
      // in a column so each menu row reads like the VS Code Approvals popup:
      //   <icon>  Default Approvals
      //           Copilot uses your configured settings
      if (typeof it.desc === 'string' && it.desc) {
        const wrap = document.createElement('div');
        wrap.className = 'menu-item-content';
        wrap.appendChild(labelEl);
        const descEl = document.createElement('div');
        descEl.className = 'menu-desc';
        descEl.textContent = String(it.desc);
        wrap.appendChild(descEl);
        el.appendChild(wrap);
        el.classList.add('with-desc');
      } else {
        el.appendChild(labelEl);
      }

      const checkEl = document.createElement('span');
      checkEl.className = 'menu-check';
      checkEl.textContent = '✓';
      el.appendChild(checkEl);

      el.addEventListener('click', () => {
        const val = String(it.value ?? '');
        const lbl = String(it.label ?? it.value ?? '');
        trigger.value = val;
        trigger.setAttribute('value', val);
        // Stash the picked item's "kind" ('mode' | 'agent' | etc) so a chip's
        // change-listener can decide which underlying field to update.
        trigger.dataset.lastKind = String(it.kind ?? '');
        const txt = trigger.querySelector('.menu-text');
        if (txt) txt.textContent = lbl;
        // If the trigger has its own icon span (.trigger-icon), refresh it
        // to the picked item's icon so the button reflects the selection.
        const triggerIcon = trigger.querySelector('.trigger-icon');
        if (triggerIcon && typeof it.icon === 'string') {
          triggerIcon.innerHTML = it.icon;
        }
        trigger.dispatchEvent(new Event('change', { bubbles: true }));
        closeMenu();
        trigger.focus();
      });
      popup.appendChild(el);
    });
    return popup;
  }

  function positionMenu(popup, trigger) {
    const rect = trigger.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = rect.left + 'px';
    popup.style.top = (rect.bottom + 4) + 'px';
    popup.style.minWidth = Math.max(180, rect.width) + 'px';
    requestAnimationFrame(() => {
      const pr = popup.getBoundingClientRect();
      if (pr.right > window.innerWidth - 8) {
        popup.style.left = Math.max(8, window.innerWidth - pr.width - 8) + 'px';
      }
      if (pr.bottom > window.innerHeight - 8) {
        const above = rect.top - pr.height - 4;
        if (above >= 8) {
          popup.style.top = above + 'px';
        } else {
          popup.style.top = '8px';
          popup.style.maxHeight = (window.innerHeight - 16) + 'px';
          popup.style.overflowY = 'auto';
        }
      }
    });
  }

  function openMenuFor(trigger) {
    closeMenu();
    const popup = buildMenu(trigger);
    document.body.appendChild(popup);
    positionMenu(popup, trigger);
    trigger.setAttribute('aria-expanded', 'true');
    activeMenu = { popup, trigger };
    const focusTarget = popup.querySelector('.menu-item.selected') || popup.querySelector('.menu-item');
    focusTarget?.focus();
  }

  document.addEventListener('mousedown', (e) => {
    const trigger = e.target.closest('.menu-trigger');
    if (trigger) {
      e.preventDefault();
      if (activeMenu && activeMenu.trigger === trigger) closeMenu();
      else openMenuFor(trigger);
      return;
    }
    if (activeMenu && !e.target.closest('.menu-popup')) closeMenu();
  });

  document.addEventListener('keydown', (e) => {
    // Escape always closes.
    if (e.key === 'Escape' && activeMenu) {
      e.preventDefault();
      const t = activeMenu.trigger;
      closeMenu();
      t.focus();
      return;
    }
    // When a menu is open, route arrow / tab keys.
    if (activeMenu) {
      const items = Array.from(activeMenu.popup.querySelectorAll('.menu-item'));
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(Math.max(i, -1) + 1) % items.length].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i - 1 + items.length) % items.length].focus();
      } else if (e.key === 'Tab') {
        closeMenu();
      }
      return;
    }
    // Open menu when a trigger has focus and user presses ↓/↑/Enter/Space.
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('menu-trigger')) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenuFor(ae);
      }
    }
  });

  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', (e) => {
    // Don't close if the user is scrolling inside the popup itself.
    if (activeMenu && e.target && e.target.closest && e.target.closest('.menu-popup')) return;
    closeMenu();
  }, true);

  // Merged Mode + Agent chip: when the user picks a menu item, the menu
  // manager updates the visible button + dispatches a change event. We
  // then route the value into either the hidden mode or subAgent input
  // depending on the picked item's kind.
  document.addEventListener('change', (e) => {
    const trigger = e.target && e.target.closest && e.target.closest('.merged-mode-agent');
    if (!trigger) return;
    const modeInput = document.getElementById(trigger.dataset.modeInput);
    const subAgentInput = document.getElementById(trigger.dataset.subagentInput);
    const lastKind = trigger.dataset.lastKind || '';
    const value = trigger.value || '';
    if (lastKind === 'mode') {
      if (modeInput)     modeInput.value = value;
      if (subAgentInput) subAgentInput.value = '';
    } else if (lastKind === 'agent') {
      if (subAgentInput) subAgentInput.value = value;
      // A discovered agent always runs in 'agent' mode.
      if (modeInput)     modeInput.value = 'agent';
    }
  });

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
      agent: agentTrigger.value,
      agentOptions: collectAgentOptions()
    };
  }

  function requestEstimate() {
    document.getElementById('estimate-status').textContent = 'Estimating…';
    document.getElementById('reasoning-badge').innerHTML = '';
    vscode.postMessage({
      type: 'requestEstimate',
      title: document.getElementById('title').value,
      description: document.getElementById('description').value
    });
  }

  function reasoningBadgeHtml(hours) {
    if (hours == null || isNaN(hours)) return '';
    if (hours < 1) return '<span class="reasoning-badge" style="background:#1a6b3c22;color:#27AE60">&#9889; Low</span>';
    if (hours <= 4) return '<span class="reasoning-badge" style="background:#1a3a6b22;color:#4A90E2">&#9670; Medium</span>';
    return '<span class="reasoning-badge" style="background:#6b1a1a22;color:#E74C3C">&#128293; High</span>';
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'setEstimate') {
      document.getElementById('total').value = msg.hours;
      document.getElementById('estimate-status').textContent = 'AI-estimated';
      document.getElementById('reasoning-badge').innerHTML = reasoningBadgeHtml(Number(msg.hours));
    }
  });

  document.getElementById('title').addEventListener('blur', requestEstimate);
  document.getElementById('description').addEventListener('blur', requestEstimate);

  const saveBtn = document.getElementById('save');
  if (saveBtn) saveBtn.addEventListener('click', () => vscode.postMessage(buildPayload('save')));
  const runBtn = document.getElementById('run');
  if (runBtn) runBtn.addEventListener('click', () => vscode.postMessage(buildPayload('run')));

  // Ctrl/Cmd+S to save
  document.addEventListener('keydown', (e) => {
    const isSave = (e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S');
    if (isSave) {
      e.preventDefault();
      vscode.postMessage(buildPayload('save'));
    }
  });

  // Init reasoning badge from existing total
  const existingHours = parseFloat(document.getElementById('total').value);
  if (!isNaN(existingHours)) {
    document.getElementById('reasoning-badge').innerHTML = reasoningBadgeHtml(existingHours);
  }

  // ── Todo list (in-panel) — delegated click handlers ──
  // Row click  → load the todo into the editor.
  // Run button → ask the host to run the agent for that todo.
  // Trash button → ask the host to delete (with confirm).
  document.addEventListener('click', (e) => {
    const action = e.target.closest && e.target.closest('[data-row-action]');
    if (action) {
      e.stopPropagation();
      const id = action.dataset.todoId;
      const kind = action.dataset.rowAction;
      if (kind === 'run')    vscode.postMessage({ type: 'runTodo',    id });
      if (kind === 'delete') vscode.postMessage({ type: 'deleteTodo', id });
      return;
    }
    const row = e.target.closest && e.target.closest('.todo-row');
    if (row && row.dataset.todoId) {
      vscode.postMessage({ type: 'selectTodo', id: row.dataset.todoId });
    }
  });
  // Keyboard activation on focused row.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('todo-row')
      ? document.activeElement
      : null;
    if (row && row.dataset.todoId) {
      e.preventDefault();
      vscode.postMessage({ type: 'selectTodo', id: row.dataset.todoId });
    }
  });
</script>
</body></html>`;
}

function renderOptionChip(
  agent: AgentType,
  field: AgentOptionField,
  value: string,
  esc: (s: string) => string
): string {
    const id = `opt-${agent}-${field.key}`;
    const labelText = esc(field.label);
    if (field.type === 'select' && field.choices) {
      const items = field.choices.map(c => ({
        value: c.value,
        label: c.label ?? c.value
      }));
      const currentLabel =
        (field.choices.find(c => c.value === value) ?? field.choices[0])?.label ??
        (field.choices.find(c => c.value === value) ?? field.choices[0])?.value ??
        value;
      const itemsAttr = encodeURIComponent(JSON.stringify(items));
      return `<button type="button" class="option-chip menu-trigger"
                      id="${esc(id)}" data-opt-key="${esc(field.key)}"
                      value="${esc(value)}"
                      data-items="${esc(itemsAttr)}"
                      aria-haspopup="menu" aria-expanded="false"
                      title="${labelText}">
        <span class="chip-label">${labelText}:</span>
        <span class="menu-text">${esc(currentLabel)}</span>
        <svg class="chevron" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
          <path d="M2 4l3 3 3-3z"/>
        </svg>
      </button>`;
    }
    return `<label class="option-chip" for="${esc(id)}" title="${labelText}">
      <span class="chip-label">${labelText}:</span>
      <input id="${esc(id)}" data-opt-key="${esc(field.key)}" value="${esc(value)}" placeholder="…" />
    </label>`;
}

function renderModeAgentChip(
  provider: 'copilot',
  modeChoices: { value: string; label: string }[],
  modeValue: string,
  subAgentValue: string,
  subAgents: ViewSubAgent[],
  esc: (s: string) => string
): string {
  // Mirrors VS Code's Copilot Chat picker: modes (Agent / Ask / Plan) at the
  // top, a divider, then discovered agents grouped by Repo / Global /
  // Extension. The menu manager writes the picked item's value back into one
  // of two hidden inputs depending on `kind`.
  const dedupe = (xs: ViewSubAgent[]) => {
    const seen = new Set<string>();
    const out: ViewSubAgent[] = [];
    for (const x of xs) {
      if (seen.has(x.name)) continue;
      seen.add(x.name);
      out.push(x);
    }
    return out;
  };

  const repo      = dedupe(subAgents.filter(s => s.source === 'repo'));
  const global    = dedupe(subAgents.filter(s => s.source === 'global'));
  const extension = dedupe(subAgents.filter(s => s.source === 'extension'));

  type Item = { value?: string; label?: string; separator?: boolean; kind?: 'mode' | 'agent' };
  const items: Item[] = [];
  for (const m of modeChoices) {
    items.push({ value: m.value, label: m.label, kind: 'mode' });
  }
  if (repo.length || global.length || extension.length) {
    items.push({ separator: true });
  }
  if (repo.length) {
    items.push({ separator: true, label: 'Repo' });
    for (const s of repo) items.push({ value: s.name, label: s.name, kind: 'agent' });
  }
  if (global.length) {
    items.push({ separator: true, label: 'Global' });
    for (const s of global) items.push({ value: s.name, label: s.name, kind: 'agent' });
  }
  if (extension.length) {
    items.push({ separator: true, label: 'Extension' });
    for (const s of extension) items.push({ value: s.name, label: s.name, kind: 'agent' });
  }

  // Visible chip text reflects whichever is "active": agent name takes
  // precedence over the mode label (if a sub-agent is picked, mode is
  // implicitly 'agent' anyway).
  let triggerText: string;
  let triggerValue: string;
  if (subAgentValue) {
    triggerText = subAgents.find(s => s.name === subAgentValue)?.name ?? subAgentValue;
    triggerValue = subAgentValue;
  } else {
    const m = modeChoices.find(c => c.value === modeValue) ?? modeChoices[0];
    triggerText = m?.label ?? 'Agent';
    triggerValue = m?.value ?? 'agent';
  }

  const itemsAttr = encodeURIComponent(JSON.stringify(items));
  const totalAgents = repo.length + global.length + extension.length;
  const tooltip = `Mode + Agent (${modeChoices.length} modes, ${totalAgents} agents discovered)`;

  // Two hidden inputs so the existing collectAgentOptions() — which scans
  // `[data-opt-key]` and reads `el.value` — picks both fields up unchanged.
  return `
    <input type="hidden" data-opt-key="mode" value="${esc(modeValue)}" id="opt-${esc(provider)}-mode-state" />
    <input type="hidden" data-opt-key="subAgent" value="${esc(subAgentValue)}" id="opt-${esc(provider)}-subAgent-state" />
    <button type="button" class="option-chip menu-trigger merged-mode-agent"
            id="opt-${esc(provider)}-modeagent"
            data-mode-input="opt-${esc(provider)}-mode-state"
            data-subagent-input="opt-${esc(provider)}-subAgent-state"
            value="${esc(triggerValue)}"
            data-items="${esc(itemsAttr)}"
            aria-haspopup="menu" aria-expanded="false"
            title="${esc(tooltip)}">
      <span class="menu-text">${esc(triggerText)}</span>
      <svg class="chevron" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
        <path d="M2 4l3 3 3-3z"/>
      </svg>
    </button>`;
}

function renderSubAgentChip(
  provider: 'claude-code' | 'copilot',
  value: string,
  subAgents: ViewSubAgent[],
  esc: (s: string) => string
): string {
  // Dedupe by name within each source so the same agent name appearing in
  // both `.claude/agents/` and `.copilot/agents/` doesn't show up twice.
  const dedupe = (xs: ViewSubAgent[]) => {
    const seen = new Set<string>();
    const out: ViewSubAgent[] = [];
    for (const x of xs) {
      if (seen.has(x.name)) continue;
      seen.add(x.name);
      out.push(x);
    }
    return out;
  };

  // Group by source so the menu reads as: Default → Repo → Global → Extension.
  const repo      = dedupe(subAgents.filter(s => s.source === 'repo'));
  const global    = dedupe(subAgents.filter(s => s.source === 'global'));
  const extension = dedupe(subAgents.filter(s => s.source === 'extension'));

  type Item = { value?: string; label?: string; separator?: boolean };
  const items: Item[] = [{ value: '', label: 'Default' }];
  if (repo.length) {
    items.push({ separator: true, label: 'Repo' });
    for (const s of repo) items.push({ value: s.name, label: s.name });
  }
  if (global.length) {
    items.push({ separator: true, label: 'Global' });
    for (const s of global) items.push({ value: s.name, label: s.name });
  }
  if (extension.length) {
    items.push({ separator: true, label: 'Extension' });
    for (const s of extension) items.push({ value: s.name, label: s.name });
  }

  const currentLabel = value
    ? (subAgents.find(s => s.name === value)?.name ?? value)
    : 'Default';
  const itemsAttr = encodeURIComponent(JSON.stringify(items));
  const id = `opt-${provider}-subAgent`;
  const totalCount = repo.length + global.length + extension.length;
  const tooltip = totalCount === 0
    ? 'No agents discovered. Add one under .claude/agents/ or .copilot/agents/.'
    : `Agent (${totalCount} discovered across all sources)`;

  return `<button type="button" class="option-chip menu-trigger"
                  id="${esc(id)}" data-opt-key="subAgent"
                  value="${esc(value)}"
                  data-items="${esc(itemsAttr)}"
                  aria-haspopup="menu" aria-expanded="false"
                  title="${esc(tooltip)}">
    <span class="chip-label">Agent:</span>
    <span class="menu-text">${esc(currentLabel)}</span>
    <svg class="chevron" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <path d="M2 4l3 3 3-3z"/>
    </svg>
  </button>`;
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

function renderTodoList(todos: Todo[], currentTodoId: string, esc: (s: string) => string): string {
  if (todos.length === 0) {
    return `
      <section class="todo-list-section">
        <div class="todo-list-header"><span>Todos</span></div>
        <div class="todo-list-empty">No todos yet — fill in the form above and click Create.</div>
      </section>`;
  }
  // Newest first.
  const sorted = [...todos].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const rows = sorted.map(t => {
    const active = t.id === currentTodoId ? ' active' : '';
    const done = t.status === 'done' ? ' done' : '';
    const meta: string[] = [t.status];
    if (t.remoteId) meta.push(`#${t.remoteId}`);
    if (t.effort?.total != null) meta.push(`${t.effort.total}h`);
    return `
      <div class="todo-row${active}${done}" data-todo-id="${esc(t.id)}" role="button" tabindex="0" title="${esc(t.title)}">
        <span class="row-icon">${rowStatusIcon(t.status)}</span>
        <div class="row-main">
          <div class="row-title">${esc(t.title) || '<em>(untitled)</em>'}</div>
          <div class="row-meta">${esc(meta.join(' · '))}</div>
        </div>
        <div class="row-actions">
          <button type="button" class="row-action" data-row-action="run" data-todo-id="${esc(t.id)}" title="Run agent" aria-label="Run agent">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 2l10 6-10 6V2z"/></svg>
          </button>
          <button type="button" class="row-action danger" data-row-action="delete" data-todo-id="${esc(t.id)}" title="Delete" aria-label="Delete">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h10M5 4V2.6h6V4M6 7v5M10 7v5M4.4 4l.7 9.4h5.8L11.6 4"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');
  return `
    <section class="todo-list-section">
      <div class="todo-list-header"><span>Todos · ${sorted.length}</span></div>
      <div class="todo-list" id="todo-list">${rows}</div>
    </section>`;
}

function rowStatusIcon(status: TodoStatus): string {
  // Compact 14px versions of the status circle, matching the colours used
  // in the larger STATUS_CONFIG pill.
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG['draft'];
  const fg = cfg.fg;
  switch (status) {
    case 'draft':
      return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="${fg}" stroke-width="1.4" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke-dasharray="3 2" opacity="0.7"/></svg>`;
    case 'synced':
      return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="${fg}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 7a5 5 0 0 1 9-3"/><path d="M12 7a5 5 0 0 1-9 3"/><polyline points="9,2 11,4 9,6"/><polyline points="5,12 3,10 5,8"/></svg>`;
    case 'in-progress':
      return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="${fg}" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="5" opacity="0.25"/><path d="M7 2a5 5 0 0 1 5 5"/></svg>`;
    case 'done':
      return `<svg width="14" height="14" viewBox="0 0 14 14" fill="${fg}" aria-hidden="true"><circle cx="7" cy="7" r="6"/><polyline points="4,7.5 6,9.5 10,5" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case 'failed':
      return `<svg width="14" height="14" viewBox="0 0 14 14" fill="${fg}" aria-hidden="true"><circle cx="7" cy="7" r="6"/><line x1="4.5" y1="4.5" x2="9.5" y2="9.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><line x1="9.5" y1="4.5" x2="4.5" y2="9.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }
}

function renderApprovalsChip(
  provider: 'copilot' | 'claude-code',
  value: string,
  esc: (s: string) => string
): string {
  type ApprovalItem = { value: string; label: string; desc: string; icon: string };
  const items: ApprovalItem[] = approvalsItemsFor(provider);

  const current = items.find(i => i.value === value) ?? items[0];
  const itemsAttr = encodeURIComponent(JSON.stringify(items));
  const id = `opt-${provider}-approvals`;

  return `
    <button type="button" class="option-chip menu-trigger"
            id="${esc(id)}" data-opt-key="approvals"
            value="${esc(current.value)}"
            data-items="${esc(itemsAttr)}"
            aria-haspopup="menu" aria-expanded="false"
            title="${esc(current.label)} — ${esc(current.desc)}">
      <span class="menu-icon trigger-icon">${current.icon}</span>
      <span class="menu-text">${esc(current.label)}</span>
      <svg class="chevron" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
        <path d="M2 4l3 3 3-3z"/>
      </svg>
    </button>`;
}

function approvalsItemsFor(provider: 'copilot' | 'claude-code'): { value: string; label: string; desc: string; icon: string }[] {
  // Match VS Code's Copilot Approvals picker for the copilot provider, and
  // map Claude's existing four `--permission-mode` values onto the same
  // visual vocabulary so users see consistent terminology across providers.
  const shield = approvalIconShield();
  const bypass = approvalIconWarning();
  const auto   = approvalIconSpark();
  const edit   = approvalIconPencil();
  const plan   = approvalIconClipboard();

  if (provider === 'copilot') {
    return [
      { value: 'default',   label: 'Default Approvals',   desc: 'Copilot uses your configured settings',     icon: shield },
      { value: 'bypass',    label: 'Bypass Approvals',    desc: 'All tool calls are auto-approved',          icon: bypass },
      { value: 'autopilot', label: 'Autopilot (Preview)', desc: 'Autonomously iterates from start to finish', icon: auto   }
    ];
  }
  // claude-code
  return [
    { value: 'default',           label: 'Default Approvals', desc: 'Prompt for each tool call',           icon: shield },
    { value: 'acceptEdits',       label: 'Accept Edits',      desc: 'Auto-approve file edits only',        icon: edit   },
    { value: 'plan',              label: 'Plan Only',         desc: 'Plan without executing any commands', icon: plan   },
    { value: 'bypassPermissions', label: 'Bypass Approvals',  desc: 'All tool calls are auto-approved',    icon: bypass }
  ];
}

function approvalIconShield(): string {
  return [
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">',
    '<path d="M8 1.5l5.2 1.8v4.4c0 3.2-2.2 5.6-5.2 6.7-3-1.1-5.2-3.5-5.2-6.7V3.3z"/>',
    '</svg>'
  ].join('');
}
function approvalIconWarning(): string {
  return [
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
    '<path d="M8 2.2L1.8 13.4h12.4z"/>',
    '<line x1="8" y1="6.4" x2="8" y2="9.8"/>',
    '<circle cx="8" cy="11.6" r="0.55" fill="currentColor" stroke="none"/>',
    '</svg>'
  ].join('');
}
function approvalIconSpark(): string {
  return [
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">',
    '<path d="M8 1.5l1.1 3.4h3.6L9.8 7l1.1 3.4L8 8.3 5.1 10.4 6.2 7 3.3 4.9h3.6z"/>',
    '<circle cx="13.2" cy="12.4" r="0.9"/>',
    '</svg>'
  ].join('');
}
function approvalIconPencil(): string {
  return [
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
    '<path d="M2.4 13.6l1-3 7.4-7.4 2 2-7.4 7.4z"/>',
    '<line x1="9.4" y1="4.6" x2="11.4" y2="6.6"/>',
    '</svg>'
  ].join('');
}
function approvalIconClipboard(): string {
  return [
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">',
    '<rect x="3.5" y="3" width="9" height="11" rx="1.2"/>',
    '<rect x="6" y="1.6" width="4" height="2.4" rx="0.8" fill="currentColor" stroke="none"/>',
    '<line x1="5.5" y1="8" x2="10.5" y2="8" stroke-linecap="round"/>',
    '<line x1="5.5" y1="10.4" x2="9" y2="10.4" stroke-linecap="round"/>',
    '</svg>'
  ].join('');
}

function agentIcon(type: AgentType): string {
  // Inline SVGs that render inside menu items. These are constants we author,
  // never user input, so they are safe to inline as innerHTML. Drawn to mirror
  // the VS Code codicons / brand marks: `device-desktop`, the GitHub Copilot
  // mark, `cloud`, and Anthropic's multi-ray starburst.
  switch (type) {
    case 'copilot':
      // Stylised GitHub Copilot mark: rounded capsule head with two oval eyes
      // and a small antenna.
      return [
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
        '<line x1="8" y1="1.6" x2="8" y2="3.2"/>',
        '<path d="M2.2 8.4c0-2.5 2-4.4 5.8-4.4s5.8 1.9 5.8 4.4v2c0 1-.8 1.8-1.8 1.8H4c-1 0-1.8-.8-1.8-1.8z"/>',
        '<ellipse cx="6" cy="9.2" rx="0.9" ry="1.3" fill="currentColor" stroke="none"/>',
        '<ellipse cx="10" cy="9.2" rx="0.9" ry="1.3" fill="currentColor" stroke="none"/>',
        '</svg>'
      ].join('');
    case 'open-issue':
      // Cloud — matches the VS Code `cloud` codicon silhouette.
      return [
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
        '<path d="M4.7 12.3h6.5c1.6 0 2.9-1.25 2.9-2.8 0-1.45-1.05-2.6-2.5-2.8-.2-2-1.95-3.55-4.05-3.55-1.85 0-3.45 1.25-3.95 2.95C2.45 6.45 1.5 7.5 1.5 8.85c0 1.6 1.4 3.45 3.2 3.45z"/>',
        '</svg>'
      ].join('');
    case 'claude-code':
      // Anthropic-style starburst — four major rays + four shorter diagonals.
      return [
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">',
        '<path d="M8 1l.9 4.4 4.4-1.3-3.1 3.3 3.1 3.3-4.4-1.3L8 14l-.9-4.6-4.4 1.3 3.1-3.3-3.1-3.3 4.4 1.3z"/>',
        '<circle cx="8" cy="8" r="1.1" fill="var(--vscode-menu-background, var(--vscode-editorWidget-background, #fff))"/>',
        '</svg>'
      ].join('');
    default:
      return '';
  }
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
