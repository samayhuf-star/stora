import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENTS, createLLM, executeRun, MemorySink, planRun, validateRepoUrl, RepoUrlError } from '../src/index.js';
import { safeRead, walk } from '../src/util/fs.js';
import { buildKeywordField } from '../src/agents/listing.js';
import { cleanApp, problemApp } from './fixtures.js';
import { baseEnv, project, scriptedLLM } from './helpers.js';

const none = () => createLLM({ provider: 'none' });

async function run(repo: string, opts: { llm?: ReturnType<typeof scriptedLLM>; goal?: any; resume?: any; settings?: any; env?: any; platform?: any } = {}) {
  const sink = new MemorySink();
  const res = await executeRun({
    runId: `r-${Math.random().toString(36).slice(2, 8)}`,
    goal: opts.goal ?? 'full_audit',
    project: project(repo, { settings: opts.settings ?? {}, platform: opts.platform ?? 'both' }),
    env: baseEnv(opts.env),
    llm: opts.llm ?? none(),
    sink,
    resume: opts.resume,
    heartbeatMs: 20,
  });
  return { res, sink };
}

describe('planning', () => {
  it('builds goal-specific plans with dependencies and no screenshots unless runner is configured', async () => {
    const p = project('https://github.com/o/r', { settings: { screenshots: true } });
    const full = await planRun('full_audit', p, baseEnv(), none());
    expect(full.steps.map((s) => s.agent)).toEqual(['scout', 'aso', 'compliance', 'listing', 'critic'].sort((a, b) => full.steps.findIndex((s) => s.agent === a) - full.steps.findIndex((s) => s.agent === b)));
    expect(full.steps.map((s) => s.agent)).not.toContain('screenshots');
    expect(full.steps[0].agent).toBe('scout');
    expect(full.steps.at(-1)!.agent).toBe('critic');
    expect(full.steps.find((s) => s.agent === 'critic')!.dependsOn.sort()).toEqual(['aso', 'compliance', 'listing', 'scout']);

    const withRunner = await planRun('full_audit', p, baseEnv({ runnerApiUrl: 'http://x', runnerToken: 't' }), none());
    expect(withRunner.steps.map((s) => s.agent)).toContain('screenshots');

    const comp = await planRun('compliance', p, baseEnv(), none());
    expect(comp.steps.map((s) => s.agent)).toEqual(['scout', 'compliance', 'critic']);
    const listing = await planRun('listing', p, baseEnv(), none());
    expect(listing.steps.map((s) => s.agent)).toEqual(expect.arrayContaining(['scout', 'aso', 'listing', 'critic']));
  });

  it('lets the LLM drop optional agents but never required ones or invented ones', async () => {
    const p = project('https://github.com/o/r');
    const dropped = await planRun('full_audit', p, baseEnv(), scriptedLLM({ 'Optional agents available': () => ({ include: [], rationale: 'user already supplied full metadata' }) }));
    expect(dropped.planner).toBe('llm');
    expect(dropped.steps.map((s) => s.agent)).not.toContain('listing');
    expect(dropped.steps.map((s) => s.agent)).toEqual(expect.arrayContaining(['scout', 'compliance', 'aso', 'critic']));
    // invalid planner output (not in enum) -> deterministic plan
    const bad = await planRun('full_audit', p, baseEnv(), scriptedLLM({ 'Optional agents available': () => ({ include: ['compliance', 'rm -rf'], rationale: 'nope nope' }) }));
    expect(bad.planner).toBe('heuristic');
    expect(bad.steps.map((s) => s.agent)).toContain('listing');
  });
});

