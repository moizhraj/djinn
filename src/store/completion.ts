import { MetricsStore } from './metricsStore';
import { TodoStore } from './todoStore';
import { TodoEffort } from '../types';

export interface CompletionInfo {
  tokensUsed?: number;
  durationMs?: number;
}

/**
 * Mark a todo as completed, settle its effort fields, and update metrics
 * exactly once. Idempotent via `completionCounted` so repeat calls (e.g. a
 * second sync) don't double-count.
 */
export async function markTodoCompleted(
  todos: TodoStore,
  metrics: MetricsStore,
  todoId: string,
  info: CompletionInfo = {}
): Promise<void> {
  const todo = todos.get(todoId);
  if (!todo) return;

  const total = todo.effort?.total ?? 0;
  const settled: TodoEffort = {
    total: total || undefined,
    remaining: 0,
    completed: total || (todo.effort?.completed ?? 0)
  };

  const tokensUsed = (todo.tokensUsed ?? 0) + (info.tokensUsed ?? 0);

  await todos.update(todoId, {
    status: 'done',
    effort: settled,
    tokensUsed,
    completionCounted: true,
    ...(info.durationMs != null ? { agentDurationMs: info.durationMs } : {})
  });

  if (todo.completionCounted) return;

  await metrics.increment('tasksCompleted');
  if (settled.completed) await metrics.increment('totalCompletedHours', settled.completed);
  if (info.tokensUsed) await metrics.increment('totalTokensUsed', info.tokensUsed);
}

/**
 * Settle effort estimate for a fresh todo and credit totalEstimatedHours
 * exactly once. Safe to call repeatedly — guarded by `effortCounted`.
 */
export async function recordEstimatedEffort(
  todos: TodoStore,
  metrics: MetricsStore,
  todoId: string,
  totalHours: number
): Promise<void> {
  const todo = todos.get(todoId);
  if (!todo || todo.effortCounted) return;
  if (!isFinite(totalHours) || totalHours <= 0) return;

  await todos.update(todoId, {
    effort: {
      total: totalHours,
      remaining: totalHours,
      completed: todo.effort?.completed ?? 0
    },
    effortCounted: true
  });
  await metrics.increment('totalEstimatedHours', totalHours);
}
