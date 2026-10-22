import type { Diagnostic } from '../shared/errors.js';

export type Gate = 'draft' | 'spec' | 'integration';
export interface Source { path: string; content: string; line: number }
export interface Scenario extends Source { id: string; title: string; given: string[]; when: string[]; then: string[] }
export interface Requirement extends Source {
  id: string; title: string; body: string; scenarios: Scenario[];
  operation?: 'ADD' | 'UPDATE' | 'REMOVE'; removedScenarios: string[]; removalReasons: Record<string, string>;
  reason?: string; impact?: string;
}
export interface SpecDocument extends Source {
  kind: 'spec' | 'delta'; formatVersion: 1; capability: string; baseHash?: string | null;
  title: string; requirements: Requirement[]; diagnostics: Diagnostic[];
}
export interface ChangeMetadata { formatVersion: 1; id: string; title: string; modules: string[]; dependsOn: string[]; tracking?: { provider: string; itemId: string }; extensions?: Record<string, unknown> }
export interface MetadataDocument extends Source { value: ChangeMetadata; diagnostics: Diagnostic[] }
export interface Task extends Source {
  id: string; title: string; complete: boolean; requires: string[]; dependsOn: string[];
  writeScopes: string[]; testMode: 'tdd' | 'verification' | 'exempt'; testScopes: string[]; testCommands: string[];
  acceptance: string; rationale?: string; testRationale?: string; fields: Record<string, string>;
}
export interface TaskDocument extends Source { tasks: Task[]; diagnostics: Diagnostic[] }
export interface Question { id: string; status: 'unresolved' | 'resolved'; type: 'behavior' | 'non-behavior'; text: string; line: number }
export interface ProposalDocument extends Source { sections: Record<string, string>; rules: { id: string; text: string; line: number }[]; questions: Question[]; diagnostics: Diagnostic[] }
export interface RemovedId { kind: 'requirement' | 'scenario'; id: string; capability: string; parentRequirementId: string | null; changeId: string; transactionId: string; reason: string }
export interface HistoryChange { changeId: string; archivePath: string; transactionId: string; archiveMetadataHash: string }
export interface HistoryIndex { formatVersion: 1; changes: HistoryChange[]; removed: RemovedId[] }
export interface ArchiveMetadata {
  formatVersion: 1; changeId: string; transactionId: string; archivePath: string;
  deltaHashes: Record<string, string>; inputHashes: Record<string, string | null>; outputHashes: Record<string, string>;
  fingerprints: Record<string, string>; removed: RemovedId[];
}
export interface ArchiveRecord { path: string; content: string; metadata: ArchiveMetadata }
export interface ScenarioEvidence { purpose?: 'current' | 'removal'; scenarioId: string; taskId: string; mode: 'automated' | 'manual' | 'not-applicable'; outcome: 'passed' | 'failed'; evidenceId: string; rationale?: string }
/** These are caller-verified facts, never inferred from Markdown task status. */
export interface IntegrationEvidence { approval: boolean; codeReview: boolean; verification: boolean; current: boolean; scenarioEvidence: ScenarioEvidence[] }
export interface ChangeBundle {
  projectRoot: string; changeId: string; metadata: MetadataDocument; proposal?: ProposalDocument; design?: Source; tasks?: TaskDocument;
  deltas: SpecDocument[]; specs: SpecDocument[]; rules?: Source; config?: Record<string, unknown>;
  history: HistoryIndex; archives: ArchiveRecord[]; activeChanges: ChangeMetadata[]; activeReferences: ActiveReference[];
  diagnostics: Diagnostic[]; integrationEvidence?: IntegrationEvidence; integratedChanges?: string[];
}
export interface ActiveReference { changeId: string; id: string; path: string; line: number }
export interface TraceEntry { kind: 'current' | 'removal'; removalReason?: string; requirementId: string; scenarioId: string; taskIds: string[]; evidence: ScenarioEvidence[]; covered: boolean }
export interface TraceResult { entries: TraceEntry[]; diagnostics: Diagnostic[] }
export interface SyncWrite { capability: string; path: string; beforeHash: string | null; afterHash: string; content: string }
export interface SyncPlan { formatVersion: 1; planId: string; writes: SyncWrite[]; removed: Omit<RemovedId, 'changeId' | 'transactionId'>[]; diagnostics: Diagnostic[]; inputHashes: Record<string, string | null>; deltaHashes: Record<string, string> }
export interface ArchivePlan { formatVersion: 1; planId: string; sync: SyncPlan; metadata: ArchiveMetadata; metadataContent: string; history: HistoryIndex; historyContent: string; moves: { from: string; to: string }[]; diagnostics: Diagnostic[] }
