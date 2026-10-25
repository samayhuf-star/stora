import { existsSync } from 'node:fs';
import { z } from 'zod';
import { AGENTS } from './agents/index.js';
import type { LLM } from './llm.js';
import type {
  AgentContext,
  AgentEnv,
  AgentName,
  AgentResults,
  CriticReport,
  LogLevel,
  PlanStep,
  ProjectInfo,
  RunGoal,
  RunPlan,
  RunSink,
  StepStatus,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

/** Agents the planner may drop. Everything else is fixed by the goal. */
const OPTIONAL: AgentName[] = ['listing', 'screenshots'];

const PlanSchema = z.object({
  include: z.array(z.enum(['listing', 'screenshots'])).max(2),
  rationale: z.string().min(5).max(400),
});

/** Adds every agent that an included agent `requires`, transitively. */
function withRequirements(names: Set<AgentName>): Set<AgentName> {
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of [...names]) {
      for (const r of AGENTS[n].requires) {
        if (!names.has(r)) {
          names.add(r);
          changed = true;
        }
      }
    }
  }
  return names;
}

export async function planRun(goal: RunGoal, project: ProjectInfo, env: AgentEnv, llm: LLM): Promise<RunPlan> {
  const base = new Set<AgentName>(
    (Object.values(AGENTS) as Array<(typeof AGENTS)[AgentName]>)
      .filter((a) => (a.goals as RunGoal[]).includes(goal))
      .map((a) => a.name)
  );
  // Screenshots need explicit opt-in and a configured runner.
  const screenshotsPossible = Boolean(project.settings.screenshots && env.runnerApiUrl && env.runnerToken);
  if (!screenshotsPossible) base.delete('screenshots');

  let planner: RunPlan['planner'] = 'heuristic';
  let rationale =
    `Goal "${goal}" runs ${[...base].join(', ')}.` +
    (base.has('screenshots') ? '' : goal === 'full_audit' ? ' Screenshots are skipped (not enabled or no runner configured).' : '');

  const optionalPresent = OPTIONAL.filter((o) => base.has(o));
  if (llm.available && optionalPresent.length > 0) {
    try {
      const r = await llm.json({
        system: 'You are the supervisor of a mobile-app launch agent team. You decide which optional agents are worth running.',
        prompt:
          `Goal: ${goal}\nProject: ${project.name}, platform ${project.platform}.\n` +
          `Project already has: description=${Boolean(project.settings.description)}, shortDescription=${Boolean(project.settings.shortDescription)}, ` +
          `targetKeywords=${(project.settings.targetKeywords ?? []).length}, screenshotsEnabled=${Boolean(project.settings.screenshots)}.\n` +
          `Optional agents available: ${optionalPresent.map((o) => `${o} (${AGENTS[o].description})`).join('; ')}.\n` +
          `Return JSON {"include": [subset of ${JSON.stringify(optionalPresent)}], "rationale": string}. ` +
          `Prefer including every available agent unless it would clearly waste the user's time or quota.`,
        schema: PlanSchema,
        maxTokens: 300,
        temperature: 0,
      });
      const keep = new Set<AgentName>(r.include.filter((x) => optionalPresent.includes(x)));
      for (const o of optionalPresent) if (!keep.has(o)) base.delete(o);
      rationale = r.rationale;
      planner = 'llm';
    } catch {
      /* fall back to the deterministic plan */
    }
  }

  const names = withRequirements(base);
  const steps: PlanStep[] = [...names]
    .map((n) => AGENTS[n])
    .map((a) => ({
      agent: a.name,
      title: a.title,
      description: a.description,
      dependsOn: [...new Set([...a.requires, ...a.after])].filter((d) => names.has(d)) as AgentName[],
    }))
    // Stable, readable order: dependencies first
    .sort((x, y) => depth(x.agent, names) - depth(y.agent, names) || x.agent.localeCompare(y.agent));
  return { goal, steps, rationale, planner };
}

