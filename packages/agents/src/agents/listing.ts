import { z } from 'zod';
import type { AgentDefinition, AndroidListing, IosListing, ListingReport } from '../types.js';
import { GENERIC_SCREENS, LIMITS, RISKY_TITLE_TERMS, stripRiskyTerms } from '../util/limits.js';
import { clipAtWord, tokenize, UNTRUSTED_NOTICE, untrusted } from '../util/text.js';

const ListingLlmSchema = z.object({
  ios: z.object({
    name: z.string(), subtitle: z.string(), promotionalText: z.string(), description: z.string(), keywords: z.string(), whatsNew: z.string(),
  }).optional(),
  android: z.object({ title: z.string(), shortDescription: z.string(), fullDescription: z.string(), whatsNew: z.string() }).optional(),
});

/** Builds the comma-separated iOS keyword field: no spaces, no repeats, nothing already in name/subtitle. */
export function buildKeywordField(candidates: string[], exclude: string[], max: number): string {
  const skip = new Set(exclude.flatMap((e) => tokenize(e)));
  const seen = new Set<string>();
  const out: string[] = [];
  let len = 0;
  for (const c of candidates) {
    for (const w of tokenize(c)) {
      if (skip.has(w) || seen.has(w)) continue;
      const add = w.length + (out.length ? 1 : 0);
      if (len + add > max) continue;
      out.push(w);
      seen.add(w);
      len += add;
    }
  }
  return out.join(',');
}

function enforceIos(l: IosListing, notes: string[]): IosListing {
  const L = LIMITS.ios;
  const fix = (field: keyof IosListing, max: number) => {
    const v = l[field];
    if (v.length > max) {
      notes.push(`iOS ${field} trimmed from ${v.length} to fit ${max} characters`);
      l[field] = clipAtWord(v, max);
    }
  };
  for (const field of ['name', 'subtitle'] as const) {
    if (RISKY_TITLE_TERMS.test(l[field])) {
      notes.push(`iOS ${field}: removed promotional term(s) "${(l[field].match(new RegExp(RISKY_TITLE_TERMS.source, 'gi')) ?? []).join('", "')}"`);
      l[field] = stripRiskyTerms(l[field]);
    }
  }
  fix('name', L.name);
  fix('subtitle', L.subtitle);
  fix('promotionalText', L.promotionalText);
  fix('description', L.description);
  fix('whatsNew', L.whatsNew);
  const cleaned = [...new Set(l.keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean))];
  let kw = cleaned.join(',');
  while (kw.length > L.keywords && cleaned.length) {
    cleaned.pop();
    kw = cleaned.join(',');
  }
  if (kw !== l.keywords) notes.push('iOS keywords normalised (no spaces, deduplicated, within 100 characters)');
  l.keywords = kw;
  return l;
}

function enforceAndroid(l: AndroidListing, notes: string[]): AndroidListing {
  const L = LIMITS.android;
  if (RISKY_TITLE_TERMS.test(l.title)) {
    notes.push(`Android title: removed promotional term(s) "${(l.title.match(new RegExp(RISKY_TITLE_TERMS.source, 'gi')) ?? []).join('", "')}"`);
    l.title = stripRiskyTerms(l.title);
  }
  const map: Array<[keyof AndroidListing, number]> = [['title', L.title], ['shortDescription', L.shortDescription], ['fullDescription', L.fullDescription], ['whatsNew', L.whatsNew]];
  for (const [field, max] of map) {
    if (l[field].length > max) {
      notes.push(`Android ${field} trimmed from ${l[field].length} to fit ${max} characters`);
      l[field] = clipAtWord(l[field], max);
    }
  }
  return l;
}

