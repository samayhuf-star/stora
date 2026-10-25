/* ------------------------------------------------------------------ */
/* Shared types for the agent team                                     */
/* ------------------------------------------------------------------ */

export type RunGoal = 'full_audit' | 'compliance' | 'aso' | 'listing';
export type TargetPlatform = 'ios' | 'android' | 'both';
export type AgentName = 'scout' | 'compliance' | 'aso' | 'listing' | 'screenshots' | 'critic';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type StepStatus = 'succeeded' | 'failed' | 'skipped';
/** How an agent produced its output */
export type AgentMode = 'llm' | 'heuristic' | 'remote' | 'static';

export interface ProjectSettings {
  appName?: string;
  shortDescription?: string;
  description?: string;
  category?: string;
  targetKeywords?: string[];
  privacyPolicyUrl?: string;
  supportUrl?: string;
  screenshots?: boolean;
}

export interface ProjectInfo {
  id: string;
  name: string;
  repoUrl: string;
  branch: string;
  platform: TargetPlatform;
  bundleId?: string | null;
  packageName?: string | null;
  settings: ProjectSettings;
}

/** Runtime configuration shared by all agents (usually derived from env vars). */
export interface AgentEnv {
  /** Directory used for repository checkouts */
  workRoot: string;
  /** Allow file:// and local-path repos (tests / self-hosting only) */
  allowLocalRepos?: boolean;
  /** Base URL of a Stora runner API (apps/api), enables the Screenshot agent */
  runnerApiUrl?: string;
  runnerToken?: string;
  /** Forwarded to Stora's screenshot runner */
  googleApiKey?: string;
  /** How long to wait for a remote screenshot job (ms) */
  screenshotTimeoutMs?: number;
}

/* ------------------------------------------------------------------ */
/* Agent outputs (the "blackboard")                                    */
/* ------------------------------------------------------------------ */

export interface ScoutReport {
  /** Absolute path of the app's root inside the checkout (handles monorepos) */
  workDir: string;
  framework: string | null;
  platforms: Array<'ios' | 'android'>;
  appName: string | null;
  version: string | null;
  bundleId: string | null;
  packageName: string | null;
  description: string | null;
  /** Short natural-language summary of what the app does */
  appSummary: string;
  /** Best-guess store category (e.g. "Health & Fitness") */
  category: string | null;
  permissions: { ios: string[]; android: string[] };
  usageDescriptions: Record<string, string>;
  sdks: { analytics: string[]; ads: string[]; payment: string[]; social: string[]; other: string[] };
  privacyPolicyUrl: string | null;
  screens: string[];
  fileCount: number;
  warnings: string[];
}

export interface RemediationItem {
  priority: number;
  action: string;
  impact: 'high' | 'medium' | 'low';
  effort: 'high' | 'medium' | 'low';
  relatedIssueIds: string[];
}

export interface ComplianceIssueOut {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  title: string;
  message: string;
  recommendation?: string;
  /** 'stora' = @stora-sh/compliance static rules, 'agents' = supplemental cross-checks */
  source: 'stora' | 'agents' | 'ai';
}

export interface ComplianceReport {
  score: number;
  grade: string;
  passLikelihood: number;
  issues: ComplianceIssueOut[];
  categories: Record<string, { score: number; weight: number; issues: number }>;
  remediation: RemediationItem[];
  assessment: string;
  /** Score from @stora-sh/compliance before the supplemental checks were merged */
  storaScore: number;
  /** Findings from the base analyzer that the agent overrode, with the reason */
  suppressed: Array<{ id: string; reason: string }>;
}

export interface AsoPlatformScore {
  platform: 'ios' | 'android';
  score: number;
  grade: string;
  titleScore: number;
  descriptionScore: number;
  keywordsScore: number;
}

export interface AsoFinding {
  platform: 'ios' | 'android' | 'both';
  severity: 'high' | 'medium' | 'low';
  message: string;
}

export interface AsoReport {
  scores: AsoPlatformScore[];
  findings: AsoFinding[];
  keywordCandidates: Array<{ keyword: string; score: number; reason: string }>;
  titleCandidates: string[];
  inputMetadata: { name: string; description: string; keywords: string };
}

