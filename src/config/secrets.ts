import * as vscode from 'vscode';

const PAT_KEY_PREFIX = 'adoTodos.pat.';

function key(orgUrl: string): string {
  return PAT_KEY_PREFIX + orgUrl.toLowerCase();
}

export async function getPat(secrets: vscode.SecretStorage, orgUrl: string): Promise<string | undefined> {
  return secrets.get(key(orgUrl));
}

export async function setPat(secrets: vscode.SecretStorage, orgUrl: string, pat: string): Promise<void> {
  await secrets.store(key(orgUrl), pat);
}

export async function clearPat(secrets: vscode.SecretStorage, orgUrl: string): Promise<void> {
  await secrets.delete(key(orgUrl));
}

export async function ensurePat(secrets: vscode.SecretStorage, orgUrl: string): Promise<string | undefined> {
  const existing = await getPat(secrets, orgUrl);
  if (existing) return existing;
  const pat = await vscode.window.showInputBox({
    prompt: `Personal Access Token for ${orgUrl} (Work Items: Read & Write)`,
    password: true,
    ignoreFocusOut: true
  });
  if (!pat) return undefined;
  await setPat(secrets, orgUrl, pat);
  return pat;
}
