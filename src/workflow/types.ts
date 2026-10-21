export const phases = ['bootstrap', 'architect', 'spec-gate', 'dev', 'tester', 'cr', 'verify', 'integrate'] as const;
export type Phase = typeof phases[number];
export type PhaseStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'suspended';
export type TaskStatus = 'pending' | 'running' | 'done' | 'blocked';
export type Fingerprints = { source: string; spec: string; plan: string; policy: string; environment: string };
export interface PhaseRecord { status: PhaseStatus; evidenceIds: string[]; invalidatedBy?: string[] }
export type Role = 'architect' | 'developer-red' | 'developer-green' | 'tester' | 'reviewer' | 'verifier';
export interface Dispatch {
  id: string; attemptId: string; taskId: string; role: Role; status: 'planned' | 'attached' | 'completed' | 'failed';
  allowedPaths: string[]; forbiddenPaths: string[]; requirementIds: string[]; scenarioIds: string[];
  startHead: string; fingerprints: Fingerprints; agentId?: string; cycleId?: string; report?: DispatchReport;
}
export interface DispatchReport {
  protocolVersion: 1; runId: string; dispatchId: string; attemptId: string;
  status: 'DONE' | 'NEEDS_PARENT_DECISION' | 'FAILED'; taskIds: string[]; files: string[];
  evidenceIds: string[]; requirementIds: string[]; scenarioIds: string[]; startHead: string;
  question: string | null; next: string;
}
export interface CommandEvidence {
  id: string; runId: string; taskId: string; cycleId?: string; step: 'baseline' | 'red' | 'green' | 'refactor' | 'verify';
  commandId: string; argv: string[]; cwd: string; startedAt: string; finishedAt: string; startedSequence: number; finishedSequence: number;
  exitCode: number | null; signal?: string; timedOut: boolean; outputTruncated: boolean;
  before: Fingerprints; after: Fingerprints; head: string; testDigest: string; implementationDigest: string;
  commandPlanDigest: string; environmentDigest: string; outputDigest: string; output?: { stdout: string; stderr: string };
}
export type FailureKind = 'business-assertion' | 'no-tests' | 'environment' | 'compile' | 'import' | 'timeout' | 'crash' | 'unknown';
export interface FailureDiagnostic { commandEvidenceId: string; kind: FailureKind; scenarioIds: string[]; assertion: string; sourceReference: string }
export interface Baseline {
  id: string; runId: string; taskId: string; commandIds: string[]; evidence: CommandEvidence[];
  fingerprints: Fingerprints; implementationDigest: string; testDigest: string; commandPlanDigest: string; environmentDigest: string;
}
export interface RedAcceptance { evidenceIds: string[]; diagnostics: FailureDiagnostic[]; rationale: string; sourceReferences: string[] }
export interface TestCycle {
  id: string; runId: string; taskId: string; revision: number; mode: 'new-test' | 'existing-failure'; status: 'open' | 'red-observed' | 'red-accepted' | 'green' | 'complete' | 'invalidated';
  scenarioIds: string[]; baseline: Baseline; testScopes: string[]; implementationScopes: string[];
  red: CommandEvidence[]; green: CommandEvidence[]; refactor: CommandEvidence[]; acceptance?: RedAcceptance;
  pairedTestDigest?: string; redAcceptedSequence?: number; refactorNotNeeded?: string; invalidatedReason?: string;
}
export interface WorkflowState {
  formatVersion: 1; runId: string; phases: Record<Phase, PhaseRecord>; dispatches: Dispatch[];
  cycles: TestCycle[]; staleReports: Array<{ report: unknown; reason: string }>;
  fingerprints?: Fingerprints; budgets: Record<string, { limit: number; consumed: number; additions: Array<{ amount: number; decisionReference: string; rationale: string }> }>;
}
