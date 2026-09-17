import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { bakeMapCollisions, getObjectWorldTransforms, getMapAssetLocalBounds, sampleTerrainHeight, type EditableMap, type MapObjectAabb } from './map';
import { applyMapOperations } from './mapOperations';
import type { RenderScheme } from './renderScheme';
import type { CgAction, CgAnchor, CgCameraPose, CgCompiledAction, CgCompiledShot, CgConstraint, CgEntityState, CgFrame, CgPatchOperation, CgQuat, CgResources, CgVec3, CompiledCG, DirectorDocument } from './cgTypes';
import { assertDirector, stableHash, validateDirectorDocument } from './cgValidation';
import { distance, findGroundPath, freeGroundPoint, samplePath, sampleSmoothPath, smoothGroundPathIsFree } from './cgPath';
import { calculateModelSemanticLandmarks } from './modelBounds';
import { buildWorldSemanticIndex } from './cgWorldSemantics';
import { bakedFrameIndex, buildPoseRig } from './cgPoseEvaluator';
import { sampleEntities as sampleModernEntities, schedulePerformance } from './cgPerformance';
import { createNavigationWorld, findNavigationPath, navigationPointFree } from './cgNavigation';
import { solveSit } from './cgInteractionSolver';
import { observeCamera } from './cgVisibility';
import { cameraCandidates } from './cgShotSkills';
import { validateMotion } from './cgMotionValidation';
import { resolveSpatialAnchor } from './cgSpatialBindings';
import { validatePerformanceClearance } from './cgPerformanceValidation';

export { stableHash, validateDirectorDocument } from './cgValidation';
export const CG_COMPILER_VERSION = 'cgcreator-2.1.0';
const clone = <T>(value: T): T => structuredClone(value);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const quat = (rotation: CgVec3): CgQuat => new Quaternion().setFromEuler(new Euler(...rotation)).toArray() as CgQuat;
const yaw = (direction: CgVec3): CgQuat => quat([0, Math.atan2(direction[0], direction[2]), 0]);
const progress = (a: CgCompiledAction, t: number) => a.end > a.start ? clamp01((t - a.start) / (a.end - a.start)) : 1;

function resolveAnchor(anchor: CgAnchor, map: EditableMap): CgAnchor {
  if (anchor.binding) return resolveSpatialAnchor(anchor, map);
  if (anchor.space !== 'object') return clone(anchor);
  const transform = getObjectWorldTransforms(map).get(anchor.objectId!);
  if (!transform) throw new Error(`Object-space anchor ${anchor.id} references missing object ${anchor.objectId}.`);
  const rotation = new Quaternion().fromArray(quat(transform.rotation));
  const position = new Vector3(...anchor.position).multiply(new Vector3(...transform.scale)).applyQuaternion(rotation).add(new Vector3(...transform.position)).toArray() as CgVec3;
  return { ...clone(anchor), position, quaternion: anchor.quaternion ? rotation.multiply(new Quaternion().fromArray(anchor.quaternion)).toArray() as CgQuat : undefined, space: 'world' };
}

