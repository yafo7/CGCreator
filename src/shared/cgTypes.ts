import type { EditableMap, MapAsset } from './map';
import type { MapOperation } from './mapOperations';
import type { RenderScheme } from './renderScheme';
import type { WorldSemanticIndex } from './cgWorldSemantics';
import type { CgPoseRig } from './cgPoseEvaluator';
import type { CgPreparation } from './cgPreparation';

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
  binding?: { kind: 'guide'; guideId: string; progress: number } | { kind: 'seat-approach'; objectId: string; nodeId: string };
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
  layout?: 'solo' | 'two-shot' | 'over-shoulder';
  aimMode?: 'fixed' | 'follow';
  pitch?: number;
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
  /** V2 coverage refers to an already scheduled behavior. */
  behaviorId?: string;
  skillId?: string;
  coveragePurpose?: 'geography' | 'follow' | 'destination' | 'emotion' | 'dialogue' | 'reaction' | 'contact';
  autoDuration?: boolean;
}
export interface CgAction {
  id: string;
  entityId: string;
  type: 'move' | 'face' | 'animate' | 'visibility' | 'effect' | 'attach' | 'detach' | 'sit' | 'stand' | 'dialogue' | 'hold';
  start: CgTimeRef;
  duration: number;
  targetAnchorId?: string;
  targetEntityId?: string;
  clipId?: string;
  visible?: boolean;
  effect?: 'spark';
  socketId?: string;
  route?: { guideIds: string[]; policy: 'required' | 'preferred'; locomotion: 'walk' | 'run'; maxSpeed?: number };
  interaction?: { objectId: string; seatNodeId: string; approachAnchorId: string };
  endBehavior?: 'restore' | 'hold';
  purpose?: string;
}
export interface CgConstraint {
  id: string;
  source: 'user';
  strength: 'hard';
  type: 'entity-position' | 'action-target' | 'action-route' | 'camera-pose' | 'camera-path' | 'action-time' | 'shot-duration';
  targetId: string;
  anchorId?: string;
  seconds?: number;
  edge?: 'start' | 'end';
  scope?: 'initial' | 'throughout';
  /** Stable ordering for editable route/camera path control points. */
  order?: number;
}
/** Authoritative intent. No generated keyframes live in this document. */
export interface DirectorDocument {
  schemaVersion: 1 | 2;
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
  locomotion?: { kind: 'walk' | 'run'; nominalSpeed: number; minRate: number; maxRate: number };
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
  clipWeight?: number;
  attachedTo?: string;
  socketId?: string;
  posture?: 'standing' | 'seated';
  behaviorId?: string;
  landmarks?: Partial<Record<'eyes' | 'face' | 'head' | 'hips' | 'leftFoot' | 'rightFoot', CgVec3>>;
  faceForward?: CgVec3;
}
export interface CgCameraPose { position: CgVec3; quaternion: CgQuat; fov: number; target?: CgVec3 }
export interface CgBinding {
  entityId: string;
  objectId: string;
  assetId: string | null;
  height: number;
  /** Model-local, floor-aligned semantic points used by camera composition. */
  focus?: { body: CgVec3; upperBody: CgVec3; face: CgVec3; eyes: CgVec3; faceHeight: number; source: 'named-head' | 'proportional-fallback' };
  poseRig?: CgPoseRig;
}
export type CgPathInterpolation = 'linear' | 'smooth';
export interface CgCompiledShot { id: string; start: number; end: number; camera: CgCameraIntent; transition?: CgShotTransition; lockedPose?: CgCameraPose; path?: CgVec3[]; pathControlIds?: string[]; pathInterpolation?: CgPathInterpolation; inputHash: string; behaviorId?: string; skillId?: string; referenceBehavior?: boolean; cameraSamples?: { fps: number; poses: CgCameraPose[] }; candidateScores?: Array<{ skillId: string; score: number; feasible: boolean }> }
export interface CgCompiledAction extends Omit<CgAction, 'start'> {
  start: number;
  end: number;
  path?: CgVec3[];
  /** Stable authored anchors shown in the editor; the baked navigation path may contain more points. */
  pathControls?: Array<{ id: string; position: CgVec3; role: 'start' | 'via' | 'end'; source: 'auto' | 'user' }>;
  pathInterpolation?: CgPathInterpolation;
  from?: CgVec3;
  to?: CgVec3;
  inputHash: string;
  contact?: { objectId: string; nodeId: string; position: CgVec3; rootPosition: CgVec3; rootQuaternion: CgQuat; tolerance: number };
  surfaceIds?: string[];
  rootRotations?: CgQuat[];
  rootSamples?: { fps: number; positions: CgVec3[]; rotations: CgQuat[] };
  playbackRate?: number;
  motionBlend?: number;
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
  semanticIndex: WorldSemanticIndex;
  duration: number;
  bindings: CgBinding[];
  initial: Record<string, CgEntityState>;
  shots: CgCompiledShot[];
  actions: CgCompiledAction[];
  dependencies: Record<string, string[]>;
  changedNodeIds: string[];
  validation: CgValidation;
  evaluationVersion?: 2;
  stage?: 'performance' | 'complete';
  performance?: { duration: number; events: Array<{ id: string; actionId: string; time: number; kind: 'start' | 'end' | 'contact' }>; occupancy: Array<{ objectId: string; slotId: string; entityId: string; start: number; end: number }> };
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
export interface CgMapSyncSummary {
  addedObjectIds: string[];
  removedObjectIds: string[];
  changedObjectIds: string[];
  changedAssetIds: string[];
  worldChanged: boolean;
  schemeChanged: boolean;
}
export interface CgMapSyncRecord {
  sourceMapVersion: number;
  sourceMapUpdatedAt: number;
  sourceHash: string;
  syncedAt: number;
  summary: CgMapSyncSummary;
}
export interface CgProject {
  schemaVersion: 1;
  id: string;
  title: string;
  revision: number;
  mapSnapshot: EditableMap;
  schemeSnapshot: RenderScheme | null;
  document: DirectorDocument;
  resources: CgResources;
  /** User-selected actors, props and immutable model versions prepared before directing. */
  preparation?: CgPreparation;
  candidate: CompiledCG | null;
  confirmed: CompiledCG | null;
  mapSync?: CgMapSyncRecord;
  coveragePending?: boolean;
  updatedAt: number;
}
export interface CgProjectSummary { id: string; title: string; mapId: string; revision: number; confirmed: boolean; updatedAt: number }
export interface CgProgress { stage: string; message: string }
