import { z } from 'zod';
import { optimizeASO } from '@stora-sh/aso';
import type { AgentDefinition, AsoFinding, AsoReport } from '../types.js';
import { LIMITS, RISKY_TITLE_TERMS, stripRiskyTerms } from '../util/limits.js';
import { clipAtWord, rankKeywords, titleCase, tokenize, UNTRUSTED_NOTICE, untrusted } from '../util/text.js';

const AsoLlmSchema = z.object({
  titleCandidates: z.array(z.string().min(3).max(60)).max(8),
  keywords: z.array(z.object({ keyword: z.string().min(2).max(40), reason: z.string().max(200) })).max(25),
  findings: z.array(z.object({ severity: z.enum(['high', 'medium', 'low']), message: z.string().min(5).max(300) })).max(8),
});

export const asoAgent: AgentDefinition<'aso'> = {
  name: 'aso',
  title: 'ASO',
  description: 'Scores store metadata with @stora-sh/aso and finds keyword and title opportunities.',
  goals: ['full_audit', 'aso', 'listing'],
  requires: ['scout'],
  after: [],
  timeoutMs: 3 * 60_000,
  async run(ctx) {
    const scout = ctx.results.scout!;
    const s = ctx.project.settings;
    const name = s.appName ?? scout.appName ?? ctx.project.name;
    const description = s.description ?? scout.description ?? scout.appSummary;
    const targets = (s.targetKeywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
    const keywordsField = targets.join(',');
    const platforms = (ctx.project.platform === 'both' ? scout.platforms : scout.platforms.filter((p) => p === ctx.project.platform));
    const active = platforms.length ? platforms : ctx.project.platform === 'both' ? (['ios', 'android'] as const).slice() : [ctx.project.platform];

    const scores: AsoReport['scores'] = [];
    for (const platform of active) {
      const r = await optimizeASO({
        projectDir: scout.workDir,
        platform,
        config: { targetKeywords: targets },
        metadata: { name, description, keywords: keywordsField },
      });
      scores.push({ platform, score: r.score, grade: r.grade, titleScore: r.titleScore, descriptionScore: r.descriptionScore, keywordsScore: r.keywordsScore });
    }

    /* ---------------------------- own findings ---------------------------- */
    const findings: AsoFinding[] = [];
    const f = (platform: AsoFinding['platform'], severity: AsoFinding['severity'], message: string) => findings.push({ platform, severity, message });
    const nameLimit = LIMITS.ios.name;
    if (name.length > nameLimit) f('both', 'high', `App name "${name}" is ${name.length} characters; the limit is ${nameLimit} on both stores.`);
    if (RISKY_TITLE_TERMS.test(name)) f('both', 'medium', `App name contains a promotional term (${name.match(RISKY_TITLE_TERMS)![0]}); stores reject or de-rank these.`);
    if (description.length < 200) f('both', 'medium', `Description is only ${description.length} characters; aim for 600+ with your core keywords in the first paragraph.`);
    if (description.length > LIMITS.ios.description) f('both', 'high', `Description exceeds the ${LIMITS.ios.description}-character limit.`);
    if (!s.shortDescription && active.includes('android')) f('android', 'low', 'No short description (80 chars) provided; it is the most visible Play Store text. The Listing agent drafts one.');
    if (keywordsField.length > LIMITS.ios.keywords) f('ios', 'high', `Keyword field is ${keywordsField.length} characters; the limit is ${LIMITS.ios.keywords}.`);
    if (/,\s/.test(keywordsField)) f('ios', 'low', 'Spaces after commas in the keyword field waste characters.');
    const nameWords = new Set(tokenize(name));
    const dupes = targets.filter((k) => k.split(/\s+/).every((w) => nameWords.has(w)));
    if (dupes.length && active.includes('ios')) f('ios', 'low', `Keyword(s) already in the app name are indexed for free; remove from the keyword field: ${dupes.join(', ')}.`);
    const haystack = `${name} ${description}`.toLowerCase();
    for (const k of targets.slice(0, 8)) if (!haystack.includes(k)) f('both', 'medium', `Target keyword "${k}" appears nowhere in the name or description.`);
    if (targets.length === 0) f('both', 'low', 'No target keywords set on the project; candidates below were derived from the app itself.');

    /* ------------------------- keyword candidates ------------------------- */
    const corpus = [name, name, name, description, scout.appSummary, scout.screens.join(' '), scout.category ?? ''].join(' ');
    const ranked = rankKeywords(corpus, 30);
    const candidateMap = new Map<string, { keyword: string; score: number; reason: string }>();
    for (const r of ranked) candidateMap.set(r.keyword, { keyword: r.keyword, score: r.score, reason: `appears ${Math.round(r.score)}× across the app's name, description and screens` });
    for (const t of targets) candidateMap.set(t, { keyword: t, score: (candidateMap.get(t)?.score ?? 0) + 5, reason: 'target keyword set on the project' });

    let titleCandidates: string[] = [];
    const top = [...candidateMap.values()].filter((c) => !nameWords.has(c.keyword) && c.keyword.split(' ').length <= 2).sort((a, b) => b.score - a.score);
    // Build suggestions from the name minus any promotional terms we just flagged in it.
    const cleanName = stripRiskyTerms(name) || name;
    if (top[0]) titleCandidates.push(clipAtWord(`${cleanName}: ${titleCase(top[0].keyword)}`, nameLimit));
    if (scout.category) titleCandidates.push(clipAtWord(`${cleanName} - ${scout.category.split(' & ')[0]}`, nameLimit));
    titleCandidates = [...new Set(titleCandidates)].filter((t) => t.length <= nameLimit && !RISKY_TITLE_TERMS.test(t));

    let mode: 'llm' | 'heuristic' = 'heuristic';
    if (ctx.llm.available) {
      try {
        const r = await ctx.llm.json({
          system: `You are an App Store Optimization specialist. ${UNTRUSTED_NOTICE}`,
          prompt:
            `Suggest ASO improvements for this app.\nName: ${name}\nCategory: ${scout.category ?? 'unknown'}\nPlatforms: ${active.join(', ')}\n` +
            `Target keywords: ${targets.join(', ') || '(none set)'}\nScreens: ${scout.screens.slice(0, 20).join(', ')}\n` +
            untrusted('description', description, 2500) +
            `\nRules: title candidates must be <= 30 characters and contain no "free", "best", "#1" or "new". ` +
            `Keywords are single words or two-word phrases real users would search; do not include competitor brand names.\n` +
            `Return JSON: {"titleCandidates": string[], "keywords": [{"keyword": string, "reason": string}], "findings": [{"severity": "high|medium|low", "message": string}]}`,
          schema: AsoLlmSchema,
          maxTokens: 2000,
        });
        titleCandidates = [...new Set([...r.titleCandidates.filter((t) => t.length <= nameLimit && !RISKY_TITLE_TERMS.test(t)), ...titleCandidates])].slice(0, 6);
        for (const k of r.keywords) {
          const key = k.keyword.toLowerCase().trim();
          if (!candidateMap.has(key)) candidateMap.set(key, { keyword: key, score: 3, reason: k.reason });
          else candidateMap.get(key)!.reason = k.reason;
        }
        for (const x of r.findings) f('both', x.severity, x.message);
        mode = 'llm';
      } catch (e) {
        ctx.log('warn', `LLM ASO analysis failed, using heuristics only: ${(e as Error).message}`);
      }
    }

    const keywordCandidates = [...candidateMap.values()].sort((a, b) => b.score - a.score).slice(0, 25);
    const report: AsoReport = { scores, findings, keywordCandidates, titleCandidates, inputMetadata: { name, description, keywords: keywordsField } };
    const scoreText = scores.map((x) => `${x.platform === 'ios' ? 'iOS' : 'Android'} ${x.score} (${x.grade})`).join(' · ');
    return { output: report, mode, summary: `${scoreText} · ${findings.length} finding(s) · ${keywordCandidates.length} keyword candidates` };
  },
};
