import { exec } from 'child_process';
import { promisify } from 'util';
import { ProviderKind } from '../types';

const pexec = promisify(exec);

export type ParsedRemote =
  | { kind: 'ado'; orgUrl: string; project: string }
  | { kind: 'github'; owner: string; repo: string }
  | { kind: 'gitlab'; host: string; projectPath: string }
  | { kind: 'unknown'; raw: string };

/** Strip a trailing `.git` suffix from a path segment. */
function stripGit(s: string): string {
  return s.replace(/\.git$/i, '');
}

export function parseRemote(remote: string): ParsedRemote {
  const trimmed = remote.trim();

  // ADO https
  let m = trimmed.match(/^https?:\/\/(?:[^@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/[^/]+/i);
  if (m) return { kind: 'ado', orgUrl: `https://dev.azure.com/${m[1]}`, project: decodeURIComponent(m[2]) };

  // ADO legacy visualstudio.com
  m = trimmed.match(/^https?:\/\/([^./]+)\.visualstudio\.com\/([^/]+)\/_git\/[^/]+/i);
  if (m) return { kind: 'ado', orgUrl: `https://${m[1]}.visualstudio.com`, project: decodeURIComponent(m[2]) };

  // ADO ssh
  m = trimmed.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/[^/]+/i);
  if (m) return { kind: 'ado', orgUrl: `https://dev.azure.com/${m[1]}`, project: decodeURIComponent(m[2]) };

  // GitHub https
  m = trimmed.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/i);
  if (m) return { kind: 'github', owner: m[1], repo: stripGit(m[2]) };

  // GitHub ssh
  m = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (m) return { kind: 'github', owner: m[1], repo: stripGit(m[2]) };

  // GitLab https (any host containing 'gitlab')
  m = trimmed.match(/^https?:\/\/(?:[^@]+@)?([^/]*gitlab[^/]*)\/(.+?)(?:\.git)?(?:\/)?$/i);
  if (m) return { kind: 'gitlab', host: m[1], projectPath: stripGit(m[2]) };

  // GitLab ssh
  m = trimmed.match(/^git@([^:]*gitlab[^:]*):(.+?)(?:\.git)?$/i);
  if (m) return { kind: 'gitlab', host: m[1], projectPath: stripGit(m[2]) };

  return { kind: 'unknown', raw: trimmed };
}

/** Back-compat shim used by older callers. */
export function parseAdoRemote(remote: string): { orgUrl: string; project: string } | undefined {
  const p = parseRemote(remote);
  return p.kind === 'ado' ? { orgUrl: p.orgUrl, project: p.project } : undefined;
}

export async function getOriginUrl(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await pexec('git remote get-url origin', { cwd });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function detectFromGit(cwd: string): Promise<ParsedRemote | undefined> {
  const url = await getOriginUrl(cwd);
  return url ? parseRemote(url) : undefined;
}

export function providerKindOf(p: ParsedRemote): ProviderKind | undefined {
  switch (p.kind) {
    case 'ado': return 'ado';
    case 'github': return 'github';
    case 'gitlab': return 'gitlab';
    case 'unknown': return undefined;
  }
}
