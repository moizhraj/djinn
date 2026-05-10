import { ProviderKind, TodoEffort, TodoStatus } from '../types';

export interface IssueRef {
  id: string;
  url: string;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  effort?: TodoEffort;
  type?: string;
}

export interface UpdateIssueInput {
  id: string;
  title?: string;
  description?: string;
  effort?: TodoEffort;
  status?: TodoStatus;
}

export interface IssueProvider {
  readonly kind: ProviderKind;
  readonly canSync: boolean;
  readonly displayName: string;

  /** Establish auth (interactive if needed). Returns false if user cancels. */
  ensureAuth(): Promise<boolean>;

  create(input: CreateIssueInput): Promise<IssueRef>;
  update(input: UpdateIssueInput): Promise<IssueRef>;

  /** Browser URL for an issue id; throws if id is unknown shape. */
  webUrl(id: string): string;
}
