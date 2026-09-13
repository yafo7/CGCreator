import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { bakeMapCollisions, getObjectWorldTransforms, getMapAssetLocalBounds, sampleTerrainHeight, type EditableMap, type MapObjectAabb } from './map';
import { applyMapOperations } from './mapOperations';
import type { RenderScheme } from './renderScheme';
import type { CgAction, CgAnchor, CgCameraPose, CgCompiledAction, CgCompiledShot, CgConstraint, CgEntityState, CgFrame, CgPatchOperation, CgQuat, CgResources, CgVec3, CompiledCG, DirectorDocument } from './cgTypes';
import { assertDirector, stableHash, validateDirectorDocument } from './cgValidation';
import { distance, findGroundPath, freeGroundPoint, mix, samplePath } from './cgPath';

export { stableHash, validateDirectorDocument } from './cgValidation';
export const CG_COMPILER_VERSION = 'cgcreator-1.0.0';
const clone = <T>(value: T): T => structuredClone(value);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const quat = (rotation: CgVec3): CgQuat => new Quaternion().setFromEuler(new Euler(...rotation)).toArray() as CgQuat;
const yaw = (direction: CgVec3): CgQuat => quat([0, Math.atan2(direction[0], direction[2]), 0]);
const progress = (a: CgCompiledAction, t: number) => a.end > a.start ? clamp01((t - a.start) / (a.end - a.start)) : 1;

function resolveAnchor(anchor: CgAnchor, map: EditableMap): CgAnchor {
  if (anchor.space !== 'object') return clone(anchor);
  const transform = getObjectWorldTransforms(map).get(anchor.objectId!);
  if (!transform) throw new Error(`Object-space anchor ${anchor.id} references missing object ${anchor.objectId}.`);
  const rotation = new Quaternion().fromArray(quat(transform.rotation));
  const position = new Vector3(...anchor.position).multiply(new Vector3(...transform.scale)).applyQuaternion(rotation).add(new Vector3(...transform.position)).toArray() as CgVec3;
  return { ...clone(anchor), position, quaternion: anchor.quaternion ? rotation.multiply(new Quaternion().fromArray(anchor.quaternion)).toArray() as CgQuat : undefined, space: 'world' };
}

