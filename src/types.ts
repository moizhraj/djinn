export type TodoStatus = 'draft' | 'synced' | 'in-progress' | 'done' | 'failed';
export type AgentType = 'claude-code' | 'copilot' | 'open-issue';
export type ProviderKind = 'ado' | 'github' | 'gitlab' | 'local';

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

export interface AgentOptionChoice {
  value: string;
  label?: string;
}

export interface AgentOptionField {
  key: string;
  label: string;
  type: 'select' | 'text';
  choices?: AgentOptionChoice[];
  default?: string;
  description?: string;
}

export interface TodoAgentOptions {
  selected?: AgentType;
  byAgent?: Partial<Record<AgentType, Record<string, string>>>;
}

export interface Todo {
  id: string;
  title: string;
  description?: string;
  /** @deprecated kept for one release for migration; use remoteId + remoteProvider. */
  adoWorkItemId?: number;
  remoteId?: string;
  remoteProvider?: ProviderKind;
  remoteUrl?: string;
  status: TodoStatus;
  effort?: TodoEffort;
  tokensUsed?: number;
  agent?: TodoAgentInfo;
  agentOptions?: TodoAgentOptions;
  /** Set once the todo's estimated effort has been added to totalEstimatedHours. */
  effortCounted?: boolean;
  /** Set once the todo's completion has been added to tasksCompleted/totalCompletedHours. */
  completionCounted?: boolean;
  /** Milliseconds from agent run start to completion, set automatically on finish. */
  agentDurationMs?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface TodoStoreFile {
  version: 1;
  items: Todo[];
}

export interface WorkspaceConfig {
  provider: ProviderKind;
  // ADO
  orgUrl?: string;
  project?: string;
  team?: string;
  defaultWorkItemType?: string;
  areaPath?: string;
  iterationPath?: string;
  // GitHub
  owner?: string;
  repo?: string;
  // GitLab
  host?: string;
  projectPath?: string;
}

export interface Metrics {
  tasksCreated: number;
  tasksCompleted: number;
  agentRunsTriggered: number;
  totalEstimatedHours: number;
  totalCompletedHours: number;
  hoursSaved: number;
  totalTokensUsed: number;
}
