import type { CompiledCG } from './cgTypes';

export type CgTimelineTrackKind = 'camera' | 'actor' | 'prop' | 'effects';
export interface CgTimelineClip {
  kind: 'clip';
  id: string;
  sourceId: string;
  start: number;
  duration: number;
  sourceRange?: { start: number; duration: number };
}
export interface CgTimelineGap { kind: 'gap'; id: string; start: number; duration: number }
export interface CgTimelineTransition { kind: 'transition'; id: string; start: number; duration: number; transition: 'cut' | 'ease-in-out' }
export interface CgTimelineTrack {
  id: string;
  kind: CgTimelineTrackKind;
  targetId?: string;
  items: Array<CgTimelineClip | CgTimelineGap | CgTimelineTransition>;
}
export interface CgTimelineComposition { schemaVersion: 1; duration: number; tracks: CgTimelineTrack[] }

/** OTIO-inspired view of the compiled result. It is derived data for editors
 * and interchange; CompiledCG remains the runtime authority. */
export function buildTimelineComposition(bundle: CompiledCG): CgTimelineComposition {
  const camera: CgTimelineTrack = { id: 'track:camera', kind: 'camera', items: [] };
  let cursor = 0;
  for (const shot of bundle.shots) {
    if (shot.start > cursor) camera.items.push({ kind: 'gap', id: `gap:camera:${cursor}`, start: cursor, duration: shot.start - cursor });
    camera.items.push({ kind: 'clip', id: `clip:${shot.id}`, sourceId: shot.id, start: shot.start, duration: shot.end - shot.start });
    if (shot.transition?.type === 'ease-in-out' && shot.transition.duration) camera.items.push({ kind: 'transition', id: `transition:${shot.id}`, start: shot.start, duration: shot.transition.duration, transition: shot.transition.type });
    cursor = Math.max(cursor, shot.end);
  }
  const tracks = [camera];
  for (const entity of bundle.document.entities) tracks.push({
    id: `track:${entity.id}`,
    kind: entity.kind,
    targetId: entity.id,
    items: bundle.actions.filter(action => action.entityId === entity.id).map(action => ({ kind: 'clip' as const, id: `clip:${action.id}`, sourceId: action.clipId ?? action.id, start: action.start, duration: action.end - action.start, ...(action.clipId ? { sourceRange: { start: 0, duration: action.duration } } : {}) }))
  });
  return { schemaVersion: 1, duration: bundle.duration, tracks };
}
