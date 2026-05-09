import * as azdev from 'azure-devops-node-api';
import { JsonPatchDocument } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { WorkItem } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import { AdoConfig } from '../types';

export interface CreateTaskInput {
  title: string;
  description?: string;
  totalEffort?: number;
  remainingEffort?: number;
  completedEffort?: number;
  workItemType?: string;
}

export interface UpdateTaskInput {
  id: number;
  title?: string;
  description?: string;
  totalEffort?: number;
  remainingEffort?: number;
  completedEffort?: number;
  state?: string;
}

export class AdoClient {
  private connection: azdev.WebApi;

  constructor(private config: AdoConfig, pat: string) {
    const authHandler = azdev.getPersonalAccessTokenHandler(pat);
    this.connection = new azdev.WebApi(config.orgUrl, authHandler);
  }

  async createTask(input: CreateTaskInput): Promise<WorkItem> {
    const wit = await this.connection.getWorkItemTrackingApi();
    const ops: JsonPatchDocument = [
      { op: 'add', path: '/fields/System.Title', value: input.title }
    ] as unknown as JsonPatchDocument;

    const push = (path: string, value: unknown) =>
      (ops as unknown as Array<{ op: string; path: string; value: unknown }>).push({ op: 'add', path, value });

    if (input.description) push('/fields/System.Description', input.description);
    if (this.config.areaPath) push('/fields/System.AreaPath', this.config.areaPath);
    if (this.config.iterationPath) push('/fields/System.IterationPath', this.config.iterationPath);
    if (input.totalEffort != null) push('/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', input.totalEffort);
    if (input.remainingEffort != null) push('/fields/Microsoft.VSTS.Scheduling.RemainingWork', input.remainingEffort);
    if (input.completedEffort != null) push('/fields/Microsoft.VSTS.Scheduling.CompletedWork', input.completedEffort);

    const type = input.workItemType ?? this.config.defaultWorkItemType ?? 'Task';
    return wit.createWorkItem(undefined as unknown as { [key: string]: string }, ops, this.config.project, type);
  }

  async updateTask(input: UpdateTaskInput): Promise<WorkItem> {
    const wit = await this.connection.getWorkItemTrackingApi();
    const ops: Array<{ op: string; path: string; value: unknown }> = [];
    if (input.title) ops.push({ op: 'add', path: '/fields/System.Title', value: input.title });
    if (input.description != null) ops.push({ op: 'add', path: '/fields/System.Description', value: input.description });
    if (input.totalEffort != null) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: input.totalEffort });
    if (input.remainingEffort != null) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: input.remainingEffort });
    if (input.completedEffort != null) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: input.completedEffort });
    if (input.state) ops.push({ op: 'add', path: '/fields/System.State', value: input.state });

    return wit.updateWorkItem(
      undefined as unknown as { [key: string]: string },
      ops as unknown as JsonPatchDocument,
      input.id,
      this.config.project
    );
  }

  async getTask(id: number): Promise<WorkItem | undefined> {
    const wit = await this.connection.getWorkItemTrackingApi();
    try {
      return await wit.getWorkItem(id);
    } catch {
      return undefined;
    }
  }
}
