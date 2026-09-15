import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { getMapBounds, getObjectWorldTransforms, sampleTerrainHeight, type EditableMap, type MapObjectAabb } from './map';
import { mapGuidePolyline } from './mapGuide';
import { isPointInsidePlayableArea } from './mapLayout';
import { isPointInsideWaterBody, waterSurfaceLevelAt } from './mapWater';
import { buildPoseRig, evaluateRig } from './cgPoseEvaluator';
import { regionContains } from './cgSpatialRegions';
import type { CgAction, CgVec3 } from './cgTypes';

export interface CgSupportSurface { id: string; matrix: number[]; inverse: number[]; min: CgVec3; max: CgVec3; normal: CgVec3 }
export interface CgNavigationWorld { map: EditableMap; boxes: MapObjectAabb[]; surfaces: CgSupportSurface[] }
export interface CgNavigationResult { points: CgVec3[]; surfaceIds: string[] }

/** Only named, flat box support faces are admitted in this backend. Unknown
 * mesh tops, chair seats and roof tops are not guessed into walkable floors. */
export function createNavigationWorld(map: EditableMap, boxes: MapObjectAabb[]): CgNavigationWorld {
  const surfaces: CgSupportSurface[] = [], transforms = getObjectWorldTransforms(map);
  const assets = new Map((map.assets ?? []).map(a => [a.id, a]));
  for (const object of map.objects.filter(o => o.visible)) {
    const asset = assets.get(object.assetId ?? ''), transform = transforms.get(object.id);
    if (!transform) continue;
    const world = new Matrix4().compose(new Vector3(...transform.position), new Quaternion().setFromEuler(new Euler(...transform.rotation)), new Vector3(...transform.scale));
    let parts: Array<{ id: string; name: string; geometry?: string; bounds?: { min: CgVec3; max: CgVec3 }; matrix: Matrix4 }>;
    if (asset) {
      const rig = buildPoseRig(asset.modelJson), matrices = evaluateRig(rig);
      parts = rig.nodes.map(n => ({ ...n, matrix: world.clone().multiply(matrices.get(n.id)!) }));
    } else parts = [{ id: 'primitive', name: object.name, geometry: 'box', bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }, matrix: world }];
    for (const part of parts) {
      if (!part.bounds || part.geometry !== 'box' || !/floor|deck|platform|step|stair|walkable|地板|桥面|平台|台阶|踏步/i.test(part.name)) continue;
      const normal = new Vector3(0, 1, 0).transformDirection(part.matrix);
      if (normal.y < Math.cos(Math.PI / 4)) continue;
      surfaces.push({ id: `${object.id}/surface:${part.id}`, matrix: part.matrix.toArray(), inverse: part.matrix.clone().invert().toArray(), min: part.bounds.min, max: part.bounds.max, normal: normal.toArray() as CgVec3 });
    }
  }
  return { map, boxes, surfaces };
}

export function supportAt(world: CgNavigationWorld, x: number, z: number, nearY: number, radius: number): { point: CgVec3; surfaceId: string } | null {
  const options: Array<{ point: CgVec3; surfaceId: string }> = [{ point: [x, sampleTerrainHeight(world.map, x, z), z], surfaceId: 'terrain' }];
  for (const surface of world.surfaces) {
    const matrix = new Matrix4().fromArray(surface.matrix), normal = new Vector3(...surface.normal);
    const top = new Vector3(0, surface.max[1], 0).applyMatrix4(matrix);
    const y = top.y - (normal.x * (x - top.x) + normal.z * (z - top.z)) / normal.y;
    const inverse = new Matrix4().fromArray(surface.inverse);
    const probes = [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]];
    if (!probes.every(([dx, dz], i) => { const local = new Vector3(x + dx, y - (normal.x * dx + normal.z * dz) / normal.y, z + dz).applyMatrix4(inverse); const onFace = local.x >= surface.min[0] - 1e-5 && local.x <= surface.max[0] + 1e-5 && local.z >= surface.min[2] - 1e-5 && local.z <= surface.max[2] + 1e-5; return onFace || i > 0 && Math.abs(sampleTerrainHeight(world.map, x + dx, z + dz) - y) <= 0.26; })) continue;
    options.push({ point: [x, y, z], surfaceId: surface.id });
  }
  return options.filter(o => Math.abs(o.point[1] - nearY) <= 0.26).sort((a, b) => b.point[1] - a.point[1] || a.surfaceId.localeCompare(b.surfaceId))[0] ?? null;
}

