import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Server as IoServer } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLLM, executeRun, MemorySink } from '../src/index.js';
import { cleanApp } from './fixtures.js';
import { baseEnv, project } from './helpers.js';

/** A stand-in for apps/api: same endpoints, same auth, same broadcast-to-everyone events. */
function fakeStoraApi(behaviour: { runners: boolean; script: (io: IoServer, jobId: string) => void }) {
  const token = 'secret-token';
  const received: any[] = [];
  const app = express();
  app.use(express.json());
  const http: HttpServer = createServer(app);
  const io = new IoServer(http, { cors: { origin: '*' } });
  io.use((s, next) => (s.handshake.auth.token === token ? next() : next(new Error('Invalid authentication token'))));
  app.post('/jobs', (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return res.status(401).json({ error: 'Unauthorized' });
    if (!behaviour.runners) return res.status(503).json({ error: 'No runners available' });
    received.push(req.body);
    res.json({ jobId: req.body.id });
    setTimeout(() => behaviour.script(io, req.body.id), 30);
  });
  return new Promise<{ url: string; token: string; received: any[]; close: () => Promise<void> }>((resolve) => {
    http.listen(0, () => {
      const port = (http.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        token,
        received,
        close: () => new Promise((r) => (io.close(), http.close(() => r()))),
      });
    });
  });
}

let api: Awaited<ReturnType<typeof fakeStoraApi>> | null = null;
afterEach(async () => {
  await api?.close();
  api = null;
});

const go = async (repo: string, env: any, settings: any = { screenshots: true }) => {
  const sink = new MemorySink();
  const res = await executeRun({
    runId: 'shot-run-1',
    goal: 'full_audit',
    project: project(repo, { settings }),
    env: baseEnv(env),
    llm: createLLM({ provider: 'none' }),
    sink,
  });
  return { res, sink };
};

describe('screenshots agent against a Stora runner API', () => {
  it('captures screenshots, ignores other jobs\' events, and feeds the readiness score', async () => {
    api = await fakeStoraApi({
      runners: true,
      script: (io, id) => {
        io.emit('job_update', { jobId: 'someone-elses-job', status: 'running', message: 'not ours' });
        io.emit('job_artifact', { jobId: 'someone-elses-job', type: 'screenshot', screenshot: { url: 'https://cdn.example/decoy.png' } });
        io.emit('job_update', { jobId: id, status: 'running', message: 'Booting simulator' });
        io.emit('job_artifact', { jobId: id, type: 'screenshot', screenshot: { url: 'https://cdn.example/1.png', screen: '1.png' } });
        io.emit('job_artifact', { jobId: id, type: 'screenshot', screenshot: { url: 'https://cdn.example/2.png', screen: '2.png' } });
        io.emit('job_artifact', { jobId: id, type: 'video', url: 'https://cdn.example/replay.mp4' });
        io.emit('job_artifact', { jobId: id, type: 'screenshot', screenshot: { url: 'javascript:alert(1)' } });
        io.emit('job_complete', { jobId: id, status: 'success', uploadedUrls: ['https://cdn.example/2.png', 'https://cdn.example/3.png'] });
      },
    });
    const { res, sink } = await go(cleanApp(), { runnerApiUrl: api.url, runnerToken: api.token, googleApiKey: 'g-key' });
    expect(res.status).toBe('succeeded');
    expect(sink.plan!.steps.map((s) => s.agent)).toContain('screenshots');
    expect(sink.steps.get('screenshots')).toMatchObject({ status: 'succeeded', mode: 'remote' });
    expect(res.results.screenshots!.urls.sort()).toEqual(['https://cdn.example/1.png', 'https://cdn.example/2.png', 'https://cdn.example/3.png']);
    expect(sink.artifacts.filter((a) => a.kind === 'screenshot').map((a) => a.url).sort()).toHaveLength(3);
    expect(res.report!.breakdown.find((b) => b.area === 'assets')!.score).toBe(100);

    // The job payload matches what apps/api expects.
    expect(api.received).toHaveLength(1);
    expect(api.received[0]).toMatchObject({
      id: 'run-shot-run-1',
      collectionId: 'shot-run-1',
      bundleId: 'com.example.recipebox',
      mobilePlatform: 'flutter',
      googleApiKey: 'g-key',
      autoBuild: true,
      useV2Flow: true,
      devices: [{ platform: 'ios', simulatorName: 'iPhone 16 Pro Max' }],
    });
  });

  it('fails the step (not the run) when no runner is connected', async () => {
    api = await fakeStoraApi({ runners: false, script: () => {} });
    const { res, sink } = await go(cleanApp(), { runnerApiUrl: api.url, runnerToken: api.token });
    expect(sink.steps.get('screenshots')!.status).toBe('failed');
    expect(sink.steps.get('screenshots')!.error).toContain('No Stora runner is currently connected');
    expect(res.status).toBe('succeeded');
    expect(res.report!.checklist.some((c) => c.title.includes('Re-run the screenshots agent'))).toBe(true);
    expect(res.report!.breakdown.find((b) => b.area === 'assets')!.score).toBe(40);
  });

  it('reports a bad token as an unreachable runner', async () => {
    api = await fakeStoraApi({ runners: true, script: () => {} });
    const { sink } = await go(cleanApp(), { runnerApiUrl: api.url, runnerToken: 'wrong' });
    expect(sink.steps.get('screenshots')!.error).toContain('Cannot reach Stora runner API');
  });

  it('surfaces a runner-side failure', async () => {
    api = await fakeStoraApi({
      runners: true,
      script: (io, id) => {
        io.emit('job_error', { jobId: id, error: 'Maestro could not find the app' });
        io.emit('job_complete', { jobId: id, status: 'failed', errors: ['build failed'] });
      },
    });
    const { sink } = await go(cleanApp(), { runnerApiUrl: api.url, runnerToken: api.token });
    expect(sink.steps.get('screenshots')!.status).toBe('failed');
    expect(sink.steps.get('screenshots')!.error).toBe('Maestro could not find the app');
  });

  it('gives up cleanly on timeout', async () => {
    api = await fakeStoraApi({ runners: true, script: () => {} });
    const { sink } = await go(cleanApp(), { runnerApiUrl: api.url, runnerToken: api.token, screenshotTimeoutMs: 300 });
    expect(sink.steps.get('screenshots')!.error).toContain('Timed out');
  });

  it('does not answer interactive prompts from the runner', async () => {
    api = await fakeStoraApi({
      runners: true,
      script: (io, id) => io.emit('job_prompt_required', { jobId: id, promptId: 'p', promptType: 'input', message: 'Enter 2FA code' }),
    });
    const { sink } = await go(cleanApp(), { runnerApiUrl: api.url, runnerToken: api.token });
    expect(sink.steps.get('screenshots')!.error).toContain('interactive input');
  });

  it('is left out of the plan unless enabled and a runner is configured', async () => {
    const off = await go(cleanApp(), {}, { screenshots: true }); // enabled, no runner
    expect(off.sink.plan!.steps.map((s) => s.agent)).not.toContain('screenshots');
    const notEnabled = await go(cleanApp(), { runnerApiUrl: 'http://x', runnerToken: 't' }, {});
    expect(notEnabled.sink.plan!.steps.map((s) => s.agent)).not.toContain('screenshots');
  });
});
