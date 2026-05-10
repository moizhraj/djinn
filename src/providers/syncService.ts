import * as vscode from 'vscode';
import { WorkspaceConfigStore } from '../config/workspaceConfig';
import { TodoStore } from '../store/todoStore';
import { MetricsStore } from '../store/metricsStore';
import { Todo } from '../types';
import { EffortEstimator } from '../agents/effortEstimator';
import { createProvider } from './factory';
import { IssueProvider } from './types';
import { markTodoCompleted, recordEstimatedEffort } from '../store/completion';

export interface SyncResult {
  created: number;
  updated: number;
  failed: number;
  skipped: number;
  errors: string[];
}

export class SyncService {
  constructor(
    private todos: TodoStore,
    private metrics: MetricsStore,
    private cfgStore: WorkspaceConfigStore,
    private secrets: vscode.SecretStorage,
    private estimator: EffortEstimator
  ) {}

  async sync(): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, failed: 0, skipped: 0, errors: [] };

    const cfg = await this.cfgStore.ensure();
    if (!cfg) {
      result.errors.push('Workspace config not available.');
      return result;
    }

    const provider = createProvider(cfg, this.secrets);

    if (!provider.canSync) {
      vscode.window.showInformationMessage(
        `${provider.displayName}: no remote sync configured. Todos remain local.`
      );
      result.skipped = this.todos.list().length;
      return result;
    }

    const ok = await provider.ensureAuth();
    if (!ok) {
      result.errors.push(`Authentication for ${provider.displayName} was cancelled.`);
      return result;
    }

    for (const todo of this.todos.list()) {
      try {
        if (!todo.remoteId) {
          await this.createOne(todo, provider);
          result.created++;
          await this.metrics.increment('tasksCreated');
        } else {
          await this.updateOne(todo, provider);
          result.updated++;
          if (todo.status === 'done' && !todo.completionCounted) {
            await markTodoCompleted(this.todos, this.metrics, todo.id);
          }
        }
      } catch (e) {
        result.failed++;
        result.errors.push(`${todo.title}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return result;
  }

  private async createOne(todo: Todo, provider: IssueProvider): Promise<void> {
    if (!todo.effort?.total) {
      const total = await this.estimator.estimate(todo);
      await recordEstimatedEffort(this.todos, this.metrics, todo.id, total);
    } else if (!todo.effortCounted) {
      await recordEstimatedEffort(this.todos, this.metrics, todo.id, todo.effort.total);
    }
    const fresh = this.todos.get(todo.id) ?? todo;
    const effort = fresh.effort;
    const ref = await provider.create({
      title: todo.title,
      description: todo.description,
      effort
    });
    await this.todos.update(todo.id, {
      remoteId: ref.id,
      remoteProvider: provider.kind,
      remoteUrl: ref.url,
      status: 'synced'
    });
  }

  private async updateOne(todo: Todo, provider: IssueProvider): Promise<void> {
    const ref = await provider.update({
      id: todo.remoteId!,
      title: todo.title,
      description: todo.description,
      effort: todo.effort,
      status: todo.status
    });
    if (!todo.remoteUrl) {
      await this.todos.update(todo.id, { remoteUrl: ref.url, remoteProvider: provider.kind });
    }
  }
}