describe('full run, heuristic mode (no API key)', () => {
  it('finds the planted problems in the problematic app', async () => {
    const { res, sink } = await run(problemApp(), { settings: { targetKeywords: ['workout log', 'fitness'] } });
    expect(res.status).toBe('succeeded');
    for (const a of ['scout', 'compliance', 'aso', 'listing', 'critic'] as const) expect(sink.steps.get(a)?.status, a).toBe('succeeded');
    expect([...sink.steps.values()].every((s) => s.mode === 'heuristic')).toBe(true);

    const scout = res.results.scout!;
    expect(scout.framework).toBe('expo');
    expect(scout.bundleId).toBe('com.acme.fittrack');
    expect(scout.packageName).toBe('com.acme.fittrack');
    expect(scout.platforms.sort()).toEqual(['android', 'ios']);
    expect(scout.sdks.ads).toContain('react-native-google-mobile-ads');
    expect(scout.screens).toEqual(expect.arrayContaining(['Workout Log', 'Progress Charts', 'Weekly Goals']));

    const ids = res.results.compliance!.issues.map((i) => i.id);
    expect(ids).toContain('ios-ats-disabled'); // from @stora-sh/compliance
    expect(ids).toContain('agents-ios-att-missing');
    expect(ids).toContain('agents-ios-sign-in-with-apple');
    expect(ids).toContain('agents-android-restricted-READ_SMS');
    expect(ids).toContain('agents-android-restricted-ACCESS_BACKGROUND_LOCATION');
    expect(ids).toContain('agents-android-debuggable');
    expect(ids).toContain('agents-android-cleartext');
    expect(ids).toContain('agents-ios-generic-NSCameraUsageDescription');
    expect(ids.some((i) => i.startsWith('agents-secret-'))).toBe(true);
    expect(ids).toContain('common-no-privacy-policy'); // really absent here, so the base rule stands
    // The leaked key itself must never be echoed into a report.
    expect(JSON.stringify(res.results.compliance)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(res.results.compliance!.score).toBeLessThan(40);

    expect(res.report!.verdict).toBe('not_ready');
    expect(res.report!.blockers.length).toBeGreaterThan(3);
    const kinds = sink.artifacts.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['listing_json', 'listing_md', 'report_md']));
    const md = sink.artifacts.find((a) => a.kind === 'report_md')!.content!;
    expect(md).toContain('| Area | Score | Weight | Notes |');
    expect(md).toContain('## Action checklist');

    // The listing agent must respect store limits and avoid promotional terms even in heuristic mode.
    const l = res.results.listing!;
    expect(l.ios!.name.length).toBeLessThanOrEqual(30);
    expect(l.ios!.name).not.toMatch(/\b(best|free)\b/i);
    expect(l.ios!.keywords.length).toBeLessThanOrEqual(100);
    expect(l.ios!.keywords).not.toContain(' ');
    expect(l.android!.shortDescription.length).toBeLessThanOrEqual(80);
  });

  it('parallelises independent agents after the scout', async () => {
    const { sink } = await run(problemApp());
    const o = sink.order;
    expect(o.indexOf('end:scout')).toBeLessThan(o.indexOf('start:compliance'));
    expect(o.indexOf('end:scout')).toBeLessThan(o.indexOf('start:aso'));
    expect(o.indexOf('start:aso')).toBeLessThan(o.indexOf('end:compliance')); // overlapped
    expect(o.indexOf('start:critic')).toBeGreaterThan(Math.max(o.indexOf('end:compliance'), o.indexOf('end:aso'), o.indexOf('end:listing')));
  });

  it('rates the clean Flutter app much higher and corrects the base privacy-policy false positive', async () => {
    const { res } = await run(cleanApp(), { settings: { supportUrl: 'https://recipebox.example/help', category: 'Food & Drink' } });
    expect(res.status).toBe('succeeded');
    const c = res.results.compliance!;
    expect(res.results.scout!.framework).toBe('flutter');
    expect(res.results.scout!.privacyPolicyUrl).toBe('https://recipebox.example/privacy');
    expect(c.issues.some((i) => i.id === 'common-no-privacy-policy')).toBe(false);
    expect(c.suppressed.map((s) => s.id)).toContain('common-no-privacy-policy');
    expect(c.issues.filter((i) => i.severity === 'critical' || i.severity === 'high')).toHaveLength(0);
    expect(res.report!.readinessScore).toBeGreaterThan(75);
    expect(res.report!.verdict).not.toBe('not_ready');
    expect(res.report!.blockers).toHaveLength(0);
  });

  it('only runs the agents the goal needs', async () => {
    const { res, sink } = await run(cleanApp(), { goal: 'compliance' });
    expect([...sink.steps.keys()].sort()).toEqual(['compliance', 'critic', 'scout']);
    expect(res.results.aso).toBeUndefined();
    expect(res.report).not.toBeNull();
  });
});

