import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { modelSpatialNodes } from './modelBounds';
import type { CgClip, CgQuat, CgVec3 } from './cgTypes';

export interface CgLocalPose { position: CgVec3; quaternion: CgQuat; scale: CgVec3 }
export interface CgPoseNode extends CgLocalPose { id: string; name: string; parent?: string; bounds?: { min: CgVec3; max: CgVec3 }; geometry?: string }
export interface CgPoseRig { nodes: CgPoseNode[]; normalization: CgVec3; landmarks: Partial<Record<'eyes' | 'face' | 'head' | 'hips' | 'leftFoot' | 'rightFoot', { nodeId: string; point: CgVec3 }>>; contactProfile?: boolean }

/** Single numerical clip evaluator for the server and the rendered Object3D nodes. */
export function sampleLocalPose(rest: CgLocalPose, track: CgClip['tracks'][string] | undefined, clip: Pick<CgClip, 'duration' | 'fps' | 'loop'> | undefined, time: number, weight = 1): CgLocalPose {
  if (!track || !clip) return structuredClone(rest);
  const t = clip.loop && clip.duration > 0 ? ((time % clip.duration) + clip.duration) % clip.duration : Math.max(0, Math.min(clip.duration, time));
  const sample = (values: CgVec3[]) => { const f = t * clip.fps, a = Math.min(Math.floor(f), values.length - 1), b = Math.min(a + 1, values.length - 1); return new Vector3(...values[a]).lerp(new Vector3(...values[b]), f - Math.floor(f)); };
  const position = new Vector3(...rest.position), scale = new Vector3(...rest.scale), quaternion = new Quaternion(...rest.quaternion);
  if (track.position?.length) position.add(sample(track.position));
  if (track.rotation?.length) { const euler = new Euler().setFromQuaternion(quaternion, 'XYZ'), delta = sample(track.rotation); quaternion.setFromEuler(new Euler(euler.x + delta.x, euler.y + delta.y, euler.z + delta.z, 'XYZ')); }
  if (track.quaternion?.length) { const f = t * clip.fps, a = Math.min(Math.floor(f), track.quaternion.length - 1), b = Math.min(a + 1, track.quaternion.length - 1); quaternion.fromArray(track.quaternion[a]).slerp(new Quaternion(...track.quaternion[b]), f - Math.floor(f)); }
  if (track.scale?.length) scale.multiply(sample(track.scale));
  if (weight < 1) {
    const w = Math.max(0, weight);
    position.lerp(new Vector3(...rest.position), 1 - w);
    quaternion.copy(new Quaternion(...rest.quaternion).slerp(quaternion, w));
    scale.lerp(new Vector3(...rest.scale), 1 - w);
  }
  return { position: position.toArray() as CgVec3, quaternion: quaternion.toArray() as CgQuat, scale: scale.toArray() as CgVec3 };
}

export function poseMatrix(pose: CgLocalPose): Matrix4 {
  return new Matrix4().compose(new Vector3(...pose.position), new Quaternion(...pose.quaternion), new Vector3(...pose.scale));
}

/** Frames baked at min(duration, i/fps) have a possibly shorter final step. */
export function bakedFrameIndex(time: number, duration: number, fps: number, count: number): number {
  if (count < 2) return 0;
  const elapsed = Math.max(0, Math.min(duration, time));
  if (elapsed >= duration) return count - 1;
  const lastStart = (count - 2) / fps;
  return Math.max(0, Math.min(count - 1, elapsed >= lastStart ? count - 2 + (elapsed - lastStart) / Math.max(1e-8, duration - lastStart) : elapsed * fps));
}

export function evaluateRig(rig: CgPoseRig, clip?: CgClip, time = 0, weight = 1): Map<string, Matrix4> {
  const result = new Map<string, Matrix4>(), nodes = new Map(rig.nodes.map(n => [n.id, n])), visiting = new Set<string>();
  const root = new Matrix4().makeTranslation(...rig.normalization);
  const visit = (node: CgPoseNode): Matrix4 => {
    if (result.has(node.id)) return result.get(node.id)!;
    if (visiting.has(node.id)) throw new Error(`cyclic_model_hierarchy:${node.id}`);
    visiting.add(node.id);
    const parent = node.parent ? nodes.get(node.parent) : undefined;
    if (node.parent && !parent) throw new Error(`missing_model_parent:${node.parent}`);
    const world = (parent ? visit(parent) : root).clone().multiply(poseMatrix(sampleLocalPose(node, clip?.tracks[node.id], clip, time, weight)));
    result.set(node.id, world); visiting.delete(node.id); return world;
  };
  for (const node of rig.nodes) visit(node);
  return result;
}

