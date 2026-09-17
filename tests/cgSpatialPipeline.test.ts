import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { bakeMapCollisions, createEmptyMap, createMapObject, type MapAsset } from '../src/shared/map';
import { buildModelColliderPlan } from '../src/shared/modelBounds';
import { createFoundationDemo } from '../src/shared/cgFoundationDemo';
import { applyDirectorPatch, compileDirector, evaluateCG, stableHash } from '../src/shared/cgCompiler';
import { buildPoseRig } from '../src/shared/cgPoseEvaluator';
import { createNavigationWorld, findNavigationPath } from '../src/shared/cgNavigation';
import { observeCamera } from '../src/shared/cgVisibility';
import { mapSpatialAnchors, resolveSpatialAnchor } from '../src/shared/cgSpatialBindings';
import { cameraCandidates } from '../src/shared/cgShotSkills';
import type { CgClip, CgEntityState } from '../src/shared/cgTypes';

const errors = (fixture: ReturnType<typeof createFoundationDemo>) => compileDirector(fixture.document, fixture.map, null, fixture.resources, undefined, { performanceOnly: true }).validation.diagnostics.filter(d => d.severity === 'error').map(d => d.code);

describe('spatial performance constraints', () => {
  it('rejects a destination outside a required road without moving the manual point', () => {
    const f = createFoundationDemo();
    f.document.anchors.push({ id: 'locked', name: 'manual', kind: 'point', position: [-6, 0, 5] });
    f.document.constraints.push({ id: 'lock', source: 'user', strength: 'hard', type: 'action-target', targetId: 'run', anchorId: 'locked' });
    expect(errors(f)).toContain('unreachable_target'); expect(f.document.anchors.at(-1)?.position).toEqual([-6, 0, 5]);
  });
  it('requires a real model-matched motion clip and refuses duplicate root translation', () => {
    const f = createFoundationDemo(); f.resources.clips.find(c => c.id === 'run-calibrated')!.modelHash = 'other';
    expect(errors(f)).toContain('clip_model_mismatch');
    f.resources.clips.find(c => c.id === 'run-calibrated')!.modelHash = stableHash(f.map.assets![0].modelJson);
    f.resources.clips.find(c => c.id === 'run-calibrated')!.tracks.hips = { position: Array.from({ length: 31 }, () => [1, 0, 0]) };
    expect(errors(f)).toContain('duplicate_root_motion');
  });
  it('rejects unbound contact rigs, excessively tall seats, and occupied seats', () => {
    const missing = createFoundationDemo(); delete (missing.map.assets![0].modelJson as any)._meta.cgRig;
    for (const c of missing.resources.clips) c.modelHash = stableHash(missing.map.assets![0].modelJson);
    expect(errors(missing)).toContain('contact_profile_required');
    const tall = createFoundationDemo(); tall.map.objects.find(o => o.id === 'chair-object')!.transform.position[1] = 0.4;
    expect(errors(tall)).toContain('seated_foot_support');
    const occupied = createFoundationDemo(); occupied.map.objects.find(o => o.id === 'friend-object')!.transform.position = [2, 0, 3];
    const clip = structuredClone(occupied.resources.clips[0]); clip.id = 'friend-sit'; clip.entityId = 'friend'; occupied.resources.clips.push(clip);
    occupied.document.actions.push({ ...structuredClone(occupied.document.actions.find(a => a.id === 'sit')!), id: 'friend-sits', entityId: 'friend', clipId: clip.id });
    expect(errors(occupied)).toContain('seat_occupied');
  });
  it('keeps seated contact after seeking and refuses walking before standing up', () => {
    const f = createFoundationDemo();
    f.document.actions.push({ id: 'invalid-leave', entityId: 'boy', type: 'move', start: { kind: 'after', id: 'sit' }, duration: 1, targetAnchorId: 'approach' });
    expect(errors(f)).toContain('seated_behavior_conflict');
  });
  it('accepts synchronized handoff motions even when the handoff sorts first', () => {
    const f = createFoundationDemo();
    const propModel = { version: '1.0', nodes: [{ id: 'blade', name: 'blade', transform: { pos: [0, 0.4, 0] }, mesh: { type: 'box', params: { width: 0.08, height: 0.8, depth: 0.04 } } }] };
    const propAsset: MapAsset = { id: 'sword-asset', name: '长剑', prompt: '古风长剑', modelJson: propModel, colliderPlan: buildModelColliderPlan(propModel), mode: 'json', createdAt: 1, updatedAt: 1 };
    f.resources.models.push(propAsset);
    f.document.entities.push({ id: 'sword', name: '长剑', kind: 'prop', assetId: propAsset.id });
    const motion = (id: string, entityId: string): CgClip => ({
      id, entityId, modelHash: stableHash(f.map.assets![0].modelJson), description: '交接长剑', duration: 1, fps: 1,
      loop: false, rootMotion: 'in-place' as const, source: 'builtin' as const,
      tracks: { right_arm: { rotation: [[0, 0, 0], [0, 0, 0]] } }
    });
    f.resources.clips.push(motion('giver-handoff', 'boy'), motion('receiver-handoff', 'friend'));
    const actorHash = stableHash(f.map.assets![0].modelJson), propHash = stableHash(propModel);
    f.resources.assemblies = [
      { id: 'giver-grip', actorEntityId: 'boy', propEntityId: 'sword', socketId: 'right-hand', nodeId: 'right_arm', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], mountedGroupId: 'blade', actorModelHash: actorHash, propModelHash: propHash, source: '3d-generate-mount' },
      { id: 'receiver-grip', actorEntityId: 'friend', propEntityId: 'sword', socketId: 'right-hand', nodeId: 'right_arm', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], mountedGroupId: 'blade', actorModelHash: actorHash, propModelHash: propHash, source: '3d-generate-mount' }
    ];
    f.document.actions = [
      { id: 'a-handoff-first', entityId: 'sword', type: 'handoff', sourceEntityId: 'boy', targetEntityId: 'friend', socketId: 'right-hand', start: { kind: 'absolute', seconds: 0 }, duration: 1 },
      { id: 'z-giver-motion', entityId: 'boy', type: 'animate', propEntityId: 'sword', clipId: 'giver-handoff', start: { kind: 'absolute', seconds: 0 }, duration: 1 },
      { id: 'z-receiver-motion', entityId: 'friend', type: 'animate', propEntityId: 'sword', clipId: 'receiver-handoff', start: { kind: 'absolute', seconds: 0 }, duration: 1 }
    ];
    f.document.shots = [{ id: 'handoff-shot', name: '交接', purpose: '完整展示交接', duration: 1, behaviorId: 'a-handoff-first', camera: { movement: 'static', framing: 'medium', layout: 'two-shot', subjectId: 'boy', secondaryId: 'friend', reference: 'interaction-axis', view: 'side', aim: 'interaction', aimMode: 'follow' } }];
    const diagnostics = compileDirector(f.document, f.map, null, f.resources, undefined, { performanceOnly: true }).validation.diagnostics;
    expect(diagnostics.some(item => item.code === 'missing_handoff_motion')).toBe(false);
  });
  it('detects an actor occupying another actor’s travel space', () => {
    const f = createFoundationDemo(); f.map.objects.find(o => o.id === 'friend-object')!.transform.position = [-2, 0, -4];
    expect(errors(f)).toContain('performer_clearance_conflict');
  });
  it('does not treat a map-bound scenery prop with no actions as an animated performer', () => {
    const f = createFoundationDemo();
    const prop = createMapObject('scenery', 'foundation-chair'); prop.id = 'scenery-prop-object'; prop.transform.position = [8, 0, 8];
    const neighbor = createMapObject('neighbor', 'foundation-chair'); neighbor.id = 'scenery-neighbor'; neighbor.transform.position = [8, 0, 8];
    f.map.objects.push(prop, neighbor);
    f.document.entities.push({ id: 'scenery-prop', name: '静态景物', kind: 'prop', objectId: prop.id });
    const diagnostics = compileDirector(f.document, f.map, null, f.resources, undefined, { performanceOnly: true }).validation.diagnostics;
    expect(diagnostics.some(item => item.code === 'animated_world_clearance' && item.nodeIds.includes('scenery-prop'))).toBe(false);
  });
  it('finishes a face action looking at the world position of a map-bound prop', () => {
    const f = createFoundationDemo();
    f.map.objects.find(object => object.id === 'chair-object')!.transform.position = [-10, 0, -10];
    f.document.entities.push({ id: 'pavilion', name: '临波水榭', kind: 'prop', objectId: 'chair-object' });
    f.resources.clips.push({ id: 'held-head-turn', entityId: 'boy', modelHash: stableHash(f.map.assets![0].modelJson), description: '停步后保留头部偏转', duration: 1, fps: 1, loop: false, rootMotion: 'in-place', source: 'builtin', tracks: { head: { rotation: [[0, Math.PI / 3, 0], [0, Math.PI / 3, 0]] } } });
    f.document.actions = [
      { id: 'stop-with-head-turn', entityId: 'boy', type: 'animate', start: { kind: 'absolute', seconds: 0 }, duration: 1, clipId: 'held-head-turn', endBehavior: 'hold' },
      { id: 'look-at-pavilion', entityId: 'boy', type: 'face', start: { kind: 'after', id: 'stop-with-head-turn' }, duration: 1, targetEntityId: 'pavilion' }
    ];
    f.document.shots = [{ id: 'look', name: '回望', purpose: '看向临波水榭', duration: 1, behaviorId: 'look-at-pavilion', autoDuration: true, camera: { movement: 'static', framing: 'close-up', subjectId: 'boy', reference: 'subject-facing', view: 'front-three-quarter', aim: 'eyes', aimMode: 'follow', lensMm: 85 } }];
    const bundle = compileDirector(f.document, f.map, null, f.resources, undefined, { performanceOnly: true });
    const state = evaluateCG(bundle, 2).entities.boy;
    const target = f.map.objects.find(object => object.id === 'chair-object')!.transform.position;
    const expected = new Vector3(target[0] - state.position[0], 0, target[2] - state.position[2]).normalize();
    const forward = new Vector3(...state.faceForward!).setY(0).normalize();
    expect(forward.dot(expected)).toBeGreaterThan(0.999);
    expect(new Quaternion(...state.quaternion).length()).toBeCloseTo(1, 8);
    const complete = compileDirector(f.document, f.map, null, f.resources);
    expect(complete.validation.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(complete.shots[0].camera.movement).toBe('tracking');
    for (const time of [1, 1.5, 2]) {
      const frame = evaluateCG(complete, time), actor = frame.entities.boy;
      const eye = actor.landmarks!.eyes!;
      expect(new Vector3(...frame.camera.position).sub(new Vector3(...eye)).normalize().dot(new Vector3(...actor.faceForward!))).toBeGreaterThan(0.1);
    }
  });
  it('rebases semantic guide/seat anchors while preserving exact world anchors', () => {
    const f = createFoundationDemo(), anchors = mapSpatialAnchors(f.map), guide = anchors.find(a => a.binding?.kind === 'guide')!, seat = anchors.find(a => a.binding?.kind === 'seat-approach')!;
    const world = { id: 'world', name: 'World', kind: 'point' as const, position: [1, 0, 2] as [number, number, number], space: 'world' as const };
    f.map.guides[0].points[0][0] -= 1; f.map.objects.find(o => o.id === 'chair-object')!.transform.position[0] += 2;
    expect(resolveSpatialAnchor(guide, f.map).position[0]).toBe(guide.position[0] - 1);
    expect(resolveSpatialAnchor(seat, f.map).position[0]).toBeCloseTo(seat.position[0] + 2);
    expect(resolveSpatialAnchor(world, f.map)).toEqual(world);
    f.map.guides = []; expect(() => resolveSpatialAnchor(guide, f.map)).toThrow('missing_guide_binding');
  });
  it('uses an explicit raised support rather than projecting it back onto terrain', () => {
    const map = createEmptyMap('deck', 'deck', [12, 6, 12]);
    const modelJson = { nodes: [{ id: 'deck', name: 'walkable deck', transform: { pos: [0, 0.05, 0] }, mesh: { type: 'box', params: { width: 6, height: 0.1, depth: 2 } } }] };
    const asset: MapAsset = { id: 'deck-asset', name: 'deck', prompt: '', modelJson, colliderPlan: buildModelColliderPlan(modelJson), mode: 'voxel', createdAt: 1, updatedAt: 1 };
    const deck = createMapObject('deck', asset.id); deck.id = 'deck-object'; deck.transform.position = [0, 0.1, 0];
    map.assets = [asset]; map.objects = [deck];
    const nav = createNavigationWorld(map, bakeMapCollisions(map).boxes);
    const result = findNavigationPath(nav, [-2, 0.2, 0], [2, 0.2, 0], 0.2, 1.7);
    expect(result).not.toBeNull(); expect(result!.points.every(p => Math.abs(p[1] - 0.2) < 1e-5)).toBe(true);
    expect(result!.surfaceIds.every(id => id.includes('deck'))).toBe(true);
    expect(findNavigationPath(nav, [-4, 0, 0], [-2, 0.2, 0], 0.2, 1.7)).not.toBeNull();
  });
  it('rejects movement across water without a supported deck', () => {
    const map = createEmptyMap('water', 'water', [12, 6, 12]); map.terrain.heights.fill(-0.2);
    map.waterBodies = [{ id: 'lake', name: 'lake', type: 'lake', level: 0, depth: 0.2, width: 1, points: [[-5, -5], [5, -5], [5, 5], [-5, 5]] }];
    expect(findNavigationPath(createNavigationWorld(map, []), [-2, -0.2, 0], [2, -0.2, 0], 0.2, 1.7)).toBeNull();
  });
});

