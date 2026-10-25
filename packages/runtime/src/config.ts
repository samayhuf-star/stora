import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEnv } from '@stora-sh/agents';

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export interface RuntimeConfig {
  agentEnv: AgentEnv;
  concurrency: number;
  pollMs: number;
  /** Max agents running at once inside a single run */
  agentConcurrency: number;
  /** Heartbeat age after which a running run is considered abandoned */
  staleMs: number;
  keepWorkdirs: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    agentEnv: {
      workRoot: env.STORA_WORK_DIR ?? join(tmpdir(), 'stora-work'),
      allowLocalRepos: env.STORA_ALLOW_LOCAL_REPOS === '1',
      runnerApiUrl: env.STORA_RUNNER_URL || undefined,
      runnerToken: env.STORA_RUNNER_TOKEN || env.ORCHESTRATOR_TOKEN || undefined,
      googleApiKey: env.GOOGLE_GENERATIVE_AI_API_KEY || undefined,
      screenshotTimeoutMs: num(env.STORA_SCREENSHOT_TIMEOUT_MS, 20 * 60_000),
    },
    concurrency: Math.floor(num(env.STORA_WORKER_CONCURRENCY, 2)),
    pollMs: num(env.STORA_WORKER_POLL_MS, 1500),
    agentConcurrency: Math.floor(num(env.STORA_AGENT_CONCURRENCY, 3)),
    staleMs: num(env.STORA_RUN_STALE_MS, 120_000),
    keepWorkdirs: env.STORA_KEEP_WORKDIRS === '1',
  };
}
