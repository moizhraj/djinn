import * as vscode from 'vscode';
import { Metrics } from '../types';

const FILE_REL = '.todos/metrics.json';

const empty = (): Metrics => ({
  tasksCreated: 0,
  tasksCompleted: 0,
  agentRunsTriggered: 0,
  totalEstimatedHours: 0,
  totalCompletedHours: 0,
  hoursSaved: 0,
  totalTokensUsed: 0
});

export class MetricsStore {
  private cache: Metrics = empty();

  constructor(private workspaceRoot: vscode.Uri) {}

  private fileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.workspaceRoot, '.todos', 'metrics.json');
  }

  async load(): Promise<Metrics> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri());
      this.cache = { ...empty(), ...JSON.parse(Buffer.from(bytes).toString('utf8')) };
    } catch {
      this.cache = empty();
    }
    return this.cache;
  }

  get(): Metrics {
    return { ...this.cache };
  }

  async update(patch: Partial<Metrics>): Promise<Metrics> {
    this.cache = { ...this.cache, ...patch };
    await this.save();
    return this.get();
  }

  async increment(field: keyof Metrics, by = 1): Promise<void> {
    this.cache[field] = (this.cache[field] ?? 0) + by;
    this.cache.hoursSaved = Math.max(0, this.cache.totalEstimatedHours - this.cache.totalCompletedHours);
    await this.save();
  }

  private async save(): Promise<void> {
    const folder = vscode.Uri.joinPath(this.workspaceRoot, '.todos');
    try {
      await vscode.workspace.fs.createDirectory(folder);
    } catch {
      // ignore
    }
    await vscode.workspace.fs.writeFile(
      this.fileUri(),
      Buffer.from(JSON.stringify(this.cache, null, 2), 'utf8')
    );
  }
}
