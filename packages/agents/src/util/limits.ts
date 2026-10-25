/** Character limits for store listing fields (as of 2026; verify before launch). */
export const LIMITS = {
  ios: { name: 30, subtitle: 30, keywords: 100, promotionalText: 170, description: 4000, whatsNew: 4000 },
  android: { title: 30, shortDescription: 80, fullDescription: 4000, whatsNew: 500 },
} as const;

/** Terms stores reject or penalise in an app name/title/subtitle. */
export const RISKY_TITLE_TERMS = /\b(free|best|#1|no\.? ?1|number one|top[- ]rated|cheap|sale|discount|new|official)\b/i;

export const GENERIC_SCREENS = /^(settings?|login|log in|sign ?in|sign ?up|register|splash|onboarding|loading|error|not ?found|about|profile|home|index|welcome|modal|tabs?|main|app|test)$/i;

/** Removes every promotional term and tidies the leftover punctuation/spacing. */
export function stripRiskyTerms(text: string): string {
  const re = new RegExp(RISKY_TITLE_TERMS.source, 'gi');
  return text.replace(re, '').replace(/\s{2,}/g, ' ').replace(/^[\s:\-–|,]+|[\s:\-–|,]+$/g, '').trim();
}
