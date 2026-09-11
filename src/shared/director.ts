export const DIRECTOR_PLAN_SCHEMA_VERSION = 1 as const;

export type DirectorReferenceKind = 'marker' | 'camera' | 'screenshot';

export interface DirectorMarkerReference {
  id: string;
  label: string;
  kind?: 'position' | 'route' | 'look-at' | 'interaction' | 'camera-target';
  position?: [number, number, number];
  boundObjectId?: string;
  description?: string;
}

export interface DirectorCameraReference {
  id: string;
  label: string;
  position: [number, number, number];
  rotation: [number, number, number];
  focalLength?: number;
  description?: string;
}

export interface DirectorScreenshotReference {
  id: string;
  label: string;
  description?: string;
}

export interface DirectorReferenceContext {
  markers: DirectorMarkerReference[];
  cameras: DirectorCameraReference[];
  screenshots: DirectorScreenshotReference[];
}

export interface DirectorCastMember {
  id: string;
  name: string;
  role: string;
  sourceObjectId?: string;
  appearance?: string;
  requiredActions: string[];
}

export type DirectorCameraHeight = 'aerial' | 'high' | 'eye-level' | 'low';
export type DirectorFraming = 'extreme-wide' | 'wide' | 'medium' | 'close-up' | 'over-shoulder' | 'pov';
export type DirectorCameraMovement = 'static' | 'pan' | 'tilt' | 'dolly' | 'tracking' | 'orbit' | 'crane' | 'handheld' | 'cut';

export interface DirectorCameraPlan {
  height: DirectorCameraHeight;
  framing: DirectorFraming;
  movement: DirectorCameraMovement;
  lensMm: number;
  direction: string;
  subject: string;
  startReferenceId?: string;
  endReferenceId?: string;
}

export interface DirectorBlockingBeat {
  actorId: string;
  from: string;
  via: string[];
  to: string;
  action: string;
  facing?: string;
  timing?: string;
}

export interface DirectorShotPlan {
  id: string;
  order: number;
  title: string;
  purpose: string;
  location: string;
  durationSeconds: number;
  camera: DirectorCameraPlan;
  blocking: DirectorBlockingBeat[];
  action: string;
  dialogue?: string;
  subtitle?: string;
  transition: 'cut' | 'blend' | 'match-cut' | 'fade';
  notes: string[];
}

export interface DirectorReferenceNeed {
  kind: DirectorReferenceKind;
  label: string;
  reason: string;
  shotId?: string;
}

/**
 * First-stage output of the Director Agent. It is an editable production brief,
 * not yet a compiled or playable performance.
 */
export interface DirectorPlan {
  schemaVersion: typeof DIRECTOR_PLAN_SCHEMA_VERSION;
  mapId: string;
  title: string;
  logline: string;
  sourcePrompt: string;
  sceneSummary: string;
  estimatedDurationSeconds: number;
  cast: DirectorCastMember[];
  shots: DirectorShotPlan[];
  assumptions: string[];
  referenceNeeds: DirectorReferenceNeed[];
}

export function createEmptyDirectorReferences(): DirectorReferenceContext {
  return { markers: [], cameras: [], screenshots: [] };
}

export function normalizeDirectorReferences(value: unknown): DirectorReferenceContext {
  if (!isRecord(value)) return createEmptyDirectorReferences();
  return {
    markers: arrayOfRecords(value.markers).slice(0, 64).map((marker, index) => ({
      id: cleanId(marker.id, `marker-${index + 1}`),
      label: cleanText(marker.label, 100) || `标点 ${index + 1}`,
      ...(enumOptional(marker.kind, ['position', 'route', 'look-at', 'interaction', 'camera-target'])
        ? { kind: enumOptional(marker.kind, ['position', 'route', 'look-at', 'interaction', 'camera-target']) }
        : {}),
      ...(vec3(marker.position) ? { position: vec3(marker.position) } : {}),
      ...(cleanText(marker.boundObjectId, 100) ? { boundObjectId: cleanText(marker.boundObjectId, 100) } : {}),
      ...(cleanText(marker.description, 300) ? { description: cleanText(marker.description, 300) } : {})
    })),
    cameras: arrayOfRecords(value.cameras).slice(0, 24).flatMap((camera, index) => {
      const position = vec3(camera.position);
      const rotation = vec3(camera.rotation);
      if (!position || !rotation) return [];
      return [{
        id: cleanId(camera.id, `camera-${index + 1}`),
        label: cleanText(camera.label, 100) || `摄像机 ${index + 1}`,
        position,
        rotation,
        ...(Number.isFinite(Number(camera.focalLength))
          ? { focalLength: boundedNumber(camera.focalLength, 35, 12, 200) }
          : {}),
        ...(cleanText(camera.description, 300) ? { description: cleanText(camera.description, 300) } : {})
      }];
    }),
    screenshots: arrayOfRecords(value.screenshots).slice(0, 24).map((screenshot, index) => ({
      id: cleanId(screenshot.id, `screenshot-${index + 1}`),
      label: cleanText(screenshot.label, 100) || `截图 ${index + 1}`,
      ...(cleanText(screenshot.description, 300) ? { description: cleanText(screenshot.description, 300) } : {})
    }))
  };
}

