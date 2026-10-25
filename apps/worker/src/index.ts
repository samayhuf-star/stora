import { createDb } from '@stora-sh/db';
import { loadConfig, startWorker } from '@stora-sh/runtime';

async function main() {
  const { db, kind, close } = await createDb();
  if (kind === 'pglite') {
    console.warn('[worker] DATABASE_URL is not set: using embedded PGlite. It cannot be shared with another process; use the web app\'s embedded worker, or set DATABASE_URL.');
  }
  const config = loadConfig();
  const worker = startWorker({ db, config });
  console.log(`[worker] ${worker.workerId} started (db=${kind}, concurrency=${config.concurrency})`);

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, finishing in-flight runs...`);
    await worker.stop();
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[worker] fatal:', e);
  process.exit(1);
});
