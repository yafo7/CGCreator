import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, sampleTerrainHeight, type MapAsset } from '../src/shared/map';
import { buildModelColliderPlan } from '../src/shared/modelBounds';
import { applyDirectorPatch, compileDirector, evaluateCG, stableHash, validateDirectorDocument } from '../src/shared/cgCompiler';
import { freeGroundPoint, sampleSmoothPath } from '../src/shared/cgPath';
import type { CgResources, DirectorDocument } from '../src/shared/cgTypes';
import { inspectCgView } from '../src/shared/cgViewSemantics';

function fixture() {
  const map = createEmptyMap('CG test', 'map-test', [20, 10, 20]);
  map.createdAt = 1; map.updatedAt = 1; map.seed = 42;
  const modelJson = { version: '1.0', nodes: [{ id: 'body', transform: { pos: [0, 0.9, 0], scale: [1, 1, 1] }, mesh: { type: 'box', params: { width: 0.5, height: 1.8, depth: 0.5 } } }] };
  const asset: MapAsset = { id: 'actor-model', name: 'Actor', prompt: 'Actor', modelJson, colliderPlan: buildModelColliderPlan(modelJson), mode: 'voxel', createdAt: 1, updatedAt: 1 };
  map.assets = [asset];
  const object = createMapObject('Actor', asset.id); object.id = 'map-actor'; object.transform.position = [-3, 0, 0]; map.objects = [object];
  const document: DirectorDocument = {
    schemaVersion: 1, id: 'director-test', title: 'A visitor arrives', sourcePrompt: 'Follow the visitor.', revision: 0, seed: 42, mapId: map.id,
    entities: [{ id: 'hero', name: 'Visitor', kind: 'actor', objectId: object.id, height: 1.8 }],
    anchors: [{ id: 'destination', name: 'Door', kind: 'point', position: [3, 0, 0] }],
    shots: [{ id: 'shot-one', name: 'Arrival', purpose: 'Follow', duration: 5, camera: { movement: 'tracking', framing: 'wide', subjectId: 'hero' } }, { id: 'shot-two', name: 'Reaction', purpose: 'Read the expression', duration: 3, camera: { movement: 'static', framing: 'close-up', subjectId: 'hero' } }],
    actions: [{ id: 'walk', entityId: 'hero', type: 'move', start: { kind: 'absolute', seconds: 0 }, duration: 4, targetAnchorId: 'destination' }], constraints: [], worldPatch: []
  };
  const resources: CgResources = { models: [], clips: [] };
  return { document, map, asset, resources };
}

