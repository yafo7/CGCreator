import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { getObjectWorldTransforms, sampleTerrainHeight, type EditableMap } from './map';
import { mapGuidePolyline } from './mapGuide';
import { samplePath } from './cgPath';
import { buildPoseRig, evaluateRig } from './cgPoseEvaluator';
import type { CgAnchor, CgVec3 } from './cgTypes';

/** Resolve semantic bindings against the current frozen map. Authored world
 * anchors without bindings remain exact and never move during synchronization. */
export function resolveSpatialAnchor(anchor: CgAnchor, map: EditableMap): CgAnchor {
  const binding = anchor.binding;
  if (!binding) return structuredClone(anchor);
  if (binding.kind === 'guide') {
    const guide = map.guides.find(g => g.id === binding.guideId);
    if (!guide) throw new Error(`missing_guide_binding:${binding.guideId}`);
    const points = mapGuidePolyline(guide, 256).map(([x, z]): CgVec3 => [x, 0, z]);
    const point = samplePath(points, binding.progress).position;
    point[1] = sampleTerrainHeight(map, point[0], point[2]);
    return { ...structuredClone(anchor), position: point, space: 'world' };
  }
  const object = map.objects.find(o => o.id === binding.objectId), asset = map.assets?.find(a => a.id === object?.assetId), transform = getObjectWorldTransforms(map).get(binding.objectId);
  if (!object || !asset || !transform) throw new Error(`missing_seat_binding:${binding.objectId}`);
  const rig = buildPoseRig(asset.modelJson), node = rig.nodes.find(n => n.id === binding.nodeId);
  if (!node?.bounds || node.geometry !== 'box') throw new Error(`missing_seat_node:${binding.nodeId}`);
  const world = new Matrix4().compose(new Vector3(...transform.position), new Quaternion().setFromEuler(new Euler(...transform.rotation)), new Vector3(...transform.scale));
  const matrix = world.multiply(evaluateRig(rig).get(node.id)!);
  const front = new Vector3((node.bounds.min[0] + node.bounds.max[0]) / 2, node.bounds.max[1], node.bounds.max[2]).applyMatrix4(matrix);
  front.addScaledVector(new Vector3(0, 0, 1).transformDirection(matrix), 0.65);
  return { ...structuredClone(anchor), space: 'world', position: [front.x, transform.position[1], front.z] };
}

export function mapSpatialAnchors(map: EditableMap): CgAnchor[] {
  const anchors: CgAnchor[] = [];
  for (const guide of map.guides ?? []) for (const [name, progress] of [['起点', 0], ['中点', 0.5], ['终点', 1]] as const) {
    const anchor: CgAnchor = { id: `map_guide:${guide.id}:${progress === 0 ? 'start' : progress === 1 ? 'end' : 'middle'}`, name: `${guide.name} ${name}（需验证可达）`, kind: 'point', position: [0, 0, 0], space: 'world', binding: { kind: 'guide', guideId: guide.id, progress } };
    anchors.push(resolveSpatialAnchor(anchor, map));
  }
  for (const object of map.objects) {
    const asset = map.assets?.find(a => a.id === object.assetId); if (!asset) continue;
    try {
      const rig = buildPoseRig(asset.modelJson);
      for (const node of rig.nodes.filter(n => n.geometry === 'box' && /seat|坐|座/i.test(`${n.id} ${n.name}`))) {
        const anchor: CgAnchor = { id: `map_seat:${object.id}:${node.id}`, name: `${object.name} ${node.name} 接近点（需验证）`, kind: 'point', position: [0, 0, 0], space: 'world', binding: { kind: 'seat-approach', objectId: object.id, nodeId: node.id } };
        if (anchor.id.length <= 120) anchors.push(resolveSpatialAnchor(anchor, map));
      }
    } catch { /* Malformed rigs are diagnosed during compilation, not advertised. */ }
  }
  return anchors.filter(a => a.id.length <= 120);
}
