export type TodoStatus = 'draft' | 'synced' | 'in-progress' | 'done' | 'failed';
export type AgentType = 'claude-code' | 'copilot' | 'ado-copilot';

export interface TodoEffort {
  total?: number;
  remaining?: number;
  completed?: number;
}

export interface TodoAgentInfo {
  type: AgentType;
  lastRunAt: string;
  lastOutputSnippet?: string;
}

export interface Todo {
  id: string;
  title: string;
  description?: string;
  adoWorkItemId?: number;
  status: TodoStatus;
  effort?: TodoEffort;
  agent?: TodoAgentInfo;
  createdAt: string;
  updatedAt: string;
}

export interface TodoStoreFile {
  version: 1;
  items: Todo[];
}

export interface AdoConfig {
  orgUrl: string;
  project: string;
  defaultWorkItemType?: string;
  areaPath?: string;
  iterationPath?: string;
}

export interface Metrics {
  tasksCreated: number;
  tasksCompleted: number;
  agentRunsTriggered: number;
  totalEstimatedHours: number;
  totalCompletedHours: number;
  hoursSaved: number;
}
