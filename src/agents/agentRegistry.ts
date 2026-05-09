import * as vscode from 'vscode';
import { AgentType, Todo } from '../types';
import { ClaudeCodeAgent } from './claudeCodeAgent';
import { CopilotAgent } from './copilotAgent';
import { AdoCopilotAgent } from './adoCopilotAgent';
import { AdoConfigStore } from '../config/adoConfig';
import { TodoStore } from '../store/todoStore';
import { MetricsStore } from '../store/metricsStore';

export interface AgentAdapter {
  type: AgentType;
  label: string;
  isAvailable(): Promise<boolean>;
  run(todo: Todo): Promise<void>;
}

export class AgentRegistry {
  private adapters: AgentAdapter[];

  constructor(
    workspaceRoot: vscode.Uri,
    todos: TodoStore,
    metrics: MetricsStore,
    cfgStore: AdoConfigStore,
    secrets: vscode.SecretStorage
  ) {
    this.adapters = [
      new ClaudeCodeAgent(workspaceRoot, todos, metrics),
      new CopilotAgent(workspaceRoot, todos, metrics),
      new AdoCopilotAgent(workspaceRoot, todos, metrics, cfgStore, secrets)
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
}