/** Compile a frozen snapshot. No IO, wall clock, random IDs, or mutation of caller data. */
export function compileDirector(document: DirectorDocument, map: EditableMap, scheme: RenderScheme | null = null, resources: CgResources = { models: [], clips: [] }, previous?: CompiledCG, options: { performanceOnly?: boolean } = {}): CompiledCG {
  const inputHash = stableHash({ version: CG_COMPILER_VERSION, document, map, scheme, resources, ...(options.performanceOnly ? { stage: 'performance' } : {}) });
  const validation = validateDirectorDocument(document);
  const bundle: CompiledCG = {
    schemaVersion: 1, compilerVersion: CG_COMPILER_VERSION, id: `compile-${inputHash}`, inputHash,
    documentRevision: document.revision, document: clone(document), map: clone(map), scheme: clone(scheme), resources: clone(resources),
    duration: 0, bindings: [], initial: {}, shots: [], actions: [], dependencies: {}, changedNodeIds: [], validation,
    semanticIndex: buildWorldSemanticIndex(map)
  };
  if (document.schemaVersion === 2) { bundle.evaluationVersion = 2; bundle.stage = options.performanceOnly ? 'performance' : 'complete'; }
  const diagnostic = (code: string, message: string, nodeIds: string[] = [], severity: 'error' | 'warning' = 'error') => {
    if (!validation.diagnostics.some((d) => d.code === code && stableHash(d.nodeIds) === stableHash(nodeIds))) validation.diagnostics.push({ severity, code, message, nodeIds });
  };
  const finish = () => {
    bundle.semanticIndex = buildWorldSemanticIndex(bundle.map);
    validation.valid = !validation.diagnostics.some((d) => d.severity === 'error');
    const old = new Map([...(previous?.actions ?? []), ...(previous?.shots ?? [])].map((n) => [n.id, n.inputHash]));
    bundle.changedNodeIds = [...bundle.actions, ...bundle.shots].filter((n) => old.get(n.id) !== n.inputHash).map((n) => n.id);
    for (const id of old.keys()) if (!bundle.actions.some((n) => n.id === id) && !bundle.shots.some((n) => n.id === id)) bundle.changedNodeIds.push(id);
    return bundle;
  };
  if (!validation.valid) return finish();
  if (document.mapId !== map.id) diagnostic('map_mismatch', 'DirectorDocument belongs to a different map snapshot.', [document.id]);
  const assetMap = new Map((map.assets ?? []).map((asset) => [asset.id, clone(asset)]));
  for (const asset of resources.models) {
    const old = assetMap.get(asset.id);
    if (old && stableHash(old.modelJson) !== stableHash(asset.modelJson)) diagnostic('asset_identity_conflict', `Asset ${asset.id} has different model contents in the map and resource snapshot.`, [asset.id]);
    else assetMap.set(asset.id, clone(asset));
  }
  bundle.map.assets = [...assetMap.values()];
  try {
    if (document.worldPatch.length) bundle.map = applyMapOperations(bundle.map, document.worldPatch);
  } catch (error) { diagnostic('world_patch_failed', String(error)); return finish(); }
  // applyMapOperations may normalize maps, but CG's clock and snapshot metadata remain frozen.
  bundle.map.createdAt = map.createdAt; bundle.map.updatedAt = map.updatedAt;
  const anchors = new Map<string, CgAnchor>();
  for (const anchor of document.anchors) {
    try { anchors.set(anchor.id, resolveAnchor(anchor, bundle.map)); }
    catch (error) { diagnostic('missing_anchor_object', String(error), [anchor.id]); }
  }
  const constraints = (type: CgConstraint['type'], id: string) => document.constraints.filter((c) => c.type === type && c.targetId === id);
  const single = (list: CgConstraint[], value: (c: CgConstraint) => unknown) => {
    if (!list.length) return undefined;
    if (list.some((c) => stableHash(value(c)) !== stableHash(value(list[0])))) diagnostic('conflicting_hard_constraints', 'Two hard constraints require different values for the same target.', list.map((c) => c.id));
    return list[0];
  };
  const positionConstraint = (type: CgConstraint['type'], id: string) => single(constraints(type, id), (c) => {
    const a = anchors.get(c.anchorId!); return type === 'camera-pose' ? [a?.position, a?.quaternion, a?.fov ?? 45] : a?.position;
  });
  const world = getObjectWorldTransforms(bundle.map);
  const boundObjects = new Set<string>();
  for (const entity of document.entities) {
    let object = entity.objectId ? bundle.map.objects.find((o) => o.id === entity.objectId) : undefined;
    if (entity.objectId && !object) { diagnostic('missing_object', `Missing map object ${entity.objectId}.`, [entity.id]); continue; }
    if (object && boundObjects.has(object.id)) { diagnostic('duplicate_binding', 'Two entities cannot independently own one map object transform.', [entity.id]); continue; }
    const assetId = entity.assetId ?? object?.assetId ?? null;
    if (object && entity.assetId && object.assetId !== entity.assetId) { diagnostic('binding_asset_mismatch', 'The requested entity asset differs from its map object asset.', [entity.id]); continue; }
    if (assetId && !assetMap.has(assetId)) { diagnostic('missing_model', `Missing frozen model resource ${assetId}.`, [entity.id, assetId]); continue; }
    if (!object) {
      const objectId = `cg:${document.id}:${entity.id}`;
      if (bundle.map.objects.some((o) => o.id === objectId)) { diagnostic('object_id_collision', 'Generated CG object ID already belongs to the map.', [entity.id]); continue; }
      object = { id: objectId, name: entity.name, parentId: null, assetId, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size: [1, 1, 1] }, heightMode: 'fixed', visible: true, locked: false };
      bundle.map.objects.push(object);
    }
    boundObjects.add(object.id);
    const transform = world.get(object.id);
    let position: CgVec3 = transform ? [...transform.position] : [0, sampleTerrainHeight(bundle.map, 0, 0), 0];
    const hard = positionConstraint('entity-position', entity.id);
    const start = anchors.get(hard?.anchorId ?? entity.startAnchorId ?? '');
    if (start) position = [...start.position];
    const scale: CgVec3 = transform ? [...transform.scale] : [1, 1, 1];
    const asset = assetId ? assetMap.get(assetId) : undefined;
    const bounds = asset ? getMapAssetLocalBounds(asset) : { min: [0, 0, 0], max: [1, 1, 1] };
    const modelHeight = bounds.max[1] - bounds.min[1];
    if (!Number.isFinite(modelHeight) || modelHeight <= 0) {
      diagnostic('invalid_model_bounds', 'A bound model must have finite, positive visual height.', [entity.id]); continue;
    }
    // New resources have no authored world scale. Resolve requested metres once,
    // here, so the camera, collision agent and visible root share the same size.
    // Existing map objects retain their authored world scale (including size).
    if (!transform && entity.height !== undefined) scale.fill(entity.height / modelHeight);
    const height = Math.max(0.1, modelHeight * Math.abs(scale[1]));
    const focus = asset ? calculateModelSemanticLandmarks(asset.modelJson) : undefined;
    let poseRig;
    if (document.schemaVersion === 2 && asset) {
      try { poseRig = buildPoseRig(asset.modelJson); } catch (error) { diagnostic('invalid_pose_rig', String(error), [entity.id]); }
    }
    bundle.bindings.push({ entityId: entity.id, objectId: object.id, assetId, height, focus, ...(poseRig ? { poseRig } : {}) });
    bundle.initial[entity.id] = { position, quaternion: transform ? quat(transform.rotation) : [0, 0, 0, 1], scale, visible: object.visible };
    // CG owns every animated root. Flatten bound roots in this derived snapshot so the
    // map renderer cannot accidentally apply a moving parent transform a second time.
    object.parentId = null;
    object.transform = { position: [...position], rotation: transform ? [...transform.rotation] : [0, 0, 0], scale: [...scale], size: [1, 1, 1] };
    object.heightMode = 'fixed';
    object.behavior = { kind: 'static', locomotion: 'static', animation: { state: 'cg-owned', speed: 0, phase: 0 } };
    bundle.dependencies[entity.id] = [object.id, ...(assetId ? [assetId] : []), ...(hard?.anchorId ? [hard.anchorId, hard.id] : entity.startAnchorId ? [entity.startAnchorId] : [])];
  }
  if (bundle.bindings.length !== document.entities.length) return finish();
  const collisionMap = clone(bundle.map);
  const staticProps = new Set(document.entities.filter((e) => e.kind === 'prop'
    && !document.actions.some((a) => a.entityId === e.id && ['move', 'airborne', 'face', 'animate', 'visibility', 'sit', 'dialogue', 'attach', 'detach', 'handoff'].includes(a.type)))
    .map((e) => bundle.bindings.find((b) => b.entityId === e.id)!.objectId));
  collisionMap.objects = collisionMap.objects.filter((o) => !boundObjects.has(o.id) || staticProps.has(o.id));
  delete collisionMap.collisionBake;
  let boxes: MapObjectAabb[];
  try { boxes = bakeMapCollisions(collisionMap).boxes; }
  catch (error) { diagnostic('collision_bake_failed', String(error)); return finish(); }
  let navigation;
  try { navigation = document.schemaVersion === 2 ? createNavigationWorld(collisionMap, boxes) : undefined; }
  catch (error) { diagnostic('invalid_navigation_geometry', String(error)); return finish(); }
  const performanceSchedule = document.schemaVersion === 2 ? schedulePerformance(document) : undefined;
  if (performanceSchedule) {
    validation.diagnostics.push(...performanceSchedule.diagnostics);
    bundle.performance = { duration: performanceSchedule.duration, events: performanceSchedule.events, occupancy: [] };
    if (performanceSchedule.diagnostics.length) return finish();
  }
  let shotStart = 0;
  for (const [shotIndex, shot] of document.shots.entries()) {
    const lockedDuration = single(constraints('shot-duration', shot.id), (c) => c.seconds);
    const nextBehaviorStart = shot.autoDuration && performanceSchedule
      ? document.shots.slice(shotIndex + 1).map(next => next.behaviorId ? performanceSchedule.times.get(next.behaviorId)?.start : undefined).find((time): time is number => time !== undefined && time > shotStart + 1e-6)
      : undefined;
    const autoEnd = nextBehaviorStart ?? performanceSchedule?.duration;
    const duration = lockedDuration?.seconds ?? (shot.autoDuration && autoEnd !== undefined ? autoEnd - shotStart : shot.duration);
    if (duration <= 0 || duration > 300) { diagnostic('coverage_time_conflict', '镜头覆盖与行为时间或镜头时长锁冲突。', [shot.id]); return finish(); }
    const hard = positionConstraint('camera-pose', shot.id), anchor = hard ? anchors.get(hard.anchorId!) : undefined;
    const compiled: CgCompiledShot = { id: shot.id, start: shotStart, end: shotStart + duration, camera: clone(shot.camera), transition: clone(shot.transition), inputHash: '', ...(shot.behaviorId ? { behaviorId: shot.behaviorId } : {}), ...(shot.skillId ? { skillId: shot.skillId } : {}) };
    if (document.schemaVersion === 2) compiled.referenceBehavior = true;
    if (anchor?.quaternion) compiled.lockedPose = { position: [...anchor.position], quaternion: [...anchor.quaternion], fov: anchor.fov ?? 45 };
    const cameraPath = constraints('camera-path', shot.id)
      .map((constraint) => ({ constraint, anchor: anchors.get(constraint.anchorId!) }))
      .filter((item): item is { constraint: CgConstraint; anchor: CgAnchor } => !!item.anchor)
      .sort((left, right) => (left.constraint.order ?? 0) - (right.constraint.order ?? 0) || left.constraint.id.localeCompare(right.constraint.id));
    if (cameraPath.length && compiled.lockedPose) diagnostic('camera_constraint_conflict', 'A shot cannot use both one exact camera pose and an editable camera path.', [shot.id, hard!.id, ...cameraPath.map((item) => item.constraint.id)]);
    else if (cameraPath.length) {
      compiled.path = cameraPath.map((item) => [...item.anchor.position]);
      compiled.pathControlIds = cameraPath.map((item) => item.anchor.id);
      compiled.pathInterpolation = cameraPath.length >= 3 ? 'smooth' : 'linear';
    }
    bundle.shots.push(compiled); shotStart += duration;
    bundle.dependencies[shot.id] = [shot.camera.subjectId, ...(shot.camera.secondaryId ? [shot.camera.secondaryId] : []), ...(hard ? [hard.id, hard.anchorId!] : []), ...(lockedDuration ? [lockedDuration.id] : []), ...cameraPath.flatMap((item) => [item.constraint.id, item.anchor.id])];
  }
  bundle.duration = options.performanceOnly && performanceSchedule ? Math.max(shotStart, performanceSchedule.duration) : shotStart;
  if (bundle.duration > 1200) diagnostic('timeline_too_long', 'V1 timelines are limited to 1200 seconds.');
  const timings = performanceSchedule?.times ?? new Map<string, { start: number; end: number }>(bundle.shots.map((s) => [s.id, s]));
  if (!options.performanceOnly && performanceSchedule && performanceSchedule.duration > bundle.duration + 1e-6) diagnostic('uncovered_performance', '镜头未覆盖完整演出，请延长覆盖；行为时间不会随镜头改变。');
  if (!options.performanceOnly && performanceSchedule) for (const shot of bundle.shots) {
    const source = document.shots.find(s => s.id === shot.id)!, action = document.actions.find(a => a.id === source.behaviorId);
    const span = action && performanceSchedule.times.get(action.id);
    if (!action || !span) continue;
    if (source.coveragePurpose === 'contact' && action.type === 'sit' && (span.end < shot.start || span.end > shot.end)) diagnostic('contact_not_covered', '接触镜头必须覆盖实际坐下接触时刻。', [shot.id, action.id]);
    if (['follow', 'destination', 'dialogue'].includes(source.coveragePurpose ?? '') && (shot.end <= span.start || shot.start >= span.end)) diagnostic('coverage_misses_behavior', '镜头时间没有覆盖其关联行为。', [shot.id, action.id]);
    const coverageSubject = action.type === 'handoff' ? action.sourceEntityId : action.entityId;
    if (['follow', 'destination', 'contact'].includes(source.coveragePurpose ?? '') && shot.camera.subjectId !== coverageSubject) diagnostic('coverage_subject_mismatch', '该镜头的主体与需要展示的行为角色不一致。', [shot.id, action.id]);
    if (action.type === 'dialogue' && ['two-shot', 'over-shoulder'].includes(shot.camera.layout ?? '') && [shot.camera.subjectId, shot.camera.secondaryId].sort().join('|') !== [action.entityId, action.targetEntityId].sort().join('|')) diagnostic('dialogue_coverage_mismatch', '双人镜头必须绑定这段对话的实际参与者。', [shot.id, action.id]);
  }
  const resolving = new Set<string>();
  const actionById = new Map(document.actions.map((a) => [a.id, a]));
  const resolveTime = (action: CgAction): { start: number; end: number } => {
    if (timings.has(action.id)) return timings.get(action.id)!;
    if (resolving.has(action.id)) { diagnostic('temporal_cycle', 'Temporal references form a cycle.', [...resolving, action.id]); return { start: 0, end: action.duration }; }
    resolving.add(action.id);
    const startLock = single(constraints('action-time', action.id).filter((c) => c.edge !== 'end'), (c) => c.seconds);
    const endLock = single(constraints('action-time', action.id).filter((c) => c.edge === 'end'), (c) => c.seconds);
    let start: number;
    if (startLock) start = startLock.seconds!;
    else if (endLock) start = endLock.seconds! - action.duration;
    else if (action.start.kind === 'absolute') start = action.start.seconds;
    else {
      const related = timings.get(action.start.id) ?? resolveTime(actionById.get(action.start.id)!);
      start = (action.start.kind === 'after' ? related.end : related.start) + (action.start.offset ?? 0);
    }
    const end = endLock?.seconds ?? start + action.duration;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || (['move', 'animate', 'effect'].includes(action.type) && end === start)) diagnostic('invalid_resolved_time', 'Hard time constraints or temporal references produce an invalid interval.', [action.id, ...(startLock ? [startLock.id] : []), ...(endLock ? [endLock.id] : [])]);
    if (end > bundle.duration + 1e-6) diagnostic('action_outside_timeline', 'Action extends beyond the final shot. Extend the timeline or adjust this action explicitly.', [action.id]);
    const result = { start, end }; timings.set(action.id, result); resolving.delete(action.id); return result;
  };
  for (const action of document.actions) resolveTime(action);
  if (validation.diagnostics.some((d) => ['temporal_cycle', 'invalid_resolved_time'].includes(d.code))) return finish();
  const sortedActions = [...document.actions].sort((a, b) => timings.get(a.id)!.start - timings.get(b.id)!.start || a.id.localeCompare(b.id));
  const clips = new Map(resources.clips.map((c) => [c.id, c]));
  if (clips.size !== resources.clips.length) diagnostic('duplicate_clip', 'Clip IDs must be unique.');
  if (bundle.evaluationVersion === 2) for (const clip of resources.clips) {
    if (clip.source === 'procedural-fallback') diagnostic('motion_generation_fallback', `3d-generate 动作生成不可用；${clip.id} 使用基于真实模型语义节点的确定性降级动作。`, [clip.id], 'warning');
  }
  for (const action of sortedActions) {
    const interval = timings.get(action.id)!;
    const compiled: CgCompiledAction = { ...clone(action), ...interval, duration: interval.end - interval.start, inputHash: '' };
    const binding = bundle.bindings.find((b) => b.entityId === action.entityId)!;
    const prior = bundle.actions.filter((a) => a.entityId === action.entityId);
    const channel = (a: { type: CgAction['type'] }) => ['move', 'airborne', 'face', 'sit', 'dialogue'].includes(a.type) ? 'root' : a.type;
    // `hold` is a semantic coverage/state marker and does not write a pose or
    // transform channel. Overlapping holds are redundant but executable.
    const overlap = action.type === 'hold' ? undefined : prior.find((a) => channel(a) === channel(action) && a.start < interval.end - 1e-6 && a.end > interval.start + 1e-6);
    if (overlap) diagnostic('action_channel_overlap', `Actions ${overlap.id} and ${action.id} compete for the same entity channel.`, [overlap.id, action.id]);
    const dependencies = [action.entityId, ...(action.start.kind !== 'absolute' ? [action.start.id] : []), ...constraints('action-time', action.id).map((c) => c.id)];
    const state = sampleEntities(bundle, interval.start)[action.entityId];
    if (bundle.evaluationVersion === 2 && (['sit', 'animate'].includes(action.type) || action.type === 'move' && action.route)) {
      const motionIssues = validateMotion(clips.get(action.clipId ?? ''), binding, assetMap.get(binding.assetId ?? '')?.modelJson, action.id);
      validation.diagnostics.push(...motionIssues);
      if (motionIssues.length) continue;
    }
    if (bundle.evaluationVersion === 2 && state.posture === 'seated' && ['move', 'face', 'animate'].includes(action.type)) diagnostic('seated_behavior_conflict', '坐姿接触期间不能直接行走、转身或替换全身动画；需要先提供受支持的站起行为。', [action.id]);
    if (bundle.evaluationVersion === 2 && prior.some(a => a.start < interval.end && a.end > interval.start && ((a.type === 'sit' && action.type === 'animate') || (a.type === 'animate' && action.type === 'sit')))) diagnostic('contact_animation_overlap', '坐下行为独占全身姿态，不能同时叠加另一条动画。', [action.id]);
    const ownsPose = (a: { type: CgAction['type']; clipId?: string }) => ['sit', 'animate'].includes(a.type) || a.type === 'move' && !!a.clipId;
    if (bundle.evaluationVersion === 2 && ownsPose(action) && prior.some(a => ownsPose(a) && a.start < interval.end && a.end > interval.start)) diagnostic('pose_channel_overlap', '同一角色的全身姿态轨道存在重叠；道路步态和交互不能再叠加另一条全身动画。', [action.id]);
    if (action.type === 'airborne') {
      const target = anchors.get(action.targetAnchorId ?? '');
      if (!target) diagnostic('missing_target', 'Airborne landing anchor cannot be resolved.', [action.id]);
      else {
        const from = new Vector3(...state.position), to = new Vector3(...target.position);
        const apex = Math.max(action.arcHeight ?? Math.max(1.2, from.distanceTo(to) * 0.22), 0.25);
        const middle = from.clone().lerp(to, 0.5); middle.y = Math.max(from.y, to.y) + apex;
        compiled.path = [from.toArray() as CgVec3, middle.toArray() as CgVec3, to.toArray() as CgVec3];
        compiled.pathControls = [
          { id: `auto-start:${action.id}`, position: [...state.position], role: 'start', source: 'auto' },
          { id: `auto-apex:${action.id}`, position: middle.toArray() as CgVec3, role: 'via', source: 'auto' },
          { id: target.id, position: [...target.position], role: 'end', source: 'auto' }
        ];
        compiled.pathInterpolation = 'smooth'; compiled.from = [...state.position]; compiled.to = [...target.position];
        dependencies.push(target.id);
      }
    } else if (action.type === 'move') {
      const hard = positionConstraint('action-target', action.id);
      const target = anchors.get(hard?.anchorId ?? action.targetAnchorId ?? '');
      if (!target) diagnostic('missing_target', 'Move target anchor cannot be resolved.', [action.id]);
      else {
        const fixed = constraints('entity-position', action.entityId).find((c) => c.scope === 'throughout');
        if (fixed && distance(state.position, target.position) > 1e-6) diagnostic('fixed_entity_moves', 'This movement conflicts with a throughout entity-position lock.', [action.id, fixed.id]);
        const radius = Math.max(0.12, Math.min(0.6, binding.height * 0.19));
        const route = constraints('action-route', action.id)
          .map((constraint) => ({ constraint, anchor: anchors.get(constraint.anchorId!) }))
          .filter((item): item is { constraint: CgConstraint; anchor: CgAnchor } => !!item.anchor)
          .sort((left, right) => (left.constraint.order ?? 0) - (right.constraint.order ?? 0) || left.constraint.id.localeCompare(right.constraint.id));
        const destinations = [...route.map((item) => item.anchor), target];
        let from = state.position;
        const resolved: CgVec3[] = [[...from]];
        for (const destination of destinations) {
          const surfacePath = navigation ? findNavigationPath(navigation, from, destination.position, radius, binding.height, action.route) : undefined;
          const segment = navigation ? surfacePath?.points : findGroundPath(collisionMap, boxes, from, destination.position, radius, binding.height);
          if (!segment) { diagnostic('unreachable_target', 'No supported path reaches the exact point within road, surface and collision constraints.', [action.id, destination.id]); break; }
          if (surfacePath) compiled.surfaceIds = [...compiled.surfaceIds ?? [surfacePath.surfaceIds[0]], ...surfacePath.surfaceIds.slice(1)];
          resolved.push(...segment.slice(1));
          from = destination.position;
        }
        if (resolved.length > 1 && resolved[resolved.length - 1].every((value, axis) => Math.abs(value - target.position[axis]) < 1e-5)) {
          compiled.path = resolved;
          compiled.pathControls = [
            { id: `auto-start:${action.id}`, position: [...state.position], role: 'start', source: 'auto' },
            ...route.map((item) => ({ id: item.anchor.id, position: [...item.anchor.position] as CgVec3, role: 'via' as const, source: 'user' as const })),
            { id: target.id, position: [...target.position], role: 'end', source: hard ? 'user' : 'auto' }
          ];
          compiled.pathInterpolation = route.length && !navigation ? 'smooth' : 'linear';
          if (navigation && resolved.length >= 3 && resolved.every(p => Math.abs(p[1] - resolved[0][1]) < 0.01)) {
            let smoothFree = true;
            const divisions = Math.min(4096, Math.max(64, resolved.length * 8));
            for (let i = 0; i <= divisions && smoothFree; i++) smoothFree = navigationPointFree(navigation, sampleSmoothPath(resolved, i / divisions).position, radius, binding.height, action.route);
            if (smoothFree) compiled.pathInterpolation = 'smooth';
          }
          if (compiled.pathInterpolation === 'smooth' && !smoothGroundPathIsFree(bundle.map, boxes, resolved, radius, binding.height)) diagnostic('smoothed_route_blocked', 'The smooth route between exact user points leaves walkable ground or intersects geometry; move the route point or add another one.', [action.id, ...route.map((item) => item.anchor.id)]);
        }
        compiled.from = [...state.position]; compiled.to = [...target.position];
        if (action.route && compiled.path) {
          compiled.motionBlend = 0.2;
          const length = compiled.path.slice(1).reduce((sum, p, i) => sum + distance(compiled.path![i], p), 0);
          if (length / Math.max(0.001, compiled.duration) > (action.route.maxSpeed ?? (action.route.locomotion === 'run' ? 7 : 2.5))) diagnostic('locomotion_speed_exceeded', '路线长度与行为时长要求的速度超出步态范围。', [action.id]);
          const motion = clips.get(action.clipId ?? '');
          if (motion?.locomotion) {
            compiled.playbackRate = length / Math.max(0.001, compiled.duration) / motion.locomotion.nominalSpeed;
            if (motion.locomotion.kind !== action.route.locomotion || compiled.playbackRate < motion.locomotion.minRate || compiled.playbackRate > motion.locomotion.maxRate) diagnostic('locomotion_rate_out_of_range', '路径速度超出此步态可适配范围，请修改行为时长或选择匹配动画。', [action.id]);
          } else diagnostic('uncalibrated_locomotion', '步态未提供标称速度，已保持原动画速度；需要预览检查脚步匹配。', [action.id], 'warning');
          if (motion && !motion.loop && motion.duration < compiled.duration * (compiled.playbackRate ?? 1) - 1e-6) diagnostic('locomotion_clip_too_short', '移动动画时长不足且不可循环。', [action.id]);
          dependencies.push(...action.route.guideIds.map(id => `guide:${id}`), ...(action.clipId ? [action.clipId] : []));
        }
        dependencies.push(target.id, ...(hard ? [hard.id] : []), ...route.flatMap((item) => [item.constraint.id, item.anchor.id]), ...prior.filter((a) => a.type === 'move').map((a) => a.id));
      }
    } else if (action.type === 'sit' && navigation) {
      validation.diagnostics.push(...solveSit(bundle, binding, compiled, state, anchors, navigation));
      if (compiled.contact) {
        const contact = compiled.contact;
        if (constraints('entity-position', action.entityId).some(c => c.scope === 'throughout') && distance(state.position, contact.rootPosition) > 1e-6) diagnostic('fixed_entity_moves', '坐下动作与人物全程位置锁冲突。', [action.id]);
        if (bundle.performance!.occupancy.some(o => o.objectId === contact.objectId && o.slotId === contact.nodeId && o.end > interval.start)) diagnostic('seat_occupied', '该座位在此时间段已经被另一个角色占用。', [action.id]);
        bundle.performance!.occupancy.push({ objectId: contact.objectId, slotId: contact.nodeId, entityId: action.entityId, start: interval.start, end: bundle.duration });
        dependencies.push(contact.objectId, `${contact.objectId}/node:${contact.nodeId}`, action.clipId!, action.interaction!.approachAnchorId);
      }
    } else if (action.type === 'dialogue') {
      const other = sampleEntities(bundle, interval.start)[action.targetEntityId!];
      if (!other) diagnostic('missing_dialogue_participant', '对话对象不存在。', [action.id]);
      else { compiled.to = [...other.position]; dependencies.push(action.targetEntityId!); }
    } else if (action.type === 'face') {
      const target = action.targetAnchorId ? anchors.get(action.targetAnchorId)?.position : sampleEntities(bundle, interval.start)[action.targetEntityId!]?.position;
      if (!target) diagnostic('missing_target', 'Facing target cannot be resolved.', [action.id]);
      else {
        compiled.from = new Euler().setFromQuaternion(new Quaternion().fromArray(state.quaternion)).toArray().slice(0, 3) as CgVec3;
        const desired = new Vector3(target[0] - state.position[0], 0, target[2] - state.position[2]);
        // A held animation may leave the head rotated relative to the body.
        // Solve the body yaw against the measured end-of-prior-actions face
        // direction so the semantic face action actually looks at its target.
        const endState = sampleEntities(bundle, interval.end)[action.entityId];
        const rootForward = new Vector3(0, 0, 1).applyQuaternion(new Quaternion().fromArray(endState?.quaternion ?? state.quaternion)).setY(0);
        const faceForward = endState?.faceForward ? new Vector3(...endState.faceForward).setY(0) : rootForward.clone();
        if (desired.lengthSq() > 1e-12 && rootForward.lengthSq() > 1e-12 && faceForward.lengthSq() > 1e-12) {
          const desiredYaw = Math.atan2(desired.x, desired.z);
          const rootYaw = Math.atan2(rootForward.x, rootForward.z);
          const faceYaw = Math.atan2(faceForward.x, faceForward.z);
          const targetRootYaw = desiredYaw - Math.atan2(Math.sin(faceYaw - rootYaw), Math.cos(faceYaw - rootYaw));
          compiled.to = [Math.sin(targetRootYaw), 0, Math.cos(targetRootYaw)];
        } else compiled.to = desired.toArray() as CgVec3;
      }
      dependencies.push(action.targetAnchorId ?? action.targetEntityId!, ...prior.filter((a) => a.type === 'move' || a.type === 'face').map((a) => a.id));
    } else if (action.type === 'attach') {
      if (!action.targetEntityId || !action.socketId) diagnostic('invalid_attachment', 'Attachment requires a prop owner and socket.', [action.id]);
      else {
        const assembly = resources.assemblies?.find(item => item.actorEntityId === action.targetEntityId && item.propEntityId === action.entityId && item.socketId === action.socketId);
        if (bundle.evaluationVersion === 2 && !assembly) diagnostic('missing_assembly_profile', 'Attachment requires a verified 3d-generate mount profile for this actor, prop and socket.', [action.id]);
        else {
          if (assembly?.source === 'semantic-node-fallback') diagnostic('assembly_mount_fallback', `3d-generate Mount 不可用；${action.id} 使用真实模型语义节点挂点。`, [action.id], 'warning');
          dependencies.push(action.targetEntityId, assembly?.id ?? action.socketId);
        }
      }
    } else if (action.type === 'detach') {
      dependencies.push(action.entityId);
    } else if (action.type === 'handoff') {
      if (!action.sourceEntityId || !action.targetEntityId || !action.socketId) diagnostic('invalid_handoff', 'Handoff requires exact source, target and receiving socket.', [action.id]);
      else {
        const giver = resources.assemblies?.find(item => item.actorEntityId === action.sourceEntityId && item.propEntityId === action.entityId && item.socketId === 'right-hand');
        const receiver = resources.assemblies?.find(item => item.actorEntityId === action.targetEntityId && item.propEntityId === action.entityId && item.socketId === action.socketId);
        if (bundle.evaluationVersion === 2 && (!giver || !receiver)) diagnostic('missing_handoff_assembly', 'Handoff requires verified giver and receiver grip profiles.', [action.id]);
        else {
          if (giver?.source === 'semantic-node-fallback' || receiver?.source === 'semantic-node-fallback') diagnostic('handoff_mount_fallback', '3d-generate Mount 不可用；交接使用双方真实模型语义节点挂点。', [action.id], 'warning');
          dependencies.push(action.sourceEntityId, action.targetEntityId, giver?.id ?? 'right-hand', receiver?.id ?? action.socketId);
        }
        // Validate against the complete authored schedule instead of the partially
        // compiled bundle. Actions with the same start time are sorted by id, so a
        // handoff can legitimately compile before either participant's animation.
        const participantMotion = (entityId: string) => document.actions.find(item => {
          if (item.type !== 'animate' || item.entityId !== entityId || item.propEntityId !== action.entityId) return false;
          const motionInterval = timings.get(item.id)!;
          return motionInterval.start < interval.end && motionInterval.end > interval.start;
        });
        const giverMotion = participantMotion(action.sourceEntityId), receiverMotion = participantMotion(action.targetEntityId);
        if (bundle.evaluationVersion === 2 && (!giverMotion || !receiverMotion)) diagnostic('missing_handoff_motion', 'Both handoff participants require synchronized prop-informed body animation.', [action.id]);
        else dependencies.push(...[giverMotion?.id, receiverMotion?.id].filter((id): id is string => !!id));
      }
    } else if (action.type === 'animate') {
      const clip = clips.get(action.clipId!);
      const asset = binding.assetId ? assetMap.get(binding.assetId) : undefined;
      if (!clip) diagnostic('missing_clip', `Missing frozen animation ${action.clipId}.`, [action.id]);
      else {
        if (clip.entityId !== action.entityId || !asset || clip.modelHash !== stableHash(asset.modelJson)) diagnostic('clip_model_mismatch', 'Animation must be baked for this exact entity and model hash.', [action.id, clip.id]);
        const model = asset?.modelJson as { nodes?: { id?: string }[] } | undefined;
        const nodes = new Set(model?.nodes?.map((n) => n.id) ?? []);
        if (clip.rootMotion !== 'in-place' || !Number.isFinite(clip.duration) || clip.duration <= 0 || !Number.isFinite(clip.fps) || clip.fps <= 0 || clip.fps > 240 || !clip.tracks || !Object.keys(clip.tracks).length) diagnostic('invalid_clip', 'Animation requires finite duration/fps, named-node tracks and in-place root motion.', [clip.id]);
        else for (const [nodeId, tracks] of Object.entries(clip.tracks)) {
          if (!nodes.has(nodeId)) diagnostic('missing_clip_node', `Animation references missing model node ${nodeId}.`, [clip.id, nodeId]);
          if (!tracks || typeof tracks !== 'object' || !Object.keys(tracks).length) {
            diagnostic('invalid_clip_samples', 'A baked animation node requires at least one sampled channel.', [clip.id, nodeId]); continue;
          }
          for (const [channel, samples] of Object.entries(tracks)) if (!['position', 'rotation', 'scale', 'quaternion'].includes(channel) || !Array.isArray(samples) || !samples.length || Array.from(samples as readonly number[][]).some((sample) => !Array.isArray(sample) || sample.length !== (channel === 'quaternion' ? 4 : 3) || Array.from(sample).some((n) => !Number.isFinite(n)) || (channel === 'quaternion' && Math.abs(Math.hypot(...sample) - 1) > 0.001))) diagnostic('invalid_clip_samples', 'Baked animation contains invalid or non-unit quaternion samples.', [clip.id, nodeId]);
        }
        compiled.playbackRate = clip.duration / Math.max(1e-6, compiled.duration);
        dependencies.push(clip.id);
      }
    }
    bundle.dependencies[action.id] = [...new Set(dependencies)];
    // Hash only resolved dependencies: changing an unrelated lens does not rebake movement.
    compiled.inputHash = stableHash({ action: compiled, initial: bundle.initial[action.entityId], binding, target: compiled.to,
      clip: action.clipId ? clips.get(action.clipId) : undefined, world: action.type === 'move' ? { boxes, terrain: collisionMap.terrain, box: collisionMap.box, layout: collisionMap.layout, ...(navigation ? { guides: collisionMap.guides, water: collisionMap.waterBodies, surfaces: navigation.surfaces } : {}) } : undefined,
      prior: prior.filter((a) => dependencies.includes(a.id)).map((a) => a.inputHash) });
    bundle.actions.push(compiled);
  }
  for (const entity of document.entities) {
    if (entity.kind !== 'actor') continue;
    const binding = bundle.bindings.find((b) => b.entityId === entity.id)!;
    const radius = Math.max(0.12, Math.min(0.6, binding.height * 0.19));
    // A launch point may deliberately be a roof or another non-walkable
    // surface. Its exact landing is still validated by the airborne action.
    const startAnchor = entity.startAnchorId ? anchors.get(entity.startAnchorId) : undefined;
    if (startAnchor?.objectId || document.actions.some(action => action.entityId === entity.id && action.type === 'airborne' && timings.get(action.id)?.start === 0)) continue;
    if (!(navigation ? navigationPointFree(navigation, bundle.initial[entity.id].position, radius, binding.height) : freeGroundPoint(collisionMap, boxes, bundle.initial[entity.id].position, radius, binding.height))) diagnostic('invalid_actor_start', 'Actor start position intersects map geometry, terrain or map bounds.', [entity.id]);
  }
  if (bundle.evaluationVersion === 2 && !validation.diagnostics.some(d => d.severity === 'error')) validation.diagnostics.push(...validatePerformanceClearance(bundle, boxes));
  if (options.performanceOnly) return finish();
  // Resolve automatic camera parameters against the frozen world; manual poses stay exact.
  for (const shot of bundle.shots) {
    if (!shot.lockedPose) {
      const original = clone(shot.camera);
      let best = original, bestScore = -Infinity;
      if (bundle.evaluationVersion === 2) {
        const authored = document.shots.find(s => s.id === shot.id)!;
        const candidates = cameraCandidates(authored, document.actions.find(a => a.id === authored.behaviorId));
        shot.candidateScores = [];
        const lockedPath = shot.path ? clone(shot.path) : undefined;
        let bestPath = lockedPath;
        for (const candidate of candidates) {
          shot.camera = candidate.camera;
          shot.path = lockedPath;
          if (!lockedPath && shot.camera.movement !== 'static') {
            const samples = Math.max(8, Math.min(120, Math.ceil((shot.end - shot.start) * 10)));
            shot.path = Array.from({ length: samples + 1 }, (_, i) => sampleSemanticCamera(bundle, shot, shot.start + (shot.end - shot.start) * i / samples).position);
            shot.pathInterpolation = 'smooth';
          }
          let score = cameraScore(bundle, shot, boxes);
          const previous = bundle.shots[bundle.shots.indexOf(shot) - 1];
          if (previous && shot.transition?.motivation !== 'reestablish' && sameInteractionPair(previous, shot)) {
            const beforeSide = interactionSide(bundle, previous, sampleCamera(bundle, previous, Math.max(previous.start, previous.end - 1e-5)), previous.end - 1e-5);
            const afterSide = interactionSide(bundle, shot, sampleCamera(bundle, shot, shot.start), shot.start);
            if (beforeSide && afterSide && beforeSide !== afterSide) score = Math.min(score, 2.5);
          }
          shot.candidateScores.push({ skillId: candidate.skillId, score, feasible: score >= 3 - 1e-8 });
          if (score > bestScore) { bestScore = score; best = clone(candidate.camera); bestPath = shot.path ? clone(shot.path) : undefined; shot.skillId = candidate.skillId; }
        }
        shot.camera = best;
        shot.path = bestPath;
        if (!candidates.length) diagnostic('unsupported_shot_skill', '镜头技能与行为、参与者或叙事目的不匹配。', [shot.id]);
      } else {
      const relative = original.reference && original.reference !== 'world';
      const offsets = relative
        ? [0, Math.PI / 12, -Math.PI / 12, Math.PI / 6, -Math.PI / 6]
        : [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI * 3 / 4, -Math.PI * 3 / 4];
      for (const offset of offsets) {
        shot.camera = { ...original, azimuth: (original.azimuth ?? (relative ? 0 : Math.PI / 5)) + offset };
        const score = cameraScore(bundle, shot, boxes);
        if (score > bestScore) { best = clone(shot.camera); bestScore = score; }
        if (score === 3) break;
      }
      }
      shot.camera = best;
      if (bestScore < 3) diagnostic('camera_obstructed', 'Automatic camera could not keep a clear view throughout this shot; adjust staging or set an exact camera pose.', [shot.id]);
      if (shot.camera.framing === 'close-up' && shot.camera.aim && bundle.bindings.find((binding) => binding.entityId === shot.camera.subjectId)?.focus?.source === 'proportional-fallback') diagnostic('face_landmark_fallback', 'Close-up uses proportional face placement because the model has no named head/face hierarchy.', [shot.id, shot.camera.subjectId], 'warning');
    } else if (cameraScore(bundle, shot, boxes, bundle.evaluationVersion !== 2) < 3) diagnostic('locked_camera_collision', bundle.evaluationVersion === 2 ? 'The exact camera pose collides or cannot see the required subject; the lock remains unchanged.' : 'The exact camera pose intersects the terrain or map geometry.', [shot.id]);
    if (bundle.evaluationVersion === 2) {
      const fps = 30, count = Math.ceil((shot.end - shot.start) * fps);
      const poses = Array.from({ length: count + 1 }, (_, i) => sampleCamera(bundle, shot, Math.min(shot.end, shot.start + i / fps)));
      shot.cameraSamples = { fps, poses };
    }
    // Future actions cannot change the evaluated state in this shot. Excluding
    // them keeps an edit to a later beat from invalidating earlier cameras.
    const deps = bundle.actions.filter((a) => a.start < shot.end && [shot.camera.subjectId, shot.camera.secondaryId].includes(a.entityId));
    bundle.dependencies[shot.id].push(...deps.map((a) => a.id));
    shot.inputHash = stableHash({ shot: { ...shot, inputHash: undefined }, subjects: [bundle.initial[shot.camera.subjectId], shot.camera.secondaryId ? bundle.initial[shot.camera.secondaryId] : undefined], bindings: bundle.bindings.filter((b) => [shot.camera.subjectId, shot.camera.secondaryId].includes(b.entityId)), actions: deps.map((a) => a.inputHash), world: boxes, terrain: bundle.map.terrain });
  }
  validateShotContinuity(bundle, diagnostic);
  return finish();
}

