import * as vscode from 'vscode';
import { TodoStore } from '../store/todoStore';
import { Todo } from '../types';

export class TodoTreeItem extends vscode.TreeItem {
  constructor(public readonly todo: Todo) {
    super(todo.title, vscode.TreeItemCollapsibleState.None);
    this.id = todo.id;
    this.description = describeStatus(todo);
    this.tooltip = buildTooltip(todo);
    this.contextValue = 'todo';
    this.iconPath = new vscode.ThemeIcon(iconForStatus(todo.status));
    this.command = {
      command: 'djinn.edit',
      title: 'Edit',
      arguments: [this]
    };
  }
}

function formatRelativeDate(iso: string): string {
  const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function describeStatus(t: Todo): string {
  const parts: string[] = [t.status];
  if (t.remoteId) parts.push(`#${t.remoteId}`);
  if (t.effort?.total != null) parts.push(`${t.effort.total}h`);
  if (t.status === 'done' && t.completedAt) {
    parts.push(`completed ${formatRelativeDate(t.completedAt)}`);
  } else {
    parts.push(`created ${formatRelativeDate(t.createdAt)}`);
  }
  return parts.join(' · ');
}

function buildTooltip(t: Todo): string {
  const lines = [`**${t.title}**`, '', `Status: ${t.status}`];
  if (t.remoteId) lines.push(`${t.remoteProvider ?? 'remote'} #${t.remoteId}`);
  if (t.remoteUrl) lines.push(t.remoteUrl);
  if (t.effort?.total != null) lines.push(`Effort: ${t.effort.total}h`);
  if (t.agent) lines.push(`Last agent: ${t.agent.type} @ ${t.agent.lastRunAt}`);
  lines.push(`Created: ${formatFullDate(t.createdAt)}`);
  if (t.completedAt) lines.push(`Completed: ${formatFullDate(t.completedAt)}`);
  if (t.description) lines.push('', t.description);
  return lines.join('\n');
}

function iconForStatus(status: Todo['status']): string {
  switch (status) {
    case 'draft': return 'circle-outline';
    case 'synced': return 'cloud';
    case 'in-progress': return 'sync~spin';
    case 'done': return 'check';
    case 'failed': return 'error';
  }
}

export class TodoTreeProvider implements vscode.TreeDataProvider<TodoTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: TodoStore) {
    store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TodoTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TodoTreeItem): TodoTreeItem[] {
    if (element) return [];
    return this.store.list()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map(t => new TodoTreeItem(t));
  }
}
