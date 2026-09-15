import { sampleTerrainHeight, type EditableMap } from './map';
import { mapGuidePolyline } from './mapGuide';
import { waterBoundaryPoints, waterSurfaceLevelAt } from './mapWater';
import { stableHash } from './cgValidation';
import { boundsRegion, regionContains, regionGeometry, type CgRegionGeometry } from './cgSpatialRegions';
import type { CgSemanticEntity } from './cgWorldSemantics';
import type { MapDesignSemantics } from './mapDesign';

export interface CgSemanticRelation {
  id: string;
  kind: 'part-of' | 'member-of' | 'has-focus' | 'has-guide' | 'entry-via' | 'exit-via' | 'axis-via' | 'protected-object' | 'removable-object' | 'targets-focus' | 'placed-along' | 'origin-in-region';
  from: string;
  to: string;
  basis: 'source' | 'geometry';
}
export interface CgSemanticIssue { code: string; entityIds: string[]; message: string }
export interface CgWorldAnalysis {
  analysisVersion: 'cg-world-2';
  sourceHash: string;
  sceneIntent: string;
  designSemantics: MapDesignSemantics;
  relations: CgSemanticRelation[];
  issues: CgSemanticIssue[];
  completeness: { status: 'structured' | 'partial' | 'objects-only'; sourceRegionCount: number; inferredRegionCount: number; unlocatedRegionIds: string[]; guideCount: number };
}

/** Adds lossless design relationships and measured footprints to a fresh index.
 * This never writes inferred boundaries back into the WorldForge map. */