/** Sample channels from their initial state every time; seeks never replay mutable events. */
function sampleEntities(bundle: CompiledCG, time: number): Record<string, CgEntityState> {
  if (bundle.evaluationVersion === 2) return sampleModernEntities(bundle, time);
  const entities = clone(bundle.initial);
  for (const action of bundle.actions) {
    if (time < action.start) continue;
    const state = entities[action.entityId]; if (!state) continue;
    if (action.type === 'move' && action.path) {
      const sampled = action.pathInterpolation === 'smooth' ? sampleSmoothPath(action.path, progress(action, time)) : samplePath(action.path, progress(action, time));
      state.position = sampled.position;
      if (action.pathInterpolation === 'smooth') state.position[1] = sampleTerrainHeight(bundle.map, state.position[0], state.position[2]);
      if (Math.hypot(sampled.direction[0], sampled.direction[2]) > 1e-7) state.quaternion = yaw(sampled.direction);
    } else if (action.type === 'face' && action.to && action.from) {
      state.quaternion = new Quaternion().fromArray(quat(action.from)).slerp(new Quaternion().fromArray(yaw(action.to)), progress(action, time)).toArray() as CgQuat;
    } else if (action.type === 'visibility') state.visible = action.visible!;
    else if (action.type === 'animate' && time <= action.end) {
      const clip = bundle.resources.clips.find((c) => c.id === action.clipId);
      if (clip) { const elapsed = Math.max(0, time - action.start); state.clipId = clip.id; state.clipTime = clip.loop ? elapsed % clip.duration : Math.min(elapsed, clip.duration); }
    }
  }
  return entities;
}

