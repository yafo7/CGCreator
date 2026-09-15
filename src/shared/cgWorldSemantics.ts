import { getMapBounds, getMapObjectVisualAabbs, getObjectWorldTransforms, normalizeMap, type EditableMap } from './map';
import type { CgVec3 } from './cgTypes';
import { analyzeWorld, type CgWorldAnalysis } from './cgWorldAnalysis';
import type { CgRegionGeometry } from './cgSpatialRegions';

export type CgSemanticKind = 'object' | 'model-part' | 'design-group' | 'focus' | 'viewpoint' | 'zone' | 'guide' | 'water' | 'grass' | 'ecology-region' | 'seam';
export interface CgSemanticSource {
  owner: 'worldforge' | '3d-generate';
  field: string;
  sourceId: string;
  confidence: 'authored' | 'generated' | 'derived' | 'unknown';
}
export interface CgSemanticEntity {
  id: string;
  kind: CgSemanticKind;
  name: string;
  parentId?: string;
  objectId?: string;
  assetId?: string;
  localPosition?: CgVec3;
  worldPosition?: CgVec3;
  bounds?: { min: CgVec3; max: CgVec3 };
  region?: unknown;
  spatial?: CgRegionGeometry;
  visible?: boolean;
  tags: string[];
  description?: string;
  source: CgSemanticSource;
}
export interface WorldSemanticIndex extends CgWorldAnalysis {
  schemaVersion: 1;
  mapId: string;
  mapVersion: number;
  axis: 'Y-up';
  units: 'metres';
  bounds: ReturnType<typeof getMapBounds>;
  entities: CgSemanticEntity[];
}

const cleanTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    if (typeof item === 'string') return [item.trim()];
    if (item && typeof item === 'object') {
      const tag = (item as { tag?: unknown }).tag;
      const semanticValue = (item as { value?: unknown }).value;
      return [tag, semanticValue].filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim());
    }
    return [];
  }).filter(Boolean))].slice(0, 32);
};

const vec3 = (value: unknown): CgVec3 | undefined => Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite)
  ? [Number(value[0]), Number(value[1]), Number(value[2])]
  : undefined;

/**
 * One stable, AI-readable index over WorldForge layout semantics and the
 * semantic hierarchy preserved inside every 3d-generate asset instance.
 */
