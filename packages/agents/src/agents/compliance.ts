import { z } from 'zod';
import { analyzeCompliance } from '@stora-sh/compliance';
import type {
  AgentDefinition,
  ComplianceIssueOut,
  ComplianceReport,
  RemediationItem,
  ScoutReport,
} from '../types.js';
import { safeRead, walk } from '../util/fs.js';
import { UNTRUSTED_NOTICE } from '../util/text.js';

type Issue = ComplianceIssueOut;
const SEVERITY_WEIGHT = { critical: 25, high: 15, medium: 8, low: 3, info: 0 } as const;
const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;

const grade = (s: number) => (s >= 95 ? 'A+' : s >= 90 ? 'A' : s >= 85 ? 'B+' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F');

const RESTRICTED_ANDROID: Array<[RegExp, Issue['severity'], string]> = [
  [/^(READ_SMS|SEND_SMS|RECEIVE_SMS|RECEIVE_MMS|RECEIVE_WAP_PUSH)$/, 'high', 'SMS permissions are restricted by Google Play and need a Permissions Declaration Form.'],
  [/^(READ_CALL_LOG|WRITE_CALL_LOG|PROCESS_OUTGOING_CALLS)$/, 'high', 'Call-log permissions are restricted by Google Play and need a Permissions Declaration Form.'],
  [/^MANAGE_EXTERNAL_STORAGE$/, 'high', '"All files access" is only allowed for specific app types and requires a declaration.'],
  [/^ACCESS_BACKGROUND_LOCATION$/, 'high', 'Background location needs a prominent in-app disclosure and a Play declaration.'],
  [/^QUERY_ALL_PACKAGES$/, 'medium', 'Broad package visibility requires a Play declaration of the core use case.'],
  [/^REQUEST_INSTALL_PACKAGES$/, 'medium', 'Installing packages is restricted; remove it unless it is the core functionality.'],
  [/^SYSTEM_ALERT_WINDOW$/, 'medium', 'Drawing over other apps draws extra review scrutiny.'],
];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'a private key'],
  [/sk_live_[0-9a-zA-Z]{20,}/, 'a Stripe live secret key'],
  [/xox[baprs]-[0-9A-Za-z-]{20,}/, 'a Slack token'],
  [/ghp_[0-9A-Za-z]{30,}/, 'a GitHub personal access token'],
];
const TEXT_FILE = /\.(js|jsx|ts|tsx|json|dart|swift|kt|java|m|h|plist|xml|gradle|properties|yaml|yml|env|ini|cfg|txt|md)$/i;

async function scanForSecrets(root: string, files: string[]): Promise<Array<{ file: string; what: string }>> {
  const hits: Array<{ file: string; what: string }> = [];
  for (const f of files.filter((x) => TEXT_FILE.test(x) || /(^|\/)\.env/.test(x)).slice(0, 3000)) {
    const text = await safeRead(root, f, 300_000);
    if (!text) continue;
    for (const [re, what] of SECRET_PATTERNS) {
      if (re.test(text)) hits.push({ file: f, what });
    }
    if (hits.length >= 5) break;
  }
  return hits;
}