function lookAt(position: CgVec3, target: CgVec3, fov: number): CgCameraPose {
  const matrix = new Matrix4().lookAt(new Vector3(...position), new Vector3(...target), new Vector3(0, 1, 0));
  return { position, quaternion: new Quaternion().setFromRotationMatrix(matrix).toArray() as CgQuat, fov, target };
}

function semanticTarget(bundle: CompiledCG, entityId: string, state: CgEntityState, aim: CgCompiledShot['camera']['aim']): CgVec3 {
  if (bundle.evaluationVersion === 2) {
    const dynamic = state.landmarks?.[aim === 'eyes' ? 'eyes' : aim === 'face' ? 'face' : 'head'];
    if (dynamic && (aim === 'face' || aim === 'eyes')) return [...dynamic];
    if (dynamic && state.landmarks?.hips) {
      const factor = aim === 'upper-body' ? 0.7 : 0.35;
      return new Vector3(...state.landmarks.hips).lerp(new Vector3(...dynamic), factor).toArray();
    }
  }
  const binding = bundle.bindings.find((candidate) => candidate.entityId === entityId);
  const height = binding?.height ?? 1.8;
  const localHeight = height / Math.max(1e-6, Math.abs(state.scale[1]));
  const fallback: Record<string, CgVec3> = {
    body: [0, localHeight * 0.5, 0], 'upper-body': [0, localHeight * 0.7, 0], face: [0, localHeight * 0.84, 0], eyes: [0, localHeight * 0.89, 0]
  };
  const local = binding?.focus?.[aim === 'upper-body' ? 'upperBody' : aim === 'face' || aim === 'eyes' ? aim : 'body'] ?? fallback[aim ?? 'body'];
  const transformed = new Vector3(...local)
    .multiply(new Vector3(...state.scale))
    .applyQuaternion(new Quaternion().fromArray(state.quaternion))
    .add(new Vector3(...state.position));
  return transformed.toArray() as CgVec3;
}

