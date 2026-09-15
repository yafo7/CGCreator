import { Box3, Euler, Matrix4, PerspectiveCamera, Quaternion, Ray, Vector3, Vector4 } from 'three';
import { buildRoomShellSegments, getObjectWorldTransforms, sampleTerrainHeight, type EditableMap } from './map';
import { buildPoseRig, evaluateRig, poseMatrix, type CgPoseRig } from './cgPoseEvaluator';
import type { CgBinding, CgCameraPose, CgEntityState, CgResources, CgVec3 } from './cgTypes';

export interface CgVisibilityItem {
  objectId: string; entityId?: string; name: string;
  screenRegion: 'left' | 'center' | 'right';
  screenBounds: { min: [number, number]; max: [number, number] };
  coverage: number; visibleFraction: number; depth: number; occludedBy: string[];
  visiblePartIds: string[];
  landmarks?: Record<string, { screen: [number, number]; visible: boolean; occludedBy?: string }>;
  precision: 'oriented-box-samples' | 'conservative-model-bounds';
}
interface Part { objectId: string; nodeId: string; inverse: Matrix4; bounds: Box3; worldBounds: Box3; matrix: Matrix4; opaque: boolean; geometry: string }
interface ObjectEntry { id: string; name: string; rig: CgPoseRig; root: Matrix4; visible: boolean; opacity: Map<string, number> }
interface Tree { bounds: Box3; parts?: Part[]; left?: Tree; right?: Tree }

const staticCache = new WeakMap<EditableMap, ObjectEntry[]>();
function sceneEntries(map: EditableMap): ObjectEntry[] {
  const cached = staticCache.get(map); if (cached) return cached;
  const assets = new Map((map.assets ?? []).map(a => [a.id, a])), rigs = new Map<string, CgPoseRig>(), transforms = getObjectWorldTransforms(map);
  const entries = map.objects.flatMap(object => {
    const transform = transforms.get(object.id); if (!transform) return [];
    const asset = assets.get(object.assetId ?? '');
    let rig = rigs.get(object.assetId ?? '');
    if (!rig) {
      rig = asset ? buildPoseRig(asset.modelJson) : { nodes: [{ id: 'primitive', name: object.name, geometry: 'box', bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }], normalization: [0, 0, 0], landmarks: {} };
      if (asset) rigs.set(asset.id, rig);
    }
    const rawNodes = (asset?.modelJson as { nodes?: Array<{ id: string; mesh?: { material?: { transparent?: boolean; opacity?: number } } }> })?.nodes ?? [];
    const opacity = new Map(rawNodes.map(n => [n.id, n.mesh?.material?.opacity ?? 1]));
    return [{ id: object.id, name: object.name, rig, visible: object.visible, opacity, root: new Matrix4().compose(new Vector3(...transform.position), new Quaternion().setFromEuler(new Euler(...transform.rotation)), new Vector3(...transform.scale)) }];
  });
  staticCache.set(map, entries); return entries;
}
function buildTree(parts: Part[]): Tree {
  const bounds = parts.reduce((b, p) => b.union(p.worldBounds), new Box3());
  if (parts.length <= 8) return { bounds, parts };
  const size = bounds.getSize(new Vector3()), axis = size.x > size.y && size.x > size.z ? 'x' : size.y > size.z ? 'y' : 'z';
  const sorted = [...parts].sort((a, b) => a.worldBounds.getCenter(new Vector3())[axis] - b.worldBounds.getCenter(new Vector3())[axis] || a.nodeId.localeCompare(b.nodeId));
  const mid = Math.floor(sorted.length / 2);
  return { bounds, left: buildTree(sorted.slice(0, mid)), right: buildTree(sorted.slice(mid)) };
}
function firstBlocker(tree: Tree, from: Vector3, to: Vector3, ignoreObjectId: string, ignoreNodeId?: string): string | null {
  const distance = from.distanceTo(to), ray = new Ray(from, to.clone().sub(from).normalize());
  let nearest = distance - 1e-4, blocker: string | null = null;
  const visit = (node: Tree) => {
    const hit = ray.intersectBox(node.bounds, new Vector3());
    if (!hit || (!node.bounds.containsPoint(from) && from.distanceTo(hit) > nearest)) return;
    if (node.parts) for (const part of node.parts) {
      if (!part.opaque || part.objectId === ignoreObjectId && (!ignoreNodeId || part.nodeId === ignoreNodeId)) continue;
      const localFrom = from.clone().applyMatrix4(part.inverse), localTo = to.clone().applyMatrix4(part.inverse);
      const localRay = new Ray(localFrom, localTo.sub(localFrom).normalize());
      const localHit = localRay.intersectBox(part.bounds, new Vector3());
      if (localHit) { const length = from.distanceTo(localHit.applyMatrix4(part.matrix)); if (length > 1e-4 && length < nearest) { nearest = length; blocker = part.objectId; } }
    } else { if (node.left) visit(node.left); if (node.right) visit(node.right); }
  };
  visit(tree); return blocker;
}

