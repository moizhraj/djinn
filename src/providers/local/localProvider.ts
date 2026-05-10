import { IssueProvider, CreateIssueInput, UpdateIssueInput, IssueRef } from '../types';

export class LocalProvider implements IssueProvider {
  readonly kind = 'local' as const;
  readonly canSync = false;
  readonly displayName = 'Local-only (no remote sync)';

  async ensureAuth(): Promise<boolean> {
    return true;
  }

  async create(_input: CreateIssueInput): Promise<IssueRef> {
    throw new Error('Local provider does not sync. Sync is disabled.');
  }

  async update(_input: UpdateIssueInput): Promise<IssueRef> {
    throw new Error('Local provider does not sync. Sync is disabled.');
  }

  webUrl(_id: string): string {
    throw new Error('Local provider has no web URL.');
  }
}
