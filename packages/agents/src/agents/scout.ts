import { join, dirname, basename } from 'node:path';
import { z } from 'zod';
import { deepScan } from '@stora-sh/analyzer';
import type { AgentDefinition, ScoutReport } from '../types.js';
import { cloneRepo } from '../util/git.js';
import { safeRead, walk } from '../util/fs.js';
import { clipAtWord, titleCase, untrusted, UNTRUSTED_NOTICE } from '../util/text.js';

/* ------------------------------ parsers ------------------------------ */

const plistString = (plist: string, key: string): string | null => {
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m ? m[1].trim() : null;
};

const usageDescriptions = (plist: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const re = /<key>(NS\w*UsageDescription|NS\w*UsageDescriptions)<\/key>\s*<string>([^<]*)<\/string>/g;
  for (let m; (m = re.exec(plist)); ) out[m[1]] = m[2].trim();
  return out;
};

const androidPermissions = (manifest: string): string[] => {
  const out = new Set<string>();
  const re = /<uses-permission[^>]*android:name="([^"]+)"/g;
  for (let m; (m = re.exec(manifest)); ) out.add(m[1].replace(/^android\.permission\./, ''));
  return [...out].sort();
};

const SDK_RULES: Array<[keyof ScoutReport['sdks'], RegExp]> = [
  ['analytics', /firebase[_-]?analytics|amplitude|mixpanel|segment|appsflyer|adjust|posthog|google[_-]?analytics|branch/i],
  ['ads', /admob|google[_-]?mobile[_-]?ads|applovin|unity[_-]?ads|ironsource|facebook[_-]?audience|audience[_-]?network|appodeal|startapp|mopub/i],
  ['payment', /stripe|revenuecat|purchases|in[_-]?app[_-]?purchase|react-native-iap|razorpay|braintree|paypal|billing/i],
  ['social', /google[_-]?sign[_-]?in|facebook|fbsdk|apple[_-]?authentication|sign[_-]?in[_-]?with[_-]?apple|twitter|linkedin|auth0/i],
  ['other', /sentry|crashlytics|bugsnag|onesignal|firebase[_-]?(messaging|core)|push/i],
];

const CATEGORY_HINTS: Array<[string, RegExp]> = [
  ['Health & Fitness', /\b(workout|fitness|gym|health|meditat|steps|calories|yoga)\b/i],
  ['Finance', /\b(bank|wallet|budget|invoice|payment|invest|crypto|expense)\b/i],
  ['Travel', /\b(travel|flight|hotel|trip|booking|visa|itinerary)\b/i],
  ['Food & Drink', /\b(recipe|restaurant|meal|food|delivery|menu)\b/i],
  ['Education', /\b(learn|course|lesson|quiz|student|study|flashcard)\b/i],
  ['Social Networking', /\b(chat|friends|follow|feed|messag|community)\b/i],
  ['Shopping', /\b(shop|cart|checkout|store|catalog|product)\b/i],
  ['Productivity', /\b(todo|task|notes?|calendar|reminder|planner)\b/i],
  ['Photo & Video', /\b(photo|camera|filter|video|gallery|editor)\b/i],
  ['Games', /\b(game|level|score|puzzle|player)\b/i],
  ['Utilities', /\b(cleaner|storage|scanner|battery|vpn|flashlight|converter)\b/i],
];

const guessCategory = (text: string): string | null => {
  let best: [string, number] | null = null;
  for (const [cat, re] of CATEGORY_HINTS) {
    const n = (text.match(new RegExp(re.source, 'gi')) ?? []).length;
    if (n > 0 && (!best || n > best[1])) best = [cat, n];
  }
  return best?.[0] ?? null;
};

const firstParagraph = (readme: string): string | null => {
  const lines = readme.split(/\r?\n/);
  const para: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) {
      if (para.length) break;
      continue;
    }
    if (/^(#|!\[|\[!\[|<|```|---|\|)/.test(l)) {
      if (para.length) break;
      continue;
    }
    para.push(l);
  }
  const text = para.join(' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return text.length >= 20 ? clipAtWord(text, 400) : null;
};

const SOURCE_EXT = /\.(tsx|jsx|ts|js|dart|swift|kt|java|vue)$/;
const SCREEN_DIR = /(^|\/)(screens?|pages?|views?|routes?|app|features?)\//i;