function horizontalFrame(intent: CgCompiledShot['camera'], subject: CgEntityState, secondary?: CgEntityState) {
  const facing = intent.reference === 'subject-facing' && subject.faceForward
    ? new Vector3(...subject.faceForward)
    : new Vector3(0, 0, 1).applyQuaternion(new Quaternion().fromArray(subject.quaternion));
  facing.y = 0;
  if (facing.lengthSq() < 1e-8) facing.set(0, 0, 1); else facing.normalize();
  let forward = facing;
  if (intent.reference === 'interaction-axis' && secondary) {
    forward = new Vector3(...secondary.position).sub(new Vector3(...subject.position));
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward = facing; else forward.normalize();
  }
  const right = new Vector3(forward.z, 0, -forward.x).normalize();
  return { forward, right };
}

function semanticOffset(intent: CgCompiledShot['camera'], forward: Vector3, right: Vector3): Vector3 {
  const side = right.clone().multiplyScalar(intent.side === 'left' ? -1 : 1);
  let offset: Vector3;
  switch (intent.view) {
    case 'front': offset = forward.clone(); break;
    case 'front-three-quarter': offset = forward.clone().add(side).normalize(); break;
    case 'side': offset = side; break;
    case 'rear-three-quarter': offset = forward.clone().multiplyScalar(-1).add(side).normalize(); break;
    case 'rear': offset = forward.clone().multiplyScalar(-1); break;
    default: offset = forward.clone().applyAxisAngle(new Vector3(0, 1, 0), intent.side === 'left' ? -(intent.azimuth ?? Math.PI / 5) : (intent.azimuth ?? Math.PI / 5)); return offset;
  }
  return offset.applyAxisAngle(new Vector3(0, 1, 0), intent.azimuth ?? 0).normalize();
}

