export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureEmbeddedWorker } = await import('./lib/server');
    await ensureEmbeddedWorker();
  }
}
