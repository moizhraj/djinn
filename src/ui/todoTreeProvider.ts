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
      command: 'adoTodos.edit',
      title: 'Edit',
      arguments: [this]
    };
  }
}

function describeStatus(t: Todo): string {
  const parts: string[] = [t.status];
  if (t.adoWorkItemId) parts.push(`#${t.adoWorkItemId}`);
  if (t.effort?.total != null) parts.push(`${t.effort.total}h`);
  return parts.join(' · ');
}

function buildTooltip(t: Todo): string {
  const lines = [`**${t.title}**`, '', `Status: ${t.status}`];
  if (t.adoWorkItemId) lines.push(`ADO Work Item: ${t.adoWorkItemId}`);
  if (t.effort) lines.push(`Effort total/remaining/completed: ${t.effort.total ?? '?'} / ${t.effort.remaining ?? '?'} / ${t.effort.completed ?? '?'}`);
  if (t.agent) lines.push(`Last agent: ${t.agent.type} @ ${t.agent.lastRunAt}`);
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
    return this.store.list().map(t => new TodoTreeItem(t));
  }
}