function composedLookAt(position: CgVec3, focus: CgVec3, fov: number, screenPosition?: [number, number]): CgCameraPose {
  if (!screenPosition || (Math.abs(screenPosition[0]) < 1e-8 && Math.abs(screenPosition[1]) < 1e-8)) return lookAt(position, focus, fov);
  const camera = new Vector3(...position), subject = new Vector3(...focus);
  const forward = subject.clone().sub(camera).normalize();
  const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, forward).normalize();
  const range = camera.distanceTo(subject);
  const vertical = 2 * range * Math.tan(fov * Math.PI / 360);
  const lookTarget = subject.clone()
    .addScaledVector(right, -screenPosition[0] * vertical * 16 / 9)
    .addScaledVector(up, -screenPosition[1] * vertical);
  const pose = lookAt(position, lookTarget.toArray() as CgVec3, fov);
  pose.target = [...focus];
  return pose;
}

function sampleSemanticCamera(bundle: CompiledCG, shot: CgCompiledShot, time: number, current?: Record<string, CgEntityState>): CgCameraPose {
  if (shot.lockedPose) return clone(shot.lockedPose);
  const referenceTime = shot.referenceBehavior && shot.behaviorId ? Math.max(shot.start, bundle.actions.find(a => a.id === shot.behaviorId)?.start ?? shot.start) : shot.start;
  const intent = shot.camera, start = sampleEntities(bundle, referenceTime);
  const sampled = current ?? sampleEntities(bundle, time);
  const subjects = intent.movement === 'static' || intent.movement === 'dolly' ? start : sampled;
  const subject = subjects[intent.subjectId];
  const height = bundle.bindings.find((b) => b.entityId === intent.subjectId)?.height ?? 1.8;
  if (!subject) return lookAt([0, 3, 6], [0, 0, 0], 45);
  const aim = intent.aim ?? (intent.framing === 'close-up' ? 'face' : intent.framing === 'medium' || intent.framing === 'over-shoulder' ? 'upper-body' : 'body');
  const secondary = intent.secondaryId ? subjects[intent.secondaryId] : undefined;
  let target = semanticTarget(bundle, intent.subjectId, subject, aim);
  if ((aim === 'interaction' || intent.layout === 'two-shot') && secondary && intent.secondaryId) {
    const other = semanticTarget(bundle, intent.secondaryId, secondary, 'upper-body');
    target = [(target[0] + other[0]) / 2, (target[1] + other[1]) / 2, (target[2] + other[2]) / 2];
  }
  const fov = 2 * Math.atan(24 / (2 * (intent.lensMm ?? (intent.framing === 'close-up' ? 85 : 40)))) * 180 / Math.PI;
  const binding = bundle.bindings.find((candidate) => candidate.entityId === intent.subjectId);
  const scaledFaceHeight = (binding?.focus?.faceHeight ?? height * 0.22) * Math.abs(subject.scale[1]);
  let extent = intent.framing === 'wide' ? height * 1.8 : intent.framing === 'close-up' ? Math.max(scaledFaceHeight * 2.2, height * 0.45) : height * 0.85;
  if (intent.layout === 'two-shot' && secondary) extent = Math.max(extent, (distance(subject.position, secondary.position) + height) / (16 / 9));
  let range = intent.distance ?? extent / (2 * Math.tan(fov * Math.PI / 360));
  const composition = intent.screenPosition ?? (aim === 'eyes' ? [0, 0.08] as [number, number] : undefined);
  const t = clamp01((time - shot.start) / (shot.end - shot.start));
  const finishPose = (position: CgVec3, baseTarget: CgVec3) => {
    let look = baseTarget;
    if (bundle.evaluationVersion === 2 && intent.aimMode !== 'fixed' && sampled[intent.subjectId]) {
      look = semanticTarget(bundle, intent.subjectId, sampled[intent.subjectId], aim);
      if ((aim === 'interaction' || intent.layout === 'two-shot') && intent.secondaryId && sampled[intent.secondaryId]) {
        const other = semanticTarget(bundle, intent.secondaryId, sampled[intent.secondaryId], 'upper-body');
        look = new Vector3(...look).lerp(new Vector3(...other), 0.5).toArray();
      }
    }
    return composedLookAt(position, look, fov, composition);
  };
  if (intent.movement === 'dolly') range *= 1.25 - 0.45 * t;
  let angle = (intent.azimuth ?? Math.PI / 5) + (intent.movement === 'orbit' ? (t - 0.5) * Math.PI / 2 : 0);
  if ((intent.framing === 'over-shoulder' || intent.layout === 'over-shoulder') && intent.secondaryId) {
    const secondary = subjects[intent.secondaryId];
    if (secondary) {
      const dx = secondary.position[0] - subject.position[0], dz = secondary.position[2] - subject.position[2];
      const length = Math.hypot(dx, dz) || 1;
      const ux = dx / length, uz = dz / length, side = intent.side === 'left' ? -1 : 1;
      const shoulderHeight = bundle.bindings.find((b) => b.entityId === intent.secondaryId)?.height ?? height;
      const cameraHeight = bundle.evaluationVersion === 2 ? (secondary.landmarks?.head?.[1] ?? secondary.position[1] + shoulderHeight * 0.87) + (intent.height ?? 0) : secondary.position[1] + (intent.height ?? shoulderHeight * 0.87);
      return finishPose([secondary.position[0] + ux * range * 0.35 + uz * side * shoulderHeight * 0.35, cameraHeight, secondary.position[2] + uz * range * 0.35 - ux * side * shoulderHeight * 0.35], target);
    }
  }
  if (intent.reference && intent.reference !== 'world') {
    const frame = horizontalFrame(intent, subject, secondary);
    const offset = semanticOffset(intent, frame.forward, frame.right);
    if (intent.movement === 'orbit') offset.applyAxisAngle(new Vector3(0, 1, 0), (t - 0.5) * Math.PI / 2);
    const baseY = intent.pitch !== undefined ? target[1] + Math.sin(intent.pitch) * range : intent.height !== undefined ? subject.position[1] + intent.height : target[1] + (intent.framing === 'wide' ? height * 0.16 : intent.framing === 'close-up' ? 0 : height * 0.08);
    const y = intent.movement === 'crane' ? baseY + t * Math.max(height * 1.2, intent.height ?? height * 2.5) : baseY;
    const horizontalRange = range * Math.cos(intent.pitch ?? 0);
    return finishPose([target[0] + offset.x * horizontalRange, y, target[2] + offset.z * horizontalRange], target);
  }
  if (intent.side === 'left') angle = -angle;
  const worldY = intent.pitch !== undefined ? target[1] + Math.sin(intent.pitch) * range : subject.position[1] + (intent.height ?? height * 0.92);
  return finishPose([target[0] + Math.sin(angle) * range * Math.cos(intent.pitch ?? 0), intent.movement === 'crane' ? worldY + t * Math.max(height * 1.2, intent.height ?? height * 2.5) : worldY, target[2] + Math.cos(angle) * range * Math.cos(intent.pitch ?? 0)], target);
}