export function analyzeWorld(map: EditableMap, entities: CgSemanticEntity[]): CgWorldAnalysis {
  const relations: CgSemanticRelation[] = [], issues: CgSemanticIssue[] = [];
  for (const e of entities) {
    // A missing generation record is not evidence that a human authored it.
    if (e.source.field.startsWith('designSemantics.') || (e.source.confidence === 'authored' && ['guides', 'waterBodies', 'grassLayers'].includes(e.source.field))) e.source.confidence = 'unknown';
  }
  const byId = new Map(entities.map(e => [e.id, e]));
  const issue = (code: string, entityIds: string[], message: string) => issues.push({ code, entityIds, message });
  const relation = (kind: CgSemanticRelation['kind'], from: string, to: string, basis: CgSemanticRelation['basis'] = 'source') => {
    if (!byId.has(from) || !byId.has(to)) { issue('missing_semantic_reference', [from, to], `空间关系 ${kind} 引用了缺失的实体。`); return; }
    const id = `${kind}:${from}>${to}`;
    if (!relations.some(r => r.id === id)) relations.push({ id, kind, from, to, basis });
  };
  const locate = (id: string, shape: unknown, precision: CgRegionGeometry['precision'] = 'source-boundary') => {
    const e = byId.get(id);
    if (!e) return;
    const spatial = regionGeometry(shape, precision);
    if (!spatial) { issue('invalid_region_geometry', [id], '区域缺少有效边界，无法给出准确范围。'); return; }
    e.spatial = spatial;
    const [x, z] = spatial.representative;
    e.worldPosition = [x, sampleTerrainHeight(map, x, z), z];
  };
  for (const region of map.layout.regions) {
    const e: CgSemanticEntity = { id: `region:${region.id}`, kind: 'ecology-region', name: region.name, tags: [], description: region.prompt, region: { kind: 'polygon', points: region.points }, source: { owner: 'worldforge', field: 'layout.regions', sourceId: region.id, confidence: region.boundaryLocked || region.contentLocked ? 'authored' : 'unknown' } };
    entities.push(e); byId.set(e.id, e);
    locate(e.id, e.region);
    if (region.groupId) e.tags.push(`layout-group:${region.groupId}`);
  }
  for (const seam of map.layout.seams) {
    const e: CgSemanticEntity = { id: `seam:${seam.id}`, kind: 'seam', name: seam.name, tags: [seam.mode], description: seam.prompt, region: { kind: 'path', points: seam.points, width: seam.width }, source: { owner: 'worldforge', field: 'layout.seams', sourceId: seam.id, confidence: seam.locked ? 'authored' : 'unknown' } };
    entities.push(e); byId.set(e.id, e); locate(e.id, e.region);
  }
  for (const group of map.designSemantics.groups) {
    const id = `group:${group.id}`;
    if (group.region) locate(id, group.region);
    if (group.parentId) relation('part-of', id, `group:${group.parentId}`);
    for (const [key, kind, prefix] of [
      ['focusIds', 'has-focus', 'focus'], ['guideIds', 'has-guide', 'guide'],
      ['entryGuideIds', 'entry-via', 'guide'], ['exitGuideIds', 'exit-via', 'guide'],
      ['axisGuideIds', 'axis-via', 'guide'], ['protectedObjectIds', 'protected-object', 'object'],
      ['removableObjectIds', 'removable-object', 'object']
    ] as const) for (const ref of group[key]) relation(kind, id, `${prefix}:${ref}`);
  }
  for (const object of map.objects) {
    const e = byId.get(`object:${object.id}`)!;
    e.visible = object.visible;
    if (object.parentId) relation('part-of', e.id, `object:${object.parentId}`);
    if (object.designGroupId) relation('member-of', e.id, `group:${object.designGroupId}`);
    if (object.sourceGuideId) relation('placed-along', e.id, `guide:${object.sourceGuideId}`);
    if (e.bounds) e.spatial = regionGeometry(boundsRegion({ min: [e.bounds.min[0], e.bounds.min[2]], max: [e.bounds.max[0], e.bounds.max[2]] }), 'object-envelope');
  }
  for (const focus of map.designSemantics.focuses) {
    const id = `focus:${focus.id}`, e = byId.get(id)!;
    relation('member-of', id, `group:${focus.groupId}`);
    if (focus.objectId) {
      const object = byId.get(`object:${focus.objectId}`);
      if (object) { e.worldPosition = object.worldPosition ? [...object.worldPosition] : undefined; e.bounds = structuredClone(object.bounds); e.spatial = structuredClone(object.spatial); }
      else { delete e.worldPosition; issue('missing_focus_object', [id, `object:${focus.objectId}`], '焦点对象已缺失；不能使用原点代替。'); }
    } else issue('unbound_focus', [id], '焦点尚未绑定具体物体，其位置未知。');
  }
  for (const viewpoint of map.designSemantics.viewpoints) {
    const e = byId.get(`viewpoint:${viewpoint.id}`)!;
    e.worldPosition = [viewpoint.point[0], sampleTerrainHeight(map, ...viewpoint.point), viewpoint.point[1]];
    e.description = '地图规划的地面视点；不是已经验证的摄影机机位。高度取地形，仍需相机高度和遮挡求解。';
    if (viewpoint.groupId) relation('member-of', e.id, `group:${viewpoint.groupId}`);
    if (viewpoint.targetFocusId) relation('targets-focus', e.id, `focus:${viewpoint.targetFocusId}`);
  }
  for (const zone of map.visualSemantics.zones) locate(`zone:${zone.id}`, zone.region ?? { kind: 'circle', x: zone.center[0], z: zone.center[1], radius: zone.radius });
  for (const guide of map.guides) {
    locate(`guide:${guide.id}`, { kind: 'path', points: mapGuidePolyline(guide, 256), width: guide.width }, guide.curve === 'catmull-rom' ? 'sampled-curve' : 'source-boundary');
  }
  for (const water of map.waterBodies) {
    if (water.type === 'ocean') locate(`water:${water.id}`, boundsRegion({ min: [-map.box.size[0] / 2, -map.box.size[2] / 2], max: [map.box.size[0] / 2, map.box.size[2] / 2] }), 'terrain-mask');
    else locate(`water:${water.id}`, { kind: 'polygon', points: waterBoundaryPoints(water) });
    const e = byId.get(`water:${water.id}`)!;
    if (e.spatial) { e.spatial.height = 'water-surface'; const [x, z] = e.spatial.representative; e.worldPosition = [x, waterSurfaceLevelAt(water, x, z), z]; }
    e.description = '边界使用 WorldForge 水体几何；实际水面还受地形裁切，非可行走区域。';
  }
  for (const grass of map.grassLayers) {
    const e = byId.get(`grass:${grass.id}`)!;
    e.visible = grass.visible;
    const active = grass.densities.flatMap((d, i) => d > 0 ? [i] : []);
    e.description += `; activeSamples=${active.length}; resolution=${grass.resolutionX}x${grass.resolutionZ}; 范围为密度支撑包络，包络内部可能无草。花卉为混合比例，不是单朵花的位置。`;
    if (active.length && grass.visible) {
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const i of active) { const x = i % grass.resolutionX, z = Math.floor(i / grass.resolutionX); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
      const x = (i: number) => (Math.max(0, Math.min(grass.resolutionX - 1, i)) / Math.max(1, grass.resolutionX - 1) - 0.5) * map.box.size[0];
      const z = (i: number) => (Math.max(0, Math.min(grass.resolutionZ - 1, i)) / Math.max(1, grass.resolutionZ - 1) - 0.5) * map.box.size[2];
      locate(e.id, boundsRegion({ min: [x(minX - 1), z(minZ - 1)], max: [x(maxX + 1), z(maxZ + 1)] }), 'density-envelope');
    }
  }
  // Missing design boundaries can be described by member-object envelopes, but
  // never promoted to an authored area or used as proof of walkability.
  const groupById = new Map(map.designSemantics.groups.map(g => [g.id, g]));
  for (const group of map.designSemantics.groups) {
    const e = byId.get(`group:${group.id}`)!;
    const members = map.objects.filter(o => {
      let id = o.designGroupId; const seen = new Set<string>();
      while (id && !seen.has(id)) { if (id === group.id) return true; seen.add(id); id = groupById.get(id)?.parentId; }
      return false;
    }).map(o => byId.get(`object:${o.id}`)!).filter(o => o.visible !== false);
    if (!e.spatial) {
      const boxes = members.flatMap(o => o.bounds ? [o.bounds] : []);
      if (boxes.length) {
        locate(e.id, boundsRegion({ min: [Math.min(...boxes.map(b => b.min[0])), Math.min(...boxes.map(b => b.min[2]))], max: [Math.max(...boxes.map(b => b.max[0])), Math.max(...boxes.map(b => b.max[2]))] }), 'object-envelope');
        issue('derived_group_extent', [e.id], '设计组未定义边界；显示范围来自其可见成员的包围盒，不是原始区域边界。');
      } else issue('unlocated_region', [e.id], '设计组没有边界或可定位成员，位置未知。');
    } else for (const member of members) if (member.worldPosition && !regionContains(e.spatial.shape, [member.worldPosition[0], member.worldPosition[2]])) issue('member_outside_region', [e.id, member.id], '对象位置已在所属设计区域之外，请检查地图修改后的语义。');
  }
  const regions = entities.filter(e => ['design-group', 'ecology-region', 'zone'].includes(e.kind));
  for (const object of entities.filter(e => e.kind === 'object' && e.worldPosition && e.visible !== false)) for (const region of regions) {
    if (region.spatial?.precision === 'source-boundary' && regionContains(region.spatial.shape, [object.worldPosition![0], object.worldPosition![2]])) relation('origin-in-region', object.id, region.id, 'geometry');
  }
  const sourceRegionCount = regions.filter(e => e.spatial?.precision === 'source-boundary').length;
  const inferredRegionCount = regions.filter(e => e.spatial?.precision === 'object-envelope').length;
  if (!sourceRegionCount) issue('missing_region_semantics', [], '地图没有明确的功能区域边界；可以定位对象，但不能声称已经知道道路与各区域的完整划分。');
  if (!map.guides.length) issue('missing_guides', [], '地图没有路径引导线；不能把空地直接当作设计道路。');
  const { version: _version, createdAt: _createdAt, updatedAt: _updatedAt, confirmedAt: _confirmedAt, ...content } = map;
  return { analysisVersion: 'cg-world-2', sourceHash: stableHash(content), sceneIntent: map.designSemantics.intent || map.layout.globalPrompt, designSemantics: structuredClone(map.designSemantics), relations, issues,
    completeness: { status: !regions.length ? 'objects-only' : issues.some(i => ['unlocated_region', 'invalid_region_geometry', 'missing_semantic_reference', 'missing_focus_object', 'member_outside_region'].includes(i.code)) || !sourceRegionCount ? 'partial' : 'structured', sourceRegionCount, inferredRegionCount, unlocatedRegionIds: regions.filter(e => !e.spatial).map(e => e.id), guideCount: map.guides.length } };
}
