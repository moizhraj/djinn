import * as vscode from 'vscode';
import { ProviderKind, WorkspaceConfig } from '../types';
import { IssueProvider } from './types';
import { AdoProvider } from './ado/adoProvider';
import { GitHubProvider } from './github/githubProvider';
import { GitLabProvider } from './gitlab/gitlabProvider';
import { LocalProvider } from './local/localProvider';

export function createProvider(cfg: WorkspaceConfig, secrets: vscode.SecretStorage): IssueProvider {
  const kind: ProviderKind = cfg.provider;
  switch (kind) {
    case 'ado': return new AdoProvider(cfg, secrets);
    case 'github': return new GitHubProvider(cfg);
    case 'gitlab': return new GitLabProvider(cfg, secrets);
    case 'local': return new LocalProvider();
  }
}
