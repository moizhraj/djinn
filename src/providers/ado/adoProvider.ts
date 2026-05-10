import * as vscode from 'vscode';
import * as azdev from 'azure-devops-node-api';
import { JsonPatchDocument } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { WorkspaceConfig } from '../../types';
import { ensurePat } from '../../config/secrets';
import { IssueProvider, CreateIssueInput, UpdateIssueInput, IssueRef } from '../types';

export class AdoProvider implements IssueProvider {
  readonly kind = 'ado' as const;
  readonly canSync = true;
  readonly displayName = 'Azure DevOps';

  private connection?: azdev.WebApi;

  constructor(private cfg: WorkspaceConfig, private secrets: vscode.SecretStorage) {
    if (!cfg.orgUrl || !cfg.project || !cfg.team) {
      throw new Error('ADO provider requires orgUrl, project, and team in workspace config.');
    }
  }

  private effectiveAreaPath(): string {
    return this.cfg.areaPath ?? `${this.cfg.project}\\${this.cfg.team}`;
  }

  async ensureAuth(): Promise<boolean> {
    const pat = await ensurePat(this.secrets, `ado:${this.cfg.orgUrl}`, `Personal Access Token for ${this.cfg.orgUrl} (Work Items: Read & Write)`);
    if (!pat) return false;
    const handler = azdev.getPersonalAccessTokenHandler(pat);
    this.connection = new azdev.WebApi(this.cfg.orgUrl!, handler);
    return true;
  }

  async create(input: CreateIssueInput): Promise<IssueRef> {
    const wit = await this.requireConnection().getWorkItemTrackingApi();
    const ops: Array<{ op: string; path: string; value: unknown }> = [
      { op: 'add', path: '/fields/System.Title', value: input.title }
    ];
    if (input.description) ops.push({ op: 'add', path: '/fields/System.Description', value: input.description });
    ops.push({ op: 'add', path: '/fields/System.AreaPath', value: this.effectiveAreaPath() });
    if (this.cfg.iterationPath) ops.push({ op: 'add', path: '/fields/System.IterationPath', value: this.cfg.iterationPath });
    if (input.effort?.total != null) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: input.effort.total });
    if (input.effort?.remaining != null) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: input.effort.remaining });
    if (input.effort?.completed != null) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: input.effort.completed });

    const type = input.type ?? this.cfg.defaultWorkItemType ?? 'Task';
    const wi = await wit.createWorkItem(
      undefined as unknown as { [key: string]: string },
      ops as unknown as JsonPatchDocument,
      this.cfg.project!,
      type
    );
    if (wi.id == null) throw new Error('ADO did not return a work item id.');
    return { id: String(wi.id), url: this.webUrl(String(wi.id)) };
  }

  async update(input: UpdateIssueInput): Promise<IssueRef> {
    const wit = await this.requireConnection().getWorkItemTrackingApi();
    const ops: Array<{ op: string; path: string; value: unknown }> = [];
    if (input.title) ops.push({ op: 'add', path: '/fields/System.Title', value: input.title });
    if (input.description != null) ops.push({ op: 'add', path: '/fields/System.Description', value: input.description });
    if (input.effort?.total != null) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: input.effort.total });
    if (input.effort?.remaining != null) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: input.effort.remaining });
    if (input.effort?.completed != null) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: input.effort.completed });

    const stateMap: Record<string, string | undefined> = {
      'draft': undefined,
      'synced': 'To Do',
      'in-progress': 'Doing',
      'done': 'Done',
      'failed': undefined
    };
    if (input.status) {
      const state = stateMap[input.status];
      if (state) ops.push({ op: 'add', path: '/fields/System.State', value: state });
    }

    const numId = Number(input.id);
    if (!Number.isFinite(numId)) throw new Error(`Invalid ADO work item id: ${input.id}`);

    await wit.updateWorkItem(
      undefined as unknown as { [key: string]: string },
      ops as unknown as JsonPatchDocument,
      numId,
      this.cfg.project!
    );
    return { id: input.id, url: this.webUrl(input.id) };
  }

  webUrl(id: string): string {
    return `${this.cfg.orgUrl}/${encodeURIComponent(this.cfg.project!)}/_workitems/edit/${id}`;
  }

  private requireConnection(): azdev.WebApi {
    if (!this.connection) throw new Error('ADO provider not authenticated. Call ensureAuth() first.');
    return this.connection;
  }
}
