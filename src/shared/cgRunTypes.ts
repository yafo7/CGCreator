import type { CgAgentName, ValidationDiagnostic } from './cgAgentTypes';

export type CgRunPhase =
  | 'world-bootstrap'
  | 'preproduction-planning'
  | 'preparing-world'
  | 'preparing-resources'
  | 'readiness-check'
  | 'director-finalizing'
  | 'performance-planning'
  | 'camera-planning'
  | 'negotiating'
  | 'compiling'
  | 'validating'
  | 'preview-ready'
  | 'failed'
  | 'cancelled'
  | 'confirmed';

export type CgRunStatus = 'active' | 'preview-ready' | 'failed' | 'cancelled' | 'confirmed';
export type CgTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type CgArtifactKind =
  | 'world-bootstrap'
  | 'preproduction-plan'
  | 'world-knowledge'
  | 'production-package'
  | 'readiness-gate'
  | 'director-document'
  | 'performance-plan'
  | 'camera-plan'
  | 'negotiation'
  | 'compiled-cg'
  | 'validation-report'
  | 'repair-plan'
  | 'timeline';

export interface CgArtifactRef {
  id: string;
  kind: CgArtifactKind;
  contentHash: string;
  projectId: string;
  projectRevision: number;
  mapId: string;
  mapVersion: number;
  createdAt: number;
}

export interface CgArtifactEnvelope<T = unknown> extends CgArtifactRef {
  schemaVersion: 1;
  producer: CgAgentName;
  runId: string;
  inputRefs: string[];
  provenance: Array<{ source: string; sourceId: string; hash: string }>;
  content: T;
}

export interface CgAgentTask {
  id: string;
  label: string;
  agent: CgAgentName;
  phase: CgRunPhase;
  dependencies: string[];
  status: CgTaskStatus;
  attempts: number;
  inputRefs: string[];
  outputRefs: string[];
  startedAt?: number;
  completedAt?: number;
  error?: { code: string; message: string };
}

export interface CgGenerationRun {
  schemaVersion: 1;
  id: string;
  projectId: string;
  projectRevision: number;
  mapId: string;
  mapVersion: number;
  prompt: string;
  demo: boolean;
  status: CgRunStatus;
  phase: CgRunPhase;
  tasks: CgAgentTask[];
  artifacts: CgArtifactRef[];
  diagnostics: ValidationDiagnostic[];
  negotiationRound: number;
  maxNegotiationRounds: number;
  repairAttempt: number;
  maxRepairAttempts: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