/** Compile a frozen snapshot. No IO, wall clock, random IDs, or mutation of caller data. */
export function compileDirector(document: DirectorDocument, map: EditableMap, scheme: RenderScheme | null = null, resources: CgResources = { models: [], clips: [] }, previous?: CompiledCG): CompiledCG {
  const inputHash = stableHash({ version: CG_COMPILER_VERSION, document, map, scheme, resources });
  const validation = validateDirectorDocument(document);
  const bundle: CompiledCG = {
    schemaVersion: 1, compilerVersion: CG_COMPILER_VERSION, id: `compile-${inputHash}`, inputHash,
    documentRevision: document.revision, document: clone(document), map: clone(map), scheme: clone(scheme), resources: clone(resources),
    duration: 0, bindings: [], initial: {}, shots: [], actions: [], dependencies: {}, changedNodeIds: [], validation
  };
  const diagnostic = (code: string, message: string, nodeIds: string[] = [], severity: 'error' | 'warning' = 'error') => {
    if (!validation.diagnostics.some((d) => d.code === code && stableHash(d.nodeIds) === stableHash(nodeIds))) validation.diagnostics.push({ severity, code, message, nodeIds });
  };
  const finish = () => {
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
    bundle.bindings.push({ entityId: entity.id, objectId: object.id, assetId, height });
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
    && !document.actions.some((a) => a.entityId === e.id && ['move', 'face', 'animate', 'visibility'].includes(a.type)))
    .map((e) => bundle.bindings.find((b) => b.entityId === e.id)!.objectId));
  collisionMap.objects = collisionMap.objects.filter((o) => !boundObjects.has(o.id) || staticProps.has(o.id));
  delete collisionMap.collisionBake;
  let boxes: MapObjectAabb[];
  try { boxes = bakeMapCollisions(collisionMap).boxes; }
  catch (error) { diagnostic('collision_bake_failed', String(error)); return finish(); }
  let shotStart = 0;
  for (const shot of document.shots) {
    const lockedDuration = single(constraints('shot-duration', shot.id), (c) => c.seconds);
    const duration = lockedDuration?.seconds ?? shot.duration;
    const hard = positionConstraint('camera-pose', shot.id), anchor = hard ? anchors.get(hard.anchorId!) : undefined;
    const compiled: CgCompiledShot = { id: shot.id, start: shotStart, end: shotStart + duration, camera: clone(shot.camera), inputHash: '' };
    if (anchor?.quaternion) compiled.lockedPose = { position: [...anchor.position], quaternion: [...anchor.quaternion], fov: anchor.fov ?? 45 };
    bundle.shots.push(compiled); shotStart += duration;
    bundle.dependencies[shot.id] = [shot.camera.subjectId, ...(shot.camera.secondaryId ? [shot.camera.secondaryId] : []), ...(hard ? [hard.id, hard.anchorId!] : []), ...(lockedDuration ? [lockedDuration.id] : [])];
  }
  bundle.duration = shotStart;
  if (bundle.duration > 1200) diagnostic('timeline_too_long', 'V1 timelines are limited to 1200 seconds.');
  const timings = new Map<string, { start: number; end: number }>(bundle.shots.map((s) => [s.id, s]));
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
  for (const action of sortedActions) {
    const interval = timings.get(action.id)!;
    const compiled: CgCompiledAction = { ...clone(action), ...interval, duration: interval.end - interval.start, inputHash: '' };
    const binding = bundle.bindings.find((b) => b.entityId === action.entityId)!;
    const prior = bundle.actions.filter((a) => a.entityId === action.entityId);
    const channel = (a: { type: CgAction['type'] }) => a.type === 'move' || a.type === 'face' ? 'root' : a.type;
    const overlap = prior.find((a) => channel(a) === channel(action) && a.start < interval.end - 1e-6 && a.end > interval.start + 1e-6);
    if (overlap) diagnostic('action_channel_overlap', `Actions ${overlap.id} and ${action.id} compete for the same entity channel.`, [overlap.id, action.id]);
    const dependencies = [action.entityId, ...(action.start.kind !== 'absolute' ? [action.start.id] : []), ...constraints('action-time', action.id).map((c) => c.id)];
    const state = sampleEntities(bundle, interval.start)[action.entityId];
    if (action.type === 'move') {
      const hard = positionConstraint('action-target', action.id);
      const target = anchors.get(hard?.anchorId ?? action.targetAnchorId ?? '');
      if (!target) diagnostic('missing_target', 'Move target anchor cannot be resolved.', [action.id]);
      else {
        const fixed = constraints('entity-position', action.entityId).find((c) => c.scope === 'throughout');
        if (fixed && distance(state.position, target.position) > 1e-6) diagnostic('fixed_entity_moves', 'This movement conflicts with a throughout entity-position lock.', [action.id, fixed.id]);
        const radius = Math.max(0.12, Math.min(0.6, binding.height * 0.19));
        const path = findGroundPath(collisionMap, boxes, state.position, target.position, radius, binding.height);
        if (!path) diagnostic('unreachable_target', 'No ground path reaches the exact target within map bounds, terrain and collision constraints.', [action.id, target.id]);
        else compiled.path = path;
        compiled.from = [...state.position]; compiled.to = [...target.position];
        dependencies.push(target.id, ...(hard ? [hard.id] : []), ...prior.filter((a) => a.type === 'move').map((a) => a.id));
      }
    } else if (action.type === 'face') {
      const target = action.targetAnchorId ? anchors.get(action.targetAnchorId)?.position : sampleEntities(bundle, interval.start)[action.targetEntityId!]?.position;
      if (!target) diagnostic('missing_target', 'Facing target cannot be resolved.', [action.id]);
      else { compiled.from = new Euler().setFromQuaternion(new Quaternion().fromArray(state.quaternion)).toArray().slice(0, 3) as CgVec3; compiled.to = [target[0] - state.position[0], 0, target[2] - state.position[2]]; }
      dependencies.push(action.targetAnchorId ?? action.targetEntityId!, ...prior.filter((a) => a.type === 'move' || a.type === 'face').map((a) => a.id));
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
        dependencies.push(clip.id);
      }
    }
    bundle.dependencies[action.id] = [...new Set(dependencies)];
    // Hash only resolved dependencies: changing an unrelated lens does not rebake movement.
    compiled.inputHash = stableHash({ action: compiled, initial: bundle.initial[action.entityId], binding, target: compiled.to,
      clip: action.clipId ? clips.get(action.clipId) : undefined, world: action.type === 'move' ? { boxes, terrain: collisionMap.terrain, box: collisionMap.box, layout: collisionMap.layout } : undefined,
      prior: prior.filter((a) => dependencies.includes(a.id)).map((a) => a.inputHash) });
    bundle.actions.push(compiled);
  }
  for (const entity of document.entities) {
    if (entity.kind !== 'actor') continue;
    const binding = bundle.bindings.find((b) => b.entityId === entity.id)!;
    if (!freeGroundPoint(collisionMap, boxes, bundle.initial[entity.id].position, Math.max(0.12, Math.min(0.6, binding.height * 0.19)), binding.height)) diagnostic('invalid_actor_start', 'Actor start position intersects map geometry, terrain or map bounds.', [entity.id]);
  }
  // Resolve automatic camera parameters against the frozen world; manual poses stay exact.
  for (const shot of bundle.shots) {
    if (!shot.lockedPose) {
      const original = clone(shot.camera);
      let best = original, bestScore = -Infinity;
      for (const offset of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI * 3 / 4, -Math.PI * 3 / 4]) {
        shot.camera = { ...original, azimuth: (original.azimuth ?? Math.PI / 5) + offset };
        const score = cameraScore(bundle, shot, boxes);
        if (score > bestScore) { best = clone(shot.camera); bestScore = score; }
        if (score === 3) break;
      }
      shot.camera = best;
      if (bestScore < 3) diagnostic('camera_obstructed', 'Automatic camera could not keep a clear view throughout this shot; adjust staging or set an exact camera pose.', [shot.id]);
    } else if (cameraScore(bundle, shot, boxes, true) < 3) diagnostic('locked_camera_collision', 'The exact camera pose intersects the terrain or map geometry.', [shot.id]);
    // Future actions cannot change the evaluated state in this shot. Excluding
    // them keeps an edit to a later beat from invalidating earlier cameras.
    const deps = bundle.actions.filter((a) => a.start < shot.end && [shot.camera.subjectId, shot.camera.secondaryId].includes(a.entityId));
    bundle.dependencies[shot.id].push(...deps.map((a) => a.id));
    shot.inputHash = stableHash({ shot: { ...shot, inputHash: undefined }, subjects: [bundle.initial[shot.camera.subjectId], shot.camera.secondaryId ? bundle.initial[shot.camera.secondaryId] : undefined], bindings: bundle.bindings.filter((b) => [shot.camera.subjectId, shot.camera.secondaryId].includes(b.entityId)), actions: deps.map((a) => a.inputHash), world: boxes, terrain: bundle.map.terrain });
  }
  return finish();
}