describe('behavior-driven camera and geometric observations', () => {
  it('reports eye occlusion geometrically and does not treat translucent geometry as an opaque wall', () => {
    const f = createFoundationDemo(), bundle = compileDirector(f.document, f.map, null, f.resources, undefined, { performanceOnly: true });
    const states = evaluateCG(bundle, 0).entities, eye = states.boy.landmarks!.eyes!;
    const map = structuredClone(bundle.map);
    const modelJson = { nodes: [{ id: 'wall', transform: { pos: [0, 1.5, 0] }, mesh: { type: 'box', params: { width: 3, height: 3, depth: 0.2 }, material: { opacity: 1 } } }] };
    const asset: MapAsset = { id: 'occluder', name: 'wall', prompt: '', modelJson, colliderPlan: buildModelColliderPlan(modelJson), mode: 'voxel', createdAt: 1, updatedAt: 1 };
    const wall = createMapObject('occluder', asset.id); wall.id = 'wall'; wall.transform.position = [eye[0], 0, eye[2] + 1];
    map.assets!.push(asset); map.objects.push(wall);
    const pose = { position: [eye[0], eye[1], eye[2] + 3] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], fov: 50 };
    const hidden = observeCamera(map, bundle.bindings, bundle.resources, states, pose, 16 / 9, ['boy-object']);
    expect(hidden[0].landmarks!.eyes).toMatchObject({ visible: false, occludedBy: 'wall' });
    const transparent = structuredClone(map); (transparent.assets!.find(a => a.id === 'occluder')!.modelJson as any).nodes[0].mesh.material.opacity = 0.3;
    const visible = observeCamera(transparent, bundle.bindings, bundle.resources, states, pose, 16 / 9, ['boy-object']);
    expect(visible[0].landmarks!.eyes.visible).toBe(true);
  });
  it('offers different coverage for dialogue and travel and preserves explicit camera refinements', () => {
    const { document } = createFoundationDemo();
    expect(cameraCandidates(document.shots[1], document.actions[1]).map(c => c.skillId)).toEqual(expect.arrayContaining(['dialogue-two', 'dialogue-ots']));
    expect(cameraCandidates(document.shots[0], document.actions[0]).some(c => c.camera.view === 'front')).toBe(false);
    const edited = applyDirectorPatch(document, [{ type: 'shot.update', id: 'conversation', patch: { camera: { framing: 'close-up', layout: 'solo', aim: 'eyes' } } }], 'ai');
    expect(cameraCandidates(edited.shots[1], edited.actions[1])).toHaveLength(1);
    expect(edited.actions).toEqual(document.actions);
  });
  it('cannot bypass a camera lock by switching skills', () => {
    const { document } = createFoundationDemo();
    document.anchors.push({ id: 'camera-lock', name: 'Camera', kind: 'camera', position: [0, 4, 8], quaternion: [0, 0, 0, 1] });
    document.constraints.push({ id: 'lock-camera', source: 'user', strength: 'hard', type: 'camera-pose', targetId: 'conversation', anchorId: 'camera-lock' });
    expect(() => applyDirectorPatch(document, [{ type: 'shot.update', id: 'conversation', patch: { skillId: 'dialogue-ots' } }], 'ai')).toThrow('camera-pose');
  });
  it('rejects a contact shot scheduled outside the actual contact event', () => {
    const f = createFoundationDemo();
    f.document.shots[2].duration = 0.2;
    f.document.shots[2].autoDuration = false;
    expect(compileDirector(f.document, f.map, null, f.resources).validation.diagnostics.some(d => d.code === 'contact_not_covered')).toBe(true);
  });
  it('reports a locked camera that cannot see the performance without moving it', () => {
    const f = createFoundationDemo();
    f.document.anchors.push({ id: 'away', name: 'Wrong direction', kind: 'camera', position: [-6, 2, -10], quaternion: [0, 0, 0, 1] });
    f.document.constraints.push({ id: 'away-lock', source: 'user', strength: 'hard', type: 'camera-pose', targetId: 'follow', anchorId: 'away' });
    const result = compileDirector(f.document, f.map, null, f.resources);
    expect(result.validation.diagnostics.some(d => d.code === 'locked_camera_collision')).toBe(true);
    expect(result.shots[0].lockedPose?.position).toEqual([-6, 2, -10]);
  });
  it('measures rotation, scaling, occlusion and near-plane clipping from geometry', () => {
    const map = createEmptyMap('view', 'view', [20, 8, 20]);
    const modelJson = { nodes: [{ id: 'body', transform: { pos: [0, 0.5, 0] }, mesh: { type: 'box', params: { width: 4, height: 1, depth: 0.2 } } }] };
    const asset: MapAsset = { id: 'wide', name: 'wide', prompt: '', modelJson, colliderPlan: buildModelColliderPlan(modelJson), mode: 'voxel', createdAt: 1, updatedAt: 1 };
    const target = createMapObject('target', asset.id); target.id = 'target'; map.assets = [asset]; map.objects = [target];
    const bindings = [{ entityId: 'actor', objectId: 'target', assetId: asset.id, height: 1, poseRig: buildPoseRig(modelJson) }];
    const states: Record<string, CgEntityState> = { actor: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], visible: true } };
    const camera = { position: [0, 0.5, 6] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], fov: 50 };
    const wide = observeCamera(map, bindings, { models: [], clips: [] }, states, camera)[0];
    states.actor.quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2).toArray();
    const narrow = observeCamera(map, bindings, { models: [], clips: [] }, states, camera)[0];
    expect(wide.coverage).toBeGreaterThan(narrow.coverage * 3);
    states.actor.position = [0, 0, 5.9];
    expect(observeCamera(map, bindings, { models: [], clips: [] }, states, camera).every(i => Number.isFinite(i.coverage) && i.coverage <= 1)).toBe(true);
    states.actor.visible = false; expect(observeCamera(map, bindings, { models: [], clips: [] }, states, camera)).toEqual([]);
  });
});
