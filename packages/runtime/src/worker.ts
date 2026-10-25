import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  appendEvent,
  claimNextRun,
  finishRun,
  getSteps,
  type Db,
} from '@stora-sh/db';
import { createLLM, executeRun, type AgentName, type LLM, type ProjectInfo, type RunGoal } from '@stora-sh/agents';
import { loadConfig, type RuntimeConfig } from './config.js';
import { DbSink } from './sink.js';

type Claim = NonNullable<Awaited<ReturnType<typeof claimNextRun>>>;

export interface WorkerOptions {
  db: Db;
  config?: RuntimeConfig;
  workerId?: string;
  /** Override for tests; defaults to a provider chosen from env keys */
  llmFactory?: () => LLM;
  log?: (msg: string) => void;
}

export interface WorkerHandle {
  readonly workerId: string;
  /** Stops claiming and waits for in-flight runs to finish */
  stop: () => Promise<void>;
  /** Claims and processes at most one run; resolves true if a run was handled (for tests/cron-style use) */
  tick: () => Promise<boolean>;
}

export function startWorker(opts: WorkerOptions): WorkerHandle {
  const config = opts.config ?? loadConfig();
  const workerId = opts.workerId ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
  const log = opts.log ?? ((m: string) => console.log(`[worker ${workerId}] ${m}`));
  const llmFactory = opts.llmFactory ?? (() => createLLM());
  const inflight = new Set<Promise<void>>();
  let stopped = false;
  let wake: (() => void) | null = null;

  async function processRun(claim: Claim) {
    const { run, project, org } = claim;
    const startedAt = Date.now();
    log(`run ${run.id} claimed (${run.goal}, attempt ${run.attempts})`);
    const info: ProjectInfo = {
      id: project.id,
      name: project.name,
      repoUrl: project.repoUrl,
      branch: project.branch,
      platform: project.platform,
      bundleId: project.bundleId,
      packageName: project.packageName,
      settings: project.settings,
    };
    const sink = new DbSink(opts.db, run.id, org.id);
    const workDir = join(config.agentEnv.workRoot, run.id);
    try {
      // A retried run reuses what already finished (the supervisor verifies the checkout still exists).
      const resume: Partial<Record<AgentName, unknown>> = {};
      if (run.attempts > 1) {
        for (const s of await getSteps(opts.db, run.id)) {
          if (s.status === 'succeeded' && s.output != null) resume[s.agent as AgentName] = s.output;
        }
        await appendEvent(opts.db, run.id, 'supervisor', 'warn', `Resuming after a worker interruption (attempt ${run.attempts})`);
      }
      const result = await executeRun({
        runId: run.id,
        goal: run.goal as RunGoal,
        project: info,
        env: config.agentEnv,
        llm: llmFactory(),
        sink,
        resume,
        concurrency: config.agentConcurrency,
      });
      const summary = {
        ...(result.report ?? {}),
        outcomes: result.outcomes,
        planner: result.plan.planner,
        rationale: result.plan.rationale,
        tokens: result.tokens,
        durationMs: Date.now() - startedAt,
      };
      await finishRun(opts.db, run.id, result.status, result.report ? summary : { outcomes: result.outcomes }, result.error ?? null);
      log(`run ${run.id} ${result.status} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      log(`run ${run.id} crashed: ${msg}`);
      await appendEvent(opts.db, run.id, 'supervisor', 'error', `Run crashed: ${msg}`).catch(() => {});
      await finishRun(opts.db, run.id, 'failed', null, msg).catch(() => {});
    } finally {
      if (!config.keepWorkdirs) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function claimOne(): Promise<Claim | null> {
    try {
      return await claimNextRun(opts.db, workerId, { staleMs: config.staleMs });
    } catch (e) {
      log(`claim failed: ${(e as Error).message}`);
      return null;
    }
  }

  const loop = (async () => {
    while (!stopped) {
      if (inflight.size < config.concurrency) {
        const claim = await claimOne();
        if (claim) {
          const p = processRun(claim).finally(() => inflight.delete(p));
          inflight.add(p);
          continue; // there may be more work queued right behind this one
        }
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, config.pollMs).unref?.();
      });
    }
  })();

  return {
    workerId,
    async stop() {
      stopped = true;
      wake?.();
      await loop;
      await Promise.allSettled([...inflight]);
    },
    async tick() {
      const claim = await claimOne();
      if (!claim) return false;
      await processRun(claim);
      return true;
    },
  };
}
