import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createDb,
  createUserWithOrg,
  createProject,
  enqueueRun,
  claimNextRun,
  requestCancel,
  getRunDetail,
  initSteps,
  updateStep,
  getSteps,
  runMigrations,
  setOrgPlan,
  createApiKey,
  verifyApiKey,
  LimitError,
  runs,
  type StoraDb,
} from '../src/index.js';

let h: StoraDb;
let n = 0;
const uniq = () => `${Date.now()}-${n++}`;

async function seed(plan: 'free' | 'pro' = 'pro') {
  const { user, org } = await createUserWithOrg(h.db, {
    email: `u${uniq()}@test.dev`,
    name: 'Tester',
    passwordHash: 'x',
    orgName: `Org ${uniq()}`,
  });
  if (plan !== 'free') await setOrgPlan(h.db, org.id, plan);
  const project = await createProject(h.db, org.id, { name: 'App', repoUrl: 'https://github.com/o/r' });
  return { user, org, project };
}

beforeAll(async () => {
  h = await createDb({ url: process.env.TEST_DATABASE_URL, dataDir: 'memory://' });
});
afterAll(async () => {
  await h.close();
});

describe(`db (${process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite'})`, () => {
  it('migrations are idempotent', async () => {
    expect(await runMigrations(h.db)).toEqual([]);
  });

  it('creates users with unique emails and unique org slugs', async () => {
    const email = `dup${uniq()}@test.dev`;
    const a = await createUserWithOrg(h.db, { email, name: 'A', passwordHash: 'x', orgName: 'Same Name' });
    await expect(createUserWithOrg(h.db, { email: email.toUpperCase(), name: 'A', passwordHash: 'x' })).rejects.toThrow('EMAIL_TAKEN');
    const b = await createUserWithOrg(h.db, { email: `o${uniq()}@test.dev`, name: 'B', passwordHash: 'x', orgName: 'Same Name' });
    expect(a.org.slug).not.toEqual(b.org.slug);
  });

  it('enforces the free plan project limit', async () => {
    const { org } = await seed('free');
    await expect(createProject(h.db, org.id, { name: 'Two', repoUrl: 'https://github.com/o/r2' })).rejects.toBeInstanceOf(LimitError);
  });

  it('enforces the monthly run limit atomically under concurrency', async () => {
    const { org, project } = await seed('free'); // 5 runs / month
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => enqueueRun(h.db, { orgId: org.id, projectId: project.id }))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(3);
    expect(rejected.every((r) => r.reason instanceof LimitError)).toBe(true);
  });

  it('isolates tenants', async () => {
    const a = await seed();
    const b = await seed();
    const run = await enqueueRun(h.db, { orgId: a.org.id, projectId: a.project.id });
    expect(await getRunDetail(h.db, b.org.id, run.id)).toBeNull();
    expect((await getRunDetail(h.db, a.org.id, run.id))?.run.id).toBe(run.id);
    await expect(enqueueRun(h.db, { orgId: b.org.id, projectId: a.project.id })).rejects.toThrow('PROJECT_NOT_FOUND');
  });

  it('claims each queued run exactly once across concurrent workers', async () => {
    await h.db.execute(sql`update runs set status = 'canceled' where status in ('queued','running')`);
    const { org, project } = await seed();
    const created = await Promise.all([1, 2, 3].map(() => enqueueRun(h.db, { orgId: org.id, projectId: project.id })));
    const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => claimNextRun(h.db, `w${i}`)));
    const got = claims.filter(Boolean).map((c) => c!.run.id);
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
    expect(new Set(got)).toEqual(new Set(created.map((r) => r.id)));
    expect(claims.find(Boolean)!.run.attempts).toBe(1);
  });

  it('re-claims abandoned runs, then fails them after max attempts', async () => {
    await h.db.execute(sql`update runs set status = 'canceled' where status in ('queued','running')`);
    const { org, project } = await seed();
    const run = await enqueueRun(h.db, { orgId: org.id, projectId: project.id });
    const stale = { staleMs: 1000, maxAttempts: 2 };
    const age = () => h.db.execute(sql`update runs set locked_at = now() - interval '1 hour' where id = ${run.id}`);

    expect((await claimNextRun(h.db, 'w1', stale))?.run.attempts).toBe(1);
    expect(await claimNextRun(h.db, 'w2', stale)).toBeNull(); // heartbeat still fresh
    await age();
    expect((await claimNextRun(h.db, 'w2', stale))?.run.attempts).toBe(2); // reclaimed
    await age();
    expect(await claimNextRun(h.db, 'w3', stale)).toBeNull(); // exhausted
    const [r] = await h.db.select().from(runs).where(sql`${runs.id} = ${run.id}`);
    expect(r.status).toBe('failed');
  });

  it('cancels queued runs immediately and flags running ones', async () => {
    await h.db.execute(sql`update runs set status = 'canceled' where status in ('queued','running')`);
    const { org, project } = await seed();
    const q = await enqueueRun(h.db, { orgId: org.id, projectId: project.id });
    expect(await requestCancel(h.db, org.id, q.id)).toBe('canceled');
    const r2 = await enqueueRun(h.db, { orgId: org.id, projectId: project.id });
    await claimNextRun(h.db, 'w');
    expect(await requestCancel(h.db, org.id, r2.id)).toBe('running');
    expect(await claimNextRun(h.db, 'w2', { staleMs: 1 })).toBeNull();
  });

  it('resets half-done steps when a run is resumed', async () => {
    const { org, project } = await seed();
    const run = await enqueueRun(h.db, { orgId: org.id, projectId: project.id });
    await initSteps(h.db, run.id, [
      { agent: 'scout', title: 'Scout', dependsOn: [] },
      { agent: 'compliance', title: 'Compliance', dependsOn: ['scout'] },
    ]);
    await updateStep(h.db, run.id, 'scout', { status: 'succeeded', output: { ok: 1 } });
    await updateStep(h.db, run.id, 'compliance', { status: 'running' });
    await initSteps(h.db, run.id, [
      { agent: 'scout', title: 'Scout', dependsOn: [] },
      { agent: 'compliance', title: 'Compliance', dependsOn: ['scout'] },
    ]);
    const steps = await getSteps(h.db, run.id);
    expect(steps.map((s) => s.status)).toEqual(['succeeded', 'pending']);
    expect(steps).toHaveLength(2);
  });

  it('issues api keys that verify once and are stored hashed', async () => {
    const { org } = await seed();
    const { key, record } = await createApiKey(h.db, org.id, 'ci');
    expect(record.keyHash).not.toContain(key);
    expect((await verifyApiKey(h.db, key))?.id).toBe(org.id);
    expect(await verifyApiKey(h.db, key + 'x')).toBeNull();
  });
});
