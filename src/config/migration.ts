import * as vscode from 'vscode';
import { TodoStoreFile } from '../types';

/**
 * One-shot migration from `.ado/` (legacy) to `.todos/`.
 *
 * - Renames the directory if `.ado/` exists and `.todos/` does not.
 * - Walks `.todos/todos.json` and copies any `adoWorkItemId` into the new
 *   `remoteId` + `remoteProvider: 'ado'` fields, preserving the legacy field
 *   for one release in case the user rolls back.
 */
export async function migrate(workspaceRoot: vscode.Uri): Promise<void> {
  const adoDir = vscode.Uri.joinPath(workspaceRoot, '.ado');
  const todosDir = vscode.Uri.joinPath(workspaceRoot, '.todos');

  const adoExists = await exists(adoDir);
  const todosExists = await exists(todosDir);

  if (adoExists && !todosExists) {
    try {
      await vscode.workspace.fs.rename(adoDir, todosDir);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showWarningMessage(`Could not rename .ado to .todos: ${msg}`);
      return;
    }
  }

  // Migrate todo records.
  const todosJson = vscode.Uri.joinPath(todosDir, 'todos.json');
  try {
    const bytes = await vscode.workspace.fs.readFile(todosJson);
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as TodoStoreFile;
    let mutated = false;
    for (const t of parsed.items ?? []) {
      if (t.adoWorkItemId != null && !t.remoteId) {
        t.remoteId = String(t.adoWorkItemId);
        t.remoteProvider = 'ado';
        mutated = true;
      }
    }
    if (mutated) {
      await vscode.workspace.fs.writeFile(todosJson, Buffer.from(JSON.stringify(parsed, null, 2), 'utf8'));
    }
  } catch {
    // todos.json may not exist yet; that's fine
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
