import { io, type Socket } from 'socket.io-client';
import type { AgentDefinition, ScreenshotsReport } from '../types.js';

const FRAMEWORKS = new Set(['flutter', 'react-native', 'expo', 'swift', 'kotlin']);

interface RunnerEvents {
  urls: string[];
  errors: string[];
  done: null | { status: string };
}

/**
 * Dispatches a screenshot job to a Stora runner (apps/api + apps/runner, which need a macOS
 * simulator and Maestro) and waits for its events. Everything the runner reports is treated as
 * data: only URLs are kept, and nothing the runner says can change what this agent does next.
 */
export const screenshotsAgent: AgentDefinition<'screenshots'> = {
  name: 'screenshots',
  title: 'Screenshots',
  description: 'Hands the app to a Stora runner to capture App Store-ready screenshots with AI-driven exploration.',
  goals: ['full_audit'],
  requires: ['scout'],
  after: [],
  timeoutMs: 30 * 60_000,
  async run(ctx) {
    const { env, project } = ctx;
    const scout = ctx.results.scout!;
    const skip = (reason: string) => ({
      output: { jobId: null, status: 'failed', urls: [], message: reason } as ScreenshotsReport,
      mode: 'remote' as const,
      summary: reason,
      skipped: reason,
    });

    if (!project.settings.screenshots) return skip('Screenshots are not enabled for this project.');
    if (!env.runnerApiUrl || !env.runnerToken) {
      return skip('No Stora runner configured (set STORA_RUNNER_URL and ORCHESTRATOR_TOKEN) — screenshots need a macOS runner with Maestro.');
    }
    const bundleId = scout.bundleId ?? scout.packageName;
    if (!bundleId) return skip('No bundle identifier found; cannot target the app on a simulator.');

    const base = env.runnerApiUrl.replace(/\/$/, '');
    const jobId = `run-${ctx.runId}`; // stable id: a resumed run re-attaches instead of queueing twice
    const state: RunnerEvents = { urls: [], errors: [], done: null };
    const iosFirst = scout.platforms.includes('ios') || !scout.platforms.length;

    let socket: Socket | null = null;
    try {
      // Connect before enqueueing so no event for this job can be missed.
      socket = io(base, { auth: { token: env.runnerToken }, transports: ['websocket'], reconnection: false, timeout: 15_000 });
      await new Promise<void>((resolve, reject) => {
        socket!.once('connect', () => resolve());
        socket!.once('connect_error', (e) => reject(new Error(`Cannot reach Stora runner API: ${e.message}`)));
      });

      let finish!: () => void;
      const finished = new Promise<void>((r) => (finish = r));
      socket.on('job_update', (d: { jobId?: string; message?: string }) => {
        if (d?.jobId === jobId && d.message) ctx.log('debug', `runner: ${String(d.message).slice(0, 200)}`);
      });
      socket.on('job_artifact', (d: { jobId?: string; screenshot?: { url?: string }; url?: string; type?: string }) => {
        if (d?.jobId !== jobId) return;
        const url = d.screenshot?.url ?? d.url;
        if (typeof url === 'string' && /^https?:\/\//.test(url) && d.type !== 'video') state.urls.push(url);
      });
      socket.on('job_error', (d: { jobId?: string; error?: string }) => {
        if (d?.jobId === jobId && d.error) state.errors.push(String(d.error).slice(0, 300));
      });
      socket.on('job_prompt_required', (d: { jobId?: string }) => {
        if (d?.jobId === jobId) {
          state.errors.push('The runner asked for interactive input, which is not supported in automated runs.');
          state.done = { status: 'failed' };
          finish();
        }
      });
      socket.on('job_complete', (d: { jobId?: string; status?: string; uploadedUrls?: string[]; errors?: string[] }) => {
        if (d?.jobId !== jobId) return;
        for (const u of d.uploadedUrls ?? []) if (typeof u === 'string' && /^https?:\/\//.test(u) && !state.urls.includes(u)) state.urls.push(u);
        for (const e of d.errors ?? []) state.errors.push(String(e).slice(0, 300));
        state.done = { status: d.status ?? 'failed' };
        finish();
      });
      socket.on('disconnect', () => {
        if (!state.done) {
          state.errors.push('Lost connection to the runner API before the job finished.');
          finish();
        }
      });

      ctx.log('info', `Queueing screenshot job ${jobId} for ${bundleId}`);
      const res = await fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.runnerToken}` },
        body: JSON.stringify({
          id: jobId,
          collectionId: ctx.runId,
          projectId: project.id,
          bundleId,
          devices: iosFirst
            ? [{ id: 'ios-default', simulatorName: 'iPhone 16 Pro Max', platform: 'ios' }]
            : [{ id: 'android-default', platform: 'android' }],
          repoUrl: project.repoUrl,
          googleApiKey: env.googleApiKey ?? '',
          mobilePlatform: scout.framework && FRAMEWORKS.has(scout.framework) ? scout.framework : undefined,
          autoBuild: true,
          useV2Flow: true,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 503) throw new Error('No Stora runner is currently connected (HTTP 503).');
      if (!res.ok) throw new Error(`Stora runner API rejected the job (HTTP ${res.status}).`);

      const timeoutMs = env.screenshotTimeoutMs ?? 20 * 60_000;
      const timer = setTimeout(() => finish(), timeoutMs);
      ctx.signal.addEventListener('abort', () => finish(), { once: true });
      await finished;
      clearTimeout(timer);

      if (ctx.signal.aborted) throw new Error('Canceled while waiting for screenshots');
      const urls = [...new Set(state.urls)];
      for (const [i, url] of urls.entries()) await ctx.artifact({ kind: 'screenshot', name: `screenshot-${i + 1}`, mime: 'image/png', url });

      let status: ScreenshotsReport['status'] = 'completed';
      let message = `Captured ${urls.length} screenshot(s).`;
      if (!state.done) {
        status = 'timeout';
        message = `Timed out after ${Math.round(timeoutMs / 60000)} minutes waiting for the runner.`;
      } else if (state.done.status !== 'success') {
        status = 'failed';
        message = state.errors[0] ?? 'The runner reported a failure.';
      }
      if (status !== 'completed') throw new Error(message);
      return { output: { jobId, status, urls, message }, mode: 'remote', summary: message };
    } finally {
      socket?.close();
    }
  },
};