function sampleCamera(bundle: CompiledCG, shot: CgCompiledShot, time: number, current?: Record<string, CgEntityState>): CgCameraPose {
  if (shot.lockedPose) return clone(shot.lockedPose);
  if (shot.cameraSamples?.poses.length) {
    const samples = shot.cameraSamples, f = bakedFrameIndex(time - shot.start, shot.end - shot.start, samples.fps, samples.poses.length), a = samples.poses[Math.floor(f)], b = samples.poses[Math.min(Math.floor(f) + 1, samples.poses.length - 1)], u = f - Math.floor(f);
    const pose: CgCameraPose = { position: new Vector3(...a.position).lerp(new Vector3(...b.position), u).toArray(), quaternion: new Quaternion(...a.quaternion).slerp(new Quaternion(...b.quaternion), u).toArray(), fov: a.fov + (b.fov - a.fov) * u, ...(a.target && b.target ? { target: new Vector3(...a.target).lerp(new Vector3(...b.target), u).toArray() as CgVec3 } : {}) };
    // An authored path keeps its exact curve; only automatic camera motion is
    // resampled. This preserves user control points between bake sample times.
    if (shot.path?.length && shot.pathControlIds?.length) {
      const progress = clamp01((time - shot.start) / Math.max(1e-6, shot.end - shot.start));
      pose.position = (shot.pathInterpolation === 'smooth' ? sampleSmoothPath(shot.path, progress) : samplePath(shot.path, progress)).position;
      if (pose.target) return composedLookAt(pose.position, pose.target, pose.fov, shot.camera.screenPosition);
    }
    return pose;
  }
  const semantic = sampleSemanticCamera(bundle, shot, time, current);
  if (!shot.path?.length || shot.lockedPose) return semantic;
  const path = shot.path.length === 1 ? [shot.path[0], shot.path[0]] : shot.path;
  const progress = clamp01((time - shot.start) / Math.max(1e-6, shot.end - shot.start));
  const position = (shot.pathInterpolation === 'smooth' ? sampleSmoothPath(path, progress) : samplePath(path, progress)).position;
  return semantic.target ? composedLookAt(position, semantic.target, semantic.fov, shot.camera.screenPosition) : { ...semantic, position };
}

function lineIntersectsBox(a: CgVec3, b: CgVec3, box: MapObjectAabb, padding = 0): boolean {
  let enter = 0, leave = 1;
  for (let i = 0; i < 3; i++) {
    const d = b[i] - a[i], lo = box.min[i] - padding, hi = box.max[i] + padding;
    if (Math.abs(d) < 1e-8) { if (a[i] < lo || a[i] > hi) return false; }
    else { const p = (lo - a[i]) / d, q = (hi - a[i]) / d; enter = Math.max(enter, Math.min(p, q)); leave = Math.min(leave, Math.max(p, q)); if (enter > leave) return false; }
  }
  return enter <= 1 && leave >= 0;
}

function cameraScore(bundle: CompiledCG, shot: CgCompiledShot, boxes: MapObjectAabb[], poseOnly = false): number {
  const subjectObject = bundle.bindings.find((b) => b.entityId === shot.camera.subjectId)?.objectId;
  let score = 0, quality = 0;
  const count = Math.max(3, Math.min(49, Math.ceil((shot.end - shot.start) / 0.25) + 1));
  let previous: CgVec3 | undefined;
  for (let i = 0; i < count; i++) {
    const t = shot.start + (shot.end - shot.start) * i / (count - 1);
    const pose = sampleCamera(bundle, shot, t);
    const cameraPathBlocked = previous && boxes.some((b) => lineIntersectsBox(previous!, pose.position, b, 0.08));
    previous = pose.position;
    if (pose.position[1] < sampleTerrainHeight(bundle.map, pose.position[0], pose.position[2]) + 0.08) continue;
    if (boxes.some((b) => lineIntersectsBox(pose.position, pose.position, b, 0.08))) continue;
    if (cameraPathBlocked) continue;
    if (!poseOnly && bundle.evaluationVersion === 2) {
      const behavior = bundle.actions.find(a => a.id === shot.behaviorId);
      const contactObject = behavior?.type === 'sit' && documentCoveragePurpose(bundle, shot.id) === 'contact' ? behavior.contact?.objectId : undefined;
      const required = [subjectObject!, ...(shot.camera.layout === 'two-shot' ? [bundle.bindings.find(b => b.entityId === shot.camera.secondaryId)?.objectId ?? ''] : []), ...(contactObject ? [contactObject] : [])];
      const items = observeCamera(bundle.map, bundle.bindings, bundle.resources, sampleEntities(bundle, t), pose, 16 / 9, required);
      const coverageFloor = shot.camera.movement === 'crane' && shot.camera.framing === 'wide' ? 0.001 : 0.005;
      if (required.some(id => !items.some(item => item.objectId === id && item.visibleFraction >= (id === contactObject ? 0.15 : 0.55) && item.coverage > coverageFloor))) continue;
      if (shot.camera.framing === 'close-up' || ['face', 'eyes'].includes(shot.camera.aim ?? '')) {
        const subject = sampleEntities(bundle, t)[shot.camera.subjectId], face = subject?.landmarks?.eyes;
        if (!face || !items.find(item => item.objectId === subjectObject)?.landmarks?.eyes?.visible) continue;
        if (subject.faceForward && new Vector3(...pose.position).sub(new Vector3(...face)).normalize().dot(new Vector3(...subject.faceForward)) <= 0.1) continue;
      }
      quality += required.reduce((sum, id) => sum + (items.find(item => item.objectId === id)?.visibleFraction ?? 0), 0) / required.length;
    } else if (!poseOnly && pose.target && boxes.some((b) => b.objectId !== subjectObject && lineIntersectsBox(pose.position, pose.target!, b))) continue;
    score++;
  }
  return bundle.evaluationVersion === 2 && score === count ? 3 + quality / count * 0.5 : score / count * 3;
}

function documentCoveragePurpose(bundle: CompiledCG, shotId: string) {
  return bundle.document.shots.find(s => s.id === shotId)?.coveragePurpose;
}

function sameInteractionPair(a: CgCompiledShot, b: CgCompiledShot): boolean {
  return !!a.camera.secondaryId && !!b.camera.secondaryId && [a.camera.subjectId, a.camera.secondaryId].sort().join('|') === [b.camera.subjectId, b.camera.secondaryId].sort().join('|');
}
function interactionSide(bundle: CompiledCG, shot: CgCompiledShot, pose: CgCameraPose, time: number): number {
  if (!shot.camera.secondaryId) return 0;
  const [a, b] = [shot.camera.subjectId, shot.camera.secondaryId].sort(), states = sampleEntities(bundle, time);
  if (!states[a] || !states[b]) return 0;
  const p = states[a].position, q = states[b].position;
  const area = (q[0] - p[0]) * (pose.position[2] - p[2]) - (q[2] - p[2]) * (pose.position[0] - p[0]);
  return Math.abs(area) < 1e-4 ? 0 : Math.sign(area);
}