export interface IosListing {
  name: string;
  subtitle: string;
  promotionalText: string;
  description: string;
  keywords: string;
  whatsNew: string;
}

export interface AndroidListing {
  title: string;
  shortDescription: string;
  fullDescription: string;
  whatsNew: string;
}

export interface ListingReport {
  ios?: IosListing;
  android?: AndroidListing;
  /** Limits that were enforced (and any trimming that had to happen) */
  adjustments: string[];
}

export interface ScreenshotsReport {
  jobId: string | null;
  status: 'completed' | 'failed' | 'timeout';
  urls: string[];
  message: string;
}

export interface ReadinessBreakdown {
  area: 'compliance' | 'store_listing' | 'assets' | 'metadata';
  score: number;
  weight: number;
  note: string;
}

export interface ChecklistItem {
  priority: number;
  title: string;
  detail: string;
  owner: AgentName | 'you';
  severity: 'blocker' | 'important' | 'nice_to_have';
}

export interface CriticReport {
  verdict: 'ready' | 'almost_ready' | 'not_ready';
  readinessScore: number;
  breakdown: ReadinessBreakdown[];
  blockers: string[];
  checklist: ChecklistItem[];
  crossChecks: string[];
  narrative: string;
  reportMarkdown: string;
}

export interface AgentResults {
  scout: ScoutReport;
  compliance: ComplianceReport;
  aso: AsoReport;
  listing: ListingReport;
  screenshots: ScreenshotsReport;
  critic: CriticReport;
}

/* ------------------------------------------------------------------ */
/* Agent contract                                                      */
/* ------------------------------------------------------------------ */

export interface AgentContext {
  runId: string;
  goal: RunGoal;
  project: ProjectInfo;
  env: AgentEnv;
  /** Per-step LLM handle (own token counters) */
  llm: import('./llm.js').LLM;
  /** Outputs of agents that already finished */
  results: Partial<AgentResults>;
  /** How every finished agent ended (lets the Critic reason about gaps) */
  outcomes: Partial<Record<AgentName, { status: StepStatus; detail?: string }>>;
  signal: AbortSignal;
  log: (level: LogLevel, message: string) => void;
  artifact: (a: { kind: string; name: string; mime?: string; content?: string; url?: string }) => Promise<void>;
}

export interface AgentOutcome<T> {
  output: T;
  /** One-line human summary shown in the UI */
  summary: string;
  mode: AgentMode;
  /** Set to skip the step with a reason (output is then ignored) */
  skipped?: string;
}

export interface AgentDefinition<N extends AgentName = AgentName> {
  name: N;
  title: string;
  description: string;
  /** Goals that include this agent */
  goals: RunGoal[];
  /** Must succeed first; if one fails/skips this agent is skipped */
  requires: AgentName[];
  /** Run after these if they are part of the plan, whatever their outcome */
  after: AgentName[];
  timeoutMs: number;
  run: (ctx: AgentContext) => Promise<AgentOutcome<AgentResults[N]>>;
}

/* ------------------------------------------------------------------ */
/* Persistence port: the worker adapts this to the database            */
/* ------------------------------------------------------------------ */

export interface PlanStep {
  agent: AgentName;
  title: string;
  description: string;
  dependsOn: AgentName[];
}

export interface RunPlan {
  goal: RunGoal;
  steps: PlanStep[];
  /** Why the supervisor chose this plan */
  rationale: string;
  planner: 'llm' | 'heuristic';
}

export interface StepResult {
  status: StepStatus;
  output?: unknown;
  summary?: string;
  error?: string;
  mode?: AgentMode;
  tokensIn?: number;
  tokensOut?: number;
}

export interface RunSink {
  planReady(plan: RunPlan): Promise<void>;
  stepStarted(agent: AgentName): Promise<void>;
  stepFinished(agent: AgentName, result: StepResult): Promise<void>;
  log(agent: AgentName | 'supervisor', level: LogLevel, message: string): Promise<void>;
  artifact(a: { kind: string; name: string; mime?: string; content?: string; url?: string }): Promise<void>;
  /** Called periodically; returns true when the user asked to cancel */
  heartbeat(): Promise<{ cancelRequested: boolean }>;
}
