import { describe, it, expect } from 'vitest';
import { createDb, createUserWithOrg, createProject, enqueueRun, getRunDetail, listEvents, requestCancel } from '@stora-sh/db';
import { createScriptedLLM } from '@stora-sh/agents';
import { startWorker, loadConfig } from '../src/index.js';
import { problemApp, cleanApp, tmp } from '../../agents/test/fixtures.js';

async function setup(repo: string) {
  const { db, close } = await createDb({ url: undefined, dataDir: 'memory://' });
  const u = await createUserWithOrg(db, { email: 'a@b.co', name: 'A', passwordHash: 'x', orgName: 'Acme' });
  const orgId = (u as any).org?.id ?? (u as any).orgId;
  const project = await createProject(db, orgId, { name: 'Demo', repoUrl: repo, platform: 'both' } as any);
  return { db, close, orgId, projectId: (project as any).id as string };
}

async function waitDone(db: any, orgId: string, runId: string) {
  for (let i = 0; i < 300; i++) {
    const d: any = await getRunDetail(db, orgId, runId);
    if (d.run.status !== 'queued' && d.run.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('worker end to end (PGlite)', () => {
  const config = { ...loadConfig({}), agentEnv: { ...loadConfig({}).agentEnv, workRoot: tmp('rt-work-'), allowLocalRepos: true }, pollMs: 50, concurrency: 1 };

  it('runs a full audit on the problem app and persists steps, events, artifacts', async () => {
    const { db, close, orgId, projectId } = await setup(problemApp());
    const enq: any = await enqueueRun(db, { orgId, projectId, goal: 'full_audit' } as any);
    const runId = enq.run?.id ?? enq.id;
    const w = startWorker({ db, config, log: () => {}, llmFactory: () => createScriptedLLM({}) });
    await waitDone(db, orgId, runId);
    const d: any = await getRunDetail(db, orgId, runId);
    expect(['succeeded', 'partial']).toContain(d.run.status);
    expect(d.steps.some((s: any) => s.agent === 'critic' && s.status === 'succeeded')).toBe(true);
    expect(d.artifacts.length).toBeGreaterThan(0);
    expect((await listEvents(db, runId, 0)).length).toBeGreaterThan(3);
    await w.stop(); await close();
  }, 60_000);

  it('background loop picks up a queued run', async () => {
    const { db, close, orgId, projectId } = await setup(cleanApp());
    const enq: any = await enqueueRun(db, { orgId, projectId, goal: 'compliance' } as any);
    const runId = enq.run?.id ?? enq.id;
    const w = startWorker({ db, config, log: () => {}, llmFactory: () => createScriptedLLM({}) });
    await waitDone(db, orgId, runId);
    const d: any = await getRunDetail(db, orgId, runId);
    expect(['succeeded', 'partial']).toContain(d.run.status);
    await w.stop(); await close();
  }, 60_000);
});
