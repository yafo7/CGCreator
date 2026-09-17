import type { CgDiagnostic, CgValidation, DirectorDocument } from './cgTypes';

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,119}$/.test(v);
const vec = (v: unknown, n = 3) => Array.isArray(v) && v.length === n && v.every(finite);
const one = (v: unknown, values: string[]) => typeof v === 'string' && values.includes(v);
export const CG_WORLD_OPERATIONS = ['object.add', 'object.update', 'object.remove', 'terrain.set', 'terrain.brush', 'room.set', 'sun.set', 'reference.set'];

/** Validate intent without coercion, generated defaults, truncation, or mutation. */
export function validateDirectorDocument(value: unknown, options: { allowNoShots?: boolean } = {}): CgValidation {
  const diagnostics: CgDiagnostic[] = [];
  const error = (message: string, nodeId = '', code = 'invalid_document') => diagnostics.push({ severity: 'error', code, message, nodeIds: nodeId ? [nodeId] : [] });
  if (!record(value)) return { valid: false, diagnostics: [{ severity: 'error', code: 'invalid_document', message: 'DirectorDocument must be an object.', nodeIds: [] }] };
  const d = value;
  const keys = (o: Record<string, any>, allowed: string[], label: string) => {
    for (const key of Object.keys(o)) if (!allowed.includes(key)) error(`Unsupported field ${label}.${key}.`, String(o.id ?? ''), 'unsupported_field');
  };
  keys(d, ['schemaVersion', 'id', 'title', 'sourcePrompt', 'revision', 'seed', 'mapId', 'entities', 'anchors', 'shots', 'actions', 'constraints', 'worldPatch'], 'document');
  if (![1, 2].includes(d.schemaVersion) || !id(d.id) || !id(d.mapId)) error('schemaVersion must be 1 or 2; document and map IDs must be stable identifiers.');
  if (typeof d.title !== 'string' || typeof d.sourcePrompt !== 'string') error('title and sourcePrompt must be strings.');
  if (!Number.isSafeInteger(d.revision) || d.revision < 0 || !Number.isSafeInteger(d.seed)) error('revision must be a nonnegative integer and seed a safe integer.');
  const limits: Record<string, number> = { entities: 64, anchors: 256, shots: 128, actions: 512, constraints: 512, worldPatch: 256 };
  for (const [key, limit] of Object.entries(limits)) if (!Array.isArray(d[key]) || d[key].length > limit) error(`${key} must be an array with at most ${limit} entries.`);
  if (diagnostics.length) return { valid: false, diagnostics };
  if ((!d.shots.length && !options.allowNoShots) || !d.entities.length) error('At least one shot and one entity are required.');
  if (d.schemaVersion === 2 && !d.actions.length) error('V2 requires a performance before camera coverage.');
  const seen = new Set<string>();
  for (const key of ['entities', 'anchors', 'shots', 'actions', 'constraints']) {
    for (const item of d[key]) {
      if (!record(item) || !id(item.id)) { error(`Every ${key} item requires a valid ID.`); continue; }
      if (seen.has(item.id)) error(`Duplicate ID ${item.id}; IDs must be unique across all node types.`, item.id, 'duplicate_id');
      seen.add(item.id);
    }
  }
  if (diagnostics.length) return { valid: false, diagnostics };
  const entities = new Map<string, any>(d.entities.map((e: any) => [e.id, e]));
  const anchors = new Map<string, any>(d.anchors.map((e: any) => [e.id, e]));
  const shots = new Map<string, any>(d.shots.map((e: any) => [e.id, e]));
  const actions = new Map<string, any>(d.actions.map((e: any) => [e.id, e]));
  const optionalId = (v: any) => v === undefined || id(v);
  for (const e of d.entities) {
    keys(e, ['id', 'name', 'kind', 'objectId', 'assetId', 'startAnchorId', 'description', 'height'], 'entity');
    if (!one(e.kind, ['actor', 'prop']) || typeof e.name !== 'string') error('Entity kind/name is invalid.', e.id);
    if (!optionalId(e.objectId) || !optionalId(e.assetId) || (!e.objectId && !e.assetId)) error('Entity requires an objectId or assetId.', e.id);
    if (e.startAnchorId !== undefined && !anchors.has(e.startAnchorId)) error('Unknown entity startAnchorId.', e.id, 'missing_reference');
    if (e.height !== undefined && (!finite(e.height) || e.height <= 0 || e.height > 100)) error('Entity height must be in (0,100] metres.', e.id);
  }
  for (const a of d.anchors) {
    keys(a, ['id', 'name', 'kind', 'position', 'quaternion', 'fov', 'space', 'objectId', ...(d.schemaVersion === 2 ? ['binding'] : [])], 'anchor');
    if (a.binding !== undefined) {
      if (!record(a.binding) || a.space !== 'world') error('Invalid spatial anchor binding.', a.id);
      else if (a.binding.kind === 'guide') {
        keys(a.binding, ['kind', 'guideId', 'progress'], 'binding');
        if (!id(a.binding.guideId) || !finite(a.binding.progress) || a.binding.progress < 0 || a.binding.progress > 1) error('Invalid guide binding.', a.id);
      } else if (a.binding.kind === 'seat-approach') {
        keys(a.binding, ['kind', 'objectId', 'nodeId'], 'binding');
        if (!id(a.binding.objectId) || !id(a.binding.nodeId)) error('Invalid seat approach binding.', a.id);
      } else error('Unsupported spatial binding.', a.id);
    }
    if (!one(a.kind, ['point', 'camera']) || typeof a.name !== 'string' || !vec(a.position)) error('Anchor requires a name, kind and finite position.', a.id);
    if (a.space !== undefined && !one(a.space, ['world', 'object'])) error('Anchor space is invalid.', a.id);
    if (a.space === 'object' && !id(a.objectId)) error('Object-space anchor requires objectId.', a.id);
    if (a.quaternion !== undefined && (!vec(a.quaternion, 4) || Math.abs(Math.hypot(...a.quaternion) - 1) > 0.001)) error('Anchor quaternion must have unit length.', a.id);
    if (a.kind === 'camera' && !vec(a.quaternion, 4)) error('Camera anchor requires an exact quaternion.', a.id);
    if (a.fov !== undefined && (!finite(a.fov) || a.fov <= 1 || a.fov >= 160)) error('Camera FOV must be between 1 and 160 degrees.', a.id);
  }
  for (const s of d.shots) {
    keys(s, ['id', 'name', 'purpose', 'duration', 'camera', 'transition', 'subtitle', ...(d.schemaVersion === 2 ? ['behaviorId', 'skillId', 'coveragePurpose', 'autoDuration'] : [])], 'shot');
    if (s.autoDuration !== undefined && (typeof s.autoDuration !== 'boolean' || s.autoDuration && !s.behaviorId)) error('Automatic coverage duration requires a behavior binding.', s.id);
    if (s.behaviorId !== undefined && !actions.has(s.behaviorId)) error('Coverage refers to a missing behavior.', s.id, 'missing_behavior');
    if (s.skillId !== undefined && !id(s.skillId)) error('Camera skill must have a stable ID.', s.id);
    if (s.coveragePurpose !== undefined && !one(s.coveragePurpose, ['geography', 'follow', 'destination', 'emotion', 'dialogue', 'reaction', 'contact'])) error('Unknown coverage purpose.', s.id);
    if (typeof s.name !== 'string' || typeof s.purpose !== 'string' || !finite(s.duration) || s.duration <= 0 || s.duration > 300) error('Shot requires name/purpose and duration in (0,300].', s.id);
    if (!record(s.camera)) { error('Shot requires a camera intent.', s.id); continue; }
    const c = s.camera;
    keys(c, ['movement', 'framing', 'subjectId', 'secondaryId', 'side', 'lensMm', 'distance', 'height', 'azimuth', 'reference', 'view', 'aim', 'screenPosition', ...(d.schemaVersion === 2 ? ['layout', 'aimMode', 'pitch'] : [])], 'camera');
    if (c.layout !== undefined && !one(c.layout, ['solo', 'two-shot', 'over-shoulder'])) error('Unknown camera layout.', s.id);
    if (['two-shot', 'over-shoulder'].includes(c.layout) && (!c.secondaryId || c.secondaryId === c.subjectId)) error('Two-person composition requires distinct subjects.', s.id);
    if (c.aimMode !== undefined && !one(c.aimMode, ['fixed', 'follow'])) error('Unknown camera aim mode.', s.id);
    if (c.pitch !== undefined && (!finite(c.pitch) || Math.abs(c.pitch) > Math.PI / 2 - 0.01)) error('Camera pitch must be within the supported radians range.', s.id);
    if (!one(c.movement, ['static', 'dolly', 'tracking', 'orbit', 'crane']) || !one(c.framing, ['wide', 'medium', 'close-up', 'over-shoulder'])) error('Unsupported camera movement or framing.', s.id, 'unsupported_camera');
    if (!entities.has(c.subjectId) || (c.secondaryId !== undefined && !entities.has(c.secondaryId))) error('Camera references an unknown entity.', s.id, 'missing_reference');
    if (c.framing === 'over-shoulder' && (!c.secondaryId || c.secondaryId === c.subjectId)) error('Over-shoulder needs two distinct entity IDs.', s.id);
    if (c.side !== undefined && !one(c.side, ['left', 'right'])) error('Camera side must be left or right.', s.id);
    if (c.reference !== undefined && !one(c.reference, ['world', 'subject-facing', 'subject-motion', 'interaction-axis'])) error('Camera reference frame is invalid.', s.id);
    if (c.view !== undefined && !one(c.view, ['front', 'front-three-quarter', 'side', 'rear-three-quarter', 'rear'])) error('Camera view is invalid.', s.id);
    if (c.aim !== undefined && !one(c.aim, ['body', 'upper-body', 'face', 'eyes', 'interaction'])) error('Camera aim is invalid.', s.id);
    if (c.reference === 'interaction-axis' && (!c.secondaryId || c.secondaryId === c.subjectId)) error('Interaction-axis camera requires a distinct secondary subject.', s.id);
    if (c.aim === 'interaction' && (!c.secondaryId || c.secondaryId === c.subjectId)) error('Interaction aim requires a distinct secondary subject.', s.id);
    if (c.screenPosition !== undefined && (!vec(c.screenPosition, 2) || c.screenPosition.some((value: number) => Math.abs(value) > 0.45))) error('Camera screenPosition axes must be finite and within [-0.45,0.45].', s.id);
    for (const k of ['lensMm', 'distance', 'height', 'azimuth']) if (c[k] !== undefined && !finite(c[k])) error(`Camera ${k} must be finite.`, s.id);
    if (c.lensMm !== undefined && (c.lensMm < 12 || c.lensMm > 200)) error('lensMm must be within [12,200].', s.id);
    if (c.distance !== undefined && (c.distance <= 0 || c.distance > 500)) error('Camera distance must be within (0,500].', s.id);
    if (c.framing === 'close-up' && c.aim !== undefined && !['face', 'eyes'].includes(c.aim)) error('Close-up framing must aim at face or eyes.', s.id, 'invalid_close_up');
    if (s.transition !== undefined) {
      if (!record(s.transition)) error('Shot transition must be an object.', s.id);
      else {
        keys(s.transition, ['type', 'duration', 'motivation'], 'transition');
        if (!one(s.transition.type, ['cut', 'ease-in-out']) || !one(s.transition.motivation, ['action', 'look', 'reaction', 'reveal', 'reestablish', 'rhythm'])) error('Shot transition type or motivation is invalid.', s.id);
        if (s.transition.type === 'ease-in-out' && (!finite(s.transition.duration) || s.transition.duration <= 0 || s.transition.duration > Math.min(5, s.duration))) error('Ease transition duration must be within the shot and no more than 5 seconds.', s.id);
        if (s.transition.type === 'cut' && s.transition.duration !== undefined) error('Cut transitions cannot have duration.', s.id);
      }
    }
    if (s.subtitle !== undefined && typeof s.subtitle !== 'string') error('Subtitle must be a string.', s.id);
  }
  for (const a of d.actions) {
    keys(a, ['id', 'entityId', 'type', 'start', 'duration', 'targetAnchorId', 'targetEntityId', 'clipId', 'visible', 'effect', 'socketId', 'sourceEntityId', 'arcHeight', ...(d.schemaVersion === 2 ? ['route', 'interaction', 'propEntityId', 'endBehavior', 'purpose'] : [])], 'action');
    if (!entities.has(a.entityId)) error('Action references an unknown entity.', a.id, 'missing_reference');
    if (!one(a.type, ['move', 'face', 'animate', 'visibility', 'effect', 'attach', 'detach', ...(d.schemaVersion === 2 ? ['airborne', 'handoff', 'sit', 'dialogue', 'hold'] : [])])) error('Unknown action type.', a.id, 'unsupported_action');
    if (a.purpose !== undefined && (typeof a.purpose !== 'string' || a.purpose.length > 2000)) error('Behavior purpose must be a bounded string.', a.id);
    if (a.route !== undefined) {
      if (a.type !== 'move' || !record(a.route)) error('Only a move can declare a route.', a.id);
      else {
        keys(a.route, ['guideIds', 'policy', 'locomotion', 'maxSpeed'], 'route');
        if (!Array.isArray(a.route.guideIds) || !a.route.guideIds.length || a.route.guideIds.length > 16 || !a.route.guideIds.every(id) || new Set(a.route.guideIds).size !== a.route.guideIds.length) error('Route requires 1–16 unique guide IDs.', a.id);
        if (!one(a.route.policy, ['required', 'preferred']) || !one(a.route.locomotion, ['walk', 'run'])) error('Invalid route policy or locomotion.', a.id);
        if (a.route.maxSpeed !== undefined && (!finite(a.route.maxSpeed) || a.route.maxSpeed <= 0 || a.route.maxSpeed > 15)) error('Invalid route maximum speed.', a.id);
      }
    }
    if (a.arcHeight !== undefined && (!finite(a.arcHeight) || a.arcHeight <= 0 || a.arcHeight > 100)) error('Airborne arc height must be finite and within (0,100].', a.id);
    if (a.type === 'airborne') {
      if (entities.get(a.entityId)?.kind !== 'actor' || !a.targetAnchorId) error('Airborne action requires an actor and an exact landing anchor.', a.id);
      if (a.route !== undefined) error('Airborne action cannot use a ground navigation route.', a.id);
    } else if (a.arcHeight !== undefined) error('Only airborne actions may declare an arc height.', a.id);
    if (a.type === 'attach') {
      if (entities.get(a.entityId)?.kind !== 'prop' || !entities.has(a.targetEntityId) || !id(a.socketId)) error('Attach requires a prop, a known owner and a named socket.', a.id);
    }
    if (a.type === 'detach' && entities.get(a.entityId)?.kind !== 'prop') error('Detach requires a prop entity.', a.id);
    if (a.type === 'handoff') {
      if (entities.get(a.entityId)?.kind !== 'prop' || !entities.has(a.sourceEntityId) || !entities.has(a.targetEntityId) || a.sourceEntityId === a.targetEntityId || !id(a.socketId)) error('Handoff requires one prop, distinct known source/target actors and a receiving socket.', a.id);
    } else if (a.sourceEntityId !== undefined) error('Only handoff actions may declare sourceEntityId.', a.id);
    if (a.propEntityId !== undefined) {
      if (a.type !== 'animate' || entities.get(a.propEntityId)?.kind !== 'prop') error('propEntityId is supported only on an actor animation and must reference a prop.', a.id);
      if (entities.get(a.entityId)?.kind !== 'actor') error('A prop-informed animation requires an actor entity.', a.id);
    }
    if (a.endBehavior !== undefined && (!['animate', 'sit'].includes(a.type) || !one(a.endBehavior, ['restore', 'hold']))) error('Unsupported end-pose behavior.', a.id);
    if (a.type === 'sit') {
      if (!id(a.clipId) || !record(a.interaction)) error('Sit requires a baked clip and a seat interaction binding.', a.id);
      else {
        keys(a.interaction, ['objectId', 'seatNodeId', 'approachAnchorId'], 'interaction');
        if (!id(a.interaction.objectId) || !id(a.interaction.seatNodeId) || !anchors.has(a.interaction.approachAnchorId)) error('Sit requires exact object/node and approach references.', a.id);
      }
      if (!finite(a.duration) || a.duration <= 0 || a.endBehavior === 'restore') error('Sit needs positive duration and a persistent seated pose.', a.id);
    } else if (a.interaction !== undefined) error('Only sit currently supports an interaction binding.', a.id);
    if (a.type === 'dialogue' && (!entities.has(a.targetEntityId) || a.targetEntityId === a.entityId)) error('Dialogue requires another known participant.', a.id);
    if (!finite(a.duration) || a.duration < 0 || a.duration > 1200 || (['move', 'airborne', 'animate', 'effect', 'handoff'].includes(a.type) && a.duration === 0)) error('Action duration is invalid.', a.id);
    if (!record(a.start)) error('Action start must be a temporal reference.', a.id);
    else {
      keys(a.start, a.start.kind === 'absolute' ? ['kind', 'seconds'] : ['kind', 'id', 'offset'], 'start');
      if (a.start.kind === 'absolute') {
        if (!finite(a.start.seconds) || a.start.seconds < 0) error('Absolute time must be finite and nonnegative.', a.id);
      } else if (one(a.start.kind, ['after', 'with'])) {
        if (!actions.has(a.start.id) && !shots.has(a.start.id)) error('Unknown temporal reference.', a.id, 'missing_reference');
        if (a.start.offset !== undefined && !finite(a.start.offset)) error('Temporal offset must be finite.', a.id);
        if (d.schemaVersion === 2 && shots.has(a.start.id)) error('V2 behavior timing cannot depend on camera shots.', a.id, 'camera_owns_behavior_time');
      } else error('Unknown temporal reference kind.', a.id);
    }
    if (a.targetAnchorId !== undefined && !anchors.has(a.targetAnchorId)) error('Unknown target anchor.', a.id, 'missing_reference');
    if (a.targetEntityId !== undefined && !entities.has(a.targetEntityId)) error('Unknown target entity.', a.id, 'missing_reference');
    if (a.type === 'move' && !a.targetAnchorId && !d.constraints.some((c: any) => c.type === 'action-target' && c.targetId === a.id)) error('Move requires a target anchor.', a.id);
    if (a.type === 'face' && !a.targetAnchorId && !a.targetEntityId) error('Face requires an anchor or entity target.', a.id);
    if (a.type === 'animate' && !id(a.clipId)) error('Animate requires clipId.', a.id);
    if (a.type === 'visibility' && typeof a.visible !== 'boolean') error('Visibility requires a boolean value.', a.id);
    if (a.type === 'effect' && a.effect !== 'spark') error('Only the deterministic spark effect is supported.', a.id, 'unsupported_effect');
  }
  for (const c of d.constraints) {
    keys(c, ['id', 'source', 'strength', 'type', 'targetId', 'anchorId', 'seconds', 'edge', 'scope', 'order'], 'constraint');
    if (c.source !== 'user' || c.strength !== 'hard') error('Constraints must be user-authored hard constraints.', c.id);
    if (!one(c.type, ['entity-position', 'action-target', 'action-route', 'camera-pose', 'camera-path', 'action-time', 'shot-duration'])) error('Unknown constraint type.', c.id);
    const table = c.type === 'entity-position' ? entities : ['camera-pose', 'camera-path', 'shot-duration'].includes(c.type) ? shots : actions;
    if (!table.has(c.targetId)) error('Constraint target is unknown or has the wrong type.', c.id, 'missing_reference');
    if (['entity-position', 'action-target', 'action-route', 'camera-pose', 'camera-path'].includes(c.type)) {
      const anchor = anchors.get(c.anchorId);
      if (!anchor) error('Constraint requires a valid anchor.', c.id, 'missing_reference');
      else if (c.type === 'camera-pose' && anchor.kind !== 'camera') error('Camera-pose requires a camera anchor.', c.id);
    }
    if (['action-time', 'shot-duration'].includes(c.type) && (!finite(c.seconds) || c.seconds < 0 || (c.type === 'shot-duration' && (c.seconds <= 0 || c.seconds > 300)))) error('Constraint time is invalid.', c.id);
    if (c.edge !== undefined && (c.type !== 'action-time' || !one(c.edge, ['start', 'end']))) error('edge is supported only for action-time constraints.', c.id);
    if (c.scope !== undefined && (c.type !== 'entity-position' || !one(c.scope, ['initial', 'throughout']))) error('scope is supported only for entity-position constraints.', c.id);
    if (c.type === 'action-target' && actions.get(c.targetId)?.type !== 'move') error('Action-target constraints require a move action.', c.id);
    if (c.type === 'action-route' && actions.get(c.targetId)?.type !== 'move') error('Action-route constraints require a move action.', c.id);
    if (['action-route', 'camera-path'].includes(c.type) && (!Number.isSafeInteger(c.order) || c.order < 0 || c.order > 1024)) error('Route constraints require an integer order in [0,1024].', c.id);
  }
  for (const op of d.worldPatch) {
    if (!record(op) || !CG_WORLD_OPERATIONS.includes(op.type)) { error('Unsupported WorldPatch operation.', '', 'unsupported_world_operation'); continue; }
    if (op.type === 'object.add' && (!record(op.object) || !id(op.object.id))) error('WorldPatch object.add requires an explicit stable ID.');
    if (['object.update', 'object.remove'].includes(op.type) && !id(op.objectId)) error('WorldPatch object operation requires objectId.');
    if (op.type === 'object.update' && !record(op.patch)) error('WorldPatch object.update requires patch.');
    const transform = op.type === 'object.add' ? op.object?.transform : op.patch?.transform;
    if (transform !== undefined) {
      if (!record(transform)) error('WorldPatch transform must be an object.');
      else for (const [k, v] of Object.entries(transform)) if (!['position', 'rotation', 'scale', 'size'].includes(k) || !vec(v) || (['scale', 'size'].includes(k) && (v as number[]).some((x) => x <= 0))) error('WorldPatch contains an invalid transform.');
    }
    if (op.type === 'terrain.brush' && (!one(op.mode, ['raise', 'lower', 'flatten']) || !vec(op.point) || (op.size !== undefined && (!finite(op.size) || op.size <= 0)) || (op.strength !== undefined && !finite(op.strength)) || (op.targetHeight !== undefined && !finite(op.targetHeight)))) error('Invalid terrain brush.');
    if (op.type === 'terrain.set' && (!record(op.terrain) || !Number.isInteger(op.terrain.resolutionX) || !Number.isInteger(op.terrain.resolutionZ) || op.terrain.resolutionX < 2 || op.terrain.resolutionZ < 2 || op.terrain.resolutionX > 1024 || op.terrain.resolutionZ > 1024 || !Array.isArray(op.terrain.heights) || op.terrain.heights.length !== op.terrain.resolutionX * op.terrain.resolutionZ || !op.terrain.heights.every(finite))) error('Invalid terrain height field.');
    if (['sun.set', 'reference.set'].includes(op.type) && !vec(op.point)) error('WorldPatch point must be finite.');
  }
  return { valid: !diagnostics.some((v) => v.severity === 'error'), diagnostics };
}

export function assertDirector(value: unknown): asserts value is DirectorDocument {
  const result = validateDirectorDocument(value);
  if (!result.valid) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n'));
}

/** Browser/server identical canonical hash; includes exact numeric values. */
export function stableHash(value: unknown): string {
  const canonical = (v: any): string => {
    if (v === undefined) return 'undefined';
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? String(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  };
  const text = canonical(value);
  let a = 2166136261, b = 2246822519;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 3266489917); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