function validateShotContinuity(bundle: CompiledCG, diagnostic: (code: string, message: string, nodeIds?: string[], severity?: 'error' | 'warning') => void) {
  for (const shot of bundle.shots) {
    if (shot.camera.framing === 'close-up' && shot.camera.lensMm !== undefined && shot.camera.lensMm < 50) {
      diagnostic('close_up_wide_lens', 'Close-up lens is below 50mm and may distort the face; use 70–100mm unless distortion is intentional.', [shot.id], 'warning');
    }
  }
  for (let index = 1; index < bundle.shots.length; index++) {
    const previous = bundle.shots[index - 1], current = bundle.shots[index];
    if (previous.camera.subjectId !== current.camera.subjectId) continue;
    const boundary = current.start;
    const subject = sampleEntities(bundle, boundary)[current.camera.subjectId];
    if (!subject) continue;
    const beforePose = sampleCamera(bundle, previous, Math.max(previous.start, previous.end - 1e-4));
    const afterPose = sampleCamera(bundle, current, current.start);
    const origin = new Vector3(...subject.position);
    const before = new Vector3(...beforePose.position).sub(origin).setY(0);
    const after = new Vector3(...afterPose.position).sub(origin).setY(0);
    if (before.lengthSq() > 1e-8 && after.lengthSq() > 1e-8) {
      const angle = before.angleTo(after) * 180 / Math.PI;
      if (angle < 30 && previous.camera.framing === current.camera.framing && current.transition?.type !== 'ease-in-out') {
        diagnostic('jump_cut_risk', `Adjacent same-size shots change the camera axis by only ${angle.toFixed(1)}°; change size or cross at least 30° for a clean cut.`, [previous.id, current.id], 'warning');
      }
    }
    if (current.transition?.motivation === 'reestablish') continue;
    const delta = Math.min(0.12, previous.end - previous.start, current.end - current.start);
    const earlier = sampleEntities(bundle, Math.max(0, boundary - delta))[current.camera.subjectId];
    const atCut = sampleEntities(bundle, boundary)[current.camera.subjectId];
    const later = sampleEntities(bundle, Math.min(bundle.duration, boundary + delta))[current.camera.subjectId];
    if (!earlier || !atCut || !later) continue;
    const inbound = new Vector3(...atCut.position).sub(new Vector3(...earlier.position)).setY(0);
    const outbound = new Vector3(...later.position).sub(new Vector3(...atCut.position)).setY(0);
    if (inbound.lengthSq() < 1e-6 || outbound.lengthSq() < 1e-6) continue;
    const motion = inbound.add(outbound).normalize();
    const screenSign = (pose: CgCameraPose) => {
      const view = new Vector3(...(pose.target ?? subject.position)).sub(new Vector3(...pose.position)).normalize();
      const right = new Vector3().crossVectors(view, new Vector3(0, 1, 0)).normalize();
      return Math.sign(motion.dot(right));
    };
    const beforeSign = screenSign(beforePose), afterSign = screenSign(afterPose);
    if (beforeSign && afterSign && beforeSign !== afterSign) {
      diagnostic('screen_direction_flip', 'Travel reverses screen direction across this cut. Show the turn or use a re-establishing transition.', [previous.id, current.id], 'warning');
    }
  }
}

export function evaluateCG(bundle: CompiledCG, time: number): CgFrame {
  const t = Math.max(0, Math.min(bundle.duration, Number.isFinite(time) ? time : 0));
  const entities = sampleEntities(bundle, t);
  const shot = bundle.shots.find((s) => t >= s.start && t < s.end) ?? bundle.shots[bundle.shots.length - 1];
  let camera = shot ? sampleCamera(bundle, shot, t, entities) : lookAt([0, 3, 6], [0, 0, 0], 45);
  if (shot?.transition?.type === 'ease-in-out' && shot.transition.duration && t < shot.start + shot.transition.duration) {
    const index = bundle.shots.indexOf(shot);
    const previous = index > 0 ? bundle.shots[index - 1] : undefined;
    if (previous) {
      const from = sampleCamera(bundle, previous, Math.max(previous.start, previous.end - 1e-6));
      const raw = clamp01((t - shot.start) / shot.transition.duration);
      const weight = raw * raw * (3 - 2 * raw);
      const target = from.target && camera.target ? new Vector3(...from.target).lerp(new Vector3(...camera.target), weight).toArray() as CgVec3 : camera.target;
      camera = {
        position: new Vector3(...from.position).lerp(new Vector3(...camera.position), weight).toArray() as CgVec3,
        quaternion: new Quaternion().fromArray(from.quaternion).slerp(new Quaternion().fromArray(camera.quaternion), weight).toArray() as CgQuat,
        fov: from.fov + (camera.fov - from.fov) * weight,
        target
      };
    }
  }
  const effects: CgFrame['effects'] = [];
  for (const a of bundle.actions) if (a.type === 'effect' && t >= a.start && t < a.end) {
    // Event location is fixed at its start; a backward seek recreates identical particles.
    const origin = sampleEntities(bundle, a.start)[a.entityId];
    if (origin) effects.push({ id: a.id, position: [...origin.position], age: t - a.start, seed: parseInt(stableHash([bundle.document.seed, a.id]).slice(0, 8), 16) });
  }
  return { time: t, shotId: shot?.id ?? '', entities, camera, effects };
}

/** Typed, transactional patches preserve stable IDs and protect explicit user decisions. */
export function applyDirectorPatch(document: DirectorDocument, operations: CgPatchOperation[], source: 'user' | 'ai' = 'user'): DirectorDocument {
  assertDirector(document);
  if (!Array.isArray(operations) || !operations.length || operations.length > 128) throw new Error('Patch must contain between 1 and 128 operations.');
  const next = clone(document);
  const lockedAnchors = new Set(document.constraints.map((c) => c.anchorId).filter(Boolean));
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || typeof operation.type !== 'string') throw new Error('Invalid patch operation.');
    if (source === 'ai' && (operation.type.startsWith('constraint.') || (operation.type === 'anchor.upsert' && lockedAnchors.has(operation.anchor?.id)))) throw new Error('AI patches cannot modify user constraints or their anchors.');
    if (operation.type === 'shot.update') {
      const shot = next.shots.find((s) => s.id === operation.id); if (!shot) throw new Error(`Unknown shot ${operation.id}.`);
      if (source === 'ai' && operation.patch?.duration !== undefined && document.constraints.some((c) => c.type === 'shot-duration' && c.targetId === shot.id && c.seconds !== operation.patch.duration)) throw new Error('AI patch conflicts with a hard shot-duration constraint.');
      if (source === 'ai' && document.constraints.some((c) => ['camera-pose', 'camera-path'].includes(c.type) && c.targetId === shot.id)
        && (operation.patch?.skillId !== undefined && operation.patch.skillId !== shot.skillId || operation.patch?.camera && stableHash({ ...shot.camera, ...operation.patch.camera }) !== stableHash(shot.camera))) throw new Error('AI camera patch conflicts with a hard camera-pose constraint. Remove the manual camera lock before changing the camera intent.');
      Object.assign(shot, operation.patch, { id: shot.id, camera: { ...shot.camera, ...operation.patch.camera } });
      if (next.schemaVersion === 2 && operation.patch.duration !== undefined && operation.patch.autoDuration === undefined) shot.autoDuration = false;
      if (next.schemaVersion === 2 && operation.patch.camera && operation.patch.skillId === undefined) shot.skillId = 'authored-intent';
      if (operation.patch.camera?.framing && operation.patch.camera.framing !== document.shots.find(s => s.id === shot.id)?.camera.framing) {
        for (const key of ['distance', 'height', 'azimuth'] as const) if (operation.patch.camera[key] === undefined) delete shot.camera[key];
      }
    } else if (operation.type === 'action.update') {
      const action = next.actions.find((a) => a.id === operation.id); if (!action) throw new Error(`Unknown action ${operation.id}.`);
      if (source === 'ai') for (const lock of document.constraints.filter((c) => c.targetId === action.id)) {
        if (lock.type === 'action-target' && operation.patch.targetAnchorId !== undefined && operation.patch.targetAnchorId !== lock.anchorId) throw new Error('AI patch conflicts with a hard action-target constraint.');
        if (lock.type === 'action-time' && (operation.patch.start !== undefined || operation.patch.duration !== undefined)) throw new Error('AI patch cannot change a manually timed action.');
      }
      Object.assign(action, operation.patch, { id: action.id });
    } else if (operation.type === 'entity.update') {
      const entity = next.entities.find((e) => e.id === operation.id); if (!entity) throw new Error(`Unknown entity ${operation.id}.`);
      if (source === 'ai' && operation.patch.startAnchorId !== undefined && document.constraints.some((c) => c.type === 'entity-position' && c.targetId === entity.id && c.anchorId !== operation.patch.startAnchorId)) throw new Error('AI patch conflicts with a hard entity-position constraint.');
      Object.assign(entity, operation.patch, { id: entity.id });
    } else if (operation.type === 'anchor.upsert') {
      const index = next.anchors.findIndex((a) => a.id === operation.anchor?.id);
      if (index < 0) next.anchors.push(clone(operation.anchor)); else next.anchors[index] = clone(operation.anchor);
    } else if (operation.type === 'constraint.upsert') {
      const index = next.constraints.findIndex((c) => c.id === operation.constraint?.id);
      if (index < 0) next.constraints.push(clone(operation.constraint)); else next.constraints[index] = clone(operation.constraint);
    } else if (operation.type === 'constraint.remove') {
      if (!next.constraints.some((c) => c.id === operation.id)) throw new Error(`Unknown constraint ${operation.id}.`);
      next.constraints = next.constraints.filter((c) => c.id !== operation.id);
    } else throw new Error(`Unsupported patch operation ${(operation as { type: string }).type}.`);
  }
  next.revision = document.revision + 1;
  assertDirector(next);
  return next;
}
