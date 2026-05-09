import * as vscode from 'vscode';
import { AdoConfigStore } from '../config/adoConfig';
import { ensurePat } from '../config/secrets';
import { TodoStore } from '../store/todoStore';
import { MetricsStore } from '../store/metricsStore';
import { AdoClient } from './client';
import { Todo } from '../types';
import { EffortEstimator } from '../agents/effortEstimator';

export interface SyncResult {
  created: number;
  updated: number;
  failed: number;
  errors: string[];
}

export class SyncService {
  constructor(
    private todos: TodoStore,
    private metrics: MetricsStore,
    private cfgStore: AdoConfigStore,
    private secrets: vscode.SecretStorage,
    private estimator: EffortEstimator
  ) {}

  async sync(): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, failed: 0, errors: [] };

    const cfg = await this.cfgStore.ensure();
    if (!cfg) {
      result.errors.push('ADO config not available.');
      return result;
    }
    const pat = await ensurePat(this.secrets, cfg.orgUrl);
    if (!pat) {
      result.errors.push('PAT not provided.');
      return result;
    }

    const client = new AdoClient(cfg, pat);

    for (const todo of this.todos.list()) {
      try {
        if (todo.adoWorkItemId == null) {
          await this.createOne(todo, client);
          result.created++;
          await this.metrics.increment('tasksCreated');
          if (todo.effort?.total) {
            await this.metrics.increment('totalEstimatedHours', todo.effort.total);
          }
        } else {
          await this.updateOne(todo, client);
          result.updated++;
          if (todo.status === 'done') {
            await this.metrics.increment('tasksCompleted');
            if (todo.effort?.completed) {
              await this.metrics.increment('totalCompletedHours', todo.effort.completed);
            }
          }
        }
      } catch (e: unknown) {
        result.failed++;
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`${todo.title}: ${msg}`);
      }
    }
    return result;
  }

  private async createOne(todo: Todo, client: AdoClient): Promise<void> {
    let effort = todo.effort;
    if (!effort?.total) {
      const total = await this.estimator.estimate(todo);
      effort = { total, remaining: total, completed: 0 };
      await this.todos.update(todo.id, { effort });
    }
    const wi = await client.createTask({
      title: todo.title,
      description: todo.description,
      totalEffort: effort.total,
      remainingEffort: effort.remaining ?? effort.total,
      completedEffort: effort.completed ?? 0
    });
    if (wi.id != null) {
      await this.todos.update(todo.id, { adoWorkItemId: wi.id, status: 'synced' });
    }
  }

  private async updateOne(todo: Todo, client: AdoClient): Promise<void> {
    const stateMap: Record<string, string | undefined> = {
      'draft': undefined,
      'synced': 'To Do',
      'in-progress': 'Doing',
      'done': 'Done',
      'failed': undefined
    };
    await client.updateTask({
      id: todo.adoWorkItemId!,
      title: todo.title,
      description: todo.description,
      totalEffort: todo.effort?.total,
      remainingEffort: todo.effort?.remaining,
      completedEffort: todo.effort?.completed,
      state: stateMap[todo.status]
    });
  }
}
