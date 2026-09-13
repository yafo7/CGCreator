import { getMapBounds, sampleTerrainHeight, type EditableMap, type MapObjectAabb } from './map';
import { isPointInsidePlayableArea } from './mapLayout';
import type { CgVec3 } from './cgTypes';

const EPS = 1e-5;
export const distance = (a: CgVec3, b: CgVec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const mix = (a: CgVec3, b: CgVec3, t: number): CgVec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A conservative ground-agent volume. Exact user anchors are never snapped. */
export function freeGroundPoint(map: EditableMap, boxes: MapObjectAabb[], point: CgVec3, radius: number, height: number): boolean {
  const [x, y, z] = point;
  const bounds = getMapBounds(map);
  if (x < bounds.minX + radius || x > bounds.maxX - radius || z < bounds.minZ + radius || z > bounds.maxZ - radius) return false;
  if (y < sampleTerrainHeight(map, x, z) - 0.035) return false;
  for (const [dx, dz] of [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
    if (!isPointInsidePlayableArea(map.layout, map.box.size, x + dx, z + dz)) return false;
  }
  return !boxes.some((b) => y + height > b.min[1] + EPS && y < b.max[1] - EPS
    && x > b.min[0] - radius + EPS && x < b.max[0] + radius - EPS
    && z > b.min[2] - radius + EPS && z < b.max[2] + radius - EPS);
}

/** Segment/AABB slabs avoid tunnelling through thin walls between path samples. */
function crossesBox(a: CgVec3, b: CgVec3, box: MapObjectAabb, radius: number, height: number): boolean {
  const low = [box.min[0] - radius + EPS, box.min[1] - height + EPS, box.min[2] - radius + EPS];
  const high = [box.max[0] + radius - EPS, box.max[1] - EPS, box.max[2] + radius - EPS];
  let enter = 0, leave = 1;
  for (let axis = 0; axis < 3; axis++) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < EPS) { if (a[axis] <= low[axis] || a[axis] >= high[axis]) return false; }
    else {
      const t1 = (low[axis] - a[axis]) / delta, t2 = (high[axis] - a[axis]) / delta;
      enter = Math.max(enter, Math.min(t1, t2)); leave = Math.min(leave, Math.max(t1, t2));
      if (enter >= leave) return false;
    }
  }
  return leave > 0 && enter < 1;
}

function groundSegment(map: EditableMap, boxes: MapObjectAabb[], a: CgVec3, b: CgVec3, radius: number, height: number): CgVec3[] | null {
  const horizontal = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const steps = Math.max(1, Math.ceil(horizontal / Math.max(0.08, Math.min(0.25, radius * 0.7))));
  const offsetA = a[1] - sampleTerrainHeight(map, a[0], a[2]);
  const offsetB = b[1] - sampleTerrainHeight(map, b[0], b[2]);
  // Ground walking cannot resolve a floating target by inventing a jump or climb.
  if (Math.abs(offsetA) > 0.15 || Math.abs(offsetB) > 0.15) return null;
  const result: CgVec3[] = [[...a]];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, p = mix(a, b, t);
    p[1] = i === steps ? b[1] : sampleTerrainHeight(map, p[0], p[2]) + offsetA * (1 - t) + offsetB * t;
    const prev = result[result.length - 1];
    if (Math.abs(p[1] - prev[1]) > Math.hypot(p[0] - prev[0], p[2] - prev[2]) * Math.tan(Math.PI / 4) + 0.02) return null;
    if (!freeGroundPoint(map, boxes, p, radius, height) || boxes.some((box) => crossesBox(prev, p, box, radius, height))) return null;
    result.push(p);
  }
  return result;
}

class MinHeap {
  private entries: { index: number; score: number; order: number }[] = [];
  private order = 0;
  private less(a: { score: number; order: number }, b: { score: number; order: number }) { return a.score < b.score || (a.score === b.score && a.order < b.order); }
  push(index: number, score: number) {
    const entry = { index, score, order: this.order++ }; this.entries.push(entry);
    let i = this.entries.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(entry, this.entries[p])) break; this.entries[i] = this.entries[p]; i = p; }
    this.entries[i] = entry;
  }
  pop(): number | undefined {
    if (!this.entries.length) return undefined;
    const first = this.entries[0], last = this.entries.pop()!;
    if (this.entries.length) {
      let i = 0;
      while (i * 2 + 1 < this.entries.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.entries.length && this.less(this.entries[child + 1], this.entries[child])) child++;
        if (!this.less(this.entries[child], last)) break;
        this.entries[i] = this.entries[child]; i = child;
      }
      this.entries[i] = last;
    }
    return first.index;
  }
}

