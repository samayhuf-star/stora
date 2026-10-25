import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  bigserial,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/* ------------------------------------------------------------------ */
/* Enums (kept as text + TS unions so migrations stay trivial)         */
/* ------------------------------------------------------------------ */

export type Plan = 'free' | 'pro' | 'agency';
export type Role = 'owner' | 'admin' | 'member';
export type TargetPlatform = 'ios' | 'android' | 'both';
export type RunGoal = 'full_audit' | 'compliance' | 'aso' | 'listing';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/* ------------------------------------------------------------------ */
/* Identity & tenancy                                                  */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull().default(''),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)]
);

export const organizations = pgTable(
  'organizations',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    plan: text('plan').$type<Plan>().notNull().default('free'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('organizations_slug_uq').on(t.slug)]
);

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<Role>().notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('memberships_org_user_uq').on(t.orgId, t.userId), index('memberships_user_idx').on(t.userId)]
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_keys_hash_uq').on(t.keyHash), index('api_keys_org_idx').on(t.orgId)]
);

/* ------------------------------------------------------------------ */
/* Projects (a mobile app to be launched)                              */
/* ------------------------------------------------------------------ */

export interface ProjectSettings {
  appName?: string;
  shortDescription?: string;
  description?: string;
  category?: string;
  targetKeywords?: string[];
  privacyPolicyUrl?: string;
  supportUrl?: string;
  /** Opt in to dispatching screenshot jobs to a Stora runner */
  screenshots?: boolean;
}

export const projects = pgTable(
  'projects',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    repoUrl: text('repo_url').notNull(),
    branch: text('branch').notNull().default('main'),
    platform: text('platform').$type<TargetPlatform>().notNull().default('both'),
    bundleId: text('bundle_id'),
    packageName: text('package_name'),
    settings: jsonb('settings').$type<ProjectSettings>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('projects_org_idx').on(t.orgId)]
);

/* ------------------------------------------------------------------ */
/* Runs: one execution of the agent team against a project             */
/* ------------------------------------------------------------------ */

export const runs = pgTable(
  'runs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    goal: text('goal').$type<RunGoal>().notNull().default('full_audit'),
    status: text('status').$type<RunStatus>().notNull().default('queued'),
    /** Supervisor's plan (agents + dependencies) */
    plan: jsonb('plan').$type<unknown>(),
    /** Final structured report from the Critic agent */
    result: jsonb('result').$type<unknown>(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    workerId: text('worker_id'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    cancelRequested: integer('cancel_requested').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('runs_org_created_idx').on(t.orgId, t.createdAt),
    index('runs_status_idx').on(t.status),
    index('runs_project_idx').on(t.projectId),
  ]
);

export const runSteps = pgTable(
  'run_steps',
  {
    id: id(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    agent: text('agent').notNull(),
    title: text('title').notNull(),
    status: text('status').$type<StepStatus>().notNull().default('pending'),
    dependsOn: jsonb('depends_on').$type<string[]>().notNull().default([]),
    output: jsonb('output').$type<unknown>(),
    summary: text('summary'),
    error: text('error'),
    mode: text('mode'), // 'llm' | 'heuristic' | 'remote'
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('run_steps_run_agent_uq').on(t.runId, t.agent), index('run_steps_run_idx').on(t.runId)]
);

/** Append-only activity log; the UI tails it with `id > cursor`. */
export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    agent: text('agent'),
    level: text('level').$type<EventLevel>().notNull().default('info'),
    message: text('message').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('run_events_run_idx').on(t.runId, t.id)]
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: id(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // report_md | listing_json | screenshot | json
    name: text('name').notNull(),
    mime: text('mime').notNull().default('text/plain'),
    content: text('content'),
    url: text('url'),
    createdAt: createdAt(),
  },
  (t) => [index('artifacts_run_idx').on(t.runId)]
);

/* ------------------------------------------------------------------ */
/* Metering                                                            */
/* ------------------------------------------------------------------ */

export const usageEvents = pgTable(
  'usage_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(), // run | llm_tokens
    quantity: integer('quantity').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [index('usage_org_kind_idx').on(t.orgId, t.kind, t.createdAt)]
);

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunStep = typeof runSteps.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
