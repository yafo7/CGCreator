import type { CompiledCG, CgResources, DirectorDocument } from './cgTypes';
import type { WorldSemanticIndex } from './cgWorldSemantics';

export type CgAgentName = 'director' | 'world' | 'production' | 'performance' | 'camera' | 'compiler' | 'validator';
export type CgFidelity = 'required' | 'approximable' | 'optional';
export type CgDiagnosticOwner = 'director' | 'world' | 'production' | 'performance' | 'camera' | 'compiler';

export interface CgEvidenceRef {
  id: string;
  source: 'worldforge' | '3d-generate' | 'director-document' | 'compiler' | 'user';
  sourceId: string;
  sourceHash: string;
  claim: string;
  confidence: 'authored' | 'generated' | 'derived' | 'verified';
}

export interface CgRequirement {
  id: string;
  kind: 'world-location' | 'model' | 'motion' | 'assembly' | 'performance' | 'camera';
  name: string;
  description: string;
  fidelity: CgFidelity;
  entityId?: string;
  actionId?: string;
  evidenceRefs: string[];
}

/** First director pass. It states what must be prepared and verified; it is
 * deliberately not executable and must never be presented as the final
 * DirectorDocument. */
export interface PreproductionPlan {
  schemaVersion: 1;
  prompt: string;
  documentId: string;
  documentRevision: number;
  synopsis: string;
  requirements: CgRequirement[];
  worldQuestions: Array<{ id: string; question: string; relatedIds: string[] }>;
  protectedConstraintIds: string[];
}

export interface WorldKnowledgePackage {
  schemaVersion: 1;
  mapId: string;
  mapVersion: number;
  sourceHash: string;
  index: WorldSemanticIndex;
  referencedEntityIds: string[];
  evidence: CgEvidenceRef[];
  unresolved: Array<{ requirementId: string; reason: string }>;
}

export interface ProductionPackage {
  schemaVersion: 1;
  resources: CgResources;
  models: Array<{ entityId: string; assetId: string; provider: string; modelHash: string }>;
  motions: Array<{ actionId: string; clipId: string; source: 'generated' | 'builtin' | 'procedural-fallback'; modelHash: string }>;
  assemblies: Array<{ id: string; actorEntityId: string; propEntityId: string; source: '3d-generate-mount' | 'semantic-node-fallback'; issue?: string }>;
  evidence: CgEvidenceRef[];
  unresolved: Array<{ requirementId: string; fidelity: CgFidelity; reason: string }>;
}

export interface PerformancePlan {
  schemaVersion: 1;
  duration: number;
  behaviors: Array<{ id: string; entityId: string; type: string; start: number; end: number; path?: [number, number, number][]; contactObjectId?: string }>;
  events: NonNullable<CompiledCG['performance']>['events'];
  occupancy: NonNullable<CompiledCG['performance']>['occupancy'];
  diagnostics: ValidationDiagnostic[];
}

export interface CameraPlan {
  schemaVersion: 1;
  duration: number;
  shots: Array<{
    id: string;
    behaviorId?: string;
    skillId?: string;
    start: number;
    end: number;
    subjectId: string;
    secondaryId?: string;
    framing: string;
    movement: string;
    candidateScores?: Array<{ skillId: string; score: number; feasible: boolean }>;
  }>;
  stagingRequests: CgStagingRequest[];
  diagnostics: ValidationDiagnostic[];
}

export interface CgStagingRequest {
  id: string;
  shotId: string;
  behaviorId?: string;
  reason: string;
  requestedChange: 'timing' | 'spacing' | 'facing' | 'visibility';
  targetIds: string[];
  status: 'proposed' | 'accepted' | 'rejected';
}

export interface ReadinessGateResult {
  schemaVersion: 1;
  ready: boolean;
  checks: Array<{
    requirementId: string;
    fidelity: CgFidelity;
    status: 'ready' | 'fallback' | 'blocked';
    message: string;
    evidenceRefs: string[];
  }>;
}

export interface ValidationDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  nodeIds: string[];
  owner: CgDiagnosticOwner;
  phase: 'readiness' | 'performance' | 'camera' | 'compile' | 'validation';
  repairable: boolean;
}

export interface RepairPlan {
  schemaVersion: 1;
  attempt: number;
  diagnostics: ValidationDiagnostic[];
  assignments: Array<{ owner: CgDiagnosticOwner; diagnosticCodes: string[]; action: string }>;
}

export interface FinalDirectorPackage {
  schemaVersion: 1;
  document: DirectorDocument;
  readinessArtifactId: string;
  worldArtifactId: string;
  productionArtifactId: string;
  protectedConstraintIds: string[];
}