/** Sample channels from their initial state every time; seeks never replay mutable events. */
function sampleEntities(bundle: CompiledCG, time: number): Record<string, CgEntityState> {
  const entities = clone(bundle.initial);
  for (const action of bundle.actions) {
    if (time < action.start) continue;
    const state = entities[action.entityId]; if (!state) continue;
    if (action.type === 'move' && action.path) {
      const sampled = samplePath(action.path, progress(action, time)); state.position = sampled.position;
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

function sampleCamera(bundle: CompiledCG, shot: CgCompiledShot, time: number, current?: Record<string, CgEntityState>): CgCameraPose {
  if (shot.lockedPose) return clone(shot.lockedPose);
  const intent = shot.camera, start = sampleEntities(bundle, shot.start);
  const sampled = current ?? sampleEntities(bundle, time);
  const subjects = intent.movement === 'static' || intent.movement === 'dolly' ? start : sampled;
  const subject = subjects[intent.subjectId];
  const height = bundle.bindings.find((b) => b.entityId === intent.subjectId)?.height ?? 1.8;
  if (!subject) return lookAt([0, 3, 6], [0, 0, 0], 45);
  const target: CgVec3 = [subject.position[0], subject.position[1] + height * (intent.framing === 'close-up' ? 0.85 : 0.65), subject.position[2]];
  const fov = 2 * Math.atan(24 / (2 * (intent.lensMm ?? (intent.framing === 'close-up' ? 70 : 40)))) * 180 / Math.PI;
  const extent = height * (intent.framing === 'wide' ? 1.8 : intent.framing === 'close-up' ? 0.33 : 0.85);
  let range = intent.distance ?? extent / (2 * Math.tan(fov * Math.PI / 360));
  const t = clamp01((time - shot.start) / (shot.end - shot.start));
  if (intent.movement === 'dolly') range *= 1.25 - 0.45 * t;
  let angle = (intent.azimuth ?? Math.PI / 5) + (intent.movement === 'orbit' ? (t - 0.5) * Math.PI / 2 : 0);
  if (intent.framing === 'over-shoulder' && intent.secondaryId) {
    const secondary = subjects[intent.secondaryId];
    if (secondary) {
      const dx = secondary.position[0] - subject.position[0], dz = secondary.position[2] - subject.position[2];
      const length = Math.hypot(dx, dz) || 1;
      const ux = dx / length, uz = dz / length, side = intent.side === 'left' ? -1 : 1;
      const shoulderHeight = bundle.bindings.find((b) => b.entityId === intent.secondaryId)?.height ?? height;
      return lookAt([secondary.position[0] + ux * range * 0.35 + uz * side * shoulderHeight * 0.35, secondary.position[1] + (intent.height ?? shoulderHeight * 0.87), secondary.position[2] + uz * range * 0.35 - ux * side * shoulderHeight * 0.35], target, fov);
    }
  }
  if (intent.side === 'left') angle = -angle;
  return lookAt([target[0] + Math.sin(angle) * range, subject.position[1] + (intent.height ?? height * 0.92), target[2] + Math.cos(angle) * range], target, fov);
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
  let score = 0;
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
    if (!poseOnly && pose.target && boxes.some((b) => b.objectId !== subjectObject && lineIntersectsBox(pose.position, pose.target!, b))) continue;
    score++;
  }
  return score / count * 3;
}

export function evaluateCG(bundle: CompiledCG, time: number): CgFrame {
  const t = Math.max(0, Math.min(bundle.duration, Number.isFinite(time) ? time : 0));
  const entities = sampleEntities(bundle, t);
  const shot = bundle.shots.find((s) => t >= s.start && t < s.end) ?? bundle.shots[bundle.shots.length - 1];
  const camera = shot ? sampleCamera(bundle, shot, t, entities) : lookAt([0, 3, 6], [0, 0, 0], 45);
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
      if (source === 'ai' && operation.patch?.camera && document.constraints.some((c) => c.type === 'camera-pose' && c.targetId === shot.id)
        && stableHash({ ...shot.camera, ...operation.patch.camera }) !== stableHash(shot.camera)) throw new Error('AI camera patch conflicts with a hard camera-pose constraint. Remove the manual camera lock before changing the camera intent.');
      Object.assign(shot, operation.patch, { id: shot.id, camera: { ...shot.camera, ...operation.patch.camera } });
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
