import * as vscode from 'vscode';
import { Gitlab } from '@gitbeaker/rest';
import { TodoEffort, WorkspaceConfig } from '../../types';
import { ensurePat } from '../../config/secrets';
import { IssueProvider, CreateIssueInput, UpdateIssueInput, IssueRef } from '../types';

type GitlabApi = InstanceType<typeof Gitlab>;

export class GitLabProvider implements IssueProvider {
  readonly kind = 'gitlab' as const;
  readonly canSync = true;
  readonly displayName = 'GitLab';

  private api?: GitlabApi;

  constructor(private cfg: WorkspaceConfig, private secrets: vscode.SecretStorage) {
    if (!cfg.host || !cfg.projectPath) throw new Error('GitLab provider requires host and projectPath.');
  }

  async ensureAuth(): Promise<boolean> {
    const pat = await ensurePat(
      this.secrets,
      `gitlab:${this.cfg.host}`,
      `Personal Access Token for ${this.cfg.host} (scope: api)`
    );
    if (!pat) return false;
    this.api = new Gitlab({ host: `https://${this.cfg.host}`, token: pat });
    return true;
  }

  async create(input: CreateIssueInput): Promise<IssueRef> {
    const api = this.requireApi();
    const issue = await api.Issues.create(this.cfg.projectPath!, input.title, {
      description: input.description
    });
    const iid = String((issue as { iid: number }).iid);
    if (input.effort) await this.applyEffort(iid, input.effort, undefined);
    const url = (issue as { web_url?: string }).web_url ?? this.webUrl(iid);
    return { id: iid, url };
  }

  async update(input: UpdateIssueInput): Promise<IssueRef> {
    const api = this.requireApi();
    const iid = Number(input.id);
    if (!Number.isFinite(iid)) throw new Error(`Invalid GitLab issue iid: ${input.id}`);

    const editOpts: Record<string, unknown> = {};
    if (input.title) editOpts.title = input.title;
    if (input.description != null) editOpts.description = input.description;
    if (input.status === 'done') editOpts.stateEvent = 'close';
    else if (input.status) editOpts.stateEvent = 'reopen';

    const issue = await api.Issues.edit(this.cfg.projectPath!, iid, editOpts);

    if (input.effort) {
      const current = await api.Issues.show(iid, { projectId: this.cfg.projectPath });
      const stats = (current as { time_stats?: { time_estimate?: number; total_time_spent?: number } }).time_stats;
      await this.applyEffort(input.id, input.effort, stats);
    }

    const url = (issue as { web_url?: string }).web_url ?? this.webUrl(input.id);
    return { id: input.id, url };
  }

  webUrl(id: string): string {
    return `https://${this.cfg.host}/${this.cfg.projectPath}/-/issues/${id}`;
  }

  private async applyEffort(
    iid: string,
    effort: TodoEffort,
    currentStats: { time_estimate?: number; total_time_spent?: number } | undefined
  ): Promise<void> {
    const api = this.requireApi();
    const num = Number(iid);
    try {
      if (effort.total != null) {
        await api.Issues.addTimeEstimate(this.cfg.projectPath!, num, `${effort.total}h`);
      }
      const desiredSpent = (effort.completed ?? 0) * 3600;
      const currentSpent = currentStats?.total_time_spent ?? 0;
      const delta = desiredSpent - currentSpent;
      if (Math.abs(delta) >= 60) {
        const hours = (delta / 3600).toFixed(2);
        await api.Issues.addSpentTime(this.cfg.projectPath!, num, `${hours}h`);
      }
    } catch {
      // best-effort; surface failures elsewhere
    }
  }

  private requireApi(): GitlabApi {
    if (!this.api) throw new Error('GitLab provider not authenticated.');
    return this.api;
  }
}
