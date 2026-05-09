import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { Todo, TodoStoreFile, TodoStatus } from '../types';

const FILE_REL = '.ado/todos.json';

export class TodoStore {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private cache: TodoStoreFile = { version: 1, items: [] };
  private watcher?: vscode.FileSystemWatcher;

  constructor(private workspaceRoot: vscode.Uri) {}

  async init(): Promise<void> {
    await this.load();
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceRoot, FILE_REL)
    );
    this.watcher.onDidChange(() => this.load().then(() => this._onDidChange.fire()));
    this.watcher.onDidCreate(() => this.load().then(() => this._onDidChange.fire()));
    this.watcher.onDidDelete(() => {
      this.cache = { version: 1, items: [] };
      this._onDidChange.fire();
    });
  }

  dispose() {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }

  private fileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.workspaceRoot, '.ado', 'todos.json');
  }

  private async load(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri());
      const text = Buffer.from(bytes).toString('utf8');
      const parsed = JSON.parse(text) as TodoStoreFile;
      this.cache = parsed && parsed.version ? parsed : { version: 1, items: [] };
    } catch {
      this.cache = { version: 1, items: [] };
    }
  }

  private async save(): Promise<void> {
    const folder = vscode.Uri.joinPath(this.workspaceRoot, '.ado');
    try {
      await vscode.workspace.fs.createDirectory(folder);
    } catch {
      // ignore
    }
    const text = JSON.stringify(this.cache, null, 2);
    await vscode.workspace.fs.writeFile(this.fileUri(), Buffer.from(text, 'utf8'));
  }

  list(): Todo[] {
    return [...this.cache.items];
  }

  get(id: string): Todo | undefined {
    return this.cache.items.find(t => t.id === id);
  }

  async add(title: string): Promise<Todo> {
    const now = new Date().toISOString();
    const todo: Todo = {
      id: uuidv4(),
      title,
      status: 'draft',
      createdAt: now,
      updatedAt: now
    };
    this.cache.items.push(todo);
    await this.save();
    this._onDidChange.fire();
    return todo;
  }

  async update(id: string, patch: Partial<Todo>): Promise<Todo | undefined> {
    const idx = this.cache.items.findIndex(t => t.id === id);
    if (idx < 0) return undefined;
    const merged: Todo = {
      ...this.cache.items[idx],
      ...patch,
      id: this.cache.items[idx].id,
      updatedAt: new Date().toISOString()
    };
    this.cache.items[idx] = merged;
    await this.save();
    this._onDidChange.fire();
    return merged;
  }

  async setStatus(id: string, status: TodoStatus): Promise<void> {
    await this.update(id, { status });
  }

  async remove(id: string): Promise<void> {
    this.cache.items = this.cache.items.filter(t => t.id !== id);
    await this.save();
    this._onDidChange.fire();
  }
}