const screenNames = (files: string[]): string[] => {
  const names = new Set<string>();
  for (const f of files) {
    if (!SOURCE_EXT.test(f) || !SCREEN_DIR.test(f) || /(test|spec|stories|\.d\.ts)/i.test(f)) continue;
    const base = basename(f).replace(SOURCE_EXT, '').replace(/(Screen|Page|View|Activity|Fragment)$/i, '');
    if (!base || /^(index|_layout|App|main|styles?|types?|utils?)$/i.test(base) || base.startsWith('_')) continue;
    names.add(titleCase(base.replace(/^\[|\]$/g, '').replace(/[()]/g, '')));
    if (names.size >= 30) break;
  }
  return [...names];
};

const classify = (deps: string[]): ScoutReport['sdks'] => {
  const sdks: ScoutReport['sdks'] = { analytics: [], ads: [], payment: [], social: [], other: [] };
  for (const d of deps) {
    for (const [kind, re] of SDK_RULES) {
      if (re.test(d)) {
        if (!sdks[kind].includes(d)) sdks[kind].push(d);
        break;
      }
    }
  }
  return sdks;
};

const parseDeps = (pkgJson: string | null, pubspec: string | null): string[] => {
  const deps = new Set<string>();
  if (pkgJson) {
    try {
      const j = JSON.parse(pkgJson);
      for (const k of Object.keys({ ...j.dependencies, ...j.devDependencies })) deps.add(k);
    } catch {
      /* ignore */
    }
  }
  if (pubspec) {
    let inDeps = false;
    for (const line of pubspec.split(/\r?\n/)) {
      if (/^(dependencies|dev_dependencies):/.test(line)) inDeps = true;
      else if (/^\S/.test(line)) inDeps = false;
      else if (inDeps) {
        const m = line.match(/^ {2}([a-z0-9_]+):/);
        if (m) deps.add(m[1]);
      }
    }
  }
  return [...deps];
};

/* --------------------------- app root finder -------------------------- */

async function findAppRoot(root: string, files: string[]): Promise<string> {
  // Candidates: dirs holding a flutter pubspec or a package.json with expo / react-native.
  const candidates: string[] = [];
  for (const f of files) {
    const name = basename(f);
    if (name !== 'pubspec.yaml' && name !== 'package.json') continue;
    const dir = dirname(f) === '.' ? '' : dirname(f);
    if (dir.split('/').length > 3) continue;
    const text = await safeRead(root, f, 100_000);
    if (!text) continue;
    if (name === 'pubspec.yaml' && /\bflutter:/m.test(text)) candidates.push(dir);
    if (name === 'package.json' && /"(expo|react-native)"\s*:/.test(text)) candidates.push(dir);
  }
  if (candidates.length) return candidates.sort((a, b) => a.split('/').length - b.split('/').length)[0];
  // Native projects: an ios/ or android/ folder (possibly nested one level)
  for (const f of files) {
    if (/(^|\/)(Info\.plist|AndroidManifest\.xml)$/.test(f)) {
      const parts = f.split('/');
      const i = parts.findIndex((p) => p === 'ios' || p === 'android');
      if (i >= 0) return parts.slice(0, i).join('/');
    }
  }
  return '';
}

/* -------------------------------- agent ------------------------------- */

const SummarySchema = z.object({ summary: z.string().min(10).max(600), category: z.string().max(60).optional() });

