import * as vscode from 'vscode';
import { MetricsStore } from '../store/metricsStore';
import { TodoStore } from '../store/todoStore';
import { Todo } from '../types';

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
      'djinn.metrics',
      'Djinn · Metrics',
      vscode.ViewColumn.One,
      { enableScripts: true }
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
    const pipe = pipeline(items);
    const daily = aggregateDaily(items);

    // Derived metrics: prefer live values from todo list over stale stored counters.
    const tasksCreated = items.length;
    const totalAgentMs = items.reduce((sum, t) => sum + (t.agentDurationMs ?? 0), 0);
    const totalAgentHours = totalAgentMs / 3_600_000;
    const hoursSaved = Math.max(0, m.totalEstimatedHours - totalAgentHours);

    const completionPct = tasksCreated > 0
      ? Math.min(100, Math.round((m.tasksCompleted / tasksCreated) * 100))
      : 0;
    const remaining = Math.max(0, tasksCreated - m.tasksCompleted);
    const ringR = 52;
    const ringC = 2 * Math.PI * ringR;
    const ringOffset = ringC * (1 - completionPct / 100);
    const avgRunMs = m.agentRunsTriggered > 0 ? totalAgentMs / m.agentRunsTriggered : 0;
    const tokensTotal = m.totalTokensUsed ?? 0;

    const timeChart = renderTimeChart(daily, 30);
    const hoursChart = renderHoursChart(daily, 30);
    const changesChart = renderChangesChart(daily, 30);
    const yearHeatmap = renderYearHeatmap(daily);
    const donut = renderDonut(pipe);

    return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  :root {
    --created: #58a6ff;
    --worked: #a371f7;
    --completed: #3fb950;
    --failed: #f85149;
    --hours: #f0883e;
    --tokens: #79c0ff;
    --added: #56d364;
    --updated: #d2a8ff;
    --muted: var(--vscode-descriptionForeground);
    --surface: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
    --surface-hi: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
    --border: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 28px 32px 56px;
    margin: 0;
    line-height: 1.45;
  }
  header {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 16px; margin-bottom: 28px; flex-wrap: wrap;
  }
  h1 {
    font-size: 24px; font-weight: 700; margin: 0;
    letter-spacing: -0.01em;
  }
  .sub { color: var(--muted); font-size: 13px; }
  h2 {
    font-size: 13px; font-weight: 600; margin: 28px 0 12px;
    text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted);
  }
  .glance {
    display: grid; gap: 16px;
    grid-template-columns: repeat(2, 1fr);
  }
  @media (max-width: 720px) { .glance { grid-template-columns: 1fr; } }

  .g-card {
    position: relative;
    padding: 22px 22px 20px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .g-card::after {
    content: ''; position: absolute; inset: 0;
    background: radial-gradient(circle at top right, var(--accent-glow, transparent), transparent 65%);
    pointer-events: none;
  }
  .g-card > * { position: relative; z-index: 1; }
  .g-head {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px;
  }
  .g-head h3 {
    margin: 0; font-size: 12px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted);
  }
  .g-pill {
    font-size: 10.5px; padding: 4px 10px; border-radius: 999px;
    background: color-mix(in srgb, var(--accent, var(--vscode-foreground)) 14%, transparent);
    color: color-mix(in srgb, var(--accent, var(--vscode-foreground)) 90%, var(--vscode-foreground));
    font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    font-variant-numeric: tabular-nums;
  }

  /* Productivity card */
  .prod { --accent: var(--completed); --accent-glow: color-mix(in srgb, var(--completed) 16%, transparent); }
  .prod-ring {
    display: grid; grid-template-columns: 124px 1fr; gap: 22px; align-items: center;
  }
  .ring-svg { width: 124px; height: 124px; transform: rotate(-90deg); }
  .ring-bg { fill: none; stroke: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); stroke-width: 11; }
  .ring-fg {
    fill: none; stroke: url(#ringGrad); stroke-width: 11; stroke-linecap: round;
    transition: stroke-dashoffset 0.6s ease;
  }
  .ring-num {
    font-size: 34px; font-weight: 800; letter-spacing: -0.03em; line-height: 1;
    color: var(--vscode-foreground);
  }
  .ring-num .frac { color: var(--muted); font-weight: 600; }
  .ring-cap {
    font-size: 11px; color: var(--muted); text-transform: uppercase;
    letter-spacing: 0.1em; margin-top: 8px; font-weight: 600;
  }
  .ring-rem { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .ring-rem b { color: var(--vscode-foreground); font-weight: 700; }

  .saved-banner {
    margin-top: 18px; padding: 14px 16px;
    border-radius: 10px;
    background: linear-gradient(135deg,
      color-mix(in srgb, var(--hours) 22%, transparent),
      color-mix(in srgb, var(--hours) 4%, transparent));
    border: 1px solid color-mix(in srgb, var(--hours) 32%, transparent);
    display: flex; align-items: center; gap: 14px;
  }
  .saved-spark {
    width: 38px; height: 38px; flex-shrink: 0;
    border-radius: 10px;
    background: color-mix(in srgb, var(--hours) 30%, transparent);
    display: grid; place-items: center;
    color: var(--hours);
  }
  .saved-num {
    font-size: 28px; font-weight: 800; letter-spacing: -0.02em;
    color: var(--hours); line-height: 1;
  }
  .saved-lbl {
    font-size: 11px; color: var(--muted); text-transform: uppercase;
    letter-spacing: 0.08em; margin-top: 4px; font-weight: 600;
  }

  /* Agent activity card */
  .agent { --accent: var(--worked); --accent-glow: color-mix(in srgb, var(--worked) 16%, transparent); }
  .agent-tiles {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
  }
  .tile {
    position: relative;
    padding: 16px 14px 14px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 9%, transparent);
    overflow: hidden;
  }
  .tile::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
    background: var(--tc);
  }
  .tile .glyph {
    position: absolute; right: -10px; bottom: -16px;
    width: 64px; height: 64px; opacity: 0.10;
    color: var(--tc);
  }
  .tile .tv {
    font-size: 24px; font-weight: 800; letter-spacing: -0.02em;
    color: var(--tc); line-height: 1; font-variant-numeric: tabular-nums;
  }
  .tile .tl {
    font-size: 10.5px; color: var(--muted); text-transform: uppercase;
    letter-spacing: 0.09em; margin-top: 6px; font-weight: 600;
  }
  .tile.runs { --tc: var(--worked); }
  .tile.runtime { --tc: var(--hours); }
  .tile.tokens { --tc: var(--tokens); }

  .agent-foot {
    margin-top: 14px; padding-top: 12px;
    border-top: 1px dashed color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    display: flex; justify-content: space-between; align-items: center;
    font-size: 11.5px; color: var(--muted);
  }
  .agent-foot b {
    color: var(--vscode-foreground); font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .row {
    display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 20px;
  }
  .card.tight { padding: 16px 18px; }
  .card-title {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 14px;
  }
  .card-title h3 {
    font-size: 14px; font-weight: 600; margin: 0;
  }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; }
  .legend span {
    font-size: 11px; color: var(--muted);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .legend i {
    width: 9px; height: 9px; border-radius: 2px; display: inline-block;
  }
  svg { display: block; width: 100%; height: auto; }
  .axis { fill: var(--muted); font-size: 10px; }
  .grid-line { stroke: var(--border); stroke-width: 1; }

  .pipeline {
    display: grid; grid-template-columns: 200px 1fr; gap: 24px; align-items: center;
  }
  .pipe-list { display: grid; gap: 8px; }
  .pipe-row {
    display: grid; grid-template-columns: 12px 1fr auto; gap: 10px;
    align-items: center; font-size: 13px;
  }
  .pipe-row i { width: 10px; height: 10px; border-radius: 3px; }
  .pipe-row b { font-variant-numeric: tabular-nums; color: var(--muted); font-weight: 600; }

  .heat-card {
    background: #ffffff;
    border: 1px solid #d0d7de;
    border-radius: 12px;
  }
  .heat-card .card-title h3 { color: #1f2328; }
  .heat-wrap {
    overflow-x: auto;
    overflow-y: hidden;
  }
  .heat-wrap svg { display: block; }
  .heat-wrap .axis { fill: #57606a; }
  .heat-tooltip {
    position: fixed;
    pointer-events: none;
    background: #24292f;
    color: #ffffff;
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 6px;
    transform: translate(-50%, calc(-100% - 8px));
    white-space: nowrap;
    opacity: 0;
    transition: opacity 0.1s;
    z-index: 100;
  }
  .heat-tooltip.show { opacity: 1; }
  .heat-foot {
    display: flex; justify-content: flex-end; align-items: center;
    gap: 8px; margin-top: 10px; font-size: 11px; color: #57606a;
  }
  .heat-scale { display: inline-flex; gap: 3px; }
  .heat-scale i { width: 11px; height: 11px; border-radius: 2px; display: inline-block; }

  @media (max-width: 720px) {
    .pipeline { grid-template-columns: 1fr; }
  }
</style></head><body>
  <header>
    <div>
      <h1>Djinn · Metrics</h1>
      <div class="sub">Activity, throughput, and effort across your tasks.</div>
    </div>
    <div class="sub">${items.length} task${items.length === 1 ? '' : 's'} tracked</div>
  </header>

  <h2>At a glance</h2>
  <div class="glance">
    <div class="g-card prod">
      <div class="g-head">
        <h3>Productivity</h3>
        <span class="g-pill">${completionPct}% complete</span>
      </div>
      <div class="prod-ring">
        <svg class="ring-svg" viewBox="0 0 124 124">
          <defs>
            <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="var(--completed)" />
              <stop offset="100%" stop-color="var(--created)" />
            </linearGradient>
          </defs>
          <circle class="ring-bg" cx="62" cy="62" r="${ringR}" />
          <circle class="ring-fg" cx="62" cy="62" r="${ringR}"
            stroke-dasharray="${ringC.toFixed(2)}"
            stroke-dashoffset="${ringOffset.toFixed(2)}" />
        </svg>
        <div>
          <div class="ring-num">${m.tasksCompleted}<span class="frac"> / ${tasksCreated}</span></div>
          <div class="ring-cap">Tasks completed</div>
          <div class="ring-rem"><b>${remaining}</b> remaining</div>
        </div>
      </div>
      <div class="saved-banner">
        <div class="saved-spark">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </div>
        <div>
          <div class="saved-num">${hoursSaved.toFixed(1)}h</div>
          <div class="saved-lbl">Hours saved vs. estimate</div>
        </div>
      </div>
    </div>

    <div class="g-card agent">
      <div class="g-head">
        <h3>Agent activity</h3>
        <span class="g-pill">${formatDuration(totalAgentMs)} total</span>
      </div>
      <div class="agent-tiles">
        <div class="tile runs">
          <svg class="glyph" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h7l-1 8 11-14h-7l1-6z"/></svg>
          <div class="tv">${m.agentRunsTriggered}</div>
          <div class="tl">Runs</div>
        </div>
        <div class="tile runtime">
          <svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/></svg>
          <div class="tv">${totalAgentHours.toFixed(1)}h</div>
          <div class="tl">Runtime</div>
        </div>
        <div class="tile tokens">
          <svg class="glyph" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l9 5-9 5-9-5 9-5zm0 9l9-5v6l-9 5-9-5V6l9 5zm0 5l9-5v6l-9 5-9-5v-6l9 5z"/></svg>
          <div class="tv">${formatTokens(tokensTotal)}</div>
          <div class="tl">Tokens</div>
        </div>
      </div>
      <div class="agent-foot">
        <span>Avg per run · <b>${avgRunMs > 0 ? formatDuration(avgRunMs) : '—'}</b></span>
        <span>Throughput · <b>${totalAgentHours.toFixed(1)}h</b> across <b>${m.agentRunsTriggered}</b></span>
      </div>
    </div>
  </div>

  <div class="row" style="margin-top:24px">
    <section class="card">
      <div class="card-title">
        <h3>Tasks · last 30 days</h3>
        <div class="legend">
          <span><i style="background:var(--created)"></i>Created</span>
          <span><i style="background:var(--worked)"></i>Worked</span>
          <span><i style="background:var(--completed)"></i>Completed</span>
          <span><i style="background:var(--failed)"></i>Failed</span>
        </div>
      </div>
      ${timeChart}
    </section>

    <section class="card">
      <div class="card-title">
        <h3>Hours of usage · last 30 days</h3>
        <div class="legend">
          <span><i style="background:var(--hours)"></i>Agent runtime</span>
        </div>
      </div>
      ${hoursChart}
    </section>
  </div>

  <div class="row" style="margin-top:16px">
    <section class="card">
      <div class="card-title">
        <h3>Changes · added vs updated</h3>
        <div class="legend">
          <span><i style="background:var(--added)"></i>Added</span>
          <span><i style="background:var(--updated)"></i>Updated</span>
        </div>
      </div>
      ${changesChart}
    </section>

    <section class="card">
      <div class="card-title"><h3>Pipeline</h3></div>
      <div class="pipeline">
        ${donut}
        <div class="pipe-list">
          ${pipeRow('Draft', pipe.draft, '#8b949e')}
          ${pipeRow('Synced', pipe.synced, 'var(--created)')}
          ${pipeRow('In progress', pipe.inProgress, '#d29922')}
          ${pipeRow('Done', pipe.done, 'var(--completed)')}
          ${pipeRow('Failed', pipe.failed, 'var(--failed)')}
        </div>
      </div>
    </section>
  </div>

  <section class="card heat-card" style="margin-top:16px">
    <div class="card-title">
      <h3>Activity heatmap · last year</h3>
    </div>
    <div class="heat-wrap" id="heatWrap">
      ${yearHeatmap}
      <div class="heat-tooltip" id="heatTip"></div>
    </div>
    <div class="heat-foot">
      <span>Less</span>
      <span class="heat-scale">
        <i style="background:${HEAT[0]};border:1px solid #d0d7de"></i>
        <i style="background:${HEAT[1]}"></i>
        <i style="background:${HEAT[2]}"></i>
        <i style="background:${HEAT[3]}"></i>
        <i style="background:${HEAT[4]}"></i>
      </span>
      <span>More</span>
    </div>
  </section>
  <script>
    (function () {
      const wrap = document.getElementById('heatWrap');
      const tip = document.getElementById('heatTip');
      if (!wrap || !tip) return;
      wrap.addEventListener('mousemove', (e) => {
        const t = e.target;
        if (t && t.tagName === 'rect' && t.dataset && t.dataset.count !== undefined) {
          const count = t.dataset.count;
          const date = t.dataset.date || '';
          tip.textContent = (date ? date + ': ' : '') + count + ' activit' + (count === '1' ? 'y' : 'ies');
          tip.style.left = e.clientX + 'px';
          tip.style.top = e.clientY + 'px';
          tip.classList.add('show');
        } else {
          tip.classList.remove('show');
        }
      });
      wrap.addEventListener('mouseleave', () => tip.classList.remove('show'));
    })();
  </script>
</body></html>`;
  }
}

// ---------- helpers ----------

interface DayBucket {
  date: string;          // YYYY-MM-DD
  created: number;
  worked: number;
  completed: number;
  failed: number;
  added: number;         // alias for created (changes added)
  updated: number;       // updates that aren't creations
  hours: number;         // agent runtime hours
  tokens: number;
  activity: number;      // any of the above (for heatmap)
}

interface Pipe {
  draft: number; synced: number; inProgress: number; done: number; failed: number;
}

const HEAT = ['#ffffff', '#9be9a8', '#40c463', '#30a14e', '#216e39'];
// Index 0 (empty) is white as requested; 1-4 use the GitHub light-green ramp.

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function pipeline(items: Todo[]): Pipe {
  return {
    draft: items.filter(t => t.status === 'draft').length,
    synced: items.filter(t => t.status === 'synced').length,
    inProgress: items.filter(t => t.status === 'in-progress').length,
    done: items.filter(t => t.status === 'done').length,
    failed: items.filter(t => t.status === 'failed').length,
  };
}

function aggregateDaily(items: Todo[]): Map<string, DayBucket> {
  const map = new Map<string, DayBucket>();
  const bump = (key: string): DayBucket => {
    let b = map.get(key);
    if (!b) {
      b = { date: key, created: 0, worked: 0, completed: 0, failed: 0, added: 0, updated: 0, hours: 0, tokens: 0, activity: 0 };
      map.set(key, b);
    }
    return b;
  };
  for (const t of items) {
    if (t.createdAt) {
      const k = dayKey(t.createdAt);
      if (k) { const b = bump(k); b.created++; b.added++; b.activity++; }
    }
    if (t.agent?.lastRunAt) {
      const k = dayKey(t.agent.lastRunAt);
      if (k) {
        const b = bump(k);
        b.worked++;
        b.activity++;
        if (t.agentDurationMs && t.agentDurationMs > 0) {
          b.hours += t.agentDurationMs / 3_600_000;
        }
        if (t.tokensUsed) b.tokens += t.tokensUsed;
      }
    }
    const completedIso = t.completedAt ?? (t.status === 'done' ? t.updatedAt : undefined);
    if (completedIso) {
      const k = dayKey(completedIso);
      if (k) { const b = bump(k); b.completed++; b.activity++; }
    }
    if (t.status === 'failed' && t.updatedAt) {
      const k = dayKey(t.updatedAt);
      if (k) { const b = bump(k); b.failed++; b.activity++; }
    }
    if (t.updatedAt && t.createdAt && t.updatedAt !== t.createdAt) {
      const k = dayKey(t.updatedAt);
      const createdKey = dayKey(t.createdAt);
      if (k && k !== createdKey) { const b = bump(k); b.updated++; }
    }
  }
  return map;
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(dayKey(d.toISOString()));
  }
  return out;
}

function kpi(label: string, value: string | number, accent: string, delta?: string): string {
  return `<div class="kpi" style="--accent:${accent}">
    <div class="v">${value}</div>
    <div class="l">${label}</div>
    ${delta ? `<div class="delta">${delta}</div>` : ''}
  </div>`;
}

function formatTokens(n: number): string {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K';
  return String(n);
}

function pipeRow(label: string, value: number, color: string): string {
  return `<div class="pipe-row"><i style="background:${color}"></i><span>${label}</span><b>${value}</b></div>`;
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ---------- charts ----------

function renderTimeChart(daily: Map<string, DayBucket>, days: number): string {
  const keys = lastNDays(days);
  const series = keys.map(k => daily.get(k) ?? emptyDay(k));
  const maxStack = Math.max(1, ...series.map(s => s.created + s.worked + s.completed + s.failed));

  const W = 720, H = 220, P = { l: 28, r: 12, t: 10, b: 26 };
  const cw = (W - P.l - P.r) / days;
  const bw = Math.max(2, cw * 0.7);
  const inner = H - P.t - P.b;

  const yTicks = 4;
  const tickVals = Array.from({ length: yTicks + 1 }, (_, i) => Math.round((maxStack * i) / yTicks));

  const gridLines = tickVals.map(v => {
    const y = P.t + inner - (v / maxStack) * inner;
    return `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}" />
            <text class="axis" x="${P.l - 6}" y="${y + 3}" text-anchor="end">${v}</text>`;
  }).join('');

  const colors = ['var(--created)', 'var(--worked)', 'var(--completed)', 'var(--failed)'];

  const bars = series.map((s, i) => {
    const x = P.l + i * cw + (cw - bw) / 2;
    const stack = [s.created, s.worked, s.completed, s.failed];
    let yCursor = P.t + inner;
    let segs = '';
    stack.forEach((val, j) => {
      if (val <= 0) return;
      const h = (val / maxStack) * inner;
      yCursor -= h;
      segs += `<rect x="${x}" y="${yCursor}" width="${bw}" height="${h}" fill="${colors[j]}" rx="1.5" />`;
    });
    return segs;
  }).join('');

  // x-axis labels: every ~5 days
  const labels = series.map((s, i) => {
    if (i % Math.ceil(days / 6) !== 0 && i !== series.length - 1) return '';
    const d = new Date(s.date);
    const lbl = `${d.getMonth() + 1}/${d.getDate()}`;
    const x = P.l + i * cw + cw / 2;
    return `<text class="axis" x="${x}" y="${H - 8}" text-anchor="middle">${lbl}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
    ${gridLines}${bars}${labels}
  </svg>`;
}

function renderHoursChart(daily: Map<string, DayBucket>, days: number): string {
  const keys = lastNDays(days);
  const series = keys.map(k => daily.get(k) ?? emptyDay(k));
  const maxV = Math.max(0.5, ...series.map(s => s.hours));

  const W = 720, H = 200, P = { l: 32, r: 12, t: 10, b: 26 };
  const cw = (W - P.l - P.r) / days;
  const inner = H - P.t - P.b;

  // smooth area + bars
  const points = series.map((s, i) => {
    const x = P.l + i * cw + cw / 2;
    const y = P.t + inner - (s.hours / maxV) * inner;
    return [x, y, s.hours] as const;
  });
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const areaPath = `${path} L${points[points.length - 1][0].toFixed(1)},${P.t + inner} L${points[0][0].toFixed(1)},${P.t + inner} Z`;

  const yTicks = 3;
  const grid = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = (maxV * i) / yTicks;
    const y = P.t + inner - (v / maxV) * inner;
    return `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}" />
            <text class="axis" x="${P.l - 6}" y="${y + 3}" text-anchor="end">${v.toFixed(1)}h</text>`;
  }).join('');

  const labels = series.map((s, i) => {
    if (i % Math.ceil(days / 6) !== 0 && i !== series.length - 1) return '';
    const d = new Date(s.date);
    const x = P.l + i * cw + cw / 2;
    return `<text class="axis" x="${x}" y="${H - 8}" text-anchor="middle">${d.getMonth() + 1}/${d.getDate()}</text>`;
  }).join('');

  const dots = points.map(p => p[2] > 0 ? `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" fill="var(--hours)" />` : '').join('');

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
    <defs>
      <linearGradient id="hoursGrad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="var(--hours)" stop-opacity="0.45" />
        <stop offset="100%" stop-color="var(--hours)" stop-opacity="0.02" />
      </linearGradient>
    </defs>
    ${grid}
    <path d="${areaPath}" fill="url(#hoursGrad)" />
    <path d="${path}" fill="none" stroke="var(--hours)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    ${dots}${labels}
  </svg>`;
}

function renderChangesChart(daily: Map<string, DayBucket>, days: number): string {
  const keys = lastNDays(days);
  const series = keys.map(k => daily.get(k) ?? emptyDay(k));
  const maxV = Math.max(1, ...series.map(s => Math.max(s.added, s.updated)));

  const W = 720, H = 200, P = { l: 28, r: 12, t: 10, b: 26 };
  const cw = (W - P.l - P.r) / days;
  const bw = Math.max(2, (cw * 0.7) / 2);
  const inner = H - P.t - P.b;

  const yTicks = 3;
  const grid = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = Math.round((maxV * i) / yTicks);
    const y = P.t + inner - (v / maxV) * inner;
    return `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}" />
            <text class="axis" x="${P.l - 6}" y="${y + 3}" text-anchor="end">${v}</text>`;
  }).join('');

  const bars = series.map((s, i) => {
    const x0 = P.l + i * cw + (cw - bw * 2 - 2) / 2;
    const hAdd = (s.added / maxV) * inner;
    const hUpd = (s.updated / maxV) * inner;
    return `
      <rect x="${x0}" y="${P.t + inner - hAdd}" width="${bw}" height="${hAdd}" fill="var(--added)" rx="1.5" />
      <rect x="${x0 + bw + 2}" y="${P.t + inner - hUpd}" width="${bw}" height="${hUpd}" fill="var(--updated)" rx="1.5" />
    `;
  }).join('');

  const labels = series.map((s, i) => {
    if (i % Math.ceil(days / 6) !== 0 && i !== series.length - 1) return '';
    const d = new Date(s.date);
    const x = P.l + i * cw + cw / 2;
    return `<text class="axis" x="${x}" y="${H - 8}" text-anchor="middle">${d.getMonth() + 1}/${d.getDate()}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
    ${grid}${bars}${labels}
  </svg>`;
}

function renderYearHeatmap(daily: Map<string, DayBucket>): string {
  // GitHub-style: 53 weekly columns, 7 day rows (Sun..Sat). Spans the last ~12 months
  // ending at the current week.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // End at the Saturday of the current week so the last column is complete on the right.
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay()));

  const totalDays = 53 * 7;
  const start = new Date(end);
  start.setDate(end.getDate() - (totalDays - 1));

  // Build per-day data
  const days: { date: Date; key: string; count: number; future: boolean }[] = [];
  let maxA = 0;
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const k = dayKey(d.toISOString());
    const b = daily.get(k);
    const c = b?.activity ?? 0;
    if (c > maxA) maxA = c;
    days.push({ date: d, key: k, count: c, future: d > today });
  }

  const level = (n: number): number => {
    if (n <= 0) return 0;
    if (maxA <= 1) return 4;
    const r = n / maxA;
    if (r > 0.75) return 4;
    if (r > 0.5) return 3;
    if (r > 0.25) return 2;
    return 1;
  };

  const cell = 13, gap = 3;
  const padL = 30, padT = 20, padR = 8, padB = 8;
  const W = padL + 53 * (cell + gap) - gap + padR;
  const H = padT + 7 * (cell + gap) - gap + padB;

  // Day-of-week labels (show every other to match GitHub style: Mon/Wed/Fri)
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dowLabels = dowNames.map((n, i) => {
    const y = padT + i * (cell + gap) + cell - 2;
    return `<text class="axis" x="${padL - 6}" y="${y}" text-anchor="end" font-size="10">${n}</text>`;
  }).join('');

  // Month labels at top: place the label at the column where the month first appears
  // (the first week containing day-of-month <= 7 for a new month).
  const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabelParts: string[] = [];
  let lastMonth = -1;
  for (let week = 0; week < 53; week++) {
    // Use the Sunday (top) cell of this column to determine month
    const dayIdx = week * 7;
    if (dayIdx >= days.length) break;
    const d = days[dayIdx].date;
    const m = d.getMonth();
    if (m !== lastMonth && d.getDate() <= 7) {
      const x = padL + week * (cell + gap);
      monthLabelParts.push(`<text class="axis" x="${x}" y="12" font-size="10">${monthShort[m]}</text>`);
      lastMonth = m;
    }
  }

  let cells = '';
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const week = Math.floor(i / 7);
    const dow = i % 7;
    const x = padL + week * (cell + gap);
    const y = padT + dow * (cell + gap);
    if (d.future) {
      // Skip future cells to keep the grid empty on the right edge
      continue;
    }
    const lvl = level(d.count);
    const fill = HEAT[lvl];
    const stroke = lvl === 0 ? '#d0d7de' : 'transparent';
    cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="1" data-count="${d.count}" data-date="${d.key}"></rect>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${monthLabelParts.join('')}${dowLabels}${cells}</svg>`;
}