/** Rest normalization is frozen, so animation cannot recenter the model. */
export function buildPoseRig(modelJson: unknown): CgPoseRig {
  const nodes = modelSpatialNodes(modelJson).map(node => ({ ...node, scale: [...node.scale] as CgVec3 }));
  // Match modelRenderer.safeModelScale for generated near-zero vertical scales.
  for (const node of nodes) if (node.scale[1] < Math.min(node.scale[0], node.scale[2]) * 0.5) node.scale[1] = Math.min(node.scale[0], node.scale[2]);
  const rig: CgPoseRig = { nodes, normalization: [0, 0, 0], landmarks: {} };
  if (new Set(nodes.map(n => n.id)).size !== nodes.length) throw new Error('duplicate_model_node');
  const matrices = evaluateRig(rig), bounds = new Box3();
  for (const node of nodes) if (node.bounds) bounds.union(new Box3(new Vector3(...node.bounds.min), new Vector3(...node.bounds.max)).applyMatrix4(matrices.get(node.id)!));
  if (!bounds.isEmpty()) rig.normalization = [-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2];
  const head = nodes.find(n => /(^|[_\s-])(head|face|头|脸)([_\s-]|$)/i.test(`${n.id} ${n.name}`));
  if (head) {
    // Generated models commonly use a meshless `head` animation group whose
    // face, hair and eye meshes are descendants. Measure the whole subtree in
    // head-local space instead of falling back to the group pivot (usually the
    // neck), otherwise close-ups aim through the body and self-occlude.
    const parents = new Map(nodes.map(node => [node.id, node.parent]));
    const belongsToHead = (node: CgPoseNode) => {
      let id: string | undefined = node.id;
      while (id) { if (id === head.id) return true; id = parents.get(id); }
      return false;
    };
    const headInverse = matrices.get(head.id)!.clone().invert(), headBounds = new Box3();
    for (const node of nodes) if (node.bounds && belongsToHead(node)) {
      const relative = headInverse.clone().multiply(matrices.get(node.id)!);
      headBounds.union(new Box3(new Vector3(...node.bounds.min), new Vector3(...node.bounds.max)).applyMatrix4(relative));
    }
    const box = !headBounds.isEmpty() ? { min: headBounds.min.toArray() as CgVec3, max: headBounds.max.toArray() as CgVec3 } : head.bounds;
    const center = box ? [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2] as CgVec3 : [0, 0, 0] as CgVec3;
    const y = box ? box.min[1] + (box.max[1] - box.min[1]) * 0.66 : 0;
    rig.landmarks.head = { nodeId: head.id, point: center };
    rig.landmarks.eyes = { nodeId: head.id, point: [center[0], y, box ? box.max[2] : 0] };
    rig.landmarks.face = { nodeId: head.id, point: [center[0], center[1], box ? box.max[2] : 0] };
  }
  for (const [name, pattern] of [['hips', /hip|pelvis|骨盆/i], ['leftFoot', /left.?foot|foot.?l\b|左脚/i], ['rightFoot', /right.?foot|foot.?r\b|右脚/i]] as const) {
    const node = nodes.find(n => pattern.test(`${n.id} ${n.name}`));
    if (node) rig.landmarks[name] = { nodeId: node.id, point: [0, node.bounds?.min[1] ?? 0, 0] };
  }
  const profile = (modelJson as { _meta?: { cgRig?: { version?: number; landmarks?: Record<string, { nodeId: string; point: CgVec3 }> } } })?._meta?.cgRig;
  if (profile) {
    if (profile.version !== 1 || !profile.landmarks || typeof profile.landmarks !== 'object') throw new Error('invalid_contact_profile');
    for (const [name, target] of Object.entries(profile.landmarks)) {
      if (!['eyes', 'face', 'head', 'hips', 'leftFoot', 'rightFoot'].includes(name) || !target || !nodes.some(n => n.id === target.nodeId) || !Array.isArray(target.point) || target.point.length !== 3 || !target.point.every(Number.isFinite)) throw new Error(`invalid_contact_landmark:${name}`);
      rig.landmarks[name as keyof CgPoseRig['landmarks']] = structuredClone(target);
    }
    rig.contactProfile = !!(profile.landmarks.hips && profile.landmarks.leftFoot && profile.landmarks.rightFoot);
  }
  return rig;
}

export function rigLandmark(rig: CgPoseRig, name: keyof CgPoseRig['landmarks'], clip?: CgClip, time = 0): CgVec3 | undefined {
  const binding = rig.landmarks[name];
  if (!binding) return undefined;
  const matrix = evaluateRig(rig, clip, time).get(binding.nodeId);
  return matrix ? new Vector3(...binding.point).applyMatrix4(matrix).toArray() as CgVec3 : undefined;
}