export const scoutAgent: AgentDefinition<'scout'> = {
  name: 'scout',
  title: 'Scout',
  description: 'Clones the repository and extracts app facts: framework, identifiers, permissions, SDKs, screens.',
  goals: ['full_audit', 'compliance', 'aso', 'listing'],
  requires: [],
  after: [],
  timeoutMs: 5 * 60_000,
  async run(ctx) {
    const { project, env } = ctx;
    const checkout = join(env.workRoot, ctx.runId, 'repo');

    ctx.log('info', `Cloning ${project.repoUrl} (${project.branch})`);
    await cloneRepo({
      url: project.repoUrl,
      branch: project.branch,
      dest: checkout,
      allowLocal: env.allowLocalRepos,
      signal: ctx.signal,
    });

    const { files, totalBytes, truncated } = await walk(checkout);
    if (totalBytes > 1_500_000_000) throw new Error('Repository is larger than 1.5 GB; refusing to analyse');
    ctx.log('info', `Checked out ${files.length} files${truncated ? ' (truncated)' : ''}`);

    const rel = await findAppRoot(checkout, files);
    const appDir = rel ? join(checkout, rel) : checkout;
    if (rel) ctx.log('info', `App root detected at ./${rel}`);
    const inApp = (f: string) => (rel ? f.startsWith(rel + '/') : true);
    const appFiles = files.filter(inApp).map((f) => (rel ? f.slice(rel.length + 1) : f));

    const scan = await deepScan(appDir).catch(() => null);
    const warnings: string[] = (scan?.warnings ?? []).map((w) => w.message);

    const read = (p: string, max?: number) => safeRead(appDir, p, max);
    const pkgJson = await read('package.json');
    const pubspec = await read('pubspec.yaml');
    const appJsonRaw = (await read('app.json')) ?? (await read('app.config.json'));
    let appJson: any = null;
    try {
      appJson = appJsonRaw ? JSON.parse(appJsonRaw) : null;
    } catch {
      /* app.config.js etc. are not statically parseable */
    }
    const expo = appJson?.expo ?? null;
    const pkg = (() => {
      try {
        return pkgJson ? JSON.parse(pkgJson) : null;
      } catch {
        return null;
      }
    })();

    const infoPlistPath = appFiles
      .filter((f) => /(^|\/)Info\.plist$/.test(f) && f.startsWith('ios'))
      .sort((a, b) => a.length - b.length)[0];
    const plist = infoPlistPath ? await read(infoPlistPath) : null;
    const manifestPath = appFiles.find((f) => /android\/.*AndroidManifest\.xml$/.test(f) && /src\/main/.test(f));
    const manifest = manifestPath ? await read(manifestPath) : null;
    const gradlePath = appFiles.find((f) => /android\/app\/build\.gradle(\.kts)?$/.test(f));
    const gradle = gradlePath ? await read(gradlePath) : null;
    const pbxPath = appFiles.find((f) => f.endsWith('project.pbxproj'));
    const pbx = pbxPath ? await read(pbxPath, 2_000_000) : null;

    // Identifiers
    const pbxBundle = pbx
      ? [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([A-Za-z0-9.\-_]+)"?;/g)]
          .map((m) => m[1])
          .find((id) => !/tests?$/i.test(id) && !id.includes('$('))
      : null;
    const plistBundle = plist ? plistString(plist, 'CFBundleIdentifier') : null;
    const bundleId =
      project.bundleId ||
      expo?.ios?.bundleIdentifier ||
      (plistBundle && !plistBundle.includes('$(') ? plistBundle : null) ||
      pbxBundle ||
      null;
    const gradleId = gradle?.match(/applicationId\s*(?:=\s*)?["']([^"']+)["']/)?.[1] ?? null;
    const manifestPkg = manifest?.match(/\spackage="([^"]+)"/)?.[1] ?? null;
    const packageName = project.packageName || expo?.android?.package || gradleId || manifestPkg || null;

    // Names / version / description
    const pubName = pubspec?.match(/^name:\s*(\S+)/m)?.[1];
    const pubDesc = pubspec?.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, '');
    const pubVersion = pubspec?.match(/^version:\s*([^\s+]+)/m)?.[1];
    const plistName = plist ? plistString(plist, 'CFBundleDisplayName') : null;
    const appName =
      project.settings.appName ||
      expo?.name ||
      appJson?.displayName ||
      (plistName && !plistName.includes('$(') ? plistName : null) ||
      (pubName ? titleCase(pubName) : null) ||
      (pkg?.name ? titleCase(String(pkg.name).replace(/^@[^/]+\//, '')) : null) ||
      project.name;
    const version = expo?.version || pkg?.version || pubVersion || null;
    const readmePath = appFiles.find((f) => /^readme(\.md|\.txt)?$/i.test(f)) ?? files.find((f) => /^readme(\.md|\.txt)?$/i.test(f));
    const readme = readmePath ? await safeRead(checkout, readmePath, 80_000) : null;
    const description =
      project.settings.description ||
      expo?.description ||
      pkg?.description ||
      pubDesc ||
      (readme ? firstParagraph(readme) : null) ||
      null;

    // Permissions
    const usage = plist ? usageDescriptions(plist) : {};
    const expoInfoPlist = expo?.ios?.infoPlist ?? {};
    for (const [k, v] of Object.entries(expoInfoPlist)) {
      if (/^NS.*UsageDescription/.test(k) && typeof v === 'string') usage[k] = v;
    }
    const expoAndroidPerms: string[] = (expo?.android?.permissions ?? []).map((p: string) => p.replace(/^android\.permission\./, ''));
    const androidPerms = [...new Set([...(manifest ? androidPermissions(manifest) : []), ...expoAndroidPerms])].sort();

    // SDKs
    const sdks = classify(parseDeps(pkgJson, pubspec));

    // Privacy policy
    const policyRe = /https?:\/\/[^\s"'<>)\]]*privacy[^\s"'<>)\]]*/i;
    const policySources = [project.settings.privacyPolicyUrl ?? '', appJsonRaw ?? '', pkgJson ?? '', pubspec ?? '', readme ?? ''];
    const privacyPolicyUrl = project.settings.privacyPolicyUrl || policySources.map((s) => s.match(policyRe)?.[0]).find(Boolean) || null;
    const policyFile = files.find((f) => /privacy[-_ ]?policy/i.test(basename(f)));
    if (!privacyPolicyUrl && policyFile) {
      warnings.push(`A privacy policy file exists in the repo (${policyFile}) but stores require a public URL.`);
    }

    // Platforms
    const platforms = new Set<'ios' | 'android'>();
    for (const p of scan?.platforms ?? []) platforms.add(p);
    if (plist || pbx || expo?.ios) platforms.add('ios');
    if (manifest || gradle || expo?.android) platforms.add('android');
    if (platforms.size === 0 && (expo || pubspec)) {
      platforms.add('ios');
      platforms.add('android');
    }
    const framework =
      scan?.framework ?? (expo ? 'expo' : pkg?.dependencies?.['react-native'] ? 'react-native' : pubspec ? 'flutter' : null) ?? (platforms.size ? 'native' : null);
    if (platforms.size === 0) warnings.push('No iOS or Android project detected in this repository.');
    if (!bundleId && platforms.has('ios')) warnings.push('Could not determine the iOS bundle identifier.');
    if (!packageName && platforms.has('android')) warnings.push('Could not determine the Android application id.');

    const screens = screenNames(appFiles);

    // Summary: LLM if available, otherwise stitch together what we know.
    const heuristicSummary = clipAtWord(
      description ??
        `${appName} is a ${framework ?? 'mobile'} app${screens.length ? ` with screens such as ${screens.slice(0, 5).join(', ')}` : ''}.`,
      500
    );
    const factsText = [appName, description ?? '', readme ?? '', screens.join(' '), Object.values(usage).join(' ')].join(' ');
    let appSummary = heuristicSummary;
    let category: string | null = project.settings.category ?? guessCategory(factsText);
    let mode: 'llm' | 'heuristic' = 'heuristic';
    if (ctx.llm.available) {
      try {
        const r = await ctx.llm.json({
          system: `You analyse mobile app repositories for an app-store launch team. ${UNTRUSTED_NOTICE}`,
          prompt:
            `Summarise what this app does for end users in 2 sentences, and pick the best App Store category.\n` +
            `App name: ${appName}\nFramework: ${framework}\nScreens: ${screens.slice(0, 20).join(', ') || 'unknown'}\n` +
            `Permissions requested: ${[...Object.keys(usage), ...androidPerms].slice(0, 20).join(', ') || 'none'}\n` +
            untrusted('README', readme ?? '(no readme)') +
            `\nReturn JSON: {"summary": string, "category": string}`,
          schema: SummarySchema,
          maxTokens: 500,
        });
        appSummary = r.summary;
        category = project.settings.category ?? r.category ?? category;
        mode = 'llm';
      } catch (e) {
        ctx.log('warn', `LLM summary failed, using heuristic: ${(e as Error).message}`);
      }
    }

    const report: ScoutReport = {
      workDir: appDir,
      framework,
      platforms: [...platforms],
      appName,
      version,
      bundleId,
      packageName,
      description,
      appSummary,
      category,
      permissions: { ios: Object.keys(usage).sort(), android: androidPerms },
      usageDescriptions: usage,
      sdks,
      privacyPolicyUrl,
      screens,
      fileCount: files.length,
      warnings,
    };
    return {
      output: report,
      mode,
      summary:
        `${framework ?? 'Unknown'} app "${appName}" · ${[...platforms].join(' + ') || 'no platforms'} · ` +
        `${report.permissions.ios.length + androidPerms.length} permission(s) · ${screens.length} screen(s)`,
    };
  },
};