const corners = (box: Box3) => [0, 1, 2, 3, 4, 5, 6, 7].map(i => new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
function terrainBlocks(map: EditableMap, from: Vector3, to: Vector3): boolean {
  const count = Math.min(512, Math.max(2, Math.ceil(from.distanceTo(to) / 0.2)));
  for (let i = 1; i < count; i++) { const p = from.clone().lerp(to, i / count); if (p.y < sampleTerrainHeight(map, p.x, p.z) - 0.02) return true; }
  return false;
}
function projectedPart(part: Part, projection: Matrix4): Vector4[] {
  const vertices = corners(part.bounds).map(p => new Vector4(p.x, p.y, p.z, 1).applyMatrix4(part.matrix).applyMatrix4(projection));
  const planes = [(p: Vector4) => p.w + p.x, (p: Vector4) => p.w - p.x, (p: Vector4) => p.w + p.y, (p: Vector4) => p.w - p.y, (p: Vector4) => p.w + p.z, (p: Vector4) => p.w - p.z];
  return faces.flatMap(face => {
    let polygon = face.map(i => vertices[i]);
    for (const plane of planes) {
      const clipped: Vector4[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length], da = plane(a), db = plane(b);
        if (da >= 0) clipped.push(a);
        if ((da >= 0) !== (db >= 0)) clipped.push(a.clone().lerp(b, da / (da - db)));
      }
      polygon = clipped;
    }
    return polygon.filter(p => p.w > 1e-7);
  });
}

/** Numerical visibility against the world at t; no image recognition. The
 * report deliberately distinguishes conservative bounds from pixel coverage. */
