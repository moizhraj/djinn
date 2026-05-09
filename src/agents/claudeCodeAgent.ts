import * as vscode from 'vscode';
import { exec } from 'child_process';
import { Todo } from '../types';
import { AgentAdapter } from './agentRegistry';
import { TodoStore } from '../store/todoStore';
import { MetricsStore } from '../store/metricsStore';
import { spawnAgentTerminal } from '../util/terminalCapture';
import { buildWorkspaceContext } from './contextBuilder';

export class ClaudeCodeAgent implements AgentAdapter {
  readonly type = 'claude-code' as const;
  readonly label = 'Claude Code (local CLI)';

  constructor(
    private workspaceRoot: vscode.Uri,
    private todos: TodoStore,
    private metrics: MetricsStore
  ) {}

  async isAvailable(): Promise<boolean> {
    const cmd = vscode.workspace.getConfiguration('adoTodos').get<string>('claudeCodeCommand', 'claude');
    return new Promise(resolve => {
      const which = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
      exec(which, err => resolve(!err));
    });
  }

  async run(todo: Todo): Promise<void> {
    const cmd = vscode.workspace.getConfiguration('adoTodos').get<string>('claudeCodeCommand', 'claude');
    const ctx = await buildWorkspaceContext(this.workspaceRoot);
    const prompt = [
      ctx,
      '',
      `Task: ${todo.title}`,
      todo.description ? `Details: ${todo.description}` : ''
    ].filter(Boolean).join('\n');

    const escaped = prompt.replace(/"/g, '\\"');
    const command = `${cmd} "${escaped}"`;

    await this.todos.update(todo.id, {
      status: 'in-progress',
      agent: { type: this.type, lastRunAt: new Date().toISOString(), lastOutputSnippet: prompt.slice(0, 500) }
    });
    await this.metrics.increment('agentRunsTriggered');

    const { done } = spawnAgentTerminal(`Claude Code · ${todo.title}`, this.workspaceRoot, command);
    done.then(async ({ exitCode }) => {
      const status = exitCode === 0 ? 'done' : exitCode === undefined ? 'in-progress' : 'failed';
      await this.todos.update(todo.id, { status });
    });
  }
}
