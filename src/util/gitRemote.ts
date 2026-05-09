import { exec } from 'child_process';
import { promisify } from 'util';

const pexec = promisify(exec);

export interface DetectedAdo {
  orgUrl: string;
  project: string;
}

/**
 * Parse ADO org/project from an `origin` URL. Supports both:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}
 *   https://{org}.visualstudio.com/{project}/_git/{repo}
 *   git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 */
export function parseAdoRemote(remote: string): DetectedAdo | undefined {
  const trimmed = remote.trim();

  let m = trimmed.match(/^https?:\/\/(?:[^@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/[^/]+/i);
  if (m) return { orgUrl: `https://dev.azure.com/${m[1]}`, project: decodeURIComponent(m[2]) };

  m = trimmed.match(/^https?:\/\/([^./]+)\.visualstudio\.com\/([^/]+)\/_git\/[^/]+/i);
  if (m) return { orgUrl: `https://${m[1]}.visualstudio.com`, project: decodeURIComponent(m[2]) };

  m = trimmed.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/[^/]+/i);
  if (m) return { orgUrl: `https://dev.azure.com/${m[1]}`, project: decodeURIComponent(m[2]) };

  return undefined;
}

export async function getOriginUrl(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await pexec('git remote get-url origin', { cwd });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function detectAdoFromGit(cwd: string): Promise<DetectedAdo | undefined> {
  const url = await getOriginUrl(cwd);
  return url ? parseAdoRemote(url) : undefined;
}
