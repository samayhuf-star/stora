import { z } from 'zod';
import type {
  AgentContext,
  AgentDefinition,
  ChecklistItem,
  CriticReport,
  ReadinessBreakdown,
} from '../types.js';
import { LIMITS, RISKY_TITLE_TERMS } from '../util/limits.js';
import { tokenize, UNTRUSTED_NOTICE } from '../util/text.js';

const ReviewSchema = z.object({
  narrative: z.string().min(20).max(1500),
  concerns: z.array(z.string().min(5).max(300)).max(8),
});

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function crossChecks(ctx: AgentContext): string[] {
  const { scout, listing, aso, screenshots } = ctx.results;
  const out: string[] = [];
  if (!scout) return out;
  const texts: string[] = [];
  if (listing?.ios) texts.push(listing.ios.description, listing.ios.promotionalText, listing.ios.subtitle);
  if (listing?.android) texts.push(listing.android.fullDescription, listing.android.shortDescription);
  const copy = texts.join('\n');

  if (/\b(no ads|ad[- ]free|without ads)\b/i.test(copy) && scout.sdks.ads.length) {
    out.push(`Listing claims the app has no ads, but ad SDK(s) were detected: ${scout.sdks.ads.join(', ')}.`);
  }
  if (/\b(no (data )?(tracking|collection)|doesn'?t collect|do not collect|collects no data)\b/i.test(copy) && (scout.sdks.analytics.length || scout.sdks.ads.length)) {
    out.push(`Listing says no data is collected, but analytics/ad SDK(s) are present (${[...scout.sdks.analytics, ...scout.sdks.ads].join(', ')}). This mismatch with the privacy label is a common rejection reason.`);
  }
  if (listing?.ios) {
    const title = new Set(tokenize(`${listing.ios.name} ${listing.ios.subtitle}`));
    const wasted = listing.ios.keywords.split(',').filter((k) => title.has(k));
    if (wasted.length) out.push(`App Store keyword field repeats words already indexed from the name/subtitle: ${wasted.join(', ')}.`);
    if (RISKY_TITLE_TERMS.test(`${listing.ios.name} ${listing.ios.subtitle}`)) out.push('App Store name/subtitle contains a promotional term that reviewers reject.');
  }
  if (listing?.android && listing.android.shortDescription.length < 30) out.push('Play short description is very short; it is the most visible text in search results.');
  if (listing && scout.privacyPolicyUrl && !copy.includes(scout.privacyPolicyUrl)) {
    // Not an error; a gentle nudge that is easy to miss.
    out.push('A privacy policy URL exists but is not referenced in the drafted listing; add it in App Store Connect / Play Console as well.');
  }
  if (screenshots && screenshots.urls.length > 0 && screenshots.urls.length < 2) out.push('Only one screenshot was captured; Google Play requires at least two phone screenshots.');
  if (aso && listing?.ios && aso.inputMetadata.name !== listing.ios.name && !listing.ios.name.startsWith(aso.inputMetadata.name.slice(0, 10))) {
    out.push(`The drafted App Store name ("${listing.ios.name}") differs from the name the ASO agent scored ("${aso.inputMetadata.name}").`);
  }
  return out;
}

export const criticAgent: AgentDefinition<'critic'> = {
  name: 'critic',
  title: 'Critic',
  description: 'Cross-checks every agent\'s output, computes launch readiness and writes the final report and checklist.',
  goals: ['full_audit', 'compliance', 'aso', 'listing'],
  requires: [],
  after: ['scout', 'compliance', 'aso', 'listing', 'screenshots'],
  timeoutMs: 3 * 60_000,
  async run(ctx) {
    const { scout, compliance, aso, listing, screenshots } = ctx.results;
    const failedAgents = Object.entries(ctx.outcomes).filter(([, o]) => o?.status === 'failed');
    if (!scout) throw new Error(`Scout did not complete, so there is nothing to review.${failedAgents[0]?.[1]?.detail ? ` (${failedAgents[0][1]!.detail})` : ''}`);

    /* --------------------------- readiness breakdown --------------------------- */
    const breakdown: ReadinessBreakdown[] = [];
    const platforms = ctx.project.platform === 'both' ? scout.platforms : scout.platforms.filter((p) => p === ctx.project.platform);

    if (ctx.outcomes.compliance) {
      breakdown.push(
        compliance
          ? { area: 'compliance', score: compliance.score, weight: 45, note: `${compliance.issues.length} finding(s); ~${Math.round(compliance.passLikelihood * 100)}% first-pass approval` }
          : { area: 'compliance', score: 0, weight: 45, note: 'Compliance could not be assessed (agent did not finish)' }
      );
    }
    if (ctx.outcomes.aso) {
      if (aso) {
        const base = aso.scores.reduce((n, x) => n + x.score, 0) / Math.max(1, aso.scores.length);
        const penalty = aso.findings.reduce((n, f) => n + (f.severity === 'high' ? 10 : f.severity === 'medium' ? 4 : 1), 0);
        breakdown.push({ area: 'store_listing', score: clamp(base - penalty), weight: 25, note: `${aso.findings.length} ASO finding(s)${listing ? '; listing draft ready' : ''}` });
      } else breakdown.push({ area: 'store_listing', score: 0, weight: 25, note: 'ASO could not be assessed (agent did not finish)' });
    }
    if (ctx.outcomes.screenshots) {
      const n = screenshots?.urls.length ?? 0;
      breakdown.push({
        area: 'assets',
        score: n >= 3 ? 100 : n > 0 ? 60 : 40,
        weight: 15,
        note: n ? `${n} screenshot(s) captured` : ctx.outcomes.screenshots.status === 'skipped' ? 'Screenshots not generated — supply your own before submitting' : 'Screenshot capture failed',
      });
    }

    const meta: Array<[string, boolean]> = [
      ['app name', Boolean(scout.appName)],
      ['version', Boolean(scout.version)],
      ['store category', Boolean(scout.category)],
      ['privacy policy URL', Boolean(scout.privacyPolicyUrl)],
      ['support URL', Boolean(ctx.project.settings.supportUrl)],
      ['description (200+ chars)', (scout.description ?? '').length >= 200 || Boolean(listing)],
    ];
    if (platforms.includes('ios')) meta.push(['iOS bundle identifier', Boolean(scout.bundleId)]);
    if (platforms.includes('android')) meta.push(['Android application id', Boolean(scout.packageName)]);
    const missingMeta = meta.filter(([, ok]) => !ok).map(([k]) => k);
    breakdown.push({ area: 'metadata', score: clamp((100 * (meta.length - missingMeta.length)) / meta.length), weight: 15, note: missingMeta.length ? `Missing: ${missingMeta.join(', ')}` : 'All key metadata present' });

    const totalWeight = breakdown.reduce((n, b) => n + b.weight, 0) || 1;
    const readinessScore = clamp(breakdown.reduce((n, b) => n + b.score * b.weight, 0) / totalWeight);

    /* -------------------------------- blockers -------------------------------- */
    const blockers: string[] = [];
    for (const i of compliance?.issues ?? []) if (i.severity === 'critical' || i.severity === 'high') blockers.push(`${i.title} — ${i.message}`);
    if (!scout.privacyPolicyUrl && !(compliance?.issues ?? []).some((i) => /privacy-policy|no-privacy/i.test(i.id))) blockers.push('No public privacy policy URL found; both stores require one.');
    if (platforms.includes('ios') && !scout.bundleId) blockers.push('iOS bundle identifier is unknown.');
    if (platforms.includes('android') && !scout.packageName) blockers.push('Android application id is unknown.');
    for (const f of aso?.findings ?? []) if (f.severity === 'high') blockers.push(`ASO: ${f.message}`);
    if (platforms.length === 0) blockers.push('No iOS or Android project was detected in the repository.');

    const checks = crossChecks(ctx);
    const criticals = (compliance?.issues ?? []).filter((i) => i.severity === 'critical').length;
    const verdict: CriticReport['verdict'] = criticals > 0 || blockers.length >= 3 || readinessScore < 60 ? 'not_ready' : blockers.length > 0 || readinessScore < 85 ? 'almost_ready' : 'ready';

    /* -------------------------------- checklist -------------------------------- */
    const items: Array<Omit<ChecklistItem, 'priority'>> = [];
    for (const i of (compliance?.issues ?? []).filter((x) => x.severity === 'critical' || x.severity === 'high')) {
      items.push({ title: i.title, detail: i.recommendation ?? i.message, owner: 'compliance', severity: 'blocker' });
    }
    if (!scout.privacyPolicyUrl) items.push({ title: 'Publish a privacy policy and set its URL', detail: 'Add the public URL to the project settings, app config and both store consoles.', owner: 'you', severity: 'blocker' });
    for (const f of (aso?.findings ?? []).filter((x) => x.severity === 'high')) items.push({ title: 'Fix a store metadata limit', detail: f.message, owner: 'aso', severity: 'blocker' });
    for (const r of compliance?.remediation ?? []) {
      if (!items.some((x) => x.detail === r.action)) items.push({ title: r.action, detail: `Impact ${r.impact}, effort ${r.effort}.`, owner: 'compliance', severity: 'important' });
    }
    for (const f of (aso?.findings ?? []).filter((x) => x.severity !== 'high')) items.push({ title: 'Improve store metadata', detail: f.message, owner: 'aso', severity: f.severity === 'medium' ? 'important' : 'nice_to_have' });
    for (const c of checks) items.push({ title: 'Resolve a cross-check mismatch', detail: c, owner: 'critic', severity: /claims|says no data/.test(c) ? 'blocker' : 'important' });
    if (ctx.outcomes.screenshots && !(screenshots?.urls.length)) items.push({ title: 'Provide store screenshots', detail: 'Capture 3–10 screenshots per device size; Google Play requires at least 2.', owner: 'you', severity: 'important' });
    if (missingMeta.length) items.push({ title: 'Complete project metadata', detail: `Missing: ${missingMeta.join(', ')}.`, owner: 'you', severity: 'important' });
    for (const [agent, o] of failedAgents) items.push({ title: `Re-run the ${agent} agent`, detail: o?.detail ?? 'The agent failed.', owner: 'you', severity: 'important' });
    const order = { blocker: 0, important: 1, nice_to_have: 2 } as const;
    const checklist: ChecklistItem[] = items
      .filter((x, i, a) => a.findIndex((y) => y.title === x.title && y.detail === x.detail) === i)
      .sort((a, b) => order[a.severity] - order[b.severity])
      .slice(0, 25)
      .map((x, i) => ({ ...x, priority: i + 1 }));

    /* --------------------------- narrative (LLM optional) --------------------------- */
    const verdictText = { ready: 'looks ready to submit', almost_ready: 'is close, with a few things to fix first', not_ready: 'is not ready to submit yet' }[verdict];
    let narrative =
      `${scout.appName ?? ctx.project.name} ${verdictText} (readiness ${readinessScore}/100). ` +
      (blockers.length ? `${blockers.length} blocking issue(s) need attention, led by: ${blockers[0].slice(0, 140)}. ` : 'No blocking issues were found. ') +
      (checks.length ? `${checks.length} cross-check mismatch(es) between the listing and the code were flagged.` : '');
    let mode: 'llm' | 'heuristic' = 'heuristic';
    const extraConcerns: string[] = [];
    if (ctx.llm.available) {
      try {
        const r = await ctx.llm.json({
          system: `You are the final reviewer on an app-launch team; you read the other agents' outputs and catch what they missed. ${UNTRUSTED_NOTICE}`,
          prompt:
            `Review this launch audit. Write a 3-4 sentence executive narrative (plain text, direct, no hype) and list up to 5 concrete concerns the automated checks may have missed (contradictions between the listing and the app's capabilities, risky claims, missing disclosures). Do not repeat existing findings.\n` +
            `App: ${scout.appName}; summary: ${scout.appSummary}; SDKs: ${JSON.stringify(scout.sdks)}; permissions: ${[...scout.permissions.ios, ...scout.permissions.android].slice(0, 15).join(', ')}\n` +
            `Verdict: ${verdict}; readiness: ${readinessScore}/100; blockers: ${JSON.stringify(blockers.slice(0, 8))}\n` +
            `Existing cross-checks: ${JSON.stringify(checks)}\n` +
            (listing ? `Draft listing: ${JSON.stringify(listing).slice(0, 3500)}\n` : '') +
            `Return JSON: {"narrative": string, "concerns": string[]}`,
          schema: ReviewSchema,
          maxTokens: 1200,
        });
        narrative = r.narrative;
        extraConcerns.push(...r.concerns);
        mode = 'llm';
      } catch (e) {
        ctx.log('warn', `LLM review failed, using templated narrative: ${(e as Error).message}`);
      }
    }
    const allChecks = [...checks, ...extraConcerns.map((c) => `Reviewer: ${c}`)];

    /* ---------------------------------- report ---------------------------------- */
    const md: string[] = [
      `# Launch readiness report — ${scout.appName ?? ctx.project.name}`,
      '',
      `**Verdict:** ${verdict.replace('_', ' ').toUpperCase()} · **Readiness:** ${readinessScore}/100`,
      '',
      narrative,
      '',
      '## Readiness breakdown',
      '',
      '| Area | Score | Weight | Notes |',
      '|---|---:|---:|---|',
      ...breakdown.map((b) => `| ${b.area.replace('_', ' ')} | ${b.score} | ${b.weight}% | ${b.note} |`),
      '',
      '## App facts',
      '',
      '| Field | Value |',
      '|---|---|',
      `| Framework | ${scout.framework ?? 'unknown'} |`,
      `| Platforms | ${platforms.join(', ') || 'none detected'} |`,
      `| Version | ${scout.version ?? '—'} |`,
      `| Bundle ID | ${scout.bundleId ?? '—'} |`,
      `| Android package | ${scout.packageName ?? '—'} |`,
      `| Category | ${scout.category ?? '—'} |`,
      `| Privacy policy | ${scout.privacyPolicyUrl ?? 'not found'} |`,
      `| Permissions | ${[...scout.permissions.ios, ...scout.permissions.android].length} |`,
      '',
    ];
    if (compliance) {
      md.push('## Compliance findings', '', `Score **${compliance.score}/100 (${compliance.grade})** — ${compliance.assessment}`, '', '| Severity | Category | Finding | Fix |', '|---|---|---|---|');
      for (const i of compliance.issues) md.push(`| ${i.severity} | ${i.category} | ${i.title.replace(/\|/g, '/')} | ${(i.recommendation ?? '').replace(/\|/g, '/')} |`);
      if (compliance.issues.length === 0) md.push('| — | — | No issues detected | — |');
      for (const s of compliance.suppressed) md.push('', `> Note: base rule \`${s.id}\` was overridden — ${s.reason}`);
      md.push('');
    }
    if (aso) {
      md.push('## ASO', '', '| Platform | Score | Title | Description | Keywords |', '|---|---:|---:|---:|---:|');
      for (const s of aso.scores) md.push(`| ${s.platform} | ${s.score} (${s.grade}) | ${s.titleScore} | ${s.descriptionScore} | ${s.keywordsScore} |`);
      if (aso.findings.length) md.push('', '| Severity | Platform | Finding |', '|---|---|---|', ...aso.findings.map((f) => `| ${f.severity} | ${f.platform} | ${f.message.replace(/\|/g, '/')} |`));
      if (aso.keywordCandidates.length) md.push('', '| Keyword candidate | Score | Why |', '|---|---:|---|', ...aso.keywordCandidates.slice(0, 12).map((k) => `| ${k.keyword} | ${k.score} | ${k.reason.replace(/\|/g, '/')} |`));
      md.push('');
    }
    if (allChecks.length) md.push('## Cross-checks', '', '| # | Observation |', '|---:|---|', ...allChecks.map((c, i) => `| ${i + 1} | ${c.replace(/\|/g, '/')} |`), '');
    md.push('## Action checklist', '', '| # | Severity | Action | Detail | Owner |', '|---:|---|---|---|---|', ...checklist.map((c) => `| ${c.priority} | ${c.severity.replace('_', ' ')} | ${c.title.replace(/\|/g, '/')} | ${c.detail.replace(/\|/g, '/')} | ${c.owner} |`));
    if (checklist.length === 0) md.push('| — | — | Nothing outstanding | — | — |');
    md.push('', '---', `Generated by the Stora agent team (${Object.entries(ctx.outcomes).map(([a, o]) => `${a}: ${o?.status}`).join(', ')}). Automated checks reduce review risk but cannot guarantee approval.`);
    const reportMarkdown = md.join('\n');
    await ctx.artifact({ kind: 'report_md', name: 'launch-readiness-report.md', mime: 'text/markdown', content: reportMarkdown });

    const report: CriticReport = { verdict, readinessScore, breakdown, blockers, checklist, crossChecks: allChecks, narrative, reportMarkdown };
    return { output: report, mode, summary: `${verdict.replace('_', ' ')} · readiness ${readinessScore}/100 · ${blockers.length} blocker(s) · ${checklist.length} action item(s)` };
  },
};
