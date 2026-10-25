import { createHash, randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, gt, gte, sql } from 'drizzle-orm';
import { rowsOf, type Db } from './client.js';
import { PLAN_LIMITS, LimitError } from './plans.js';
import {
  apiKeys,
  artifacts,
  memberships,
  organizations,
  projects,
  runEvents,
  runs,
  runSteps,
  usageEvents,
  users,
  type EventLevel,
  type Organization,
  type Plan,
  type Project,
  type ProjectSettings,
  type Role,
  type Run,
  type RunGoal,
  type RunStatus,
  type StepStatus,
  type TargetPlatform,
} from './schema.js';

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';

/* ================================================================== */
/* Users & organizations                                               */
/* ================================================================== */

export async function getUserByEmail(db: Db, email: string) {
  const [u] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return u ?? null;
}

export async function getUserById(db: Db, id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return u ?? null;
}

/** Creates a user plus their first workspace (owner) atomically. */
export async function createUserWithOrg(
  db: Db,
  input: { email: string; name: string; passwordHash: string; orgName?: string }
) {
  return db.transaction(async (tx) => {
    const email = input.email.toLowerCase();
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) throw new Error('EMAIL_TAKEN');

    const [user] = await tx
      .insert(users)
      .values({ email, name: input.name, passwordHash: input.passwordHash })
      .returning();

    const orgName = input.orgName?.trim() || `${input.name || email.split('@')[0]}'s workspace`;
    const base = slugify(orgName);
    let slug = base;
    for (let i = 2; ; i++) {
      const [clash] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1);
      if (!clash) break;
      slug = `${base}-${i}`;
    }
    const [org] = await tx.insert(organizations).values({ name: orgName, slug }).returning();
    await tx.insert(memberships).values({ orgId: org.id, userId: user.id, role: 'owner' });
    return { user, org };
  });
}

export async function listOrgsForUser(db: Db, userId: string) {
  return db
    .select({ org: organizations, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(organizations.createdAt));
}

export async function getMembership(db: Db, userId: string, orgId: string) {
  const [row] = await db
    .select({ org: organizations, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

export async function setOrgPlan(db: Db, orgId: string, plan: Plan) {
  const [org] = await db.update(organizations).set({ plan }).where(eq(organizations.id, orgId)).returning();
  return org ?? null;
}

export async function addMember(db: Db, orgId: string, userId: string, role: Role = 'member') {
  await db.insert(memberships).values({ orgId, userId, role }).onConflictDoNothing();
}

/* ================================================================== */
/* API keys (for CI / programmatic access)                             */
/* ================================================================== */

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createApiKey(db: Db, orgId: string, name: string) {
  const raw = `stora_${randomBytes(24).toString('hex')}`;
  const [row] = await db
    .insert(apiKeys)
    .values({ orgId, name, prefix: raw.slice(0, 12), keyHash: sha256(raw) })
    .returning();
  // The raw key is returned exactly once; only its hash is stored.
  return { key: raw, record: row };
}

export async function verifyApiKey(db: Db, raw: string): Promise<Organization | null> {
  const [row] = await db
    .select({ org: organizations, keyId: apiKeys.id })
    .from(apiKeys)
    .innerJoin(organizations, eq(apiKeys.orgId, organizations.id))
    .where(eq(apiKeys.keyHash, sha256(raw)))
    .limit(1);
  if (!row) return null;
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.keyId));
  return row.org;
}

export async function listApiKeys(db: Db, orgId: string) {
  return db
    .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, lastUsedAt: apiKeys.lastUsedAt, createdAt: apiKeys.createdAt })
    .from(apiKeys)
    .where(eq(apiKeys.orgId, orgId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function deleteApiKey(db: Db, orgId: string, id: string) {
  await db.delete(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, orgId)));
}

/* ================================================================== */
/* Projects                                                            */
/* ================================================================== */

export interface ProjectInput {
  name: string;
  repoUrl: string;
  branch?: string;
  platform?: TargetPlatform;
  bundleId?: string | null;
  packageName?: string | null;
  settings?: ProjectSettings;
}

export async function createProject(db: Db, orgId: string, input: ProjectInput): Promise<Project> {
  return db.transaction(async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).for('update');
    if (!org) throw new Error('ORG_NOT_FOUND');
    const [{ n }] = await tx.select({ n: count() }).from(projects).where(eq(projects.orgId, orgId));
    const limit = PLAN_LIMITS[org.plan].projects;
    if (Number(n) >= limit) {
      throw new LimitError(`The ${PLAN_LIMITS[org.plan].label} plan allows ${limit} project(s). Upgrade to add more.`);
    }
    const [p] = await tx
      .insert(projects)
      .values({
        orgId,
        name: input.name,
        repoUrl: input.repoUrl,
        branch: input.branch || 'main',
        platform: input.platform ?? 'both',
        bundleId: input.bundleId ?? null,
        packageName: input.packageName ?? null,
        settings: input.settings ?? {},
      })
      .returning();
    return p;
  });
}

