// scripts/preview-server.mjs
//
// Tiny dev preview for the todo editor webview. Renders the same HTML the
// real WebviewPanel renders, but in a regular browser, so you don't have to
// re-install the extension after every UI tweak.
//
// Workflow:
//   Terminal 1:  npm run watch       (tsc --watch -p ./)
//   Terminal 2:  npm run preview     (this script)
//   Browser:     http://localhost:5173
//
// Each request re-loads the compiled view module from `out/`, so just hit
// refresh after the TypeScript compiler finishes a rebuild.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PORT = Number(process.env.PORT) || 5173;
const VIEW_PATH = path.resolve(__dirname, '..', 'out', 'ui', 'todoEditorView.js');

// ── Sample data — mirrors the real agents' option schemas ────────────────
const sampleAgents = [
  {
    type: 'copilot',
    label: 'GitHub Copilot',
    schema: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        default: 'agent',
        choices: [
          { value: 'agent', label: 'Agent' },
          { value: 'ask',   label: 'Ask'   },
          { value: 'plan',  label: 'Plan'  }
        ]
      },
      {
        key: 'model',
        label: 'Model',
        type: 'select',
        default: '',
        choices: [
          { value: '',                  label: 'Auto' },
          { value: 'gpt-4o',            label: 'GPT-4o' },
          { value: 'gpt-4.1',           label: 'GPT-4.1' },
          { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
          { value: 'o3',                label: 'o3' }
        ]
      }
    ]
  },
  {
    type: 'claude-code',
    label: 'Claude',
    schema: [
      {
        key: 'model',
        label: 'Model',
        type: 'select',
        default: 'auto',
        choices: [
          { value: 'auto',              label: 'Auto'              },
          { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
          { value: 'claude-opus-4-7',   label: 'Claude Opus 4.7'   },
          { value: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5'  }
        ]
      },
      {
        key: 'reasoning',
        label: 'Reasoning',
        type: 'select',
        default: 'none',
        choices: [
          { value: 'none',       label: 'None'       },
          { value: 'think',      label: 'Think'      },
          { value: 'think-hard', label: 'Think hard' },
          { value: 'ultrathink', label: 'Ultrathink' }
        ]
      },
      {
        key: 'approvals',
        label: 'Approvals',
        type: 'select',
        default: 'default',
        choices: [
          { value: 'default',           label: 'Default (prompt per tool)' },
          { value: 'acceptEdits',       label: 'Accept edits' },
          { value: 'plan',              label: 'Plan only' },
          { value: 'bypassPermissions', label: 'Bypass (yolo)' }
        ]
      }
    ]
  },
  { type: 'open-issue', label: 'Cloud', schema: [] }
];

const sampleTodo = {
  id: 'preview-1',
  title: 'Wire up provider picker',
  description:
    'Make sure the Provider dropdown shows GitHub Copilot / Claude / Cloud with the\n' +
    'right icons and a chat-style popup. The Agent chip below should list sub-agents\n' +
    'discovered from .claude/agents/ (or .copilot/agents/) under the repo + home dir.',
  status: 'in-progress',
  effort: { total: 2.5 },
  agentDurationMs: 47000,
  remoteId: '123',
  remoteUrl: 'https://github.com/example/repo/issues/123',
  remoteProvider: 'github',
  agentOptions: { selected: 'copilot' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

// A small list of additional sample todos so the in-panel list section has
// something to render in the browser preview.
const sampleTodoList = [
  sampleTodo,
  {
    id: 'preview-2',
    title: 'Fix dropdown z-index regression',
    status: 'draft',
    effort: { total: 0.5 },
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString()
  },
  {
    id: 'preview-3',
    title: 'Add Approvals chip to Claude provider',
    status: 'done',
    effort: { total: 1.5 },
    completedAt: new Date(Date.now() - 3600000).toISOString(),
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 3600000).toISOString()
  },
  {
    id: 'preview-4',
    title: 'Investigate failing extension test on macOS',
    status: 'failed',
    remoteId: '142',
    remoteProvider: 'github',
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 86400000).toISOString()
  }
];

// Discover real sub-agents from the user's home dir + this repo, so the
// Agent picker shows actual files. Loaded from the same compiled module the
// real panel uses, so behavior matches 1:1.
function loadDiscoverSubAgents() {
  const p = path.resolve(__dirname, '..', 'out', 'agents', 'subAgentDiscovery.js');
  delete require.cache[require.resolve(p)];
  return require(p).discoverSubAgents;
}

// ── Browser shim: provide VS Code CSS variables + acquireVsCodeApi stub ──
const VSCODE_VAR_DEFAULTS = `
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif;
  --vscode-editor-font-family: "Cascadia Code", Consolas, "Courier New", monospace;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #a0a0a0;
  --vscode-editor-background: #1e1e1e;
  --vscode-editorWidget-background: #252526;
  --vscode-editorWidget-border: #454545;
  --vscode-panel-border: #2b2b2b;
  --vscode-widget-border: #454545;
  --vscode-input-background: #3c3c3c;
  --vscode-input-border: #3c3c3c;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-focusBorder: #007fd4;
  --vscode-textLink-foreground: #3794ff;
  --vscode-menu-background: #252526;
  --vscode-menu-foreground: #cccccc;
  --vscode-menu-border: #454545;
  --vscode-menu-selectionBackground: #094771;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-menu-separatorBackground: #404040;
`;

const PREVIEW_SHIM = `
<style id="preview-vscode-defaults">:root, body { ${VSCODE_VAR_DEFAULTS} }</style>
<script id="preview-api-shim">
  // Stand-in for the VS Code webview API so the panel's inline JS doesn't crash.
  window.acquireVsCodeApi = () => ({
    postMessage: (msg) => console.log('[postMessage]', msg),
    setState:    (s)   => { window.__previewState = s; },
    getState:    ()    => window.__previewState ?? null
  });
</script>
<style>
  /* Tiny preview banner so it's clear this isn't the real VS Code. */
  body::before {
    content: "Preview · localhost — refresh after tsc rebuilds";
    position: fixed; top: 0; left: 0; right: 0;
    background: #094771; color: #fff;
    font: 11px/24px -apple-system, "Segoe UI", sans-serif;
    text-align: center;
    z-index: 9999;
    height: 24px;
  }
  body { padding-top: 24px; }
</style>
`;

function injectShim(html) {
  // Inject right after <head>, before any of the panel's own <style>.
  const headIdx = html.indexOf('<head>');
  if (headIdx === -1) return PREVIEW_SHIM + html;
  const cut = headIdx + '<head>'.length;
  return html.slice(0, cut) + PREVIEW_SHIM + html.slice(cut);
}

function loadView() {
  if (!fs.existsSync(VIEW_PATH)) {
    throw new Error(
      `Compiled view not found at ${VIEW_PATH}. Run \`npm run compile\` (or \`npm run watch\`) first.`
    );
  }
  // Bust require cache so the next request picks up the latest tsc output.
  delete require.cache[require.resolve(VIEW_PATH)];
  return require(VIEW_PATH).renderTodoEditorHtml;
}

const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  // Parse `?mode=create` so you can preview both layouts side by side.
  // Anything else (including the default `/`) renders edit mode.
  let mode = 'edit';
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('mode') === 'create') mode = 'create';
  } catch {
    // ignore malformed URLs
  }
  try {
    const renderTodoEditorHtml = loadView();
    const discoverSubAgents = loadDiscoverSubAgents();
    const subAgents = discoverSubAgents({
      workspaceRoot: path.resolve(__dirname, '..')
    });
    // For Create mode, render with a blank stub so you see the empty form.
    const todo = mode === 'create'
      ? {
          id: '',
          title: '',
          status: 'draft',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      : sampleTodo;
    const html = renderTodoEditorHtml({
      todo,
      agents: sampleAgents,
      defaultAgentType: 'copilot',
      subAgents,
      mode,
      todos: mode === 'create' ? sampleTodoList : sampleTodoList,
      currentTodoId: mode === 'create' ? '' : sampleTodo.id
    });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(injectShim(html));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Preview render failed:\n\n${err && err.stack ? err.stack : String(err)}`);
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`\n  Djinn editor preview → http://localhost:${PORT}\n`);
  console.log(`  Refresh the browser after tsc rebuilds.`);
  console.log(`  Form actions log to the browser devtools console (no real save/run).\n`);
});
