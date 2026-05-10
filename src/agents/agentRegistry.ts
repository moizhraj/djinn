import * as vscode from 'vscode';
import { AgentOptionField, AgentType, Todo } from '../types';
import { ClaudeCodeAgent } from './claudeCodeAgent';
import { CopilotAgent } from './copilotAgent';
import { OpenIssueAgent } from './openIssueAgent';
import { WorkspaceConfigStore } from '../config/workspaceConfig';
import { TodoStore } from '../store/todoStore';
import { MetricsStore } from '../store/metricsStore';

export interface AgentAdapter {
  type: AgentType;
  label: string;
  isAvailable(): Promise<boolean>;
  optionsSchema(): AgentOptionField[];
  run(todo: Todo, options?: Record<string, string>): Promise<void>;
}

export interface AgentDescriptor {
  type: AgentType;
  label: string;
  schema: AgentOptionField[];
}

export class AgentRegistry {
  private adapters: AgentAdapter[];

  constructor(
    workspaceRoot: vscode.Uri,
    todos: TodoStore,
    metrics: MetricsStore,
    cfgStore: WorkspaceConfigStore,
    _secrets: vscode.SecretStorage
  ) {
    this.adapters = [
      new ClaudeCodeAgent(workspaceRoot, todos, metrics),
      new CopilotAgent(workspaceRoot, todos, metrics),
      new OpenIssueAgent(todos, metrics, cfgStore)
    ];
  }

  async listAvailable(): Promise<AgentAdapter[]> {
    const out: AgentAdapter[] = [];
    for (const a of this.adapters) {
      if (await a.isAvailable()) out.push(a);
    }
    return out;
  }

  get(type: AgentType): AgentAdapter | undefined {
    return this.adapters.find(a => a.type === type);
  }

  list(): AgentAdapter[] {
    return [...this.adapters];
  }

  describe(): AgentDescriptor[] {
    return this.adapters.map(a => ({ type: a.type, label: a.label, schema: a.optionsSchema() }));
  }
}