function isStepSupport(world: CgNavigationWorld, box: MapObjectAabb, y: number): boolean {
  if (box.max[1] > y + 0.26 || box.max[1] < y - 0.04) return false;
  return world.surfaces.some(s => {
    if (!s.id.startsWith(`${box.objectId}/surface:`)) return false;
    const top = new Vector3(0, s.max[1], 0).applyMatrix4(new Matrix4().fromArray(s.matrix));
    return Math.abs(top.y - box.max[1]) < 0.015;
  });
}

export function navigationPointFree(world: CgNavigationWorld, point: CgVec3, radius: number, height: number, route?: CgAction['route']): boolean {
  const [x, y, z] = point, bounds = getMapBounds(world.map);
  if (x < bounds.minX + radius || x > bounds.maxX - radius || z < bounds.minZ + radius || z > bounds.maxZ - radius) return false;
  if ([[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]].some(([dx, dz]) => !isPointInsidePlayableArea(world.map.layout, world.map.box.size, x + dx, z + dz))) return false;
  const support = supportAt(world, x, z, y, radius);
  if (!support || Math.abs(support.point[1] - y) > 0.04) return false;
  if (support.surfaceId === 'terrain' && world.map.waterBodies.some(w => isPointInsideWaterBody(w, x, z, world.map) && y < waterSurfaceLevelAt(w, x, z) - 0.02)) return false;
  if (world.boxes.some(b => !isStepSupport(world, b, y) && y + height > b.min[1] + 1e-4 && y < b.max[1] - 1e-4 && x > b.min[0] - radius && x < b.max[0] + radius && z > b.min[2] - radius && z < b.max[2] + radius)) return false;
  if (route?.policy === 'required') {
    const guides = route.guideIds.map(id => world.map.guides.find(g => g.id === id));
    if (guides.some(g => !g) || !guides.some(g => g!.width > 2 * radius && regionContains({ kind: 'path', points: mapGuidePolyline(g!, 256), width: g!.width - radius * 2 }, [x, z]))) return false;
  }
  return true;
}

function segment(world: CgNavigationWorld, from: CgVec3, to: CgVec3, radius: number, height: number, route?: CgAction['route']): CgNavigationResult | null {
  const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[2] - from[2]) / 0.12));
  const points: CgVec3[] = [[...from]], surfaceIds: string[] = [supportAt(world, ...[from[0], from[2], from[1], radius] as [number, number, number, number])?.surfaceId ?? 'terrain'];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t;
    const previous = points[points.length - 1], support = supportAt(world, x, z, previous[1], radius);
    if (!support || !navigationPointFree(world, support.point, radius, height, route)) return null;
    const p = support.point;
    if (Math.abs(p[1] - previous[1]) > 0.25 + Math.hypot(p[0] - previous[0], p[2] - previous[2]) * Math.tan(Math.PI / 4)) return null;
    if (i === steps && Math.abs(p[1] - to[1]) > 0.04) return null;
    // Sweep expanded boxes, including thin walls between support samples.
    if (world.boxes.some(b => !isStepSupport(world, b, Math.max(previous[1], p[1])) && sweptBox(previous, p, b, radius, height))) return null;
    points.push(i === steps ? [...to] : p); surfaceIds.push(support.surfaceId);
  }
  return { points, surfaceIds };
}

function sweptBox(a: CgVec3, b: CgVec3, box: MapObjectAabb, radius: number, height: number): boolean {
  let lo = 0, hi = 1;
  const min = [box.min[0] - radius + 1e-4, box.min[1] - height + 1e-4, box.min[2] - radius + 1e-4], max = [box.max[0] + radius - 1e-4, box.max[1] - 1e-4, box.max[2] + radius - 1e-4];
  for (let k = 0; k < 3; k++) { const d = b[k] - a[k]; if (Math.abs(d) < 1e-8) { if (a[k] <= min[k] || a[k] >= max[k]) return false; } else { const t1 = (min[k] - a[k]) / d, t2 = (max[k] - a[k]) / d; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)); if (lo >= hi) return false; } }
  return hi > 0 && lo < 1;
}

