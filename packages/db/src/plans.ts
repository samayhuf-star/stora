import type { Plan } from './schema.js';

export interface PlanLimits {
  label: string;
  runsPerMonth: number;
  projects: number;
  /** price in USD / month, for display only (billing is stubbed) */
  priceUsd: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { label: 'Free', runsPerMonth: 5, projects: 1, priceUsd: 0 },
  pro: { label: 'Pro', runsPerMonth: 100, projects: 10, priceUsd: 49 },
  agency: { label: 'Agency', runsPerMonth: 1000, projects: 100, priceUsd: 199 },
};

export class LimitError extends Error {
  readonly code = 'PLAN_LIMIT';
  constructor(message: string) {
    super(message);
    this.name = 'LimitError';
  }
}