export async function listProjects(db: Db, orgId: string) {
  return db.select().from(projects).where(eq(projects.orgId, orgId)).orderBy(desc(projects.createdAt));
}

export async function getProject(db: Db, orgId: string, id: string) {
  const [p] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.orgId, orgId))).limit(1);
  return p ?? null;
}

export async function updateProject(db: Db, orgId: string, id: string, patch: Partial<ProjectInput>) {
  const set: Partial<typeof projects.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.repoUrl !== undefined) set.repoUrl = patch.repoUrl;
  if (patch.branch !== undefined) set.branch = patch.branch;
  if (patch.platform !== undefined) set.platform = patch.platform;
  if (patch.bundleId !== undefined) set.bundleId = patch.bundleId;
  if (patch.packageName !== undefined) set.packageName = patch.packageName;
  if (patch.settings !== undefined) set.settings = patch.settings;
  if (Object.keys(set).length === 0) return getProject(db, orgId, id);
  const [p] = await db.update(projects).set(set).where(and(eq(projects.id, id), eq(projects.orgId, orgId))).returning();
  return p ?? null;
}

export async function deleteProject(db: Db, orgId: string, id: string) {
  await db.delete(projects).where(and(eq(projects.id, id), eq(projects.orgId, orgId)));
}

/* ================================================================== */
/* Runs: enqueue, read, cancel                                         */
/* ================================================================== */

export async function monthlyRunUsage(db: Db, orgId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)` })
    .from(usageEvents)
    .where(and(eq(usageEvents.orgId, orgId), eq(usageEvents.kind, 'run'), gte(usageEvents.createdAt, monthStart())));
  return Number(n);
}

/** Queues a run, enforcing the plan's monthly cap atomically (row-locks the org). */
export async function enqueueRun(
  db: Db,
  input: { orgId: string; projectId: string; createdBy?: string | null; goal?: RunGoal }
): Promise<Run> {
  return db.transaction(async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, input.orgId)).for('update');
    if (!org) throw new Error('ORG_NOT_FOUND');
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.orgId, input.orgId)))
      .limit(1);
    if (!project) throw new Error('PROJECT_NOT_FOUND');

    const [{ n }] = await tx
      .select({ n: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)` })
      .from(usageEvents)
      .where(and(eq(usageEvents.orgId, org.id), eq(usageEvents.kind, 'run'), gte(usageEvents.createdAt, monthStart())));
    const limit = PLAN_LIMITS[org.plan].runsPerMonth;
    if (Number(n) >= limit) {
      throw new LimitError(`Monthly run limit reached (${limit} on the ${PLAN_LIMITS[org.plan].label} plan).`);
    }

    const [run] = await tx
      .insert(runs)
      .values({
        orgId: org.id,
        projectId: input.projectId,
        createdBy: input.createdBy ?? null,
        goal: input.goal ?? 'full_audit',
        status: 'queued',
      })
      .returning();
    await tx.insert(usageEvents).values({ orgId: org.id, runId: run.id, kind: 'run', quantity: 1 });
    return run;
  });
}