export const listingAgent: AgentDefinition<'listing'> = {
  name: 'listing',
  title: 'Listing writer',
  description: 'Drafts store-ready listing copy (name, subtitle, description, keywords) within each store\'s limits.',
  goals: ['full_audit', 'listing'],
  requires: ['scout'],
  after: ['aso', 'compliance'],
  timeoutMs: 3 * 60_000,
  async run(ctx) {
    const { scout } = ctx.results as { scout: NonNullable<typeof ctx.results.scout> };
    const aso = ctx.results.aso;
    const compliance = ctx.results.compliance;
    const s = ctx.project.settings;
    const name = s.appName ?? scout.appName ?? ctx.project.name;
    const wanted = ctx.project.platform === 'both' ? scout.platforms : scout.platforms.filter((p) => p === ctx.project.platform);
    const active = wanted.length ? wanted : ctx.project.platform === 'both' ? (['ios', 'android'] as const).slice() : [ctx.project.platform];
    const candidates = (aso?.keywordCandidates ?? []).map((c) => c.keyword);
    const features = scout.screens.filter((x) => !GENERIC_SCREENS.test(x)).slice(0, 6);
    const notes: string[] = [];

    /* ----------------------------- heuristic draft ----------------------------- */
    const subtitleSource = s.shortDescription ?? (candidates[0] ? `${candidates[0][0].toUpperCase()}${candidates[0].slice(1)} made simple` : scout.category ?? 'Your mobile companion');
    const summary = scout.appSummary;
    const body = [
      summary,
      features.length ? `Key features:\n${features.map((x) => `• ${x}`).join('\n')}` : '',
      s.supportUrl ? `Support: ${s.supportUrl}` : '',
      scout.privacyPolicyUrl ? `Privacy policy: ${scout.privacyPolicyUrl}` : '',
    ].filter(Boolean).join('\n\n');

    const heuristic: ListingReport = { adjustments: notes };
    if (active.includes('ios')) {
      const subtitle = clipAtWord(subtitleSource, LIMITS.ios.subtitle);
      heuristic.ios = enforceIos(
        {
          name,
          subtitle,
          promotionalText: summary,
          description: body,
          keywords: buildKeywordField(candidates, [name, subtitle], LIMITS.ios.keywords),
          whatsNew: `Welcome to ${name}! This is our first release.`,
        },
        notes
      );
    }
    if (active.includes('android')) {
      heuristic.android = enforceAndroid(
        { title: name, shortDescription: clipAtWord(s.shortDescription ?? summary, LIMITS.android.shortDescription), fullDescription: body, whatsNew: `Welcome to ${name}! This is our first release.` },
        notes
      );
    }

    /* ------------------------------- LLM draft ------------------------------- */
    let result = heuristic;
    let mode: 'llm' | 'heuristic' = 'heuristic';
    if (ctx.llm.available) {
      try {
        const avoid = (compliance?.issues ?? []).filter((i) => i.severity === 'critical' || i.severity === 'high').map((i) => i.title).slice(0, 8);
        const r = await ctx.llm.json({
          system: `You write app store listings that are accurate, specific and compliant. ${UNTRUSTED_NOTICE}`,
          prompt:
            `Write store listing copy for this app. Only describe features supported by the facts below; never invent features, awards, rankings, prices, or medical/financial outcomes.\n` +
            `Name: ${name}\nCategory: ${scout.category ?? 'unknown'}\nSummary: ${scout.appSummary}\nScreens/features: ${features.join(', ') || 'unknown'}\n` +
            `Target keywords: ${(s.targetKeywords ?? []).join(', ') || candidates.slice(0, 10).join(', ')}\n` +
            `Platforms needed: ${active.join(', ')}\n` +
            (avoid.length ? `Compliance problems to avoid aggravating: ${avoid.join('; ')}\n` : '') +
            untrusted('existing description', scout.description ?? '(none)', 1500) +
            `\nLimits (characters): iOS name ${LIMITS.ios.name}, subtitle ${LIMITS.ios.subtitle}, promotionalText ${LIMITS.ios.promotionalText}, keywords ${LIMITS.ios.keywords} (comma-separated, no spaces, do not repeat words from name/subtitle), description ${LIMITS.ios.description}; ` +
            `Android title ${LIMITS.android.title}, shortDescription ${LIMITS.android.shortDescription}, fullDescription ${LIMITS.android.fullDescription}, whatsNew ${LIMITS.android.whatsNew}. ` +
            `Do not use the words free, best, #1, new, official in names/titles/subtitles. Plain text only (no markdown).\n` +
            `Return JSON: {${active.includes('ios') ? '"ios": {"name","subtitle","promotionalText","description","keywords","whatsNew"}' : ''}${active.length === 2 ? ', ' : ''}${active.includes('android') ? '"android": {"title","shortDescription","fullDescription","whatsNew"}' : ''}}`,
          schema: ListingLlmSchema,
          maxTokens: 4000,
          temperature: 0.5,
        });
        const llmNotes: string[] = [];
        result = { adjustments: llmNotes };
        if (active.includes('ios') && r.ios) result.ios = enforceIos({ ...r.ios }, llmNotes);
        else result.ios = heuristic.ios;
        if (active.includes('android') && r.android) result.android = enforceAndroid({ ...r.android }, llmNotes);
        else result.android = heuristic.android;
        mode = 'llm';
      } catch (e) {
        ctx.log('warn', `LLM listing draft failed, using template draft: ${(e as Error).message}`);
      }
    }

    // Artifacts: structured JSON and a copy-paste-friendly markdown sheet with character counts.
    await ctx.artifact({ kind: 'listing_json', name: 'listing.json', mime: 'application/json', content: JSON.stringify(result, null, 2) });
    const md: string[] = [`# Store listing draft — ${name}`, ''];
    const field = (label: string, v: string, max: number) => md.push(`**${label}** (${v.length}/${max})`, '', v, '');
    if (result.ios) {
      md.push('## App Store', '');
      field('Name', result.ios.name, LIMITS.ios.name);
      field('Subtitle', result.ios.subtitle, LIMITS.ios.subtitle);
      field('Promotional text', result.ios.promotionalText, LIMITS.ios.promotionalText);
      field('Keywords', result.ios.keywords, LIMITS.ios.keywords);
      field('Description', result.ios.description, LIMITS.ios.description);
      field("What's new", result.ios.whatsNew, LIMITS.ios.whatsNew);
    }
    if (result.android) {
      md.push('## Google Play', '');
      field('Title', result.android.title, LIMITS.android.title);
      field('Short description', result.android.shortDescription, LIMITS.android.shortDescription);
      field('Full description', result.android.fullDescription, LIMITS.android.fullDescription);
      field("What's new", result.android.whatsNew, LIMITS.android.whatsNew);
    }
    if (result.adjustments.length) md.push('## Automatic adjustments', '', ...result.adjustments.map((a) => `- ${a}`), '');
    await ctx.artifact({ kind: 'listing_md', name: 'listing.md', mime: 'text/markdown', content: md.join('\n') });

    return {
      output: result,
      mode,
      summary: `Drafted ${[result.ios && 'App Store', result.android && 'Google Play'].filter(Boolean).join(' + ')} listing${result.adjustments.length ? ` · ${result.adjustments.length} automatic adjustment(s)` : ''}`,
    };
  },
};