export function normalizeDirectorPlan(value: unknown, prompt: string, mapId: string): DirectorPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_director_plan');
  const input = value as Record<string, unknown>;
  const rawShots = arrayOfRecords(input.shots).slice(0, 16);
  if (rawShots.length === 0) throw new Error('director_plan_requires_shots');
  const shots = rawShots.map((shot, index) => normalizeShot(shot, index));
  return {
    schemaVersion: DIRECTOR_PLAN_SCHEMA_VERSION,
    mapId: cleanText(mapId, 100) || 'unknown-map',
    title: cleanText(input.title, 100) || '未命名实机演出',
    logline: cleanText(input.logline, 400) || cleanText(prompt, 400),
    sourcePrompt: cleanText(prompt, 4_000),
    sceneSummary: cleanText(input.sceneSummary, 1_200) || cleanText(input.summary, 1_200),
    estimatedDurationSeconds: round(shots.reduce((sum, shot) => sum + shot.durationSeconds, 0), 2),
    cast: arrayOfRecords(input.cast).slice(0, 24).map((member, index) => normalizeCastMember(member, index)),
    shots,
    assumptions: stringList(input.assumptions, 16, 300),
    referenceNeeds: arrayOfRecords(input.referenceNeeds).slice(0, 16).map(normalizeReferenceNeed)
  };
}

function normalizeCastMember(input: Record<string, unknown>, index: number): DirectorCastMember {
  const name = cleanText(input.name, 80) || `角色 ${index + 1}`;
  return {
    id: cleanId(input.id, `actor-${index + 1}`),
    name,
    role: cleanText(input.role, 160) || name,
    ...(cleanText(input.sourceObjectId, 100) ? { sourceObjectId: cleanText(input.sourceObjectId, 100) } : {}),
    ...(cleanText(input.appearance, 300) ? { appearance: cleanText(input.appearance, 300) } : {}),
    requiredActions: stringList(input.requiredActions, 20, 120)
  };
}

function normalizeShot(input: Record<string, unknown>, index: number): DirectorShotPlan {
  const camera = isRecord(input.camera) ? input.camera : {};
  return {
    id: cleanId(input.id, `shot-${index + 1}`),
    order: index + 1,
    title: cleanText(input.title, 100) || `镜头 ${index + 1}`,
    purpose: cleanText(input.purpose, 400),
    location: cleanText(input.location, 240) || '当前场景',
    durationSeconds: boundedNumber(input.durationSeconds, 4, 0.5, 60),
    camera: {
      height: enumValue(camera.height, ['aerial', 'high', 'eye-level', 'low'], 'eye-level'),
      framing: enumValue(camera.framing, ['extreme-wide', 'wide', 'medium', 'close-up', 'over-shoulder', 'pov'], 'wide'),
      movement: enumValue(camera.movement, ['static', 'pan', 'tilt', 'dolly', 'tracking', 'orbit', 'crane', 'handheld', 'cut'], 'static'),
      lensMm: boundedNumber(camera.lensMm, 35, 12, 200),
      direction: cleanText(camera.direction, 500),
      subject: cleanText(camera.subject, 240),
      ...(cleanText(camera.startReferenceId, 100) ? { startReferenceId: cleanText(camera.startReferenceId, 100) } : {}),
      ...(cleanText(camera.endReferenceId, 100) ? { endReferenceId: cleanText(camera.endReferenceId, 100) } : {})
    },
    blocking: arrayOfRecords(input.blocking).slice(0, 16).map((beat, beatIndex) => ({
      actorId: cleanId(beat.actorId, `actor-${beatIndex + 1}`),
      from: cleanText(beat.from, 240) || '镜头起始位置',
      via: stringList(beat.via, 12, 120),
      to: cleanText(beat.to, 240) || '镜头结束位置',
      action: cleanText(beat.action, 500),
      ...(cleanText(beat.facing, 240) ? { facing: cleanText(beat.facing, 240) } : {}),
      ...(cleanText(beat.timing, 160) ? { timing: cleanText(beat.timing, 160) } : {})
    })),
    action: cleanText(input.action, 1_000),
    ...(cleanText(input.dialogue, 1_000) ? { dialogue: cleanText(input.dialogue, 1_000) } : {}),
    ...(cleanText(input.subtitle, 1_000) ? { subtitle: cleanText(input.subtitle, 1_000) } : {}),
    transition: enumValue(input.transition, ['cut', 'blend', 'match-cut', 'fade'], 'cut'),
    notes: stringList(input.notes, 12, 300)
  };
}

function normalizeReferenceNeed(input: Record<string, unknown>): DirectorReferenceNeed {
  return {
    kind: enumValue(input.kind, ['marker', 'camera', 'screenshot'], 'marker'),
    label: cleanText(input.label, 100) || '待补充参考',
    reason: cleanText(input.reason, 400) || '需要用户确认空间或构图',
    ...(cleanText(input.shotId, 100) ? { shotId: cleanText(input.shotId, 100) } : {})
  };
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown, limit: number, length: number): string[] {
  return Array.isArray(value)
    ? value.map((item) => cleanText(item, length)).filter(Boolean).slice(0, limit)
    : [];
}

function cleanText(value: unknown, length: number): string {
  return typeof value === 'string' ? value.trim().slice(0, length) : '';
}

function cleanId(value: unknown, fallback: string): string {
  const id = cleanText(value, 100).replace(/[^a-zA-Z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '');
  return id || fallback;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  return round(Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? number : fallback)), 2);
}

function enumValue<const T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
}

function enumOptional<const T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === 'string' && values.includes(value as T) ? value as T : undefined;
}

function vec3(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const result = value.slice(0, 3).map(Number);
  return result.every(Number.isFinite) ? result as [number, number, number] : undefined;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