describe('LLM mode', () => {
  it('uses the LLM at each agent, validates it, and still enforces store limits', async () => {
    const { res, sink } = await run(problemApp(), { llm: scriptedLLM() });
    expect(res.status).toBe('succeeded');
    expect(sink.plan!.planner).toBe('llm');
    for (const a of ['scout', 'compliance', 'aso', 'listing', 'critic'] as const) expect(sink.steps.get(a)?.mode, a).toBe('llm');
    expect(res.tokens.input).toBeGreaterThan(0);
    expect(res.results.scout!.appSummary).toContain('workout logging');
    // LLM-supplied remediation: unknown issue ids are dropped
    expect(res.results.compliance!.remediation[0].relatedIssueIds).not.toContain('made-up-id');
    // titles over 30 chars or with "best" are discarded
    expect(res.results.aso!.titleCandidates.every((t) => t.length <= 30 && !/best/i.test(t))).toBe(true);
    // the over-long / promotional listing the "LLM" returned was repaired, and the repairs were recorded
    const l = res.results.listing!;
    expect(l.ios!.name.length).toBeLessThanOrEqual(30);
    expect(l.ios!.name).not.toMatch(/\b(best|free)\b/i);
    expect(l.ios!.promotionalText.length).toBeLessThanOrEqual(170);
    expect(l.android!.shortDescription.length).toBeLessThanOrEqual(80);
    expect(l.ios!.keywords).toBe('workout,gym,tracker,fitness');
    expect(l.adjustments.length).toBeGreaterThanOrEqual(4);
    expect(res.report!.crossChecks.some((c) => c.startsWith('Reviewer:'))).toBe(true);
  });

  it('falls back to heuristics when one agent\'s LLM reply is invalid, without failing the run', async () => {
    const llm = scriptedLLM({ 'Suggest ASO improvements': () => ({ nonsense: true }) });
    const { res, sink } = await run(cleanApp(), { llm });
    expect(res.status).toBe('succeeded');
    expect(sink.steps.get('aso')!.mode).toBe('heuristic');
    expect(sink.steps.get('compliance')!.mode).toBe('heuristic'); // clean app: nothing to triage
    expect(sink.logs.some((l) => l.agent === 'aso' && l.level === 'warn')).toBe(true);
    expect(res.results.aso!.keywordCandidates.length).toBeGreaterThan(0);
  });
});

