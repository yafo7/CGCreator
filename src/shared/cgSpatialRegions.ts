import type { VisualZoneRegion } from './visualDirection';

export type CgPoint2 = [number, number];
export interface CgBounds2 { min: CgPoint2; max: CgPoint2 }
export interface CgRegionGeometry {
  /** All coordinates are world X/Z in metres. Bounds never imply membership. */
  shape: VisualZoneRegion;
  bounds: CgBounds2;
  representative: CgPoint2;
  precision: 'source-boundary' | 'sampled-curve' | 'object-envelope' | 'density-envelope' | 'terrain-mask';
  height: 'terrain-sample' | 'water-surface' | 'unspecified';
}

const EPS = 1e-7;
function segmentDistance(p: CgPoint2, a: CgPoint2, b: CgPoint2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], length = dx * dx + dz * dz;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}

export function regionContains(shape: VisualZoneRegion, point: CgPoint2): boolean {
  if (shape.kind === 'circle') return Math.hypot(point[0] - shape.x, point[1] - shape.z) <= shape.radius + EPS;
  if (shape.kind === 'path') return shape.points.some((p, i) => i > 0 && segmentDistance(point, shape.points[i - 1], p) <= shape.width / 2 + EPS);
  let inside = false;
  for (let i = 0, j = shape.points.length - 1; i < shape.points.length; j = i++) {
    const a = shape.points[j], b = shape.points[i];
    if (segmentDistance(point, a, b) <= EPS) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function regionGeometry(value: unknown, precision: CgRegionGeometry['precision'] = 'source-boundary'): CgRegionGeometry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const shape = structuredClone(value) as VisualZoneRegion;
  const finitePoint = (p: unknown): p is CgPoint2 => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (shape.kind === 'circle') {
    if (![shape.x, shape.z, shape.radius].every(Number.isFinite) || shape.radius <= 0) return undefined;
    return { shape, precision, height: 'terrain-sample', bounds: { min: [shape.x - shape.radius, shape.z - shape.radius], max: [shape.x + shape.radius, shape.z + shape.radius] }, representative: [shape.x, shape.z] };
  }
  if (shape.kind !== 'path' && shape.kind !== 'polygon') return undefined;
  if (!Array.isArray(shape.points) || shape.points.length < (shape.kind === 'path' ? 2 : 3) || !shape.points.every(finitePoint)) return undefined;
  if (shape.kind === 'path' && (!Number.isFinite(shape.width) || shape.width <= 0)) return undefined;
  if (shape.kind === 'polygon') {
    const area = shape.points.reduce((sum, p, i) => { const next = shape.points[(i + 1) % shape.points.length]; return sum + p[0] * next[1] - next[0] * p[1]; }, 0);
    if (Math.abs(area) < EPS) return undefined;
  }
  const padding = shape.kind === 'path' ? shape.width / 2 : 0;
  const bounds: CgBounds2 = { min: [Math.min(...shape.points.map(p => p[0])) - padding, Math.min(...shape.points.map(p => p[1])) - padding], max: [Math.max(...shape.points.map(p => p[0])) + padding, Math.max(...shape.points.map(p => p[1])) + padding] };
  let representative: CgPoint2 = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2];
  if (shape.kind === 'path') representative = [...shape.points[Math.floor(shape.points.length / 2)]];
  else if (!regionContains(shape, representative)) {
    // A concave polygon's bounding-box centre can be outside it. Find an interior
    // interval on a scan line between vertex heights; never invent a centre.
    representative = [...shape.points[0]];
    const heights = [...new Set(shape.points.map(p => p[1]))].sort((a, b) => a - b);
    let best = 0;
    for (let row = 1; row < heights.length; row++) {
      const z = (heights[row - 1] + heights[row]) / 2, xs: number[] = [];
      for (let i = 0, j = shape.points.length - 1; i < shape.points.length; j = i++) {
        const a = shape.points[j], b = shape.points[i];
        if ((a[1] > z) !== (b[1] > z)) xs.push(a[0] + (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]));
      }
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i += 2) if (xs[i] - xs[i - 1] > best) {
        best = xs[i] - xs[i - 1]; representative = [(xs[i - 1] + xs[i]) / 2, z];
      }
    }
  }
  return { shape, bounds, representative, precision, height: 'terrain-sample' };
}

export function boundsRegion(bounds: CgBounds2): VisualZoneRegion {
  const { min, max } = bounds;
  return { kind: 'polygon', points: [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]] };
}
