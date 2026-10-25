import {
  addArtifact,
  appendEvent,
  heartbeat,
  initSteps,
  recordLlmUsage,
  savePlan,
  updateStep,
  type Db,
} from '@stora-sh/db';
import type { AgentName, LogLevel, RunPlan, RunSink, StepResult } from '@stora-sh/agents';

/** Persists everything the agent team does for one run into Postgres. */
export class DbSink implements RunSink {
  private tokens = 0;
  constructor(
    private db: Db,
    private runId: string,
    private orgId: string
  ) {}

  async planReady(plan: RunPlan) {
    await savePlan(this.db, this.runId, plan);
    await initSteps(
      this.db,
      this.runId,
      plan.steps.map((s) => ({ agent: s.agent, title: s.title, dependsOn: s.dependsOn }))
    );
  }

  async stepStarted(agent: AgentName) {
    await updateStep(this.db, this.runId, agent, { status: 'running', error: null });
    await appendEvent(this.db, this.runId, agent, 'info', 'Started');
  }

  async stepFinished(agent: AgentName, r: StepResult) {
    await updateStep(this.db, this.runId, agent, {
      status: r.status,
      output: r.output ?? null,
      summary: r.summary ?? null,
      error: r.error ?? null,
      mode: r.mode ?? null,
      tokensIn: r.tokensIn ?? 0,
      tokensOut: r.tokensOut ?? 0,
    });
    const total = (r.tokensIn ?? 0) + (r.tokensOut ?? 0);
    if (total > 0) {
      this.tokens += total;
      await recordLlmUsage(this.db, this.orgId, this.runId, total);
    }
    const icon = r.status === 'succeeded' ? 'Finished' : r.status === 'skipped' ? 'Skipped' : 'Failed';
    await appendEvent(this.db, this.runId, agent, r.status === 'failed' ? 'error' : 'info', `${icon}${r.summary ? `: ${r.summary}` : r.error ? `: ${r.error}` : ''}`);
  }

  async log(agent: AgentName | 'supervisor', level: LogLevel, message: string) {
    await appendEvent(this.db, this.runId, agent, level, message);
  }

  async artifact(a: { kind: string; name: string; mime?: string; content?: string; url?: string }) {
    await addArtifact(this.db, this.runId, a);
  }

  heartbeat() {
    return heartbeat(this.db, this.runId);
  }
}