function depth(n: AgentName, names: Set<AgentName>, memo = new Map<AgentName, number>()): number {
  const known = memo.get(n);
  if (known !== undefined) return known;
  const deps = [...AGENTS[n].requires, ...AGENTS[n].after].filter((d) => names.has(d));
  const d = deps.length ? 1 + Math.max(...deps.map((x) => depth(x, names, memo))) : 0;
  memo.set(n, d);
  return d;
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export interface ExecuteInput {
  runId: string;
  goal: RunGoal;
  project: ProjectInfo;
  env: AgentEnv;
  llm: LLM;
  sink: RunSink;
  /** Outputs of steps that already succeeded in a previous attempt */
  resume?: Partial<Record<AgentName, unknown>>;
  signal?: AbortSignal;
  /** Max agents running at once (default 3) */
  concurrency?: number;
  heartbeatMs?: number;
}

export interface ExecuteResult {
  status: 'succeeded' | 'failed' | 'canceled';
  plan: RunPlan;
  outcomes: Partial<Record<AgentName, { status: StepStatus; detail?: string }>>;
  results: Partial<AgentResults>;
  /** The Critic's report (without the markdown body) when it completed */
  report: Omit<CriticReport, 'reportMarkdown'> | null;
  error?: string;
  tokens: { input: number; output: number };
}

const TRANSIENT = /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|early EOF|RPC failed|HTTP 5\d\d|HTTP 429|fetch failed|socket hang up/i;
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 500);

