// src/agents/subAgentDiscovery.ts
//
// Cross-platform discovery of provider sub-agents.
//
//   GitHub Copilot agents:
//     - `<repo>/.copilot/agents/*.md`               (repo)
//     - `~/.copilot/agents/*.md`                    (global)
//     - `~/.vscode/extensions/*/<sub>/*.md`         (extension contributions —
//       e.g. Windows AI Studio's `resources/lmt/chatAgents/`, matching what
//       the real VS Code Copilot Agent picker shows)
//
//   Claude agents:
//     - `<repo>/.claude/agents/*.md`                (repo)
//     - `~/.claude/agents/*.md`                     (global)
//
// All file I/O uses Node built-ins so the same code works on Windows, macOS,
// and Linux. Designed to never throw on missing/unreadable dirs — discovery
// failures are silent and just yield an empty list.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentType } from '../types';

export type SubAgentProvider = Extract<AgentType, 'claude-code' | 'copilot'>;
export type SubAgentSource = 'global' | 'repo' | 'extension';

export interface SubAgent {
  provider: SubAgentProvider;
  /** Display name — frontmatter `name:` if present, else filename without `.md`. */
  name: string;
  source: SubAgentSource;
  /** Absolute path of the source markdown file. Useful for tooltips / open. */
  filePath: string;
  /** Optional one-line description from frontmatter `description:`. */
  description?: string;
  /** For `source === 'extension'`, the extension folder name (e.g. `ms-windows-ai-studio…`). */
  extensionId?: string;
}

export interface DiscoverOptions {
  /** Workspace root for repo-scoped agents. Pass `undefined` to skip. */
  workspaceRoot?: string;
  /** Override home dir (mainly for tests). Defaults to `os.homedir()`. */
  homeDir?: string;
  /**
   * Override the VS Code extensions directory.
   * Defaults to `~/.vscode/extensions` (works on Windows, macOS, Linux because
   * VS Code uses the same path under the user home dir on all platforms).
   * Pass `null` to disable extension scanning.
   */
  vscodeExtensionsDir?: string | null;
}

interface ProviderConfig {
  provider: SubAgentProvider;
  /** Folder name under home / repo root (e.g. `.claude`, `.copilot`). */
  rootFolder: string;
  /** Whether to also scan VS Code extension contributions. */
  scanExtensions: boolean;
}

const PROVIDERS: ProviderConfig[] = [
  { provider: 'claude-code', rootFolder: '.claude',  scanExtensions: false },
  { provider: 'copilot',     rootFolder: '.copilot', scanExtensions: true  }
];

// Known extension subpaths that contain chat-agent markdown files. Tried in
// order under each `~/.vscode/extensions/<ext>/` directory. Covers the
// real-world conventions used by Microsoft's first-party extensions:
//   - `resources/lmt/chatAgents/` — Windows AI Studio
//   - `resources/agents/`         — Azure GitHub Copilot, others
//   - `resources/chatAgents/`     — alternate spelling
//   - `chatAgents/` / `agents/`   — community fallbacks
const EXTENSION_AGENT_SUBPATHS: string[][] = [
  ['resources', 'lmt', 'chatAgents'],
  ['resources', 'agents'],
  ['resources', 'chatAgents'],
  ['chatAgents'],
  ['agents']
];

export function discoverSubAgents(opts: DiscoverOptions = {}): SubAgent[] {
  const home = opts.homeDir ?? os.homedir();
  const vscodeExt = opts.vscodeExtensionsDir === null
    ? undefined
    : (opts.vscodeExtensionsDir ?? (home ? path.join(home, '.vscode', 'extensions') : undefined));
  const out: SubAgent[] = [];

  for (const cfg of PROVIDERS) {
    if (home) {
      out.push(...scanAgentsDir(path.join(home, cfg.rootFolder, 'agents'), cfg.provider, 'global'));
    }
    if (opts.workspaceRoot) {
      out.push(...scanAgentsDir(
        path.join(opts.workspaceRoot, cfg.rootFolder, 'agents'),
        cfg.provider,
        'repo'
      ));
    }
    if (cfg.scanExtensions && vscodeExt) {
      out.push(...scanExtensionAgents(vscodeExt, cfg.provider));
    }
  }

  return out;
}

function scanAgentsDir(dir: string, provider: SubAgentProvider, source: SubAgentSource): SubAgent[] {
  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(dir)) return [];
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SubAgent[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.md$/i.test(entry.name)) continue;

    const filePath = path.join(dir, entry.name);
    const fallbackName = entry.name.replace(/\.agent\.md$/i, '').replace(/\.md$/i, '');
    let name = fallbackName;
    let description: string | undefined;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const meta = parseFrontmatter(raw);
      if (meta.name) name = meta.name;
      if (meta.description) description = meta.description;
    } catch {
      // Permission denied / binary file / etc — fall through with filename.
    }

    out.push({ provider, name, source, filePath, description });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function scanExtensionAgents(vscodeExtRoot: string, provider: SubAgentProvider): SubAgent[] {
  let extDirs: fs.Dirent[];
  try {
    if (!fs.existsSync(vscodeExtRoot)) return [];
    extDirs = fs.readdirSync(vscodeExtRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SubAgent[] = [];
  for (const ext of extDirs) {
    if (!ext.isDirectory()) continue;
    for (const sub of EXTENSION_AGENT_SUBPATHS) {
      const dir = path.join(vscodeExtRoot, ext.name, ...sub);
      const found = scanAgentsDir(dir, provider, 'extension');
      for (const a of found) {
        a.extensionId = ext.name;
        out.push(a);
      }
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Minimal YAML-frontmatter extractor: supports `key: value` lines between two
 * `---` delimiters at the top of the file. Strips matched surrounding single
 * or double quotes from the value. No support for block scalars / nested keys
 * — kept tiny on purpose because we only need `name` and `description`.
 */
function parseFrontmatter(content: string): Record<string, string> {
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!kv) continue;
    let value = kv[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === '') continue;
    out[kv[1]] = value;
  }
  return out;
}