export function observeCamera(map: EditableMap, bindings: CgBinding[], resources: CgResources, states: Record<string, CgEntityState>, pose: CgCameraPose, aspect = 16 / 9, targetObjectIds?: string[]): CgVisibilityItem[] {
  const entries = sceneEntries(map), bindingByObject = new Map(bindings.map(b => [b.objectId, b]));
  const parts: Part[] = [];
  for (const entry of entries) {
    const binding = bindingByObject.get(entry.id), state = binding ? states[binding.entityId] : undefined;
    if (state ? !state.visible : !entry.visible) continue;
    const rig = binding?.poseRig ?? entry.rig, clip = state?.clipId ? resources.clips.find(c => c.id === state.clipId) : undefined;
    const matrices = evaluateRig(rig, clip, state?.clipTime ?? 0, state?.clipWeight ?? 1), root = state ? poseMatrix(state) : entry.root;
    for (const node of rig.nodes) if (node.bounds && (entry.opacity.get(node.id) ?? 1) > 0) {
      const matrix = root.clone().multiply(matrices.get(node.id)!), bounds = new Box3(new Vector3(...node.bounds.min), new Vector3(...node.bounds.max));
      parts.push({ objectId: entry.id, nodeId: node.id, bounds, matrix, inverse: matrix.clone().invert(), worldBounds: bounds.clone().applyMatrix4(matrix), opaque: (entry.opacity.get(node.id) ?? 1) >= 0.98, geometry: node.geometry ?? 'unknown' });
    }
  }
  for (const [index, wall] of buildRoomShellSegments(map).entries()) {
    const matrix = new Matrix4().makeTranslation(...wall.center), bounds = new Box3(new Vector3(-wall.size[0] / 2, -wall.size[1] / 2, -wall.size[2] / 2), new Vector3(wall.size[0] / 2, wall.size[1] / 2, wall.size[2] / 2));
    parts.push({ objectId: `room:${wall.surface}:${index}`, nodeId: 'shell', bounds, matrix, inverse: matrix.clone().invert(), worldBounds: bounds.clone().applyMatrix4(matrix), opaque: true, geometry: 'box' });
  }
  if (!parts.length) return [];
  const tree = buildTree(parts), camera = new PerspectiveCamera(pose.fov, aspect, 0.05, 5000);
  camera.position.fromArray(pose.position); camera.quaternion.fromArray(pose.quaternion); camera.updateMatrixWorld(true); camera.updateProjectionMatrix();
  const projection = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse), items: CgVisibilityItem[] = [];
  for (const entry of entries) {
    if (targetObjectIds && !targetObjectIds.includes(entry.id)) continue;
    const own = parts.filter(p => p.objectId === entry.id), projected = own.flatMap(p => projectedPart(p, projection));
    if (!projected.length) continue;
    const xs = projected.map(p => p.x / p.w), ys = projected.map(p => p.y / p.w);
    const minX = Math.max(-1, Math.min(...xs)), maxX = Math.min(1, Math.max(...xs)), minY = Math.max(-1, Math.min(...ys)), maxY = Math.min(1, Math.max(...ys));
    if (minX >= maxX || minY >= maxY) continue;
    const occludedBy = new Set<string>(), visibleParts = new Set<string>(); let visible = 0, total = 0;
    for (const part of own) {
      if (!projectedPart(part, projection).length) continue;
      const samples = [part.bounds.getCenter(new Vector3()), ...corners(part.bounds)];
      for (const local of samples) {
        const point = local.applyMatrix4(part.matrix), screen = new Vector4(point.x, point.y, point.z, 1).applyMatrix4(projection);
        if (screen.w <= 0 || Math.abs(screen.x) > screen.w || Math.abs(screen.y) > screen.w || Math.abs(screen.z) > screen.w) continue;
        total++;
        let blocker = firstBlocker(tree, camera.position, point, part.objectId);
        if (!blocker && terrainBlocks(map, camera.position, point)) blocker = 'terrain';
        if (blocker) occludedBy.add(blocker); else { visible++; visibleParts.add(part.nodeId); }
      }
    }
    const binding = bindingByObject.get(entry.id), center = (minX + maxX) / 2;
    const landmarks: CgVisibilityItem['landmarks'] = {};
    if (binding) for (const [name, position] of Object.entries(states[binding.entityId]?.landmarks ?? {})) {
      const point = new Vector3(...position), clip = new Vector4(point.x, point.y, point.z, 1).applyMatrix4(projection);
      const nodeId = binding.poseRig?.landmarks[name as keyof CgPoseRig['landmarks']]?.nodeId;
      const blocker = firstBlocker(tree, camera.position, point, entry.id, nodeId) ?? (terrainBlocks(map, camera.position, point) ? 'terrain' : null);
      const inFrame = clip.w > 0 && Math.abs(clip.x) <= clip.w && Math.abs(clip.y) <= clip.w && Math.abs(clip.z) <= clip.w;
      landmarks[name] = { screen: clip.w > 0 ? [(clip.x / clip.w + 1) / 2, (1 - clip.y / clip.w) / 2] : [-1, -1], visible: inFrame && !blocker, ...(blocker ? { occludedBy: blocker } : {}) };
    }
    items.push({ objectId: entry.id, ...(binding ? { entityId: binding.entityId } : {}), name: entry.name, screenRegion: center < -0.25 ? 'left' : center > 0.25 ? 'right' : 'center', screenBounds: { min: [(minX + 1) / 2, (1 - maxY) / 2], max: [(maxX + 1) / 2, (1 - minY) / 2] }, coverage: (maxX - minX) * (maxY - minY) / 4, visibleFraction: total ? visible / total : 0, depth: own[0] ? camera.position.distanceTo(own[0].worldBounds.getCenter(new Vector3())) : 0, occludedBy: [...occludedBy], visiblePartIds: [...visibleParts], landmarks, precision: own.every(p => p.geometry === 'box') ? 'oriented-box-samples' : 'conservative-model-bounds' });
  }
  return items.sort((a, b) => b.coverage - a.coverage || a.objectId.localeCompare(b.objectId));
}
