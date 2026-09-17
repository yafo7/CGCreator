import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { sampleTerrainHeight } from './map';
import { samplePath, sampleSmoothPath } from './cgPath';
import { bakedFrameIndex, evaluateRig, poseMatrix } from './cgPoseEvaluator';
import type { CgAction, CgDiagnostic, CgEntityState, CgQuat, CgVec3, CompiledCG, DirectorDocument } from './cgTypes';

const yaw = (x: number, z: number): CgQuat => new Quaternion().setFromEuler(new Euler(0, Math.atan2(x, z), 0)).toArray();

/** Behaviors own their time. Coverage is a consumer of this immutable schedule. */
export function schedulePerformance(document: DirectorDocument) {
  const times = new Map<string, { start: number; end: number }>(), visiting = new Set<string>(), diagnostics: CgDiagnostic[] = [];
  const actions = new Map(document.actions.map(a => [a.id, a]));
  const error = (code: string, id: string, message: string) => diagnostics.push({ code, severity: 'error', nodeIds: [id], message });
  const visit = (action: CgAction): { start: number; end: number } => {
    if (times.has(action.id)) return times.get(action.id)!;
    if (visiting.has(action.id)) { error('temporal_cycle', action.id, '行为时间关系存在循环。'); return { start: 0, end: 0 }; }
    visiting.add(action.id);
    let start = action.start.kind === 'absolute' ? action.start.seconds : 0;
    if (action.start.kind !== 'absolute') {
      const other = actions.get(action.start.id);
      if (!other) error('missing_behavior_time', action.id, 'V2 行为时间只能引用另一个行为。');
      else { const span = visit(other); start = (action.start.kind === 'with' ? span.start : span.end) + (action.start.offset ?? 0); }
    }
    const locks = document.constraints.filter(c => c.type === 'action-time' && c.targetId === action.id);
    const starts = locks.filter(c => c.edge !== 'end'), ends = locks.filter(c => c.edge === 'end');
    if (new Set(starts.map(c => c.seconds)).size > 1 || new Set(ends.map(c => c.seconds)).size > 1) error('conflicting_hard_constraints', action.id, '行为时间锁互相冲突。');
    if (starts.length) start = starts[0].seconds!;
    else if (ends.length) start = ends[0].seconds! - action.duration;
    const end = ends[0]?.seconds ?? start + action.duration;
    if (![start, end].every(Number.isFinite) || start < 0 || end < start || end > 1200) error('invalid_resolved_time', action.id, '行为时间超出范围。');
    const span = { start, end }; times.set(action.id, span); visiting.delete(action.id); return span;
  };
  for (const a of document.actions) visit(a);
  const duration = Math.max(0, ...[...times.values()].map(t => t.end));
  const events = document.actions.flatMap(a => { const t = times.get(a.id)!; return [{ id: `${a.id}:start`, actionId: a.id, time: t.start, kind: 'start' as const }, { id: `${a.id}:end`, actionId: a.id, time: t.end, kind: a.type === 'sit' ? 'contact' as const : 'end' as const }]; });
  return { times, duration, events, diagnostics };
}

/** Complete absolute-time performance state. Old bundles keep their old
 * restore-at-end and terrain-only rules until explicitly recompiled as V2. */
