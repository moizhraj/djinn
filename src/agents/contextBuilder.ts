import * as vscode from 'vscode';
import * as path from 'path';

const MAX_README = 1500;
const MAX_DIRS = 20;

export async function buildWorkspaceContext(root: vscode.Uri): Promise<string> {
  const lines: string[] = [];
  lines.push(`Workspace: ${path.basename(root.fsPath)}`);
  lines.push(`Path: ${root.fsPath}`);

  try {
    const entries = await vscode.workspace.fs.readDirectory(root);
    const dirs = entries
      .filter(([name, kind]) => kind === vscode.FileType.Directory && !name.startsWith('.') && name !== 'node_modules')
      .map(([name]) => name)
      .slice(0, MAX_DIRS);
    if (dirs.length) lines.push(`Top-level dirs: ${dirs.join(', ')}`);

    const manifestNames = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'];
    const found: string[] = [];
    for (const [name, kind] of entries) {
      if (kind === vscode.FileType.File && (manifestNames.includes(name) || name.endsWith('.csproj') || name.endsWith('.sln'))) {
        found.push(name);
      }
    }
    if (found.length) lines.push(`Manifests: ${found.join(', ')}`);

    const readme = entries.find(([name, kind]) => kind === vscode.FileType.File && /^readme(\.md)?$/i.test(name));
    if (readme) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, readme[0]));
        const text = Buffer.from(bytes).toString('utf8').slice(0, MAX_README);
        lines.push(`README excerpt:\n${text}`);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return lines.join('\n');
}
