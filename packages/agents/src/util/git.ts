import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;
const PRIVATE_IPV4 = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export class RepoUrlError extends Error {}

/**
 * Only plain https URLs to public hosts are accepted (no credentials, no ssh/git/ext
 * transports, no private addresses). file:// and local paths require allowLocal.
 */
export function validateRepoUrl(raw: string, allowLocal = false): string {
  const url = raw.trim();
  if (allowLocal && (isAbsolute(url) || url.startsWith('file://'))) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new RepoUrlError('Repository URL is not a valid URL');
  }
  if (u.protocol !== 'https:') throw new RepoUrlError('Only https:// repository URLs are supported');
  if (u.username || u.password) throw new RepoUrlError('Credentials in repository URLs are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST.test(host) || PRIVATE_IPV4.test(host) || host === '::1' || host.includes(':')) {
    throw new RepoUrlError('Repository host is not allowed');
  }
  if (!host.includes('.')) throw new RepoUrlError('Repository host is not allowed');
  return u.toString();
}

export function validateBranch(branch: string): string {
  if (!/^[\w][\w./-]{0,99}$/.test(branch) || branch.includes('..')) throw new RepoUrlError('Invalid branch name');
  return branch;
}

function git(args: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        timeout: opts.timeoutMs,
        signal: opts.signal,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_CONFIG_NOSYSTEM: '1' },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).toString().trim().slice(0, 500)));
        else resolve(stdout.toString());
      }
    );
  });
}

export async function cloneRepo(opts: {
  url: string;
  branch: string;
  dest: string;
  allowLocal?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const url = validateRepoUrl(opts.url, opts.allowLocal);
  const branch = validateBranch(opts.branch);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const proto = [
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    ...(opts.allowLocal ? ['-c', 'protocol.file.allow=always'] : []),
    '-c', 'core.symlinks=false',
    '-c', 'core.hooksPath=/dev/null',
  ];
  await rm(opts.dest, { recursive: true, force: true });
  await mkdir(opts.dest, { recursive: true });
  const base = [...proto, 'clone', '--depth', '1', '--single-branch', '--no-tags'];
  try {
    await git([...base, '--branch', branch, '--', url, opts.dest], { timeoutMs, signal: opts.signal });
  } catch (e) {
    // Fall back to the remote's default branch if the named one does not exist.
    if (!/not found|remote branch/i.test((e as Error).message)) throw e;
    await rm(opts.dest, { recursive: true, force: true });
    await mkdir(opts.dest, { recursive: true });
    await git([...base, '--', url, opts.dest], { timeoutMs, signal: opts.signal });
  }
  await rm(`${opts.dest}/.git`, { recursive: true, force: true });
}
