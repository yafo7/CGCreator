import { Matrix4, PerspectiveCamera, Quaternion, Vector3, Vector4 } from 'three';
import { getMapObjectVisualAabbs } from './map';
import { evaluateCG } from './cgCompiler';
import type { CgVec3, CompiledCG } from './cgTypes';
import { observeCamera } from './cgVisibility';

export interface CgViewItem {
  semanticId: string;
  objectId: string;
  entityId?: string;
  name: string;
  tags: string[];
  screenBounds: { min: [number, number]; max: [number, number] };
  screenRegion: 'left' | 'center' | 'right';
  coverage: number;
  depth: number;
  visibleFraction: number;
  occludedBy: string[];
  semanticParts: Array<{ id: string; name: string }>;
  precision?: 'oriented-box-samples' | 'conservative-model-bounds';
}
export interface CgViewObservation {
  schemaVersion: 1;
  time: number;
  shotId: string;
  camera: { position: CgVec3; target?: CgVec3; fov: number; aspect: number };
  items: CgViewItem[];
}

const corners = (min: CgVec3, max: CgVec3): CgVec3[] => {
  const result: CgVec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) result.push([x, y, z]);
  return result;
};
const segmentHitsBox = (from: Vector3, to: Vector3, min: CgVec3, max: CgVec3): boolean => {
  const direction = to.clone().sub(from);
  let enter = 0, leave = 1;
  for (let axis = 0; axis < 3; axis++) {
    const delta = direction.getComponent(axis);
    if (Math.abs(delta) < 1e-8) { if (from.getComponent(axis) < min[axis] || from.getComponent(axis) > max[axis]) return false; }
    else {
      const a = (min[axis] - from.getComponent(axis)) / delta, b = (max[axis] - from.getComponent(axis)) / delta;
      enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
      if (enter > leave) return false;
    }
  }
  return enter > 1e-4 && enter < 0.995;
};

/** Mechanical camera facts at an exact CG time. This does not make an artistic judgement. */
export function inspectCgView(bundle: CompiledCG, time: number, aspect = 16 / 9): CgViewObservation {
  const frame = evaluateCG(bundle, time);
  if (bundle.evaluationVersion === 2) {
    const observations = observeCamera(bundle.map, bundle.bindings, bundle.resources, frame.entities, frame.camera, aspect);
    return { schemaVersion: 1, time: frame.time, shotId: frame.shotId, camera: { position: frame.camera.position, target: frame.camera.target, fov: frame.camera.fov, aspect }, items: observations.map(item => ({ ...item, semanticId: `object:${item.objectId}`, tags: bundle.map.assets?.find(a => a.id === bundle.map.objects.find(o => o.id === item.objectId)?.assetId)?.tags ?? [], semanticParts: item.visiblePartIds.map(id => ({ id: `object:${item.objectId}/node:${id}`, name: id })) })) };
  }
  const camera = new PerspectiveCamera(frame.camera.fov, Math.max(0.1, aspect), 0.05, 5000);
  camera.position.fromArray(frame.camera.position);
  camera.quaternion.fromArray(frame.camera.quaternion);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const viewProjection = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const bindings = new Map(bundle.bindings.map((binding) => [binding.objectId, binding]));
  const objects = new Map(bundle.map.objects.map((object) => [object.id, object]));
  const assets = new Map((bundle.map.assets ?? []).map((asset) => [asset.id, asset]));
  const boxes = getMapObjectVisualAabbs(bundle.map).map((box) => {
    const binding = bindings.get(box.objectId);
    const state = binding ? frame.entities[binding.entityId] : undefined;
    const initial = binding ? bundle.initial[binding.entityId] : undefined;
    const delta: CgVec3 = state && initial ? [state.position[0] - initial.position[0], state.position[1] - initial.position[1], state.position[2] - initial.position[2]] : [0, 0, 0];
    return { ...box, min: [box.min[0] + delta[0], box.min[1] + delta[1], box.min[2] + delta[2]] as CgVec3, max: [box.max[0] + delta[0], box.max[1] + delta[1], box.max[2] + delta[2]] as CgVec3 };
  });
  const eye = camera.position;
  const items: CgViewItem[] = [];
  for (const box of boxes) {
    const object = objects.get(box.objectId);
    if (!object) continue;
    const binding = bindings.get(box.objectId);
    if (binding && frame.entities[binding.entityId]?.visible === false) continue;
    const projected = corners(box.min, box.max).map((point) => new Vector4(...point, 1).applyMatrix4(viewProjection)).filter((point) => point.w > 1e-7).map((point) => [point.x / point.w, point.y / point.w, point.z / point.w] as CgVec3);
    if (!projected.length) continue;
    const minX = Math.max(-1, Math.min(...projected.map((point) => point[0]))), maxX = Math.min(1, Math.max(...projected.map((point) => point[0])));
    const minY = Math.max(-1, Math.min(...projected.map((point) => point[1]))), maxY = Math.min(1, Math.max(...projected.map((point) => point[1])));
    if (minX >= maxX || minY >= maxY || projected.every((point) => point[2] < -1 || point[2] > 1)) continue;
    const samples = [new Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2), ...corners(box.min, box.max).map((point) => new Vector3(...point))];
    const blockers = new Set<string>();
    let visible = 0;
    for (const sample of samples) {
      const blocked = boxes.filter((other) => other.objectId !== box.objectId && segmentHitsBox(eye, sample, other.min, other.max)).sort((a, b) => eye.distanceTo(new Vector3(...a.min)) - eye.distanceTo(new Vector3(...b.min)))[0];
      if (blocked) blockers.add(blocked.objectId); else visible++;
    }
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    const nodes = ((asset?.modelJson as { nodes?: Array<{ id?: unknown; name?: unknown; label?: unknown }> } | undefined)?.nodes ?? []).filter((node) => typeof node.id === 'string');
    const centerX = (minX + maxX) / 2;
    items.push({ semanticId: `object:${box.objectId}`, objectId: box.objectId, ...(binding ? { entityId: binding.entityId } : {}), name: object.name, tags: asset?.tags ?? [], screenBounds: { min: [(minX + 1) / 2, (1 - maxY) / 2], max: [(maxX + 1) / 2, (1 - minY) / 2] }, screenRegion: centerX < -0.25 ? 'left' : centerX > 0.25 ? 'right' : 'center', coverage: Math.max(0, (maxX - minX) * (maxY - minY) / 4), depth: eye.distanceTo(samples[0]), visibleFraction: visible / samples.length, occludedBy: [...blockers], semanticParts: nodes.slice(0, 64).map((node) => ({ id: `object:${box.objectId}/node:${node.id as string}`, name: typeof node.name === 'string' ? node.name : typeof node.label === 'string' ? node.label : node.id as string })) });
  }
  items.sort((left, right) => right.coverage - left.coverage || left.depth - right.depth || left.semanticId.localeCompare(right.semanticId));
  return { schemaVersion: 1, time: frame.time, shotId: frame.shotId, camera: { position: [...frame.camera.position], ...(frame.camera.target ? { target: [...frame.camera.target] } : {}), fov: frame.camera.fov, aspect }, items };
}

export function inspectShotSamples(bundle: CompiledCG, shotId: string, aspect = 16 / 9): CgViewObservation[] {
  const shot = bundle.shots.find((candidate) => candidate.id === shotId);
  if (!shot) return [];
  const epsilon = Math.min(1e-4, Math.max(0, (shot.end - shot.start) / 1000));
  return [shot.start, (shot.start + shot.end) / 2, Math.max(shot.start, shot.end - epsilon)].map((time) => inspectCgView(bundle, time, aspect));
}
