import type { EditableMap, MapAsset } from './map';
import type { MapOperation } from './mapOperations';
import type { RenderScheme } from './renderScheme';

export type CgVec3 = [number, number, number];
export type CgQuat = [number, number, number, number];
export type CgCameraReference = 'world' | 'subject-facing' | 'subject-motion' | 'interaction-axis';
export type CgCameraView = 'front' | 'front-three-quarter' | 'side' | 'rear-three-quarter' | 'rear';
export type CgCameraAim = 'body' | 'upper-body' | 'face' | 'eyes' | 'interaction';
export interface CgAnchor {
  id: string;
  name: string;
  kind: 'point' | 'camera';
  position: CgVec3;
  quaternion?: CgQuat;
  fov?: number;
  space?: 'world' | 'object';
  objectId?: string;
}
export interface CgEntity {
  id: string;
  name: string;
  kind: 'actor' | 'prop';
  objectId?: string;
  assetId?: string;
  startAnchorId?: string;
  description?: string;
  height?: number;
}
export type CgTimeRef = { kind: 'absolute'; seconds: number }
  | { kind: 'after' | 'with'; id: string; offset?: number };
export interface CgCameraIntent {
  movement: 'static' | 'dolly' | 'tracking' | 'orbit';
  framing: 'wide' | 'medium' | 'close-up' | 'over-shoulder';
  subjectId: string;
  secondaryId?: string;
  side?: 'left' | 'right';
  lensMm?: number;
  distance?: number;
  height?: number;
  azimuth?: number;
  /** Coordinate frame used to interpret view/azimuth. Subject-relative frames turn with the performance. */
  reference?: CgCameraReference;
  /** Where the camera sits around the subject inside the selected reference frame. */
  view?: CgCameraView;
  /** Semantic model region kept in composition. */
  aim?: CgCameraAim;
  /** Desired subject position in normalized screen coordinates, each axis in [-0.45, 0.45]. */
  screenPosition?: [number, number];
}
export interface CgShotTransition {
  type: 'cut' | 'ease-in-out';
  duration?: number;
  motivation: 'action' | 'look' | 'reaction' | 'reveal' | 'reestablish' | 'rhythm';
}
export interface CgShot {
  id: string;
  name: string;
  purpose: string;
  duration: number;
  camera: CgCameraIntent;
  transition?: CgShotTransition;
  subtitle?: string;
}
export interface CgAction {
  id: string;
  entityId: string;
  type: 'move' | 'face' | 'animate' | 'visibility' | 'effect' | 'attach' | 'detach';
  start: CgTimeRef;
  duration: number;
  targetAnchorId?: string;
  targetEntityId?: string;
  clipId?: string;
  visible?: boolean;
  effect?: 'spark';
  socketId?: string;
}
export interface CgConstraint {
  id: string;
  source: 'user';
  strength: 'hard';
  type: 'entity-position' | 'action-target' | 'camera-pose' | 'action-time' | 'shot-duration';
  targetId: string;
  anchorId?: string;
  seconds?: number;
  edge?: 'start' | 'end';
  scope?: 'initial' | 'throughout';
}
/** Authoritative intent. No generated keyframes live in this document. */
export interface DirectorDocument {
  schemaVersion: 1;
  id: string;
  title: string;
  sourcePrompt: string;
  revision: number;
  seed: number;
  mapId: string;
  entities: CgEntity[];
  anchors: CgAnchor[];
  shots: CgShot[];
  actions: CgAction[];
  constraints: CgConstraint[];
  worldPatch: MapOperation[];
}
export interface CgClip {
  id: string;
  entityId: string;
  modelHash: string;
  description: string;
  duration: number;
  fps: number;
  loop: boolean;
  rootMotion: 'in-place';
  source: 'generated' | 'builtin';
  tracks: Record<string, {
    position?: CgVec3[];
    rotation?: CgVec3[];
    quaternion?: CgQuat[];
    scale?: CgVec3[];
  }>;
}
export interface CgResources { models: MapAsset[]; clips: CgClip[] }
export interface CgDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  nodeIds: string[];
}
export interface CgValidation { valid: boolean; diagnostics: CgDiagnostic[] }
export interface CgEntityState {
  position: CgVec3;
  quaternion: CgQuat;
  scale: CgVec3;
  visible: boolean;
  clipId?: string;
  clipTime?: number;
  attachedTo?: string;
  socketId?: string;
}
export interface CgCameraPose { position: CgVec3; quaternion: CgQuat; fov: number; target?: CgVec3 }
export interface CgBinding {
  entityId: string;
  objectId: string;
  assetId: string | null;
  height: number;
  /** Model-local, floor-aligned semantic points used by camera composition. */
  focus?: { body: CgVec3; upperBody: CgVec3; face: CgVec3; eyes: CgVec3; faceHeight: number; source: 'named-head' | 'proportional-fallback' };
}
export interface CgCompiledShot { id: string; start: number; end: number; camera: CgCameraIntent; transition?: CgShotTransition; lockedPose?: CgCameraPose; inputHash: string }
export interface CgCompiledAction extends Omit<CgAction, 'start'> {
  start: number;
  end: number;
  path?: CgVec3[];
  from?: CgVec3;
  to?: CgVec3;
  inputHash: string;
}
export interface CompiledCG {
  schemaVersion: 1;
  compilerVersion: string;
  id: string;
  inputHash: string;
  documentRevision: number;
  document: DirectorDocument;
  map: EditableMap;
  scheme: RenderScheme | null;
  resources: CgResources;
  duration: number;
  bindings: CgBinding[];
  initial: Record<string, CgEntityState>;
  shots: CgCompiledShot[];
  actions: CgCompiledAction[];
  dependencies: Record<string, string[]>;
  changedNodeIds: string[];
  validation: CgValidation;
}
export interface CgFrame {
  time: number;
  shotId: string;
  entities: Record<string, CgEntityState>;
  camera: CgCameraPose;
  effects: Array<{ id: string; position: CgVec3; age: number; seed: number }>;
}
export type CgPatchOperation =
  | { type: 'shot.update'; id: string; patch: Partial<Omit<CgShot, 'id' | 'camera'>> & { camera?: Partial<CgCameraIntent> } }
  | { type: 'action.update'; id: string; patch: Partial<Omit<CgAction, 'id'>> }
  | { type: 'entity.update'; id: string; patch: Partial<Omit<CgEntity, 'id'>> }
  | { type: 'anchor.upsert'; anchor: CgAnchor }
  | { type: 'constraint.upsert'; constraint: CgConstraint }
  | { type: 'constraint.remove'; id: string };
export interface CgProject {
  schemaVersion: 1;
  id: string;
  title: string;
  revision: number;
  mapSnapshot: EditableMap;
  schemeSnapshot: RenderScheme | null;
  document: DirectorDocument;
  resources: CgResources;
  candidate: CompiledCG | null;
  confirmed: CompiledCG | null;
  updatedAt: number;
}
export interface CgProjectSummary { id: string; title: string; mapId: string; revision: number; confirmed: boolean; updatedAt: number }
export interface CgProgress { stage: string; message: string }
