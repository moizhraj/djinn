import * as vscode from 'vscode';

const HOOK_MARKER = 'DJINN_DONE_FILE';
const HOOK_COMMAND =
  'node -e "var f=process.env.DJINN_DONE_FILE;if(f){var fs=require(\'fs\'),p=require(\'path\');fs.mkdirSync(p.dirname(f),{recursive:true});fs.closeSync(fs.openSync(f,\'a\'))}"';

/**
 * Ensures the project's `.claude/settings.json` has a Stop hook that touches
 * the file at $DJINN_DONE_FILE. The hook is a no-op when the env var is
 * absent, so it doesn't affect users running `claude` outside the extension.
 * Idempotent — re-runs detect the existing entry by its $DJINN_DONE_FILE
 * reference and leave the file alone.
 */
export async function ensureDjinnStopHook(workspaceRoot: vscode.Uri): Promise<void> {
  const settingsUri = vscode.Uri.joinPath(workspaceRoot, '.claude', 'settings.json');
  let json: Record<string, unknown> = {};
  try {
    const buf = await vscode.workspace.fs.readFile(settingsUri);
    json = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    // File missing or unparseable — start fresh.
  }

  const hooks = (json.hooks ??= {}) as Record<string, unknown>;
  const stop = Array.isArray(hooks.Stop) ? (hooks.Stop as Array<Record<string, unknown>>) : [];
  hooks.Stop = stop;

  const present = stop.some(entry => {
    const inner = Array.isArray(entry?.hooks) ? (entry.hooks as Array<Record<string, unknown>>) : [];
    return inner.some(h => typeof h?.command === 'string' && (h.command as string).includes(HOOK_MARKER));
  });
  if (present) return;

  stop.push({ matcher: '', hooks: [{ type: 'command', command: HOOK_COMMAND }] });

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot, '.claude'));
  const out = JSON.stringify(json, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(settingsUri, new TextEncoder().encode(out));
}

export function sentinelUri(workspaceRoot: vscode.Uri, runId: string): vscode.Uri {
  return vscode.Uri.joinPath(workspaceRoot, '.djinn', 'completion', `${runId}.done`);
}
