import * as vscode from 'vscode';
import { AdoConfig } from '../types';
import { detectAdoFromGit } from '../util/gitRemote';

const FILE_REL = '.ado/config.json';

export class AdoConfigStore {
  constructor(private workspaceRoot: vscode.Uri) {}

  private fileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.workspaceRoot, '.ado', 'config.json');
  }

  async load(): Promise<AdoConfig | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri());
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as AdoConfig;
    } catch {
      return undefined;
    }
  }

  async save(cfg: AdoConfig): Promise<void> {
    const folder = vscode.Uri.joinPath(this.workspaceRoot, '.ado');
    try {
      await vscode.workspace.fs.createDirectory(folder);
    } catch {
      // ignore
    }
    await vscode.workspace.fs.writeFile(
      this.fileUri(),
      Buffer.from(JSON.stringify(cfg, null, 2), 'utf8')
    );
  }

  /** Load config; if missing, try git remote detection then prompt for missing pieces. */
  async ensure(): Promise<AdoConfig | undefined> {
    const existing = await this.load();
    if (existing && existing.orgUrl && existing.project) return existing;

    let detected = await detectAdoFromGit(this.workspaceRoot.fsPath);
    let orgUrl = existing?.orgUrl ?? detected?.orgUrl;
    let project = existing?.project ?? detected?.project;

    if (!orgUrl) {
      orgUrl = await vscode.window.showInputBox({
        prompt: 'Azure DevOps organization URL',
        placeHolder: 'https://dev.azure.com/your-org',
        ignoreFocusOut: true
      });
      if (!orgUrl) return undefined;
    }

    if (!project) {
      project = await vscode.window.showInputBox({
        prompt: 'Azure DevOps project name',
        ignoreFocusOut: true
      });
      if (!project) return undefined;
    }

    const cfg: AdoConfig = {
      orgUrl: orgUrl.replace(/\/$/, ''),
      project,
      defaultWorkItemType: existing?.defaultWorkItemType ?? 'Task',
      areaPath: existing?.areaPath,
      iterationPath: existing?.iterationPath
    };
    await this.save(cfg);
    return cfg;
  }
}