/** Cross-checks that use Scout's facts; they add to (never silently replace) the base analyzer's rules. */
async function supplementalChecks(scout: ScoutReport, platforms: Array<'ios' | 'android'>): Promise<{ issues: Issue[]; files: string[] }> {
  const issues: Issue[] = [];
  const add = (i: Omit<Issue, 'source'>) => issues.push({ ...i, source: 'agents' });
  const { files } = await walk(scout.workDir);
  const ios = platforms.includes('ios');
  const android = platforms.includes('android');

  if (ios) {
    const keys = scout.permissions.ios;
    for (const [k, v] of Object.entries(scout.usageDescriptions)) {
      const generic = v.length < 25 || /^(todo|test|lorem|\$\(product_name\)\s*(needs|requires))/i.test(v) || /^this app (needs|requires) (access|permission)\.?$/i.test(v);
      if (generic && v.length >= 10) {
        add({
          id: `agents-ios-generic-${k}`,
          severity: 'medium',
          category: 'Privacy',
          title: `Generic purpose string for ${k}`,
          message: `"${v}" is unlikely to satisfy reviewers; purpose strings must explain how the data is used.`,
          recommendation: 'Describe the specific feature and benefit, e.g. "Used to scan receipts so you can add expenses faster."',
        });
      }
    }
    if (scout.sdks.ads.length > 0 && !keys.includes('NSUserTrackingUsageDescription')) {
      add({
        id: 'agents-ios-att-missing',
        severity: 'high',
        category: 'Privacy',
        title: 'Ad SDK without App Tracking Transparency prompt',
        message: `Ad SDK(s) detected (${scout.sdks.ads.join(', ')}) but NSUserTrackingUsageDescription is not set.`,
        recommendation: 'Add NSUserTrackingUsageDescription and request ATT authorization before tracking, or disable personalised ads on iOS.',
      });
    }
    const socialNoApple = scout.sdks.social.filter((s) => !/apple/i.test(s));
    if (socialNoApple.length > 0 && !scout.sdks.social.some((s) => /apple/i.test(s))) {
      add({
        id: 'agents-ios-sign-in-with-apple',
        severity: 'high',
        category: 'Authentication',
        title: 'Third-party login without Sign in with Apple',
        message: `Social login SDK(s) detected (${socialNoApple.join(', ')}) but no Sign in with Apple. Guideline 4.8 requires an equivalent privacy-preserving option.`,
        recommendation: 'Add Sign in with Apple (or another login service meeting the 4.8 criteria) next to other social logins.',
      });
    }
    const hasIosProject = files.some((f) => /(^|\/)ios\//.test(f) && /\.(plist|pbxproj)$/.test(f));
    if (hasIosProject && !files.some((f) => f.endsWith('PrivacyInfo.xcprivacy'))) {
      add({
        id: 'agents-ios-privacy-manifest',
        severity: 'medium',
        category: 'Privacy',
        title: 'No privacy manifest (PrivacyInfo.xcprivacy)',
        message: 'Apps using required-reason APIs or listed third-party SDKs must ship a privacy manifest.',
        recommendation: 'Add PrivacyInfo.xcprivacy declaring collected data types and required-reason API usage.',
      });
    }
  }

  if (android) {
    for (const perm of scout.permissions.android) {
      for (const [re, severity, why] of RESTRICTED_ANDROID) {
        if (re.test(perm)) {
          add({
            id: `agents-android-restricted-${perm}`,
            severity,
            category: 'Permissions',
            title: `Restricted permission ${perm}`,
            message: why,
            recommendation: 'Remove the permission if it is not core to the app, otherwise prepare the Play Console declaration.',
          });
        }
      }
    }
    const manifestPath = files.find((f) => /android\/.*src\/main\/AndroidManifest\.xml$/.test(f));
    const manifest = manifestPath ? await safeRead(scout.workDir, manifestPath) : null;
    if (manifest?.includes('android:debuggable="true"')) {
      add({
        id: 'agents-android-debuggable',
        severity: 'high',
        category: 'Security',
        title: 'Release manifest is debuggable',
        message: 'android:debuggable="true" is set in the main AndroidManifest.xml.',
        recommendation: 'Remove the attribute; the build system sets it per build type.',
      });
    }
    if (manifest?.includes('usesCleartextTraffic="true"')) {
      add({
        id: 'agents-android-cleartext',
        severity: 'medium',
        category: 'Security',
        title: 'Cleartext HTTP traffic allowed',
        message: 'android:usesCleartextTraffic="true" permits unencrypted connections.',
        recommendation: 'Use HTTPS everywhere; scope any exceptions with a network security config.',
      });
    }
    if (scout.sdks.ads.length + scout.sdks.analytics.length > 0) {
      add({
        id: 'agents-android-data-safety',
        severity: 'info',
        category: 'Privacy',
        title: 'Data safety form must reflect SDK data collection',
        message: `Analytics/ad SDKs detected (${[...scout.sdks.analytics, ...scout.sdks.ads].join(', ')}).`,
        recommendation: 'Review each SDK\'s data disclosures and mirror them in the Play Console Data safety section.',
      });
    }
  }

  if (scout.sdks.payment.some((s) => /purchases|revenuecat|in[_-]?app|iap/i.test(s))) {
    add({
      id: 'agents-iap-restore',
      severity: 'info',
      category: 'Payments',
      title: 'In-app purchases: verify restore flow and terms',
      message: 'In-app purchase SDK detected.',
      recommendation: 'Provide a Restore Purchases action, show price/period before purchase, and link Terms and Privacy on the paywall.',
    });
  }
  if (scout.sdks.payment.some((s) => /stripe|razorpay|paypal|braintree/i.test(s)) && ios) {
    add({
      id: 'agents-ios-external-payments',
      severity: 'low',
      category: 'Payments',
      title: 'External payment SDK: confirm it is not for digital goods',
      message: `Payment SDK(s) detected (${scout.sdks.payment.join(', ')}). Guideline 3.1.1 requires In-App Purchase for digital content.`,
      recommendation: 'Keep external processors for physical goods and services only.',
    });
  }

  const secrets = await scanForSecrets(scout.workDir, files);
  for (const s of secrets) {
    add({
      id: `agents-secret-${s.file}`,
      severity: 'critical',
      category: 'Security',
      title: `Possible secret committed: ${s.what}`,
      message: `A pattern matching ${s.what} was found in ${s.file}. The value is intentionally not shown here.`,
      recommendation: 'Rotate the credential immediately, remove it from the repository history, and load it from a secrets manager.',
    });
  }
  return { issues, files };
}

const TriageSchema = z.object({
  assessment: z.string().min(10).max(1200),
  remediation: z
    .array(
      z.object({
        priority: z.number().int().min(1).max(20),
        action: z.string().min(5).max(300),
        impact: z.enum(['high', 'medium', 'low']),
        effort: z.enum(['high', 'medium', 'low']),
        relatedIssueIds: z.array(z.string()).max(10),
      })
    )
    .min(1)
    .max(10),
});

function heuristicRemediation(issues: Issue[]): RemediationItem[] {
  return issues
    .filter((i) => i.severity !== 'info')
    .sort((a, b) => RANK[a.severity] - RANK[b.severity])
    .slice(0, 10)
    .map((i, idx) => ({
      priority: idx + 1,
      action: i.recommendation ?? i.title,
      impact: i.severity === 'critical' || i.severity === 'high' ? 'high' : i.severity === 'medium' ? 'medium' : 'low',
      effort: /remove|add|set|enable|disable/i.test(i.recommendation ?? '') ? 'low' : 'medium',
      relatedIssueIds: [i.id],
    }));
}

export const complianceAgent: AgentDefinition<'compliance'> = {
  name: 'compliance',
  title: 'Compliance',
  description: 'Checks the app against App Store and Google Play policies using @stora-sh/compliance plus supplemental cross-checks.',
  goals: ['full_audit', 'compliance'],
  requires: ['scout'],
  after: [],
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const scout = ctx.results.scout!;
    const wanted = ctx.project.platform === 'both' ? scout.platforms : scout.platforms.filter((p) => p === ctx.project.platform);
    const platforms = wanted.length ? wanted : ctx.project.platform === 'both' ? (['ios', 'android'] as const).slice() : [ctx.project.platform];
    const platformArg = platforms.length === 2 ? 'both' : platforms[0];

    ctx.log('info', `Running Stora compliance rules (${platformArg})`);
    const base = await analyzeCompliance(scout.workDir, {
      platform: platformArg,
      appName: scout.appName ?? undefined,
      version: scout.version ?? undefined,
      framework: scout.framework ?? undefined,
      enableAI: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
    });

    const aiIds = new Set((base.aiAnalysis?.discoveredIssues ?? []).map((i) => i.id));
    let issues: Issue[] = base.issues.map((i) => ({
      id: i.id,
      severity: i.severity,
      category: i.category,
      title: i.title,
      message: i.message,
      recommendation: i.recommendation,
      source: aiIds.has(i.id) ? ('ai' as const) : ('stora' as const),
    }));

    // The base rule only looks for PRIVACY.md in the repo; a public policy URL is what stores actually need.
    const suppressed: ComplianceReport['suppressed'] = [];
    if (scout.privacyPolicyUrl && issues.some((i) => i.id === 'common-no-privacy-policy')) {
      issues = issues.filter((i) => i.id !== 'common-no-privacy-policy');
      suppressed.push({
        id: 'common-no-privacy-policy',
        reason: `A privacy policy URL is configured (${scout.privacyPolicyUrl}); the base rule only searches for PRIVACY.md files.`,
      });
    }

    ctx.log('info', 'Running supplemental store-policy cross-checks');
    const extra = await supplementalChecks(scout, platforms as Array<'ios' | 'android'>);
    const known = new Set(issues.map((i) => i.id));
    for (const i of extra.issues) if (!known.has(i.id)) issues.push(i);
    issues.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

    // Re-score over the merged list so supplemental findings count.
    const deduction = issues.reduce((n, i) => n + SEVERITY_WEIGHT[i.severity], 0);
    const score = Math.max(0, 100 - deduction);
    const criticals = issues.filter((i) => i.severity === 'critical').length;
    const highs = issues.filter((i) => i.severity === 'high').length;
    const passLikelihood = Math.max(0.02, Math.min(0.98, (criticals ? 0.3 : 0.95) - highs * 0.08 - issues.filter((i) => i.severity === 'medium').length * 0.02));

    const categories: ComplianceReport['categories'] = {};
    for (const i of issues) {
      const c = (categories[i.category] ??= { score: 100, weight: 1, issues: 0 });
      c.issues += 1;
      c.score = Math.max(0, c.score - SEVERITY_WEIGHT[i.severity]);
    }

    // Triage: LLM when available, otherwise severity-ordered heuristics.
    let remediation = heuristicRemediation(issues);
    const counts = (['critical', 'high', 'medium', 'low', 'info'] as const).map((s) => [s, issues.filter((i) => i.severity === s).length] as const);
    let assessment =
      issues.length === 0
        ? 'No compliance issues were detected by the automated checks. A manual review is still recommended before submission.'
        : `Found ${issues.length} item(s): ${counts.filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ')}. ` +
          (criticals || highs ? 'Resolve the critical and high items before submitting.' : 'No blocking issues; address the remaining items to reduce review friction.');
    let mode: 'llm' | 'heuristic' = 'heuristic';

    if (ctx.llm.available && issues.length > 0) {
      try {
        const known2 = new Set(issues.map((i) => i.id));
        const r = await ctx.llm.json({
          system: `You are a senior App Store / Google Play review specialist. ${UNTRUSTED_NOTICE}`,
          prompt:
            `Prioritise remediation for this mobile app. Be concrete and brief.\n` +
            `App: ${scout.appName} (${scout.framework}, ${platforms.join('+')}), category: ${scout.category ?? 'unknown'}\n` +
            `Summary: ${scout.appSummary}\nSDKs: ${JSON.stringify(scout.sdks)}\n` +
            `Issues (JSON): ${JSON.stringify(issues.slice(0, 40).map(({ id, severity, category, title, message }) => ({ id, severity, category, title, message })))}\n` +
            `Return JSON: {"assessment": string (2-3 sentences on likelihood of first-pass approval), ` +
            `"remediation": [{"priority": number, "action": string, "impact": "high|medium|low", "effort": "high|medium|low", "relatedIssueIds": string[]}]}`,
          schema: TriageSchema,
          maxTokens: 1800,
        });
        remediation = r.remediation
          .map((x) => ({ ...x, relatedIssueIds: x.relatedIssueIds.filter((id) => known2.has(id)) }))
          .sort((a, b) => a.priority - b.priority);
        assessment = r.assessment;
        mode = 'llm';
      } catch (e) {
        ctx.log('warn', `LLM triage failed, using heuristic ordering: ${(e as Error).message}`);
      }
    }

    const report: ComplianceReport = {
      score,
      grade: grade(score),
      passLikelihood: Math.round(passLikelihood * 100) / 100,
      issues,
      categories,
      remediation,
      assessment,
      storaScore: base.score,
      suppressed,
    };
    return {
      output: report,
      mode,
      summary: `Score ${score}/100 (${report.grade}) · ${issues.length} finding(s)${criticals ? `, ${criticals} critical` : ''} · ~${Math.round(report.passLikelihood * 100)}% first-pass approval`,
    };
  },
};
