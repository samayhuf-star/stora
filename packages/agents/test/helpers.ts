import { createScriptedLLM, type LLM } from '../src/index.js';
import type { AgentEnv, ProjectInfo } from '../src/types.js';
import { tmp } from './fixtures.js';

export const baseEnv = (over: Partial<AgentEnv> = {}): AgentEnv => ({ workRoot: tmp('work-'), allowLocalRepos: true, ...over });

export const project = (repoUrl: string, over: Partial<ProjectInfo> = {}): ProjectInfo => ({
  id: 'proj-1',
  name: 'Test App',
  repoUrl,
  branch: 'main',
  platform: 'both',
  bundleId: null,
  packageName: null,
  settings: {},
  ...over,
});

/** Routes each agent's LLM prompt to a canned, schema-valid reply. */
export function scriptedLLM(overrides: Record<string, (prompt: string) => unknown> = {}): LLM {
  return createScriptedLLM(({ prompt }) => {
    for (const [needle, fn] of Object.entries(overrides)) if (prompt.includes(needle)) return fn(prompt);
    if (prompt.includes('Summarise what this app does')) return { summary: 'A workout logging app that tracks progress and weekly goals.', category: 'Health & Fitness' };
    if (prompt.includes('Prioritise remediation')) {
      const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
      return {
        assessment: 'Several policy problems would likely cause a rejection on first submission.',
        remediation: [{ priority: 1, action: 'Fix the highest-risk policy problems first', impact: 'high', effort: 'medium', relatedIssueIds: [ids[0] ?? 'x', 'made-up-id'] }],
      };
    }
    if (prompt.includes('Suggest ASO improvements')) {
      return {
        titleCandidates: ['FitTrack: Workout Log', 'FitTrack - Best Workout Tracker', 'FitTrack: A Very Long Title That Exceeds'],
        keywords: [{ keyword: 'workout log', reason: 'core feature' }, { keyword: 'gym tracker', reason: 'search intent' }],
        findings: [{ severity: 'low', message: 'Add a localized description for top markets.' }],
      };
    }
    if (prompt.includes('Write store listing copy')) {
      return {
        ios: {
          name: 'FitTrack: Best Free Workout Tracker and Gym Log', // too long + risky terms
          subtitle: 'Log workouts, track progress',
          promotionalText: 'x'.repeat(300),
          description: 'FitTrack helps you log workouts and see progress.',
          keywords: 'workout, gym, tracker, workout, fitness',
          whatsNew: 'First release',
        },
        android: { title: 'FitTrack', shortDescription: 'y'.repeat(120), fullDescription: 'FitTrack helps you log workouts.', whatsNew: 'First release' },
      };
    }
    if (prompt.includes('Review this launch audit')) return { narrative: 'The app has serious policy blockers but a solid core feature set; fix the blockers and resubmit.', concerns: ['Subscription terms are not described in the listing.'] };
    if (prompt.includes('Optional agents available')) return { include: ['listing'], rationale: 'Listing copy is valuable; screenshots are not enabled.' };
    throw new Error(`unscripted prompt: ${prompt.slice(0, 80)}`);
  });
}
