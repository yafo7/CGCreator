import { Box3, Vector3 } from 'three';
import { evaluateRig, poseMatrix } from './cgPoseEvaluator';
import { sampleEntities } from './cgPerformance';
import type { CgDiagnostic, CompiledCG } from './cgTypes';
import type { MapObjectAabb } from './map';

/** A deterministic sampled clearance audit for independently animated actors
 * and props. Static-world route/seat validation remains owned by its solver. */
export function validatePerformanceClearance(bundle: CompiledCG, staticBoxes: MapObjectAabb[] = []): CgDiagnostic[] {
  const issues: CgDiagnostic[] = [], reported = new Set<string>();
  const count = Math.min(2400, Math.max(2, Math.ceil(bundle.duration * 10)));
  for (let i = 0; i <= count; i++) {
    const time = bundle.duration * i / count, states = sampleEntities(bundle, time);
    const boxes = bundle.bindings.flatMap(binding => {
      const state = states[binding.entityId], rig = binding.poseRig;
      if (!state?.visible || !rig) return [];
      const nodes = evaluateRig(rig, bundle.resources.clips.find(c => c.id === state.clipId), state.clipTime ?? 0, state.clipWeight ?? 1), root = poseMatrix(state), bounds = new Box3();
      for (const node of rig.nodes) if (node.bounds) bounds.union(new Box3(new Vector3(...node.bounds.min), new Vector3(...node.bounds.max)).applyMatrix4(root.clone().multiply(nodes.get(node.id)!)));
      return bounds.isEmpty() ? [] : [{ id: binding.entityId, bounds }];
    });
    for (const actor of boxes) for (const obstacle of staticBoxes) {
      const ownObject = bundle.bindings.find(b => b.entityId === actor.id)?.objectId;
      if (obstacle.objectId === ownObject || bundle.performance?.occupancy.some(o => o.entityId === actor.id && o.objectId === obstacle.objectId && time >= o.start && time <= o.end)) continue;
      const id = `${actor.id}:world:${obstacle.objectId}`, x = actor.bounds;
      if (!reported.has(id) && x.min.x < obstacle.max[0] - 0.02 && x.max.x > obstacle.min[0] + 0.02 && x.min.y < obstacle.max[1] - 0.02 && x.max.y > obstacle.min[1] + 0.02 && x.min.z < obstacle.max[2] - 0.02 && x.max.z > obstacle.min[2] + 0.02) {
        issues.push({ code: 'animated_world_clearance', severity: 'error', nodeIds: [actor.id, obstacle.objectId], message: `${time.toFixed(2)} 秒时动画姿态的保守边界与场景物体重叠。` }); reported.add(id);
      }
    }
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const x = boxes[a], y = boxes[b], id = `${x.id}:${y.id}`;
      if (reported.has(id)) continue;
      const xObject = bundle.bindings.find(b => b.entityId === x.id)?.objectId, yObject = bundle.bindings.find(b => b.entityId === y.id)?.objectId;
      if (bundle.performance?.occupancy.some(o => time >= o.start && time <= o.end && (o.entityId === x.id && o.objectId === yObject || o.entityId === y.id && o.objectId === xObject))) continue;
      if (x.bounds.min.x < y.bounds.max.x - 0.02 && x.bounds.max.x > y.bounds.min.x + 0.02 && x.bounds.min.y < y.bounds.max.y - 0.02 && x.bounds.max.y > y.bounds.min.y + 0.02 && x.bounds.min.z < y.bounds.max.z - 0.02 && x.bounds.max.z > y.bounds.min.z + 0.02) {
        issues.push({ code: 'performer_clearance_conflict', severity: 'error', nodeIds: [x.id, y.id], message: `${time.toFixed(2)} 秒时演出实体的保守姿态边界重叠，请调整走位或时间。` }); reported.add(id);
      }
    }
  }
  return issues;
}