describe('robustness', () => {
  it('skips dependants and fails clearly when the repository cannot be cloned', async () => {
    const { res, sink } = await run('https://example.invalid/nope/nothing.git');
    expect(res.status).toBe('failed');
    expect(sink.steps.get('scout')!.status).toBe('failed');
    for (const a of ['compliance', 'aso', 'listing'] as const) {
      expect(sink.steps.get(a)!.status).toBe('skipped');
      expect(sink.steps.get(a)!.summary).toContain('scout did not complete');
    }
    expect(res.error).toContain('scout');
  });

  it('refuses unsafe repository URLs before running git', async () => {
    const { res, sink } = await run('http://169.254.169.254/latest', { env: { allowLocalRepos: false } });
    expect(res.status).toBe('failed');
    expect(sink.steps.get('scout')!.error).toMatch(/https|not allowed/i);
  });

  it('isolates a failing agent: the others finish and the Critic reports the gap', async () => {
    const spy = vi.spyOn(AGENTS.aso, 'run').mockRejectedValueOnce(new Error('boom: ASO exploded'));
    try {
      const { res, sink } = await run(cleanApp());
      expect(sink.steps.get('aso')!.status).toBe('failed');
      expect(sink.steps.get('compliance')!.status).toBe('succeeded');
      expect(sink.steps.get('listing')!.status).toBe('succeeded'); // aso is only an ordering dep for listing
      expect(res.status).toBe('succeeded');
      expect(res.report!.checklist.some((c) => c.title.includes('Re-run the aso agent') && c.detail.includes('boom'))).toBe(true);
      expect(res.report!.breakdown.find((b) => b.area === 'store_listing')!.score).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('times a slow agent out without blocking the rest', async () => {
    const orig = AGENTS.aso.timeoutMs;
    AGENTS.aso.timeoutMs = 50;
    const spy = vi.spyOn(AGENTS.aso, 'run').mockImplementationOnce(() => new Promise(() => {}));
    try {
      const { res, sink } = await run(cleanApp());
      expect(sink.steps.get('aso')!.status).toBe('failed');
      expect(sink.steps.get('aso')!.error).toContain('timed out');
      expect(res.status).toBe('succeeded');
    } finally {
      AGENTS.aso.timeoutMs = orig;
      spy.mockRestore();
    }
  });

  it('retries once on a transient error', async () => {
    const real = AGENTS.aso.run;
    let calls = 0;
    const spy = vi.spyOn(AGENTS.aso, 'run').mockImplementation(async (ctx) => {
      calls++;
      if (calls === 1) throw new Error('fetch failed: ECONNRESET');
      return real.call(AGENTS.aso, ctx);
    });
    try {
      const { sink } = await run(cleanApp());
      expect(calls).toBe(2);
      expect(sink.steps.get('aso')!.status).toBe('succeeded');
    } finally {
      spy.mockRestore();
    }
  });

  it('cancels mid-run via heartbeat and marks pending steps skipped', async () => {
    const sink = new MemorySink();
    const repo = cleanApp();
    const spy = vi.spyOn(AGENTS.compliance, 'run').mockImplementation(
      (ctx) =>
        new Promise((_, rej) => {
          sink.cancel = true; // the user clicked cancel while compliance was running
          ctx.signal.addEventListener('abort', () => rej(new Error('aborted')));
        })
    );
    try {
      const res = await executeRun({ runId: 'cancel-1', goal: 'full_audit', project: project(repo), env: baseEnv(), llm: none(), sink, heartbeatMs: 20 });
      expect(res.status).toBe('canceled');
      expect(sink.steps.get('compliance')!.error).toBe('Canceled');
      expect(sink.steps.get('critic')!.status).toBe('skipped');
    } finally {
      spy.mockRestore();
    }
  });

  it('resumes from earlier outputs without re-running them (when the checkout still exists)', async () => {
    const repo = cleanApp();
    const env = baseEnv();
    const first = new MemorySink();
    const r1 = await executeRun({ runId: 'resume-1', goal: 'full_audit', project: project(repo), env, llm: none(), sink: first });
    expect(r1.status).toBe('succeeded');
    const scoutSpy = vi.spyOn(AGENTS.scout, 'run');
    const complianceSpy = vi.spyOn(AGENTS.compliance, 'run');
    try {
      const second = new MemorySink();
      const r2 = await executeRun({
        runId: 'resume-1',
        goal: 'full_audit',
        project: project(repo),
        env,
        llm: none(),
        sink: second,
        resume: { scout: r1.results.scout, compliance: r1.results.compliance, aso: r1.results.aso },
      });
      expect(r2.status).toBe('succeeded');
      expect(scoutSpy).not.toHaveBeenCalled();
      expect(complianceSpy).not.toHaveBeenCalled();
      expect(second.logs.some((l) => l.message.includes('Resuming: reusing scout'))).toBe(true);
      expect(r2.report!.readinessScore).toBe(r1.report!.readinessScore);
    } finally {
      scoutSpy.mockRestore();
      complianceSpy.mockRestore();
    }
  });
});

describe('safety helpers', () => {
  it('validates repository URLs', () => {
    expect(validateRepoUrl('https://github.com/storasource/stora')).toContain('github.com');
    for (const bad of ['http://github.com/a/b', 'ssh://git@github.com/a/b', 'git@github.com:a/b.git', 'https://user:pw@github.com/a/b', 'https://localhost/a', 'https://127.0.0.1/a', 'https://10.0.0.5/a', 'https://192.168.1.1/a', 'https://169.254.169.254/a', 'https://[::1]/a', 'https://intranet/a', 'ext::sh -c id', '/etc/passwd', 'file:///etc']) {
      expect(() => validateRepoUrl(bad), bad).toThrow(RepoUrlError);
    }
    expect(validateRepoUrl('/tmp/x', true)).toBe('/tmp/x');
  });

  it('never follows symlinks out of a checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sym-'));
    const secret = join(mkdtempSync(join(tmpdir(), 'secret-')), 'secret.txt');
    writeFileSync(secret, 'TOP SECRET');
    writeFileSync(join(root, 'ok.txt'), 'fine');
    symlinkSync(secret, join(root, 'README.md'));
    expect(await safeRead(root, 'ok.txt')).toBe('fine');
    expect(await safeRead(root, 'README.md')).toBeNull();
    expect(await safeRead(root, '../' + secret.split('/').slice(-2).join('/'))).toBeNull();
    expect((await walk(root)).files).toEqual(['ok.txt']);
  });

  it('builds a valid iOS keyword field', () => {
    const f = buildKeywordField(['workout log', 'gym tracker', 'fittrack app', 'a'.repeat(120)], ['FitTrack Tracker'], 100);
    expect(f).toBe('workout,log,gym');
    expect(f.length).toBeLessThanOrEqual(100);
  });
});
