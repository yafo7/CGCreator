import {
  createEmptyDirectorReferences,
  normalizeDirectorReferences,
  normalizeDirectorPlan,
  type DirectorPlan,
  type DirectorReferenceContext
} from './director';

export const CINEMATIC_SCHEMA_VERSION = 1 as const;

export type CinematicStatus = 'draft' | 'approved' | 'compiled';

export interface CinematicActorBinding {
  id: string;
  objectId?: string;
  assetId?: string;
  role?: string;
}

export interface CinematicPropBinding {
  id: string;
  objectId?: string;
  assetId?: string;
  role?: string;
}

/** Persisted, project-facing source document for one WorldForge cutscene. */
export interface CinematicDocument {
  schemaVersion: typeof CINEMATIC_SCHEMA_VERSION;
  kind: 'worldforge-cinematic';
  id: string;
  projectId: string;
  mapId: string;
  mapVersion: number;
  mapFingerprint?: string;
  title: string;
  status: CinematicStatus;
  sourcePrompt: string;
  references: DirectorReferenceContext;
  bindings: {
    actors: CinematicActorBinding[];
    props: CinematicPropBinding[];
  };
  directorPlan: DirectorPlan;
  compiledRuntime: unknown | null;
  createdAt: number;
  updatedAt: number;
}

export interface CinematicSummary {
  id: string;
  projectId: string;
  mapId: string;
  mapVersion: number;
  title: string;
  status: CinematicStatus;
  updatedAt: number;
  shotCount: number;
  durationSeconds: number;
  stale: boolean;
}

export function normalizeCinematic(value: unknown, fallback?: Partial<CinematicDocument>): CinematicDocument {
  const input = isRecord(value) ? value : {};
  const fallbackRecord = fallback ?? {};
  const mapId = cleanId(input.mapId ?? fallbackRecord.mapId, 'unknown-map');
  const prompt = cleanText(input.sourcePrompt ?? fallbackRecord.sourcePrompt, 4_000);
  const rawPlan = input.directorPlan ?? fallbackRecord.directorPlan;
  const plan = rawPlan
    ? normalizeDirectorPlan(rawPlan, prompt, mapId)
    : normalizeDirectorPlan({
        title: cleanText(input.title ?? fallbackRecord.title, 100) || '未命名实机演出',
        shots: [{ title: '待策划镜头', durationSeconds: 1 }]
      }, prompt, mapId);
  const now = Date.now();
  return {
    schemaVersion: CINEMATIC_SCHEMA_VERSION,
    kind: 'worldforge-cinematic',
    id: cleanId(input.id ?? fallbackRecord.id, `cg-${now.toString(36)}`),
    projectId: cleanId(input.projectId ?? fallbackRecord.projectId, 'local-worldforge'),
    mapId,
    mapVersion: boundedInteger(input.mapVersion ?? fallbackRecord.mapVersion, 1, 0, 2_000_000_000),
    ...(cleanText(input.mapFingerprint ?? fallbackRecord.mapFingerprint, 128)
      ? { mapFingerprint: cleanText(input.mapFingerprint ?? fallbackRecord.mapFingerprint, 128) }
      : {}),
    title: cleanText(input.title ?? fallbackRecord.title, 100) || plan.title,
    status: enumValue(input.status, ['draft', 'approved', 'compiled'], 'draft'),
    sourcePrompt: prompt || plan.sourcePrompt,
    references: normalizeReferences(input.references ?? fallbackRecord.references),
    bindings: {
      actors: normalizeBindings(input.bindings && isRecord(input.bindings) ? input.bindings.actors : undefined),
      props: normalizeBindings(input.bindings && isRecord(input.bindings) ? input.bindings.props : undefined)
    },
    directorPlan: plan,
    compiledRuntime: input.compiledRuntime ?? null,
    createdAt: boundedInteger(input.createdAt ?? fallbackRecord.createdAt, now, 0, 9_999_999_999_999),
    updatedAt: boundedInteger(input.updatedAt ?? fallbackRecord.updatedAt, now, 0, 9_999_999_999_999)
  };
}

export function cinematicSummary(
  document: CinematicDocument,
  currentMapVersion: number | null,
  currentMapFingerprint?: string | null
): CinematicSummary {
  return {
    id: document.id,
    projectId: document.projectId,
    mapId: document.mapId,
    mapVersion: document.mapVersion,
    title: document.title,
    status: document.status,
    updatedAt: document.updatedAt,
    shotCount: document.directorPlan.shots.length,
    durationSeconds: document.directorPlan.estimatedDurationSeconds,
    stale: currentMapVersion === null
      || currentMapVersion !== document.mapVersion
      || Boolean(document.mapFingerprint && currentMapFingerprint && document.mapFingerprint !== currentMapFingerprint)
  };
}

function normalizeReferences(value: unknown): DirectorReferenceContext {
  return normalizeDirectorReferences(value ?? createEmptyDirectorReferences());
}

function normalizeBindings(value: unknown): CinematicActorBinding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = cleanId(item.id, 'binding');
    const objectId = cleanText(item.objectId, 120);
    const assetId = cleanText(item.assetId, 120);
    const role = cleanText(item.role, 160);
    if (!objectId && !assetId) return [];
    return [{ id, ...(objectId ? { objectId } : {}), ...(assetId ? { assetId } : {}), ...(role ? { role } : {}) }];
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown, length: number): string {
  return typeof value === 'string' ? value.trim().slice(0, length) : '';
}

function cleanId(value: unknown, fallback: string): string {
  const id = cleanText(value, 120).replace(/[^a-zA-Z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '');
  return id || fallback;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  return Math.min(maximum, Math.max(minimum, Math.round(Number.isFinite(number) ? number : fallback)));
}

function enumValue<const T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
}
