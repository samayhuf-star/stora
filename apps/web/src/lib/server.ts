import { createDb, type Db } from '@stora-sh/db';

interface Shared { db?: Promise<{ db: Db; kind: 'pglite' | 'postgres' }>; worker?: unknown }
const g = globalThis as unknown as { __stora?: Shared };
const shared: Shared = (g.__stora ??= {});

async function init() {
  const { db, kind } = await createDb({ dataDir: process.env.PGLITE_DIR || './.data/pglite' });
  return { db, kind };
}

export async function getDb(): Promise<Db> {
  return (await (shared.db ??= init())).db;
}

/**
 * Serverless mode (Vercel): there is no long-lived process, so the request that queued a run
 * drains the queue after responding (Next `after`). A cron hits /api/cron/worker as a safety net.
 */
export async function drainQueue(maxRuns = 3) {
  const { db, kind } = await (shared.db ??= init());
  if (kind === 'pglite' || process.env.STORA_EMBEDDED_WORKER === '1') return; // embedded worker handles it
  const { startWorker, loadConfig } = await import('@stora-sh/runtime');
  const w = startWorker({ db, loop: false, config: { ...loadConfig(), concurrency: 1 } });
  for (let i = 0; i < maxRuns; i++) if (!(await w.tick())) break;
}

/** Starts the in-process worker once (embedded PGlite can't be shared with another process). */
export async function ensureEmbeddedWorker() {
  if (shared.worker || process.env.STORA_EMBEDDED_WORKER === '0') return;
  const { db, kind } = await (shared.db ??= init());
  if (kind !== 'pglite' && process.env.STORA_EMBEDDED_WORKER !== '1') return; // prod: run apps/worker separately
  const { startWorker } = await import('@stora-sh/runtime');
  shared.worker = startWorker({ db });
  console.log(`[web] embedded worker started (db=${kind})`);
}
