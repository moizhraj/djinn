import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Todo } from '../types';

const pexec = promisify(exec);

/**
 * Estimate "Total Effort" hours for a todo. Tries the configured Claude Code CLI
 * first if available; otherwise falls back to a length-and-keyword heuristic.
 */
export class EffortEstimator {
  constructor(private workspaceRoot: vscode.Uri) {}

  async estimate(todo: Todo): Promise<number> {
    const claudeCmd = vscode.workspace.getConfiguration('djinn').get<string>('claudeCodeCommand', 'claude');
    const viaAgent = await this.estimateWithClaudeCode(todo, claudeCmd);
    if (viaAgent != null) return viaAgent;
    return this.heuristic(todo);
  }

  private async estimateWithClaudeCode(todo: Todo, cmd: string): Promise<number | undefined> {
    const prompt = [
      'You are estimating the total time a human engineer spends to complete a task with the help of an AI coding agent.',
      'Account for the full workflow: (1) writing the task title and description, (2) initiating the agent run, (3) reviewing agent progress and providing guidance, (4) validating and testing the completed work.',
      'Reply with ONLY a number of hours (integer or one decimal place). No units, no explanation.',
      `Title: ${todo.title}`,
      todo.description ? `Description: ${todo.description}` : ''
    ].filter(Boolean).join('\n');

    try {
      const { stdout } = await pexec(`${cmd} -p ${JSON.stringify(prompt)}`, {
        cwd: this.workspaceRoot.fsPath,
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      });
      const match = stdout.match(/(\d+(?:\.\d+)?)/);
      if (!match) return undefined;
      const n = parseFloat(match[1]);
      if (!isFinite(n) || n <= 0 || n > 200) return undefined;
      return n;
    } catch {
      return undefined;
    }
  }

  private heuristic(todo: Todo): number {
    let hours = 1;
    const len = todo.title.length;
    if (len > 60) hours += 1;
    if (todo.description) hours += 2;
    const blob = `${todo.title} ${todo.description ?? ''}`.toLowerCase();
    if (/(refactor|migrate|rewrite|redesign)/.test(blob)) hours += 4;
    if (/(investigate|research|spike)/.test(blob)) hours += 2;
    if (/(typo|rename|tweak|small)/.test(blob)) hours = Math.max(0.5, hours - 1);
    return hours;
  }
}