/** Bounded deterministic graph search. Guide samples retain bends; grid nodes
 * provide local obstacle detours. Multiple height layers retain surface IDs. */
export function findNavigationPath(world: CgNavigationWorld, start: CgVec3, target: CgVec3, radius: number, height: number, route?: CgAction['route']): CgNavigationResult | null {
  if (route?.guideIds.some(id => !world.map.guides.some(g => g.id === id))) return null;
  if (!navigationPointFree(world, start, radius, height, route) || !navigationPointFree(world, target, radius, height, route)) return null;
  const direct = segment(world, start, target, radius, height, route);
  if (direct && (!route || route.policy === 'required')) return direct;
  // A visibility graph over dense guide points is small for authored routes.
  const nodes: CgVec3[] = [[...start], [...target]];
  const guides = route ? world.map.guides.filter(g => route.guideIds.includes(g.id)) : [];
  for (const guide of guides) for (const [x, z] of mapGuidePolyline(guide, 192)) {
    const heights = [sampleTerrainHeight(world.map, x, z), ...world.surfaces.map(s => new Vector3(0, s.max[1], 0).applyMatrix4(new Matrix4().fromArray(s.matrix)).y)];
    for (const y of heights) { const s = supportAt(world, x, z, y, radius); if (s && navigationPointFree(world, s.point, radius, height, route) && !nodes.some(p => new Vector3(...p).distanceTo(new Vector3(...s.point)) < 0.02)) nodes.push(s.point); }
  }
  // Fixed-size local grid allows route corridors to bend around obstacles.
  const bounds = getMapBounds(world.map), spacing = Math.max(0.6, radius * 2, Math.max(world.map.box.size[0], world.map.box.size[2]) / 45);
  for (let x = bounds.minX + radius; x <= bounds.maxX - radius; x += spacing) for (let z = bounds.minZ + radius; z <= bounds.maxZ - radius; z += spacing) {
    const y = sampleTerrainHeight(world.map, x, z), s = supportAt(world, x, z, y, radius);
    if (s && navigationPointFree(world, s.point, radius, height, route)) nodes.push(s.point);
  }
  const costs = new Map<number, number>([[0, 0]]), parent = new Map<number, number>(), open = new Set([0]), closed = new Set<number>();
  const distance = (a: number, b: number) => Math.hypot(...nodes[a].map((n, i) => n - nodes[b][i]));
  const edges = new Map<string, CgNavigationResult>();
  for (let visits = 0; open.size && visits < nodes.length; visits++) {
    const current = [...open].sort((a, b) => costs.get(a)! + distance(a, 1) - costs.get(b)! - distance(b, 1) || a - b)[0];
    open.delete(current); if (current === 1) break; closed.add(current);
    const candidates = nodes.map((_, i) => i).filter(i => i !== current && !closed.has(i) && (i === 1 || distance(current, i) <= spacing * 1.6 || i < 2 + guides.length * 192)).sort((a, b) => distance(current, a) - distance(current, b) || a - b).slice(0, 48);
    if (!candidates.includes(1)) candidates.push(1);
    for (const next of candidates) {
      const path = segment(world, nodes[current], nodes[next], radius, height, route); if (!path) continue;
      const onGuide = guides.some(g => regionContains({ kind: 'path', points: mapGuidePolyline(g, 256), width: g.width }, [nodes[next][0], nodes[next][2]]));
      const cost = costs.get(current)! + distance(current, next) * (route?.policy === 'preferred' && !onGuide ? 4 : 1);
      if (cost >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, cost); parent.set(next, current); edges.set(`${current}:${next}`, path); open.add(next);
    }
  }
  if (!parent.has(1)) return direct;
  const chain = [1]; while (chain[0] !== 0) chain.unshift(parent.get(chain[0])!);
  const result: CgNavigationResult = { points: [[...start]], surfaceIds: [supportAt(world, start[0], start[2], start[1], radius)!.surfaceId] };
  for (let i = 1; i < chain.length; i++) { const part = edges.get(`${chain[i - 1]}:${chain[i]}`)!; result.points.push(...part.points.slice(1)); result.surfaceIds.push(...part.surfaceIds.slice(1)); }
  return result;
}