describe('CG deterministic compiler', () => {
  it('keeps a stationary bound prop in the ground path obstacle set', () => {
    const { document, map } = fixture();
    const wall = createMapObject('Bound obstacle');
    wall.id = 'bound-obstacle'; wall.transform.size = [1.5, 2, 2.5];
    map.objects.push(wall);
    document.entities.push({ id: 'obstacle-prop', name: 'Obstacle', kind: 'prop', objectId: wall.id });
    const result = compileDirector(document, map);
    expect(result.actions.find((a) => a.id === 'walk')?.path?.some((p) => Math.abs(p[2]) > 1.25)).toBe(true);
    expect(evaluateCG(result, 4).entities.hero.position).toEqual([3, 0, 0]);
  });
  it('compiles frozen map snapshots and samples an exact endpoint independent of seek order', () => {
    const { document, map } = fixture();
    const before = structuredClone(map);
    const a = compileDirector(document, map), b = compileDirector(document, map);
    expect(a.validation).toEqual({ valid: true, diagnostics: [] });
    expect(a).toEqual(b); expect(map).toEqual(before);
    const middle = evaluateCG(a, 2); evaluateCG(a, 7); evaluateCG(a, 0.25);
    expect(evaluateCG(a, 2)).toEqual(middle);
    expect(middle.entities.hero.position[0]).toBeCloseTo(0, 8);
    expect(evaluateCG(a, 4).entities.hero.position).toEqual([3, 0, 0]);
    expect(evaluateCG(a, 8).entities.hero.position).toEqual([3, 0, 0]);
    expect(evaluateCG(a, 5).shotId).toBe('shot-two');
    expect(a.map.objects[0].behavior?.animation?.state).toBe('cg-owned');
  });

  it('keeps rear and side tracking views relative to the actor motion', () => {
    const { document, map } = fixture();
    document.shots[0].camera = { movement: 'tracking', framing: 'wide', subjectId: 'hero', reference: 'subject-motion', view: 'rear-three-quarter', aim: 'body', side: 'right' };
    const rear = compileDirector(document, map);
    const rearFrame = evaluateCG(rear, 2);
    expect(rearFrame.camera.position[0]).toBeLessThan(rearFrame.entities.hero.position[0]);

    document.shots[0].camera.view = 'side';
    const side = compileDirector(document, map);
    const sideFrame = evaluateCG(side, 2);
    const alongMotion = sideFrame.camera.position[0] - sideFrame.entities.hero.position[0];
    const lateral = sideFrame.camera.position[2] - sideFrame.entities.hero.position[2];
    expect(Math.abs(alongMotion)).toBeLessThan(Math.abs(lateral));
  });

  it('builds an AI-readable world hierarchy and reports mechanical view semantics', () => {
    const { document, map } = fixture();
    map.assets![0].tags = ['character', 'visitor'];
    map.visualSemantics.zones.push({ id: 'garden', tags: ['grass'], center: [0, 0], radius: 6, intensity: 1 });
    map.waterBodies.push({ id: 'pond', name: 'Pond', type: 'lake', level: 0, depth: 1, width: 3, points: [[-2, -2], [2, -2], [2, 2], [-2, 2]] });
    const result = compileDirector(document, map);
    expect(result.semanticIndex.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'object:map-actor', kind: 'object', tags: expect.arrayContaining(['character']) }),
      expect.objectContaining({ id: 'object:map-actor/node:body', kind: 'model-part', parentId: 'object:map-actor' }),
      expect.objectContaining({ id: 'zone:garden', kind: 'zone', tags: ['grass'] }),
      expect.objectContaining({ id: 'water:pond', kind: 'water' })
    ]));
    const observation = inspectCgView(result, 2, 16 / 9);
    expect(observation.shotId).toBe('shot-one');
    expect(observation.items.find((item) => item.objectId === 'map-actor')).toMatchObject({
      entityId: 'hero', screenRegion: expect.stringMatching(/left|center|right/)
    });
    expect(observation.items.find((item) => item.objectId === 'map-actor')!.coverage).toBeGreaterThan(0);
  });

  it('routes actors through ordered hard points and lets a camera path override automatic travel positions', () => {
    const { document, map } = fixture();
    document.anchors.push(
      { id: 'route-via', name: 'Around pond', kind: 'point', position: [0, 0, 3] },
      { id: 'camera-a', name: 'Camera A', kind: 'point', position: [-4, 3, 6] },
      { id: 'camera-b', name: 'Camera B', kind: 'point', position: [0, 3, 6] },
      { id: 'camera-c', name: 'Camera C', kind: 'point', position: [4, 3, 6] }
    );
    document.constraints.push(
      { id: 'via-lock', source: 'user', strength: 'hard', type: 'action-route', targetId: 'walk', anchorId: 'route-via', order: 0 },
      { id: 'camera-path-a', source: 'user', strength: 'hard', type: 'camera-path', targetId: 'shot-one', anchorId: 'camera-a', order: 0 },
      { id: 'camera-path-b', source: 'user', strength: 'hard', type: 'camera-path', targetId: 'shot-one', anchorId: 'camera-b', order: 1 },
      { id: 'camera-path-c', source: 'user', strength: 'hard', type: 'camera-path', targetId: 'shot-one', anchorId: 'camera-c', order: 2 }
    );
    const result = compileDirector(document, map);
    expect(result.validation.valid).toBe(true);
    expect(result.actions.find((action) => action.id === 'walk')?.path).toContainEqual([0, 0, 3]);
    expect(result.shots[0].path).toEqual([[-4, 3, 6], [0, 3, 6], [4, 3, 6]]);
    expect(result.shots[0].pathControlIds).toEqual(['camera-a', 'camera-b', 'camera-c']);
    expect(result.shots[0].pathInterpolation).toBe('smooth');
    expect(evaluateCG(result, 2.5).camera.position).toEqual([0, 3, 6]);
  });

  it('moves through authored camera controls with continuous, distance-based curve sampling', () => {
    const path: Array<[number, number, number]> = [[-5, 2, 4], [0, 7, 1], [8, 3, 5]];
    expect(sampleSmoothPath(path, 0).position).toEqual(path[0]);
    expect(sampleSmoothPath(path, 1).position).toEqual(path[2]);
    const before = sampleSmoothPath(path, 0.49).direction;
    const after = sampleSmoothPath(path, 0.51).direction;
    const dot = before[0] * after[0] + before[1] * after[1] + before[2] * after[2];
    expect(dot).toBeGreaterThan(0);
    expect(sampleSmoothPath(path, 0.5).position[1]).toBeGreaterThan(6.5);
    expect(sampleSmoothPath(path, 0.5)).toEqual(sampleSmoothPath(path, 0.5));
  });

  it('uses named eye landmarks and a portrait lens for semantic close-ups', () => {
    const { document, map } = fixture();
    const modelJson = { version: '1.0', nodes: [
      { id: 'torso', transform: { pos: [0, 0.7, 0] }, mesh: { type: 'box', params: { width: 0.6, height: 1.4, depth: 0.4 } } },
      { id: 'head', transform: { pos: [0, 1.55, 0] }, mesh: { type: 'box', params: { width: 0.42, height: 0.42, depth: 0.42 } } }
    ] };
    map.assets![0] = { ...map.assets![0], modelJson, colliderPlan: buildModelColliderPlan(modelJson) };
    document.shots[1].camera = { movement: 'static', framing: 'close-up', subjectId: 'hero', reference: 'subject-facing', view: 'front-three-quarter', aim: 'eyes', lensMm: 85 };
    const result = compileDirector(document, map);
    const frame = evaluateCG(result, 5);
    expect(result.bindings[0].focus?.source).toBe('named-head');
    expect(frame.camera.target?.[1]).toBeGreaterThan(1.5);
    expect(frame.camera.fov).toBeLessThan(20);
    expect(result.validation.diagnostics.some((item) => item.code === 'face_landmark_fallback')).toBe(false);
  });

  it('blends only an explicitly eased shot handoff and diagnoses weak cuts', () => {
    const { document, map } = fixture();
    document.shots[0].camera = { movement: 'tracking', framing: 'medium', subjectId: 'hero', reference: 'subject-motion', view: 'side', aim: 'upper-body' };
    document.shots[1].camera = { movement: 'static', framing: 'medium', subjectId: 'hero', reference: 'subject-facing', view: 'side', aim: 'upper-body' };
    let result = compileDirector(document, map);
    expect(result.validation.diagnostics.some((item) => item.code === 'jump_cut_risk')).toBe(true);
    const cutPose = evaluateCG(result, 5).camera;

    document.shots[1].transition = { type: 'ease-in-out', duration: 1, motivation: 'reaction' };
    document.shots[1].camera.view = 'front';
    result = compileDirector(document, map);
    const easedStart = evaluateCG(result, 5).camera;
    const previousEnd = evaluateCG(result, 4.999999).camera;
    expect(easedStart.position).toEqual(previousEnd.position);
    expect(evaluateCG(result, 5.5).camera.position).not.toEqual(cutPose.position);
    expect(evaluateCG(result, 5.5)).toEqual(evaluateCG(result, 5.5));
  });

  it('rejects close-ups aimed at the body and invalid interaction axes', () => {
    const { document } = fixture();
    document.shots[1].camera.aim = 'body';
    document.shots[1].camera.reference = 'interaction-axis';
    const validation = validateDirectorDocument(document);
    expect(validation.diagnostics.some((item) => item.code === 'invalid_close_up')).toBe(true);
    expect(validation.diagnostics.some((item) => item.message.includes('distinct secondary'))).toBe(true);
  });

  it('routes around collision geometry and reaches the exact anchor', () => {
    const { document, map } = fixture();
    const wall = createMapObject('Obstacle'); wall.id = 'obstacle'; wall.transform.position = [0, 0, 0]; wall.transform.size = [1.5, 2, 2.5]; map.objects.push(wall);
    const result = compileDirector(document, map);
    expect(result.validation.diagnostics.filter((d) => d.code === 'unreachable_target')).toEqual([]);
    const path = result.actions[0].path!;
    expect(path.length).toBeGreaterThan(2);
    expect(Math.max(...path.map((p) => Math.abs(p[2])))).toBeGreaterThan(1);
    expect(path[0]).toEqual([-3, 0, 0]); expect(path[path.length - 1]).toEqual([3, 0, 0]);
    const obstacle = { objectId: 'obstacle', min: [-0.75, 0, -1.25] as [number, number, number], max: [0.75, 2, 1.25] as [number, number, number] };
    for (let t = 0; t <= 4; t += 0.01) expect(freeGroundPoint(map, [obstacle], evaluateCG(result, t).entities.hero.position, 0.3, 1.8)).toBe(true);
  });

  it('scales newly bound models to their requested physical height', () => {
    const { document, map, asset } = fixture();
    map.objects = [];
    document.entities[0] = { id: 'hero', name: 'Small visitor', kind: 'actor', assetId: asset.id, height: 0.9 };
    const result = compileDirector(document, map);
    expect(result.validation.valid).toBe(true);
    expect(result.initial.hero.scale).toEqual([0.5, 0.5, 0.5]);
    expect(result.bindings[0].height).toBeCloseTo(0.9);
    expect(result.map.objects[0].transform.scale).toEqual(result.initial.hero.scale);
  });

  it('preserves existing map object scale and size instead of resizing its visual root', () => {
    const { document, map } = fixture();
    map.objects[0].transform.scale = [0.5, 2, 0.75];
    map.objects[0].transform.size = [2, 3, 4];
    document.entities[0].height = 0.9;
    const result = compileDirector(document, map);
    expect(result.initial.hero.scale).toEqual([1, 6, 3]);
    expect(result.map.objects[0].transform.size).toEqual([1, 1, 1]);
    expect(result.bindings[0].height).toBeCloseTo(10.8);
    expect(map.objects[0].transform.size).toEqual([2, 3, 4]);
  });

  it('rejects unreachable hard targets without silently moving the anchor', () => {
    const { document, map } = fixture();
    document.anchors[0].position = [100, 0, 0];
    document.constraints.push({ id: 'lock-target', source: 'user', strength: 'hard', type: 'action-target', targetId: 'walk', anchorId: 'destination' });
    const result = compileDirector(document, map);
    expect(result.validation.valid).toBe(false);
    expect(result.validation.diagnostics.some((d) => d.code === 'unreachable_target')).toBe(true);
    expect(result.document.anchors[0].position).toEqual([100, 0, 0]);
    expect(result.actions[0].to).toEqual([100, 0, 0]);
  });

  it('follows terrain along the entire path', () => {
    const { document, map } = fixture();
    for (let z = 0; z < map.terrain.resolutionZ; z++) for (let x = 0; x < map.terrain.resolutionX; x++) map.terrain.heights[z * map.terrain.resolutionX + x] = (x / (map.terrain.resolutionX - 1)) * 2;
    map.objects[0].transform.position[1] = sampleTerrainHeight(map, -3, 0);
    document.anchors[0].position[1] = sampleTerrainHeight(map, 3, 0);
    const result = compileDirector(document, map);
    expect(result.validation.valid).toBe(true);
    for (const p of result.actions[0].path!) expect(p[1]).toBeCloseTo(sampleTerrainHeight(map, p[0], p[2]), 8);
  });

  it('resolves action/shot time references and detects temporal cycles', () => {
    const { document, map } = fixture();
    document.actions.push({ id: 'hide', entityId: 'hero', type: 'visibility', visible: false, start: { kind: 'after', id: 'walk', offset: 0.5 }, duration: 0 });
    const result = compileDirector(document, map);
    expect(result.actions.find((a) => a.id === 'hide')?.start).toBe(4.5);
    expect(evaluateCG(result, 6).entities.hero.visible).toBe(false);
    expect(evaluateCG(result, 1).entities.hero.visible).toBe(true);
    document.actions[0].start = { kind: 'after', id: 'hide' };
    expect(compileDirector(document, map).validation.diagnostics.some((d) => d.code === 'temporal_cycle')).toBe(true);
  });

  it('applies user time, point and camera locks ahead of automatic intent', () => {
    const { document, map } = fixture();
    document.anchors.push({ id: 'manual-camera', name: 'Camera', kind: 'camera', position: [-3, 2, 5], quaternion: [0, 0, 0, 1], fov: 37 });
    document.constraints.push(
      { id: 'camera-lock', source: 'user', strength: 'hard', type: 'camera-pose', targetId: 'shot-one', anchorId: 'manual-camera' },
      { id: 'start-lock', source: 'user', strength: 'hard', type: 'action-time', targetId: 'walk', seconds: 1 },
      { id: 'end-lock', source: 'user', strength: 'hard', type: 'action-time', targetId: 'walk', edge: 'end', seconds: 4 },
      { id: 'duration-lock', source: 'user', strength: 'hard', type: 'shot-duration', targetId: 'shot-one', seconds: 6 }
    );
    const result = compileDirector(document, map);
    expect(result.validation.valid).toBe(true);
    expect(result.actions[0]).toMatchObject({ start: 1, end: 4, duration: 3 });
    expect(result.shots[0].end).toBe(6);
    for (const t of [0, 1, 3, 5.9]) expect(evaluateCG(result, t).camera).toEqual({ position: [-3, 2, 5], quaternion: [0, 0, 0, 1], fov: 37 });
  });

  it('reports conflicting hard constraints and throughout movement conflicts', () => {
    const { document, map } = fixture();
    document.anchors.push({ id: 'start-point', name: 'Initial', kind: 'point', position: [-3, 0, 0] });
    document.constraints.push({ id: 'fixed-actor', source: 'user', strength: 'hard', type: 'entity-position', targetId: 'hero', anchorId: 'start-point', scope: 'throughout' });
    expect(compileDirector(document, map).validation.diagnostics.some((d) => d.code === 'fixed_entity_moves')).toBe(true);
    document.constraints.push({ id: 'another-position', source: 'user', strength: 'hard', type: 'entity-position', targetId: 'hero', anchorId: 'destination' });
    expect(compileDirector(document, map).validation.diagnostics.some((d) => d.code === 'conflicting_hard_constraints')).toBe(true);
  });

  it('refines a single shot while preserving unrelated action and shot hashes', () => {
    const { document, map } = fixture();
    const before = compileDirector(document, map);
    const next = applyDirectorPatch(document, [{ type: 'shot.update', id: 'shot-two', patch: { camera: { lensMm: 90 } } }], 'ai');
    const after = compileDirector(next, map, null, undefined, before);
    expect(next.revision).toBe(1); expect(document.revision).toBe(0);
    expect(after.actions[0].inputHash).toBe(before.actions[0].inputHash);
    expect(after.shots[0].inputHash).toBe(before.shots[0].inputHash);
    expect(after.changedNodeIds).toEqual(['shot-two']);
    expect(after.inputHash).not.toBe(before.inputHash);
  });

  it('protects manual anchors and timing from AI patches atomically', () => {
    const { document } = fixture();
    document.constraints.push({ id: 'target-lock', source: 'user', strength: 'hard', type: 'action-target', targetId: 'walk', anchorId: 'destination' });
    const before = structuredClone(document);
    expect(() => applyDirectorPatch(document, [{ type: 'shot.update', id: 'shot-one', patch: { duration: 6 } }, { type: 'anchor.upsert', anchor: { ...document.anchors[0], position: [9, 0, 0] } }], 'ai')).toThrow(/cannot modify/);
    expect(document).toEqual(before);
    expect(() => applyDirectorPatch(document, [{ type: 'constraint.remove', id: 'target-lock' }], 'ai')).toThrow();
    expect(applyDirectorPatch(document, [{ type: 'constraint.remove', id: 'target-lock' }]).constraints).toEqual([]);
  });

  it('rejects a camera intent refine that would be hidden by a manual camera lock', () => {
    const { document } = fixture();
    document.anchors.push({ id: 'camera-anchor', name: 'Exact camera', kind: 'camera', position: [0, 2, 5], quaternion: [0, 0, 0, 1] });
    document.constraints.push({ id: 'camera-lock', source: 'user', strength: 'hard', type: 'camera-pose', targetId: 'shot-one', anchorId: 'camera-anchor' });
    const before = structuredClone(document);
    expect(() => applyDirectorPatch(document, [{ type: 'shot.update', id: 'shot-one', patch: { camera: { framing: 'close-up' } } }], 'ai')).toThrow(/camera-pose constraint/);
    expect(document).toEqual(before);
    expect(applyDirectorPatch(document, [{ type: 'shot.update', id: 'shot-one', patch: { duration: 6 } }], 'ai').shots[0].duration).toBe(6);
  });

  it('invalidates the dependent later camera without rebaking earlier shots or actions', () => {
    const { document, map } = fixture();
    document.anchors.push({ id: 'later-destination', name: 'Later', kind: 'point', position: [3, 0, 2] });
    document.actions.push({ id: 'later-walk', entityId: 'hero', type: 'move', start: { kind: 'absolute', seconds: 5 }, duration: 2, targetAnchorId: 'later-destination' });
    document.shots[1].camera.movement = 'tracking';
    const before = compileDirector(document, map);
    const next = applyDirectorPatch(document, [{ type: 'anchor.upsert', anchor: { ...document.anchors[1], position: [2, 0, 2] } }], 'ai');
    const after = compileDirector(next, map, null, undefined, before);
    expect(after.validation.valid).toBe(true);
    expect(after.changedNodeIds).toEqual(['later-walk', 'shot-two']);
    expect(after.actions[0].inputHash).toBe(before.actions[0].inputHash);
    expect(after.shots[0].inputHash).toBe(before.shots[0].inputHash);
  });

  it('samples a generated in-place clip and analytical event from absolute time', () => {
    const { document, map, asset, resources } = fixture();
    resources.clips.push({ id: 'wave-clip', entityId: 'hero', modelHash: stableHash(asset.modelJson), description: 'Wave', duration: 1, fps: 2, loop: true, rootMotion: 'in-place', source: 'generated', tracks: { body: { rotation: [[0, 0, 0], [0, 0, 0.2]] } } });
    document.actions.push({ id: 'wave', entityId: 'hero', type: 'animate', start: { kind: 'absolute', seconds: 0 }, duration: 4, clipId: 'wave-clip' }, { id: 'arrival-spark', entityId: 'hero', type: 'effect', start: { kind: 'after', id: 'walk' }, duration: 2, effect: 'spark' });
    const result = compileDirector(document, map, null, resources);
    expect(result.validation.valid).toBe(true);
    expect(evaluateCG(result, 2.5).entities.hero).toMatchObject({ clipId: 'wave-clip', clipTime: 0.5 });
    const fx = evaluateCG(result, 4.5).effects;
    expect(fx[0]).toMatchObject({ id: 'arrival-spark', position: [3, 0, 0], age: 0.5 });
    expect(evaluateCG(result, 2).effects).toEqual([]);
    expect(evaluateCG(result, 4.5).effects).toEqual(fx);
    resources.clips[0].modelHash = 'different';
    expect(compileDirector(document, map, null, resources).validation.diagnostics.some((d) => d.code === 'clip_model_mismatch')).toBe(true);
  });

  it('applies isolated WorldPatch before resolving object anchors', () => {
    const { document, map } = fixture();
    const marker = createMapObject('Marker'); marker.id = 'marker'; marker.visible = false; map.objects.push(marker);
    document.worldPatch = [{ type: 'object.update', objectId: 'marker', patch: { transform: { position: [2, 0, 1] } } }];
    document.anchors[0] = { id: 'destination', name: 'Marker-local point', kind: 'point', position: [1, 0, 0], space: 'object', objectId: 'marker' };
    const result = compileDirector(document, map);
    expect(result.validation.valid).toBe(true);
    expect(evaluateCG(result, 4).entities.hero.position).toEqual([3, 0, 1]);
    expect(map.objects.find((o) => o.id === 'marker')!.transform.position).toEqual([0, 0, 0]);
  });

  it('validates missing resources, overlapping channels and invalid attachment ownership', () => {
    const { document, map } = fixture();
    document.actions.push({ ...document.actions[0], id: 'walk-again', duration: 2 });
    expect(compileDirector(document, map).validation.diagnostics.some((d) => d.code === 'action_channel_overlap')).toBe(true);
    map.assets = [];
    expect(compileDirector(document, map).validation.diagnostics.some((d) => d.code === 'missing_model')).toBe(true);
    document.actions[1].type = 'attach';
    expect(validateDirectorDocument(document).diagnostics.some((d) => d.code === 'invalid_document')).toBe(true);
  });

  it('rejects invalid baked tracks instead of claiming a playable animation', () => {
    const { document, map, asset, resources } = fixture();
    const clip = { id: 'invalid-clip', entityId: 'hero', modelHash: stableHash(asset.modelJson), description: 'Invalid', duration: 1, fps: 2, loop: false, rootMotion: 'in-place' as const, source: 'generated' as const, tracks: { body: {} } };
    resources.clips.push(clip);
    document.actions.push({ id: 'animation', entityId: 'hero', type: 'animate', start: { kind: 'absolute', seconds: 0 }, duration: 1, clipId: clip.id });
    expect(compileDirector(document, map, null, resources).validation.diagnostics.some(d => d.code === 'invalid_clip_samples')).toBe(true);
    resources.clips[0].tracks.body = { position: new Array(3) };
    expect(compileDirector(document, map, null, resources).validation.diagnostics.some(d => d.code === 'invalid_clip_samples')).toBe(true);
    resources.clips[0].tracks.body = { quaternion: [[0, 0, 0, 3]] };
    expect(compileDirector(document, map, null, resources).validation.diagnostics.some(d => d.code === 'invalid_clip_samples')).toBe(true);
  });

  it('hashes exact frozen model contents and rejects contradictory time locks', () => {
    const { document, map, asset, resources } = fixture();
    const original = compileDirector(document, map, null, resources);
    resources.models.push({ ...asset, modelJson: { ...asset.modelJson as object, changed: true } });
    const conflict = compileDirector(document, map, null, resources);
    expect(conflict.inputHash).not.toBe(original.inputHash);
    expect(conflict.validation.diagnostics.some(d => d.code === 'asset_identity_conflict')).toBe(true);
    document.constraints.push(
      { id: 'start-time-lock', source: 'user', strength: 'hard', type: 'action-time', targetId: 'walk', seconds: 4 },
      { id: 'end-time-lock', source: 'user', strength: 'hard', type: 'action-time', targetId: 'walk', edge: 'end', seconds: 2 }
    );
    expect(compileDirector(document, map).validation.diagnostics.some(d => d.code === 'invalid_resolved_time')).toBe(true);
  });
});
