import * as vscode from 'vscode';
import { ProviderKind, WorkspaceConfig } from '../types';
import { detectFromGit, providerKindOf } from '../util/gitRemote';

const FILE_REL = '.todos/config.json';

export class WorkspaceConfigStore {
  constructor(private workspaceRoot: vscode.Uri) {}

  private fileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.workspaceRoot, '.todos', 'config.json');
  }

  async load(): Promise<WorkspaceConfig | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri());
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as WorkspaceConfig;
    } catch {
      return undefined;
    }
  }

  async save(cfg: WorkspaceConfig): Promise<void> {
    const folder = vscode.Uri.joinPath(this.workspaceRoot, '.todos');
    try { await vscode.workspace.fs.createDirectory(folder); } catch { /* ignore */ }
    await vscode.workspace.fs.writeFile(this.fileUri(), Buffer.from(JSON.stringify(cfg, null, 2), 'utf8'));
  }

  /** Load config; if missing, auto-detect from git remote, then prompt for missing pieces. */
  /**
   * Non-interactive: load existing config, else infer fully from `origin`,
   * else default to local-only. Always returns a WorkspaceConfig (saves it).
   * Never prompts the user.
   */
  async detect(): Promise<WorkspaceConfig> {
    const existing = await this.load();
    if (existing && this.isComplete(existing)) return existing;

    const remote = await detectFromGit(this.workspaceRoot.fsPath);
    let cfg: WorkspaceConfig;
    if (remote?.kind === 'ado') {
      cfg = {
        ...(existing ?? {}),
        provider: 'ado',
        orgUrl: remote.orgUrl,
        project: remote.project,
        defaultWorkItemType: existing?.defaultWorkItemType ?? 'Task'
      };
    } else if (remote?.kind === 'github') {
      cfg = { ...(existing ?? {}), provider: 'github', owner: remote.owner, repo: remote.repo };
    } else if (remote?.kind === 'gitlab') {
      cfg = { ...(existing ?? {}), provider: 'gitlab', host: remote.host, projectPath: remote.projectPath };
    } else {
      cfg = { ...(existing ?? {}), provider: 'local' };
    }
    await this.save(cfg);
    return cfg;
  }

  async ensure(): Promise<WorkspaceConfig | undefined> {
    const existing = await this.load();
    if (existing && this.isComplete(existing)) return existing;

    const detected = await detectFromGit(this.workspaceRoot.fsPath);
    let provider: ProviderKind | undefined = existing?.provider ?? (detected ? providerKindOf(detected) : undefined);

    if (!provider) {
      const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { id: ProviderKind }>(
        [
          { label: 'Azure DevOps', id: 'ado' },
          { label: 'GitHub Issues', id: 'github' },
          { label: 'GitLab Issues', id: 'gitlab' },
          { label: 'Local-only (no remote sync)', id: 'local' }
        ],
        { placeHolder: 'No remote detected. Choose a sync provider.' }
      );
      if (!pick) return undefined;
      provider = pick.id;
    }

    const cfg: WorkspaceConfig = { ...(existing ?? {}), provider };

    if (provider === 'ado') {
      cfg.orgUrl = cfg.orgUrl ?? (detected?.kind === 'ado' ? detected.orgUrl : undefined)
        ?? (await vscode.window.showInputBox({ prompt: 'ADO organization URL', placeHolder: 'https://dev.azure.com/your-org', ignoreFocusOut: true }))?.replace(/\/$/, '');
      if (!cfg.orgUrl) return undefined;
      cfg.project = cfg.project ?? (detected?.kind === 'ado' ? detected.project : undefined)
        ?? (await vscode.window.showInputBox({ prompt: 'ADO project name', ignoreFocusOut: true }));
      if (!cfg.project) return undefined;
      cfg.team = cfg.team
        ?? (await vscode.window.showInputBox({ prompt: 'ADO team name', placeHolder: 'e.g. My Team', ignoreFocusOut: true }));
      if (!cfg.team) return undefined;
      cfg.defaultWorkItemType = cfg.defaultWorkItemType ?? 'Task';
    } else if (provider === 'github') {
      cfg.owner = cfg.owner ?? (detected?.kind === 'github' ? detected.owner : undefined)
        ?? (await vscode.window.showInputBox({ prompt: 'GitHub owner (user or org)', ignoreFocusOut: true }));
      if (!cfg.owner) return undefined;
      cfg.repo = cfg.repo ?? (detected?.kind === 'github' ? detected.repo : undefined)
        ?? (await vscode.window.showInputBox({ prompt: 'GitHub repository name', ignoreFocusOut: true }));
      if (!cfg.repo) return undefined;
    } else if (provider === 'gitlab') {
      cfg.host = cfg.host ?? (detected?.kind === 'gitlab' ? detected.host : undefined)
        ?? (await vscode.window.showInputBox({ prompt: 'GitLab host', placeHolder: 'gitlab.com', ignoreFocusOut: true })) ?? 'gitlab.com';
      cfg.projectPath = cfg.projectPath ?? (detected?.kind === 'gitlab' ? detected.projectPath : undefined)
        ?? (await vscode.window.showInputBox({ prompt: 'GitLab project path', placeHolder: 'group/subgroup/repo', ignoreFocusOut: true }));
      if (!cfg.projectPath) return undefined;
    }

    await this.save(cfg);
    return cfg;
  }

  private isComplete(cfg: WorkspaceConfig): boolean {
    switch (cfg.provider) {
      case 'ado': return !!cfg.orgUrl && !!cfg.project && !!cfg.team;
      case 'github': return !!cfg.owner && !!cfg.repo;
      case 'gitlab': return !!cfg.host && !!cfg.projectPath;
      case 'local': return true;
    }
  }
}