/** Deterministic A* with exact endpoints, terrain heights, fixed tie order and a bounded grid. */
export function findGroundPath(map: EditableMap, boxes: MapObjectAabb[], start: CgVec3, target: CgVec3, radius: number, height: number): CgVec3[] | null {
  if (!freeGroundPoint(map, boxes, start, radius, height) || !freeGroundPoint(map, boxes, target, radius, height)) return null;
  const direct = groundSegment(map, boxes, start, target, radius, height);
  if (direct) return direct;
  const bounds = getMapBounds(map);
  const spacing = Math.max(0.3, radius, Math.max(map.box.size[0], map.box.size[2]) / 160);
  const nx = Math.floor((bounds.maxX - bounds.minX - 2 * radius) / spacing) + 1;
  const nz = Math.floor((bounds.maxZ - bounds.minZ - 2 * radius) / spacing) + 1;
  if (nx < 1 || nz < 1) return null;
  const points = new Map<number, CgVec3>();
  const point = (index: number): CgVec3 => {
    let p = points.get(index);
    if (!p) { const x = bounds.minX + radius + index % nx * spacing, z = bounds.minZ + radius + Math.floor(index / nx) * spacing; p = [x, sampleTerrainHeight(map, x, z), z]; points.set(index, p); }
    return p;
  };
  const neighborsOfPosition = (p: CgVec3) => {
    const x = Math.round((p[0] - bounds.minX - radius) / spacing), z = Math.round((p[2] - bounds.minZ - radius) / spacing);
    const ids: number[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && x + dx < nx && z + dz >= 0 && z + dz < nz) ids.push((z + dz) * nx + x + dx);
    return ids.sort((a, b) => distance(point(a), p) - distance(point(b), p) || a - b);
  };
  const goalIndices = new Set(neighborsOfPosition(target).filter((i) => groundSegment(map, boxes, point(i), target, radius, height)));
  if (!goalIndices.size) return null;
  const open = new MinHeap(), costs = new Map<number, number>(), parents = new Map<number, number>(), closed = new Set<number>();
  for (const i of neighborsOfPosition(start)) {
    if (!groundSegment(map, boxes, start, point(i), radius, height)) continue;
    const cost = distance(start, point(i)); costs.set(i, cost); parents.set(i, -1); open.push(i, cost + distance(point(i), target));
  }
  let goal: number | undefined;
  for (let visits = 0; visits < nx * nz; visits++) {
    const current = open.pop(); if (current === undefined) break;
    if (closed.has(current)) { visits--; continue; }
    closed.add(current);
    if (goalIndices.has(current)) { goal = current; break; }
    const x = current % nx, z = Math.floor(current / nx);
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      const xx = x + dx, zz = z + dz;
      if (xx < 0 || xx >= nx || zz < 0 || zz >= nz) continue;
      const next = zz * nx + xx;
      if (closed.has(next) || !groundSegment(map, boxes, point(current), point(next), radius, height)) continue;
      const cost = costs.get(current)! + distance(point(current), point(next));
      if (cost >= (costs.get(next) ?? Infinity) - EPS) continue;
      costs.set(next, cost); parents.set(next, current); open.push(next, cost + distance(point(next), target));
    }
  }
  if (goal === undefined) return null;
  const coarse: CgVec3[] = [[...target]];
  for (let at = goal; at !== -1; at = parents.get(at)!) coarse.push(point(at));
  coarse.push([...start]); coarse.reverse();
  // Preserve sampled terrain; shortcuts are accepted only after swept-volume validation.
  const result: CgVec3[] = [[...start]];
  for (let i = 0; i < coarse.length - 1;) {
    let next = i + 1, segment = groundSegment(map, boxes, coarse[i], coarse[next], radius, height)!;
    for (let j = coarse.length - 1; j > next; j--) { const candidate = groundSegment(map, boxes, coarse[i], coarse[j], radius, height); if (candidate) { next = j; segment = candidate; break; } }
    if (!segment) return null;
    result.push(...segment.slice(1)); i = next;
  }
  return result;
}

export function samplePath(path: CgVec3[], progress: number): { position: CgVec3; direction: CgVec3 } {
  if (path.length < 2) return { position: [...(path[0] ?? [0, 0, 0])], direction: [0, 0, 1] };
  const lengths = path.slice(1).map((p, i) => distance(path[i], p));
  let remaining = Math.max(0, Math.min(1, progress)) * lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] || i === lengths.length - 1) return { position: progress >= 1 ? [...path[path.length - 1]] : mix(path[i], path[i + 1], lengths[i] ? remaining / lengths[i] : 0), direction: [path[i + 1][0] - path[i][0], 0, path[i + 1][2] - path[i][2]] };
    remaining -= lengths[i];
  }
  return { position: [...path[path.length - 1]], direction: [0, 0, 1] };
}
