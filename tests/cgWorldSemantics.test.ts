import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, normalizeMap, type EditableMap } from '../src/shared/map';
import { buildWorldSemanticIndex } from '../src/shared/cgWorldSemantics';
import { regionContains, regionGeometry } from '../src/shared/cgSpatialRegions';
import { queryWorld, validateWorldQuery, worldSummary } from '../src/shared/cgWorldQuery';
import { buildSemanticContext } from '../src/server/cgService';
import { renderWorldInspector } from '../src/client/cgWorldInspector';
import { sampleGrassDensity } from '../src/shared/mapGrass';
import { waterBoundaryPoints } from '../src/shared/mapWater';

function fixture() {
  const map = createEmptyMap('Garden', 'semantic-garden', [40, 16, 40]);
  map.terrain.heights.fill(2);
  map.designSemantics = {
    version: 1, experienceMode: 'sequential', intent: '沿园路进入东亭，池塘位于西侧。',
    groups: [{ id: 'pavilion', name: '东亭区域', intent: '留出演出空间', region: { kind: 'polygon', points: [[2, 2], [12, 2], [12, 12], [2, 12]] }, focusIds: ['pavilion-focus'], guideIds: ['road'], entryGuideIds: ['road'], exitGuideIds: [], axisGuideIds: ['road'], protectedObjectIds: ['pavilion-object'], removableObjectIds: [], layers: [{ level: 1, intent: '焦点', density: 'open' }] }],
    focuses: [{ id: 'pavilion-focus', name: '凉亭', groupId: 'pavilion', kind: 'primary', rank: 1, objectId: 'pavilion-object', reveal: 'sequence' }],
    viewpoints: [{ id: 'entrance', point: [1, 2], groupId: 'pavilion', targetFocusId: 'pavilion-focus', role: 'entry' }],
    relations: [{ id: 'spacing', kind: 'repel', sourceSelector: 'tree', targetSelector: 'pavilion', strength: 'open', minDistance: 3 }]
  };
  const pavilion = createMapObject('凉亭'); pavilion.id = 'pavilion-object'; pavilion.transform.position = [7, 2, 7]; pavilion.designGroupId = 'pavilion';
  map.objects.push(pavilion);
  map.guides = [{ id: 'road', name: '到凉亭的园路', points: [[-10, 3], [2, 3], [7, 7]], curve: 'polyline', closed: false, width: 2, tags: ['route'] }];
  map.layout.regions = [{ id: 'west', name: '西侧树林', prompt: '树林', groupId: null, points: [[-15, -10], [-5, -10], [-5, 0], [-15, 0]], color: '#00ff00', boundaryLocked: true, contentLocked: false }];
  return map;
}

