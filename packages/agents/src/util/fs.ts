import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'Pods', 'build', 'dist', '.gradle', '.dart_tool', 'DerivedData',
  '.next', 'vendor', '.idea', '.expo', '.cxx', 'coverage', '__pycache__', '.turbo',
]);

export interface WalkResult {
  files: string[]; // paths relative to root, '/' separated
  totalBytes: number;
  truncated: boolean;
}

/** Walks a checkout without ever following symlinks (repos are untrusted input). */
export async function walk(root: string, opts: { maxFiles?: number; maxDepth?: number } = {}): Promise<WalkResult> {
  const maxFiles = opts.maxFiles ?? 20_000;
  const maxDepth = opts.maxDepth ?? 14;
  const files: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  async function rec(dir: string, depth: number) {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await rec(full, depth + 1);
      } else if (e.isFile()) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        files.push(relative(root, full).split(sep).join('/'));
        try {
          totalBytes += (await lstat(full)).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  await rec(root, 0);
  return { files, totalBytes, truncated };
}

/**
 * Reads a text file from the checkout. Refuses symlinks and anything that resolves
 * outside `root`, so a hostile repo cannot exfiltrate host files into a report.
 */
export async function safeRead(root: string, rel: string, maxBytes = 512 * 1024): Promise<string | null> {
  try {
    const full = resolve(root, rel);
    const st = await lstat(full);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const [realRoot, realFull] = await Promise.all([realpath(root), realpath(full)]);
    if (realFull !== realRoot && !realFull.startsWith(realRoot + sep)) return null;
    const buf = await readFile(full);
    return buf.subarray(0, maxBytes).toString('utf8');
  } catch {
    return null;
  }
}