export async function listRuns(db: Db, orgId: string, opts: { projectId?: string; limit?: number } = {}) {
  const where = opts.projectId
    ? and(eq(runs.orgId, orgId), eq(runs.projectId, opts.projectId))
    : eq(runs.orgId, orgId);
  return db
    .select({ run: runs, projectName: projects.name })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(where)
    .orderBy(desc(runs.createdAt))
    .limit(opts.limit ?? 50);
}

export async function getRunDetail(db: Db, orgId: string, runId: string) {
  const [row] = await db
    .select({ run: runs, project: projects })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(and(eq(runs.id, runId), eq(runs.orgId, orgId)))
    .limit(1);
  if (!row) return null;
  const [steps, arts] = await Promise.all([
    db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq)),
    db.select().from(artifacts).where(eq(artifacts.runId, runId)).orderBy(asc(artifacts.createdAt)),
  ]);
  return { run: row.run, project: row.project, steps, artifacts: arts };
}

export async function getArtifact(db: Db, orgId: string, artifactId: string) {
  const [row] = await db
    .select({ artifact: artifacts })
    .from(artifacts)
    .innerJoin(runs, eq(artifacts.runId, runs.id))
    .where(and(eq(artifacts.id, artifactId), eq(runs.orgId, orgId)))
    .limit(1);
  return row?.artifact ?? null;
}

export async function listEvents(db: Db, runId: string, afterId = 0, limit = 500) {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.id, afterId)))
    .orderBy(asc(runEvents.id))
    .limit(limit);
}

export async function requestCancel(db: Db, orgId: string, runId: string): Promise<RunStatus | null> {
  return db.transaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.orgId, orgId)))
      .for('update');
    if (!r) return null;
    if (r.status === 'queued') {
      await tx.update(runs).set({ status: 'canceled', finishedAt: new Date() }).where(eq(runs.id, runId));
      return 'canceled';
    }
    if (r.status === 'running') {
      await tx.update(runs).set({ cancelRequested: 1 }).where(eq(runs.id, runId));
      return 'running';
    }
    return r.status;
  });
}

/* ================================================================== */
/* Worker-side queue operations                                        */
/* ================================================================== */

export interface ClaimOptions {
  /** A running run whose heartbeat is older than this is considered abandoned */
  staleMs?: number;
  maxAttempts?: number;
}

/**
 * Atomically claims the oldest runnable run. Uses FOR UPDATE SKIP LOCKED so any
 * number of workers can poll the same table safely. Abandoned runs (worker died)
 * are re-claimed after `staleMs`, up to `maxAttempts`.
 */
export async function claimNextRun(db: Db, workerId: string, opts: ClaimOptions = {}) {
  const staleSecs = Math.max(1, Math.round((opts.staleMs ?? 120_000) / 1000));
  const maxAttempts = opts.maxAttempts ?? 3;

  // Give up on abandoned runs that have exhausted their attempts.
  await db.execute(sql`
    update runs
       set status = 'failed', error = 'Worker lost; retry limit reached', finished_at = now()
     where status = 'running'
       and locked_at < now() - make_interval(secs => ${staleSecs})
       and attempts >= ${maxAttempts}`);

  const res = await db.execute(sql`
    update runs
       set status = 'running',
           worker_id = ${workerId},
           locked_at = now(),
           attempts = attempts + 1,
           started_at = coalesce(started_at, now())
     where id = (
       select id from runs
        where cancel_requested = 0
          and attempts < ${maxAttempts}
          and (status = 'queued'
               or (status = 'running' and locked_at < now() - make_interval(secs => ${staleSecs})))
        order by created_at
        for update skip locked
        limit 1)
    returning id`);
  const claimed = rowsOf<{ id: string }>(res)[0];
  if (!claimed) return null;

  const [row] = await db
    .select({ run: runs, project: projects, org: organizations })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .innerJoin(organizations, eq(runs.orgId, organizations.id))
    .where(eq(runs.id, claimed.id))
    .limit(1);
  return row ?? null;
}

export async function heartbeat(db: Db, runId: string): Promise<{ cancelRequested: boolean }> {
  const [r] = await db
    .update(runs)
    .set({ lockedAt: new Date() })
    .where(eq(runs.id, runId))
    .returning({ cancelRequested: runs.cancelRequested });
  return { cancelRequested: (r?.cancelRequested ?? 0) === 1 };
}