function renderDonut(p: Pipe): string {
  const segs = [
    { v: p.draft, c: '#8b949e' },
    { v: p.synced, c: '#58a6ff' },
    { v: p.inProgress, c: '#d29922' },
    { v: p.done, c: '#3fb950' },
    { v: p.failed, c: '#f85149' },
  ];
  const total = segs.reduce((a, s) => a + s.v, 0);
  const cx = 90, cy = 90, r = 70, rInner = 48;

  if (total === 0) {
    return `<svg viewBox="0 0 180 180" role="img">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${r - rInner}" />
      <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="var(--muted)" font-size="12">No tasks yet</text>
    </svg>`;
  }

  let acc = 0;
  const arcs = segs.filter(s => s.v > 0).map(s => {
    const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += s.v;
    const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
    const xi2 = cx + rInner * Math.cos(end), yi2 = cy + rInner * Math.sin(end);
    const xi1 = cx + rInner * Math.cos(start), yi1 = cy + rInner * Math.sin(start);
    return `<path d="M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${xi2},${yi2} A${rInner},${rInner} 0 ${large} 0 ${xi1},${yi1} Z" fill="${s.c}" />`;
  }).join('');

  return `<svg viewBox="0 0 180 180" role="img">
    ${arcs}
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" fill="var(--vscode-foreground)" font-size="22" font-weight="700">${total}</text>
    <text x="${cx}" y="${cy + 16}" text-anchor="middle" fill="var(--muted)" font-size="11">tasks</text>
  </svg>`;
}

function emptyDay(date: string): DayBucket {
  return { date, created: 0, worked: 0, completed: 0, failed: 0, added: 0, updated: 0, hours: 0, tokens: 0, activity: 0 };
}