describe('precise director world understanding', () => {
  it('preserves exact shapes, full design links and terrain-derived viewpoint height without mutating the map', () => {
    const map = fixture(), before = structuredClone(map), index = buildWorldSemanticIndex(map);
    expect(map).toEqual(before);
    expect(index.designSemantics).toEqual(map.designSemantics);
    expect(index.sceneIntent).toBe(map.designSemantics.intent);
    expect(index.entities.find(e => e.id === 'group:pavilion')?.spatial?.shape).toEqual(map.designSemantics.groups[0].region);
    expect(index.entities.find(e => e.id === 'viewpoint:entrance')?.worldPosition).toEqual([1, 2, 2]);
    expect(index.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'entry-via', from: 'group:pavilion', to: 'guide:road' }),
      expect.objectContaining({ kind: 'axis-via', from: 'group:pavilion', to: 'guide:road' }),
      expect.objectContaining({ kind: 'protected-object', to: 'object:pavilion-object' }),
      expect.objectContaining({ kind: 'origin-in-region', from: 'object:pavilion-object', to: 'group:pavilion' })
    ]));
    expect(buildSemanticContext(map).worldUnderstanding.sourceHash).toBe(index.sourceHash);
    expect(buildSemanticContext(map).designSemantics.relations[0].minDistance).toBe(3);
  });

  it('does not confuse a concave polygon bounding box with its actual area', () => {
    const region = regionGeometry({ kind: 'polygon', points: [[0, 0], [8, 0], [8, 2], [2, 2], [2, 8], [0, 8]] })!;
    expect(regionContains(region.shape, [4, 4])).toBe(false);
    expect(regionContains(region.shape, region.representative)).toBe(true);
    expect(regionContains(region.shape, [1, 6])).toBe(true);
    expect(regionContains(region.shape, [2, 6])).toBe(true);
    expect(regionGeometry({ kind: 'circle', x: 0, z: 0, radius: -1 })).toBeUndefined();
    expect(regionGeometry({ kind: 'path', points: [[NaN, 0], [0, 2]], width: 2 })).toBeUndefined();
    expect(regionGeometry({ kind: 'polygon', points: [[0, 0], [1, 1], [2, 2]] })).toBeUndefined();
  });

  it('queries road width, region membership and out-of-map positions using world coordinates', () => {
    const map = fixture();
    const onRoad = queryWorld(map, { type: 'point', position: [-5, 3.8] });
    expect(onRoad).toMatchObject({ inBounds: true, terrainHeight: 2, matches: expect.arrayContaining([expect.objectContaining({ id: 'guide:road' })]) });
    expect(queryWorld(map, { type: 'point', position: [-5, 4.2] })).toMatchObject({ matches: expect.not.arrayContaining([expect.objectContaining({ id: 'guide:road' })]) });
    expect(queryWorld(map, { type: 'point', position: [-10, -5] })).toMatchObject({ matches: expect.arrayContaining([expect.objectContaining({ id: 'region:west', basis: 'source-boundary' })]) });
    expect(queryWorld(map, { type: 'point', position: [50, 50] })).toMatchObject({ inBounds: false, playable: false, terrainHeight: null, matches: [] });
  });

  it('uses the density field rather than claiming all points in a grass envelope contain grass', () => {
    const map = fixture();
    const grass = { id: 'g', name: '草地', visible: true, seed: 1, resolutionX: 5, resolutionZ: 5, densities: Array(25).fill(0), preset: 'meadow' as const, height: 0.3, mix: { short: 1, tall: 0, flowers: 0.1 } };
    grass.densities[0] = 1; grass.densities[24] = 1;
    map.grassLayers = [grass];
    expect(queryWorld(map, { type: 'point', position: [0, 0] })).toMatchObject({ matches: expect.not.arrayContaining([expect.objectContaining({ id: 'grass:g' })]) });
    expect(queryWorld(map, { type: 'point', position: [-20, -20] })).toMatchObject({ matches: expect.arrayContaining([expect.objectContaining({ id: 'grass:g', density: 1 })]) });
    expect(sampleGrassDensity(grass, map, 0, 0)).toBe(0);
    expect(buildWorldSemanticIndex(map).entities.find(e => e.id === 'grass:g')?.spatial?.precision).toBe('density-envelope');
  });

  it('uses WorldForge shoreline geometry and excludes dry land above water', () => {
    const map = fixture();
    map.waterBodies = [{ id: 'pond', name: '池塘', type: 'lake', level: 3, depth: 1, width: 1, points: [[-8, -8], [0, -8], [0, 0], [-8, 0]], shorelineSmoothness: 0.8, shorelineIrregularity: 0.1, seed: 5 }];
    const index = buildWorldSemanticIndex(map);
    expect(index.entities.find(e => e.id === 'water:pond')?.spatial?.shape).toEqual({ kind: 'polygon', points: waterBoundaryPoints(map.waterBodies[0]) });
    expect(queryWorld(map, { type: 'point', position: [-4, -4] })).toMatchObject({ matches: expect.arrayContaining([expect.objectContaining({ id: 'water:pond' })]) });
    map.terrain.heights.fill(4);
    expect(queryWorld(map, { type: 'point', position: [-4, -4] })).toMatchObject({ matches: expect.not.arrayContaining([expect.objectContaining({ id: 'water:pond' })]) });
  });

  it('reports deleted focus objects and broken road references without substituting the origin', () => {
    const map = fixture(); map.objects = []; map.guides = [];
    const index = buildWorldSemanticIndex(map);
    expect(index.entities.find(e => e.id === 'focus:pavilion-focus')?.worldPosition).toBeUndefined();
    expect(index.issues.map(i => i.code)).toContain('missing_focus_object');
    expect(index.issues.map(i => i.code)).toContain('missing_semantic_reference');
    expect(index.completeness.status).toBe('partial');
  });

  it('handles oceans using terrain coverage beyond their control polygon', () => {
    const map = fixture();
    map.waterBodies = [{ id: 'ocean', name: '海洋', type: 'ocean', level: 3, depth: 1, width: 1, points: [[-10, -10], [-5, -10], [-5, -5]] }];
    const index = buildWorldSemanticIndex(map);
    expect(index.entities.find(e => e.id === 'water:ocean')?.spatial?.precision).toBe('terrain-mask');
    expect(queryWorld(map, { type: 'point', position: [0, 0] })).toMatchObject({ matches: expect.arrayContaining([expect.objectContaining({ id: 'water:ocean' })]) });
    map.terrain.heights.fill(4);
    expect(queryWorld(map, { type: 'point', position: [0, 0] })).toMatchObject({ matches: expect.not.arrayContaining([expect.objectContaining({ id: 'water:ocean' })]) });
  });

  it('flags moved members, refreshes positions and changes the world hash even without a map version bump', () => {
    const map = fixture(), before = buildWorldSemanticIndex(map);
    map.objects[0].transform.position = [-10, 2, -10];
    const after = buildWorldSemanticIndex(map);
    expect(after.sourceHash).not.toBe(before.sourceHash);
    expect(after.entities.find(e => e.id === 'focus:pavilion-focus')?.worldPosition).toEqual([-10, 2, -10]);
    expect(after.issues.map(i => i.code)).toContain('member_outside_region');
    map.version++; map.updatedAt++;
    expect(buildWorldSemanticIndex(map).sourceHash).toBe(after.sourceHash);
  });

  it('marks inferred group envelopes and keeps old object-only maps explicitly incomplete', () => {
    const map = fixture(); delete map.designSemantics.groups[0].region;
    const index = buildWorldSemanticIndex(map);
    expect(index.entities.find(e => e.id === 'group:pavilion')?.spatial?.precision).toBe('object-envelope');
    expect(index.issues.map(i => i.code)).toContain('derived_group_extent');
    const old = { ...map, designSemantics: undefined, visualSemantics: undefined, guides: undefined, layout: undefined } as unknown as EditableMap;
    const oldIndex = buildWorldSemanticIndex(old);
    expect(oldIndex.completeness.status).toBe('objects-only');
    expect(oldIndex.entities.find(e => e.id === 'object:pavilion-object')?.worldPosition).toEqual([7, 2, 7]);
    expect(oldIndex.issues.map(i => i.code)).toContain('missing_region_semantics');
  });

  it('round-trips native portable map semantics and resolves names with explicit ambiguity', () => {
    const map = fixture();
    const imported = normalizeMap(JSON.parse(JSON.stringify(map)));
    expect(worldSummary(buildWorldSemanticIndex(imported))).toEqual(worldSummary(buildWorldSemanticIndex(map)));
    expect(queryWorld(map, { type: 'resolve', text: '凉亭' })).toMatchObject({ ambiguous: true, matches: expect.arrayContaining([expect.objectContaining({ entity: expect.objectContaining({ id: 'object:pavilion-object' }) })]) });
    expect(queryWorld(map, { type: 'inspect', semanticId: 'does-not-exist' })).toMatchObject({ found: false, entity: null });
    expect(() => validateWorldQuery({ type: 'point', position: [Infinity, 1] })).toThrow();
    expect(() => validateWorldQuery({ type: 'summary', code: 'execute' })).toThrow();
  });

  it('renders searchable exact bounds and escapes untrusted map descriptions', () => {
    const map = fixture(); map.designSemantics.intent = '<script>alert(1)</script>';
    const html = renderWorldInspector(buildWorldSemanticIndex(map), '东亭');
    expect(html).toContain('group:pavilion'); expect(html).toContain('原始边界');
    expect(html).toContain('world-focus'); expect(html).not.toContain('<script>');
    expect(html).not.toContain('region:west');
  });
});