export function sampleEntities(bundle: CompiledCG, time: number): Record<string, CgEntityState> {
  const entities = structuredClone(bundle.initial), modern = bundle.evaluationVersion === 2;
  for (const action of bundle.actions) {
    if (time < action.start) continue;
    const state = entities[action.entityId]; if (!state) continue;
    const u = action.end > action.start ? Math.max(0, Math.min(1, (time - action.start) / (action.end - action.start))) : 1;
    if (modern && ['move', 'airborne', 'sit', 'dialogue', 'handoff', 'hold'].includes(action.type)) state.behaviorId = action.id;
    if ((action.type === 'move' || action.type === 'airborne') && action.path) {
      const sampled = action.pathInterpolation === 'smooth' ? sampleSmoothPath(action.path, u) : samplePath(action.path, u);
      state.position = sampled.position;
      if (action.type === 'move' && action.pathInterpolation === 'smooth' && !action.surfaceIds) state.position[1] = sampleTerrainHeight(bundle.map, state.position[0], state.position[2]);
      if (Math.hypot(sampled.direction[0], sampled.direction[2]) > 1e-7) state.quaternion = yaw(sampled.direction[0], sampled.direction[2]);
      if (modern && action.clipId && time < action.end) {
        const clip = bundle.resources.clips.find(c => c.id === action.clipId);
        if (clip) {
          const elapsed = (time - action.start) * (action.playbackRate ?? 1); state.clipId = clip.id; state.clipTime = clip.loop ? elapsed % clip.duration : Math.min(elapsed, clip.duration);
          if (action.motionBlend) { const w = Math.max(0, Math.min(1, (time - action.start) / action.motionBlend, (action.end - time) / action.motionBlend)); state.clipWeight = w * w * (3 - 2 * w); }
        }
      }
    } else if (action.type === 'attach' && action.targetEntityId) {
      state.attachedTo = action.targetEntityId; state.socketId = action.socketId; delete state.handoff;
    } else if (action.type === 'detach') {
      delete state.attachedTo; delete state.socketId; delete state.handoff;
    } else if (action.type === 'handoff' && action.sourceEntityId && action.targetEntityId) {
      state.attachedTo = u < 0.5 ? action.sourceEntityId : action.targetEntityId;
      state.socketId = u < 0.5 ? 'right-hand' : action.socketId;
      state.handoff = { sourceEntityId: action.sourceEntityId, targetEntityId: action.targetEntityId, sourceSocketId: 'right-hand', targetSocketId: action.socketId ?? 'right-hand', progress: u };
    } else if (action.type === 'face' && action.to && action.from) {
      const from = new Quaternion().setFromEuler(new Euler(...action.from));
      const to = new Quaternion().fromArray(yaw(action.to[0], action.to[2]));
      state.quaternion = from.slerp(to, u).normalize().toArray();
    } else if (action.type === 'visibility') state.visible = action.visible!;
    else if (modern && action.type === 'sit' && action.rootSamples && action.contact) {
      const samples = action.rootSamples, f = bakedFrameIndex(time - action.start, action.duration, samples.fps, samples.positions.length), a = Math.floor(f), b = Math.min(a + 1, samples.positions.length - 1);
      state.position = new Vector3(...samples.positions[a]).lerp(new Vector3(...samples.positions[b]), f - a).toArray();
      state.quaternion = new Quaternion(...samples.rotations[a]).slerp(new Quaternion(...samples.rotations[b]), f - a).toArray();
      const clip = bundle.resources.clips.find(c => c.id === action.clipId);
      if (clip) { state.clipId = clip.id; state.clipTime = Math.min(Math.max(0, time - action.start), clip.duration); }
      state.posture = time >= action.end ? 'seated' : 'standing'; state.socketId = `${action.contact.objectId}/${action.contact.nodeId}`;
    } else if (modern && action.type === 'dialogue' && action.to && state.posture !== 'seated') {
      const dx = action.to[0] - state.position[0], dz = action.to[2] - state.position[2];
      if (Math.hypot(dx, dz) > 1e-6) state.quaternion = yaw(dx, dz);
    } else if (action.type === 'animate' && (time <= action.end || modern && action.endBehavior === 'hold')) {
      const clip = bundle.resources.clips.find(c => c.id === action.clipId);
      if (clip) { const elapsed = Math.max(0, time - action.start) * (action.playbackRate ?? 1); state.clipId = clip.id; state.clipTime = time > action.end ? clip.duration : clip.loop ? elapsed % clip.duration : Math.min(elapsed, clip.duration); }
    }
  }
  const rigMatrices = new Map<string, Map<string, Matrix4>>(), rootMatrices = new Map<string, Matrix4>();
  if (modern) for (const binding of bundle.bindings) {
    const state = entities[binding.entityId], rig = binding.poseRig; if (!state || !rig) continue;
    const clip = bundle.resources.clips.find(c => c.id === state.clipId), matrices = evaluateRig(rig, clip, state.clipTime ?? 0, state.clipWeight ?? 1), root = poseMatrix(state);
    rigMatrices.set(binding.entityId, matrices); rootMatrices.set(binding.entityId, root);
    state.landmarks = {};
    for (const [name, target] of Object.entries(rig.landmarks)) {
      const matrix = target && matrices.get(target.nodeId);
      if (matrix) state.landmarks[name as keyof NonNullable<CgEntityState['landmarks']>] = new Vector3(...target!.point).applyMatrix4(matrix).applyMatrix4(root).toArray();
    }
    const face = rig.landmarks.face ?? rig.landmarks.eyes;
    if (face && matrices.has(face.nodeId)) state.faceForward = new Vector3(0, 0, 1).transformDirection(root.clone().multiply(matrices.get(face.nodeId)!)).toArray();
  }
  // Attachments are a final pose-aware pass. New projects use the exact
  // actor-node socket measured from a 3d-generate mount result. The height
  // offset remains only for legacy bundles created before assembly profiles.
  for (const [propEntityId, state] of Object.entries(entities)) {
    if (!state.attachedTo) continue;
    const owner = entities[state.attachedTo];
    if (!owner) continue;
    const mountedPose = (actorEntityId: string, socketId: string) => {
      const profile = bundle.resources.assemblies?.find(item => item.actorEntityId === actorEntityId && item.propEntityId === propEntityId && item.socketId === socketId);
      const node = profile && rigMatrices.get(actorEntityId)?.get(profile.nodeId), root = profile && rootMatrices.get(actorEntityId);
      if (!profile || !node || !root) return undefined;
      const matrix = root.clone().multiply(node).multiply(poseMatrix(profile)), position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3();
      matrix.decompose(position, quaternion, scale);
      return { position, quaternion, scale };
    };
    if (state.handoff) {
      const source = mountedPose(state.handoff.sourceEntityId, state.handoff.sourceSocketId), target = mountedPose(state.handoff.targetEntityId, state.handoff.targetSocketId);
      if (source && target) {
        const u = state.handoff.progress * state.handoff.progress * (3 - 2 * state.handoff.progress);
        state.position = source.position.lerp(target.position, u).toArray();
        state.quaternion = source.quaternion.slerp(target.quaternion, u).toArray();
        state.scale = source.scale.lerp(target.scale, u).toArray();
        continue;
      }
    }
    const profile = bundle.resources.assemblies?.find(item => item.actorEntityId === state.attachedTo && item.propEntityId === propEntityId && item.socketId === (state.socketId ?? 'right-hand'));
    const node = profile && rigMatrices.get(state.attachedTo)?.get(profile.nodeId), root = profile && rootMatrices.get(state.attachedTo);
    if (profile && node && root) {
      const world = root.clone().multiply(node).multiply(poseMatrix(profile));
      const position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3();
      world.decompose(position, quaternion, scale);
      state.position = position.toArray(); state.quaternion = quaternion.toArray(); state.scale = scale.toArray();
      continue;
    }
    const height = bundle.bindings.find(binding => binding.entityId === state.attachedTo)?.height ?? 1.8;
    const socket = state.socketId ?? 'right-hand';
    const local: CgVec3 = socket.includes('back') ? [0, height * 0.62, -0.18] : [socket.includes('left') ? -0.30 : 0.30, height * 0.62, 0.12];
    const offset = new Vector3(...local).applyQuaternion(new Quaternion(...owner.quaternion));
    state.position = new Vector3(...owner.position).add(offset).toArray();
    state.quaternion = [...owner.quaternion];
  }
  return entities;
}