export async function savePlan(db: Db, runId: string, plan: unknown) {
  await db.update(runs).set({ plan }).where(eq(runs.id, runId));
}

export interface StepSeed {
  agent: string;
  title: string;
  dependsOn: string[];
}

/** Creates the step rows for a plan; safe to call again on a resumed run. */
export async function initSteps(db: Db, runId: string, steps: StepSeed[]) {
  if (steps.length === 0) return;
  await db
    .insert(runSteps)
    .values(steps.map((s, i) => ({ runId, seq: i, agent: s.agent, title: s.title, dependsOn: s.dependsOn })))
    .onConflictDoNothing();
  // A step left 'running' by a dead worker must run again.
  await db
    .update(runSteps)
    .set({ status: 'pending', startedAt: null })
    .where(and(eq(runSteps.runId, runId), eq(runSteps.status, 'running')));
}

export async function getSteps(db: Db, runId: string) {
  return db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq));
}

export interface StepPatch {
  status?: StepStatus;
  output?: unknown;
  summary?: string | null;
  error?: string | null;
  mode?: string | null;
  tokensIn?: number;
  tokensOut?: number;
}

export async function updateStep(db: Db, runId: string, agent: string, patch: StepPatch) {
  const set: Partial<typeof runSteps.$inferInsert> = { ...patch };
  if (patch.status === 'running') set.startedAt = new Date();
  if (patch.status && patch.status !== 'running' && patch.status !== 'pending') set.finishedAt = new Date();
  await db.update(runSteps).set(set).where(and(eq(runSteps.runId, runId), eq(runSteps.agent, agent)));
}

export async function appendEvent(db: Db, runId: string, agent: string | null, level: EventLevel, message: string) {
  await db.insert(runEvents).values({ runId, agent, level, message: message.slice(0, 4000) });
}

export async function addArtifact(
  db: Db,
  runId: string,
  a: { kind: string; name: string; mime?: string; content?: string; url?: string }
) {
  const [row] = await db
    .insert(artifacts)
    .values({ runId, kind: a.kind, name: a.name, mime: a.mime ?? 'text/plain', content: a.content ?? null, url: a.url ?? null })
    .returning();
  return row;
}

export async function recordLlmUsage(db: Db, orgId: string, runId: string, tokens: number) {
  if (tokens <= 0) return;
  await db.insert(usageEvents).values({ orgId, runId, kind: 'llm_tokens', quantity: tokens });
}

export async function finishRun(
  db: Db,
  runId: string,
  status: Exclude<RunStatus, 'queued' | 'running'>,
  result?: unknown,
  error?: string | null
) {
  await db
    .update(runs)
    .set({ status, result: result ?? null, error: error ?? null, finishedAt: new Date(), lockedAt: null })
    .where(eq(runs.id, runId));
}

/* ================================================================== */
/* Dashboard aggregates                                                */
/* ================================================================== */

export async function orgOverview(db: Db, orgId: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return null;
  const [{ projectCount }] = await db.select({ projectCount: count() }).from(projects).where(eq(projects.orgId, orgId));
  const statusRows = await db
    .select({ status: runs.status, n: count() })
    .from(runs)
    .where(eq(runs.orgId, orgId))
    .groupBy(runs.status);
  const [{ tokens }] = await db
    .select({ tokens: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)` })
    .from(usageEvents)
    .where(and(eq(usageEvents.orgId, orgId), eq(usageEvents.kind, 'llm_tokens'), gte(usageEvents.createdAt, monthStart())));
  const used = await monthlyRunUsage(db, orgId);
  const limits = PLAN_LIMITS[org.plan];
  return {
    org,
    limits,
    projects: Number(projectCount),
    runsThisMonth: used,
    llmTokensThisMonth: Number(tokens),
    runsByStatus: Object.fromEntries(statusRows.map((r) => [r.status, Number(r.n)])) as Partial<Record<RunStatus, number>>,
  };
}