export async function executeRun(input: ExecuteInput): Promise<ExecuteResult> {
  const { runId, goal, project, env, llm, sink } = input;
  const concurrency = Math.max(1, input.concurrency ?? 3);
  const plan = await planRun(goal, project, env, llm.fork());
  await sink.planReady(plan);
  await sink.log('supervisor', 'info', `Plan (${plan.planner}): ${plan.steps.map((s) => s.agent).join(' → ')} — ${plan.rationale}`);

  const run = new AbortController();
  input.signal?.addEventListener('abort', () => run.abort(), { once: true });

  const results: Partial<AgentResults> = {};
  const outcomes: ExecuteResult['outcomes'] = {};
  const state = new Map<AgentName, 'pending' | 'running' | StepStatus>(plan.steps.map((s) => [s.agent, 'pending']));
  const tokens = { input: 0, output: 0 };
  let canceled = false;

  // Resume: reuse earlier outputs, but only if the checkout they point at still exists.
  const resumeData = input.resume ?? {};
  const scoutDir = (resumeData.scout as AgentResults['scout'] | undefined)?.workDir;
  if (Object.keys(resumeData).length && scoutDir && existsSync(scoutDir)) {
    for (const step of plan.steps) {
      const prev = resumeData[step.agent];
      if (prev !== undefined && step.agent !== 'critic') {
        (results as Record<string, unknown>)[step.agent] = prev;
        outcomes[step.agent] = { status: 'succeeded', detail: 'reused from a previous attempt' };
        state.set(step.agent, 'succeeded');
        await sink.log('supervisor', 'info', `Resuming: reusing ${step.agent} output`);
      }
    }
  }

  const heartbeat = setInterval(async () => {
    try {
      const { cancelRequested } = await sink.heartbeat();
      if (cancelRequested && !run.signal.aborted) {
        canceled = true;
        run.abort();
      }
    } catch {
      /* a missed heartbeat is retried on the next tick */
    }
  }, input.heartbeatMs ?? 10_000);

  const running = new Map<AgentName, Promise<void>>();

  const finishStep = async (agent: AgentName, status: StepStatus, detail?: { summary?: string; error?: string; output?: unknown; mode?: any; llm?: LLM }) => {
    state.set(agent, status);
    outcomes[agent] = { status, detail: detail?.error ?? detail?.summary };
    const usage = detail?.llm?.usage() ?? { input: 0, output: 0 };
    tokens.input += usage.input;
    tokens.output += usage.output;
    await sink.stepFinished(agent, {
      status,
      output: detail?.output,
      summary: detail?.summary,
      error: detail?.error,
      mode: detail?.mode,
      tokensIn: usage.input,
      tokensOut: usage.output,
    });
  };

  const launch = (step: PlanStep) => {
    const def = AGENTS[step.agent];
    state.set(step.agent, 'running');
    const p = (async () => {
      await sink.stepStarted(step.agent);
      const stepLlm = llm.fork();
      const ctl = new AbortController();
      run.signal.addEventListener('abort', () => ctl.abort(), { once: true });
      const ctx: AgentContext = {
        runId,
        goal,
        project,
        env,
        llm: stepLlm,
        results: { ...results },
        outcomes: { ...outcomes },
        signal: ctl.signal,
        log: (level: LogLevel, message: string) => void sink.log(step.agent, level, message).catch(() => {}),
        artifact: (a) => sink.artifact(a),
      };
      const attemptOnce = async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            def.run(ctx),
            new Promise<never>((_, rej) => {
              timer = setTimeout(() => {
                ctl.abort();
                rej(new Error(`${def.title} timed out after ${Math.round(def.timeoutMs / 1000)}s`));
              }, def.timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        let outcome;
        try {
          outcome = await attemptOnce();
        } catch (e) {
          if (run.signal.aborted || !TRANSIENT.test(short(e))) throw e;
          ctx.log('warn', `Transient error (${short(e)}); retrying once`);
          await new Promise((r) => setTimeout(r, 1500));
          outcome = await attemptOnce();
        }
        if (outcome.skipped) {
          await finishStep(step.agent, 'skipped', { summary: outcome.skipped, llm: stepLlm, mode: outcome.mode });
          return;
        }
        (results as Record<string, unknown>)[step.agent] = outcome.output;
        await finishStep(step.agent, 'succeeded', { summary: outcome.summary, output: outcome.output, mode: outcome.mode, llm: stepLlm });
      } catch (e) {
        const msg = run.signal.aborted && canceled ? 'Canceled' : short(e);
        await sink.log(step.agent, 'error', msg).catch(() => {});
        await finishStep(step.agent, 'failed', { error: msg, llm: stepLlm });
      }
    })().finally(() => running.delete(step.agent));
    running.set(step.agent, p);
  };

  try {
    // Scheduler loop: launch whatever is ready, then wait for any step to finish.
    for (;;) {
      if (run.signal.aborted) break;
      let progressed = false;
      for (const step of plan.steps) {
        if (state.get(step.agent) !== 'pending') continue;
        const deps = step.dependsOn;
        if (!deps.every((d) => !['pending', 'running'].includes(state.get(d) ?? 'succeeded'))) continue; // wait
        const def = AGENTS[step.agent];
        const blocked = def.requires.find((r) => state.get(r) !== 'succeeded');
        if (blocked) {
          await sink.stepStarted(step.agent);
          await finishStep(step.agent, 'skipped', { summary: `Skipped: ${blocked} did not complete` });
          progressed = true;
          continue;
        }
        if (running.size >= concurrency) continue;
        launch(step);
        progressed = true;
      }
      if (running.size === 0 && !progressed) break; // nothing running, nothing launchable => done
      if (running.size > 0) await Promise.race(running.values());
    }
    // Make sure nothing is left dangling after a cancel.
    await Promise.allSettled(running.values());
    if (run.signal.aborted) {
      for (const step of plan.steps) {
        if (state.get(step.agent) === 'pending') {
          await sink.stepStarted(step.agent).catch(() => {});
          await finishStep(step.agent, 'skipped', { summary: 'Skipped: run was canceled' });
        }
      }
    }
  } finally {
    clearInterval(heartbeat);
  }

  if (canceled || (input.signal?.aborted ?? false)) {
    return { status: 'canceled', plan, outcomes, results, report: null, error: 'Canceled', tokens };
  }
  const critic = results.critic;
  if (!critic) {
    const failed = Object.entries(outcomes).find(([, o]) => o?.status === 'failed');
    return { status: 'failed', plan, outcomes, results, report: null, error: failed ? `${failed[0]}: ${failed[1]?.detail}` : 'The Critic did not produce a report', tokens };
  }
  const { reportMarkdown: _md, ...report } = critic;
  return { status: 'succeeded', plan, outcomes, results, report, tokens };
}

/* ------------------------------------------------------------------ */
/* In-memory sink (tests, CLI)                                         */
/* ------------------------------------------------------------------ */

export class MemorySink implements RunSink {
  plan: RunPlan | null = null;
  steps = new Map<AgentName, { status: string; summary?: string; error?: string; mode?: string; output?: unknown }>();
  logs: Array<{ agent: string; level: LogLevel; message: string }> = [];
  artifacts: Array<{ kind: string; name: string; mime?: string; content?: string; url?: string }> = [];
  order: string[] = [];
  cancel = false;
  constructor(private onLog?: (line: string) => void) {}
  async planReady(plan: RunPlan) {
    this.plan = plan;
  }
  async stepStarted(agent: AgentName) {
    this.steps.set(agent, { status: 'running' });
    this.order.push(`start:${agent}`);
  }
  async stepFinished(agent: AgentName, r: { status: string; summary?: string; error?: string; mode?: string; output?: unknown }) {
    this.steps.set(agent, { status: r.status, summary: r.summary, error: r.error, mode: r.mode, output: r.output });
    this.order.push(`end:${agent}`);
  }
  async log(agent: AgentName | 'supervisor', level: LogLevel, message: string) {
    this.logs.push({ agent, level, message });
    this.onLog?.(`[${agent}] ${message}`);
  }
  async artifact(a: { kind: string; name: string; mime?: string; content?: string; url?: string }) {
    this.artifacts.push(a);
  }
  async heartbeat() {
    return { cancelRequested: this.cancel };
  }
}