export function buildWorldSemanticIndex(input: EditableMap): WorldSemanticIndex {
  // Portable and older maps can omit newer semantic fields. Normalize a copy,
  // never the stored source map or an already confirmed playback bundle.
  const map = normalizeMap(input);
  const entities: CgSemanticEntity[] = [];
  const transforms = getObjectWorldTransforms(map);
  const objectBounds = new Map<string, { min: CgVec3; max: CgVec3 }>();
  for (const box of getMapObjectVisualAabbs(map)) {
    const existing = objectBounds.get(box.objectId);
    if (!existing) objectBounds.set(box.objectId, { min: [...box.min], max: [...box.max] });
    else {
      for (let axis = 0; axis < 3; axis++) {
        existing.min[axis] = Math.min(existing.min[axis], box.min[axis]);
        existing.max[axis] = Math.max(existing.max[axis], box.max[axis]);
      }
    }
  }
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  for (const object of map.objects) {
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    const objectSemanticId = `object:${object.id}`;
    entities.push({
      id: objectSemanticId,
      kind: 'object',
      name: object.name,
      ...(object.parentId ? { parentId: `object:${object.parentId}` } : {}),
      objectId: object.id,
      ...(object.assetId ? { assetId: object.assetId } : {}),
      worldPosition: [...(transforms.get(object.id)?.position ?? object.transform.position)],
      bounds: objectBounds.get(object.id),
      tags: [...new Set([...(asset?.tags ?? []), ...(object.designGroupId ? [`group:${object.designGroupId}`] : []), ...(object.sourceGuideId ? [`guide:${object.sourceGuideId}`] : []), ...(object.compositionLayer ? [`layer:${object.compositionLayer}`] : [])])],
      description: asset?.prompt,
      source: { owner: 'worldforge', field: 'objects', sourceId: object.id, confidence: object.generation ? 'generated' : 'unknown' }
    });
    const model = asset?.modelJson as { nodes?: unknown[]; _meta?: { semanticSnapshot?: { text?: unknown } } } | undefined;
    const nodes = Array.isArray(model?.nodes) ? model.nodes : [];
    const nodeIds = new Set(nodes.flatMap((raw) => raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? [(raw as { id: string }).id] : []));
    for (const raw of nodes) {
      if (!raw || typeof raw !== 'object') continue;
      const node = raw as { id?: unknown; name?: unknown; label?: unknown; parent?: unknown; transform?: { pos?: unknown }; tags?: unknown };
      if (typeof node.id !== 'string' || !node.id) continue;
      const parent = typeof node.parent === 'string' && nodeIds.has(node.parent) ? `object:${object.id}/node:${node.parent}` : objectSemanticId;
      entities.push({
        id: `object:${object.id}/node:${node.id}`,
        kind: 'model-part',
        name: typeof node.name === 'string' && node.name.trim() ? node.name : typeof node.label === 'string' && node.label.trim() ? node.label : node.id,
        parentId: parent,
        objectId: object.id,
        ...(asset ? { assetId: asset.id } : {}),
        localPosition: vec3(node.transform?.pos),
        tags: cleanTags(node.tags),
        source: { owner: '3d-generate', field: 'modelJson.nodes', sourceId: node.id, confidence: node.name || node.label ? 'generated' : 'derived' }
      });
    }
    if (typeof model?._meta?.semanticSnapshot?.text === 'string' && model._meta.semanticSnapshot.text.trim()) {
      const root = entities.find((entry) => entry.id === objectSemanticId);
      if (root) root.description = `${root.description ?? ''}\n${model._meta.semanticSnapshot.text}`.trim();
    }
  }
  for (const group of map.designSemantics.groups) entities.push({ id: `group:${group.id}`, kind: 'design-group', name: group.name, ...(group.parentId ? { parentId: `group:${group.parentId}` } : {}), region: group.region, tags: group.layers.map((layer) => `layer:${layer.level}`), description: group.intent, source: { owner: 'worldforge', field: 'designSemantics.groups', sourceId: group.id, confidence: 'generated' } });
  for (const focus of map.designSemantics.focuses) entities.push({ id: `focus:${focus.id}`, kind: 'focus', name: focus.name, parentId: `group:${focus.groupId}`, ...(focus.objectId ? { objectId: focus.objectId, worldPosition: [...(transforms.get(focus.objectId)?.position ?? [0, 0, 0])] } : {}), tags: [focus.kind, `reveal:${focus.reveal}`, `rank:${focus.rank}`], description: focus.selector, source: { owner: 'worldforge', field: 'designSemantics.focuses', sourceId: focus.id, confidence: 'generated' } });
  for (const viewpoint of map.designSemantics.viewpoints) entities.push({ id: `viewpoint:${viewpoint.id}`, kind: 'viewpoint', name: viewpoint.id, ...(viewpoint.groupId ? { parentId: `group:${viewpoint.groupId}` } : {}), worldPosition: [viewpoint.point[0], 0, viewpoint.point[1]], tags: [viewpoint.role, ...(viewpoint.targetFocusId ? [`target:${viewpoint.targetFocusId}`] : [])], source: { owner: 'worldforge', field: 'designSemantics.viewpoints', sourceId: viewpoint.id, confidence: 'generated' } });
  for (const zone of map.visualSemantics.zones) entities.push({ id: `zone:${zone.id}`, kind: 'zone', name: zone.id, region: zone.region ?? { kind: 'circle', x: zone.center[0], z: zone.center[1], radius: zone.radius }, worldPosition: [zone.center[0], 0, zone.center[1]], tags: [...zone.tags, ...(zone.material ? [`material:${zone.material}`] : [])], source: { owner: 'worldforge', field: 'visualSemantics.zones', sourceId: zone.id, confidence: zone.locks && Object.keys(zone.locks).length ? 'authored' : 'generated' } });
  for (const guide of map.guides) entities.push({ id: `guide:${guide.id}`, kind: 'guide', name: guide.name, region: { kind: 'path', points: guide.points, width: guide.width, closed: guide.closed, curve: guide.curve }, tags: guide.tags, source: { owner: 'worldforge', field: 'guides', sourceId: guide.id, confidence: guide.generation ? 'generated' : 'authored' } });
  for (const water of map.waterBodies) entities.push({ id: `water:${water.id}`, kind: 'water', name: water.name, region: { type: water.type, points: water.points, width: water.width, level: water.level }, tags: ['water', water.type], source: { owner: 'worldforge', field: 'waterBodies', sourceId: water.id, confidence: 'authored' } });
  for (const grass of map.grassLayers) entities.push({ id: `grass:${grass.id}`, kind: 'grass', name: grass.name, tags: ['grass', grass.preset, ...(grass.mix.flowers > 0 ? ['flowers'] : [])], description: `height=${grass.height}; flowerMix=${grass.mix.flowers}`, source: { owner: 'worldforge', field: 'grassLayers', sourceId: grass.id, confidence: 'authored' } });
  const analysis = analyzeWorld(map, entities);
  return { schemaVersion: 1, mapId: map.id, mapVersion: map.version, axis: 'Y-up', units: 'metres', bounds: getMapBounds(map), entities, ...analysis };
}

export function semanticChildren(index: WorldSemanticIndex, parentId: string): CgSemanticEntity[] {
  return index.entities.filter((entity) => entity.parentId === parentId);
}
