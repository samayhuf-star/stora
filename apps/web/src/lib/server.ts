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

/** Starts the in-process worker once (embedded PGlite can't be shared with another process). */
export async function ensureEmbeddedWorker() {
  if (shared.worker || process.env.STORA_EMBEDDED_WORKER === '0') return;
  const { db, kind } = await (shared.db ??= init());
  if (kind !== 'pglite' && process.env.STORA_EMBEDDED_WORKER !== '1') return; // prod: run apps/worker separately
  const { startWorker } = await import('@stora-sh/runtime');
  shared.worker = startWorker({ db });
  console.log(`[web] embedded worker started (db=${kind})`);
}
