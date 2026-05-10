import * as vscode from 'vscode';
import { Octokit } from '@octokit/rest';
import { TodoEffort, WorkspaceConfig } from '../../types';
import { IssueProvider, CreateIssueInput, UpdateIssueInput, IssueRef } from '../types';

const EFFORT_MARKER_START = '<!-- todo-sync:effort ';
const EFFORT_MARKER_END = ' -->';
const STATUS_LABEL = 'status:in-progress';

export class GitHubProvider implements IssueProvider {
  readonly kind = 'github' as const;
  readonly canSync = true;
  readonly displayName = 'GitHub';

  private octokit?: Octokit;

  constructor(private cfg: WorkspaceConfig) {
    if (!cfg.owner || !cfg.repo) throw new Error('GitHub provider requires owner and repo.');
  }

  async ensureAuth(): Promise<boolean> {
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
      if (!session) return false;
      this.octokit = new Octokit({ auth: session.accessToken });
      return true;
    } catch {
      return false;
    }
  }

  async create(input: CreateIssueInput): Promise<IssueRef> {
    const body = composeBody(input.description, input.effort);
    const labels = effortLabels(input.effort);
    const res = await this.requireOctokit().issues.create({
      owner: this.cfg.owner!,
      repo: this.cfg.repo!,
      title: input.title,
      body,
      labels: labels.length ? labels : undefined
    });
    return { id: String(res.data.number), url: res.data.html_url };
  }

  async update(input: UpdateIssueInput): Promise<IssueRef> {
    const num = Number(input.id);
    if (!Number.isFinite(num)) throw new Error(`Invalid GitHub issue number: ${input.id}`);

    const params: Parameters<Octokit['issues']['update']>[0] = {
      owner: this.cfg.owner!,
      repo: this.cfg.repo!,
      issue_number: num
    };
    if (input.title) params.title = input.title;
    if (input.description != null || input.effort) {
      params.body = composeBody(input.description, input.effort);
    }
    params.state = input.status === 'done' ? 'closed' : 'open';

    const res = await this.requireOctokit().issues.update(params);

    // Reconcile labels (best-effort; failures don't break the sync).
    try {
      const desired = new Set(effortLabels(input.effort));
      if (input.status === 'in-progress') desired.add(STATUS_LABEL);
      const current = await this.requireOctokit().issues.listLabelsOnIssue({
        owner: this.cfg.owner!, repo: this.cfg.repo!, issue_number: num
      });
      const ourPrefix = (n: string) => n.startsWith('effort:') || n === STATUS_LABEL;
      const toRemove = current.data.map(l => l.name).filter(n => ourPrefix(n) && !desired.has(n));
      const toAdd = [...desired].filter(n => !current.data.some(l => l.name === n));
      for (const name of toRemove) {
        await this.requireOctokit().issues.removeLabel({ owner: this.cfg.owner!, repo: this.cfg.repo!, issue_number: num, name });
      }
      if (toAdd.length) {
        await this.requireOctokit().issues.addLabels({ owner: this.cfg.owner!, repo: this.cfg.repo!, issue_number: num, labels: toAdd });
      }
    } catch {
      // ignore label sync failures
    }

    return { id: input.id, url: res.data.html_url };
  }

  webUrl(id: string): string {
    return `https://github.com/${this.cfg.owner}/${this.cfg.repo}/issues/${id}`;
  }

  private requireOctokit(): Octokit {
    if (!this.octokit) throw new Error('GitHub provider not authenticated.');
    return this.octokit;
  }
}

function composeBody(description: string | undefined, effort: TodoEffort | undefined): string {
  const base = description ?? '';
  if (!effort || (effort.total == null && effort.remaining == null && effort.completed == null)) return base;
  const json = JSON.stringify({
    total: effort.total,
    remaining: effort.remaining,
    completed: effort.completed
  });
  const marker = `${EFFORT_MARKER_START}${json}${EFFORT_MARKER_END}`;
  return `${base}\n\n${marker}\n`.trimStart();
}

function effortLabels(effort: TodoEffort | undefined): string[] {
  if (!effort) return [];
  const out: string[] = [];
  if (effort.total != null) out.push(`effort:total:${effort.total}h`);
  if (effort.remaining != null) out.push(`effort:remaining:${effort.remaining}h`);
  if (effort.completed != null) out.push(`effort:completed:${effort.completed}h`);
  return out;
}

