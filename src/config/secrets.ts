import * as vscode from 'vscode';

const PREFIX = 'todoSync.secret.';

function fullKey(key: string): string {
  return PREFIX + key.toLowerCase();
}

export async function getSecret(secrets: vscode.SecretStorage, key: string): Promise<string | undefined> {
  return secrets.get(fullKey(key));
}

export async function setSecret(secrets: vscode.SecretStorage, key: string, value: string): Promise<void> {
  await secrets.store(fullKey(key), value);
}

export async function clearSecret(secrets: vscode.SecretStorage, key: string): Promise<void> {
  await secrets.delete(fullKey(key));
}

/**
 * Get a PAT-style secret, prompting the user if missing.
 * `key` is a stable identifier, e.g. `ado:https://dev.azure.com/foo` or `gitlab:gitlab.com`.
 */
export async function ensurePat(secrets: vscode.SecretStorage, key: string, prompt: string): Promise<string | undefined> {
  const existing = await getSecret(secrets, key);
  if (existing) return existing;
  const pat = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
  if (!pat) return undefined;
  await setSecret(secrets, key, pat);
  return pat;
}
