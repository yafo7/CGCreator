import { createEmptyMap, createMapObject, type MapAsset } from './map';
import { buildModelColliderPlan } from './modelBounds';
import { stableHash } from './cgValidation';
import type { CgClip, CgResources, DirectorDocument } from './cgTypes';

/** Explicitly labelled offline fixture; never used as a remote-generation fallback. */
export function foundationActorModel() {
  const box = (id: string, parent: string, pos: number[], size: number[], color = 0x58a6bd) => ({ id, name: id, parent, transform: { pos }, mesh: { type: 'box', params: { width: size[0], height: size[1], depth: size[2] }, color } });
  const nodes: any[] = [
    { id: 'hips', name: 'hips', transform: { pos: [0, 1, 0] } },
    box('pelvis', 'hips', [0, 0, 0], [0.32, 0.18, 0.22]),
    box('torso', 'hips', [0, 0.33, 0], [0.38, 0.48, 0.24]),
    box('head', 'hips', [0, 0.74, 0], [0.32, 0.34, 0.30], 0xefcaa8),
    box('left_arm', 'hips', [-0.29, 0.25, 0], [0.12, 0.42, 0.12]),
    box('right_arm', 'hips', [0.29, 0.25, 0], [0.12, 0.42, 0.12])
  ];
  for (const [side, x] of [['left', -0.1], ['right', 0.1]] as const) nodes.push(
    { id: `${side}_thigh`, name: `${side}_thigh`, parent: 'hips', transform: { pos: [x, -0.1, 0] } },
    box(`${side}_thigh_mesh`, `${side}_thigh`, [0, -0.22, 0], [0.14, 0.44, 0.14], 0x34455a),
    { id: `${side}_knee`, name: `${side}_knee`, parent: `${side}_thigh`, transform: { pos: [0, -0.44, 0] } },
    box(`${side}_shin`, `${side}_knee`, [0, -0.22, 0], [0.12, 0.44, 0.12], 0x34455a),
    box(`${side}_foot`, `${side}_knee`, [0, -0.48, 0.06], [0.14, 0.08, 0.24], 0x29313e)
  );
  return { version: '1.0', nodes, _meta: { cgRig: { version: 1, landmarks: {
    hips: { nodeId: 'hips', point: [0, -0.17, 0] },
    leftFoot: { nodeId: 'left_foot', point: [0, -0.04, 0] }, rightFoot: { nodeId: 'right_foot', point: [0, -0.04, 0] },
    head: { nodeId: 'head', point: [0, 0, 0] }, eyes: { nodeId: 'head', point: [0, 0.055, 0.15] }, face: { nodeId: 'head', point: [0, 0, 0.15] }
  } } } };
}

export function foundationSitClip(modelJson: unknown, entityId = 'boy', duration = 2): CgClip {
  const fps = 30, times = Array.from({ length: Math.ceil(duration * fps) + 1 }, (_, i) => i / fps);
  const tracks: CgClip['tracks'] = {};
  for (const side of ['left', 'right']) {
    tracks[`${side}_thigh`] = { rotation: times.map(t => { const u = Math.min(1, t / duration * 2), a = u * u * (3 - 2 * u); return [-Math.PI / 2 * a, 0, 0]; }) };
    tracks[`${side}_knee`] = { rotation: times.map(t => { const u = Math.min(1, t / duration * 2), a = u * u * (3 - 2 * u); return [Math.PI / 2 * a, 0, 0]; }) };
  }
  return { id: 'sit-calibrated', entityId, modelHash: stableHash(modelJson), description: '内置校准坐下动作', duration, fps, loop: false, rootMotion: 'in-place', source: 'builtin', tracks };
}

export function foundationRunClip(modelJson: unknown): CgClip {
  const frames = Array.from({ length: 31 }, (_, i) => i / 30), tracks: CgClip['tracks'] = {};
  for (const [side, offset] of [['left', 0], ['right', Math.PI]] as const) {
    tracks[`${side}_thigh`] = { rotation: frames.map(t => [Math.sin(t * Math.PI * 2 + offset) * 0.55, 0, 0]) };
    tracks[`${side}_knee`] = { rotation: frames.map(t => [Math.max(0, Math.sin(t * Math.PI * 2 + offset)) * 0.6, 0, 0]) };
  }
  return { id: 'run-calibrated', entityId: 'boy', modelHash: stableHash(modelJson), description: '内置跑步循环', duration: 1, fps: 30, loop: true, rootMotion: 'in-place', source: 'builtin', locomotion: { kind: 'run', nominalSpeed: 3.6, minRate: 0.5, maxRate: 1.8 }, tracks };
}

export function createFoundationDemo() {
  const map = createEmptyMap('基础闭环演示 · 弯路、对话与坐下', 'cg-foundation-map', [24, 10, 24]);
  map.seed = 42; map.createdAt = 1; map.updatedAt = 1;
  const actorModel = foundationActorModel();
  const seatModel = { version: '1.0', nodes: [
    { id: 'seat', name: 'seat', transform: { pos: [0, 0.40, 0] }, mesh: { type: 'box', params: { width: 0.8, height: 0.1, depth: 0.5 }, color: 0xae784e } },
    { id: 'backrest', name: 'backrest', transform: { pos: [0, 0.7, -0.29] }, mesh: { type: 'box', params: { width: 0.8, height: 0.7, depth: 0.1 }, color: 0xae784e } },
    ...[-1, 1].flatMap(x => [-1, 1].map(z => ({ id: `leg${x === -1 ? 'L' : 'R'}${z === -1 ? 'B' : 'F'}`, transform: { pos: [x * 0.32, 0.175, z * 0.19] }, mesh: { type: 'box', params: { width: 0.08, height: 0.35, depth: 0.08 }, color: 0x765030 } })))
  ] };
  const asset = (id: string, name: string, modelJson: unknown): MapAsset => ({ id, name, prompt: name, modelJson, colliderPlan: buildModelColliderPlan(modelJson), mode: 'voxel', createdAt: 1, updatedAt: 1 });
  map.assets = [asset('foundation-actor', '内置校准演员', actorModel), asset('foundation-chair', '校准座椅', seatModel)];
  const boy = createMapObject('少年', 'foundation-actor'); boy.id = 'boy-object'; boy.transform.position = [-6, 0, -4];
  const friend = createMapObject('对话者', 'foundation-actor'); friend.id = 'friend-object'; friend.transform.position = [4.5, 0, 3]; friend.transform.rotation = [0, -Math.PI / 2, 0];
  const chair = createMapObject('座椅', 'foundation-chair'); chair.id = 'chair-object'; chair.transform.position = [2, 0, 2.3];
  map.objects = [boy, friend, chair];
  map.guides = [{ id: 'garden-road', name: '弯曲石子路', points: [[-6, -4], [-2, -4], [-2, 0], [0, 0], [0, 4.5], [2, 4.5], [2, 3]], width: 1.6, closed: false, curve: 'polyline', tags: ['route', 'garden-stone'] }];
  map.visualSemantics.zones = [{ id: 'stone-road', tags: ['paving'], material: 'garden-stone', center: [-2, -1], radius: 8, intensity: 1, region: { kind: 'path', points: map.guides[0].points, width: 1.6 } }];
  map.layout.globalPrompt = '少年沿弯曲石子路跑向座椅，与右侧朋友对话后坐下。';
  const document: DirectorDocument = { schemaVersion: 2, id: 'foundation-director', title: map.name, sourcePrompt: map.layout.globalPrompt, revision: 0, seed: 42, mapId: map.id,
    entities: [{ id: 'boy', name: '少年', kind: 'actor', objectId: boy.id }, { id: 'friend', name: '对话者', kind: 'actor', objectId: friend.id }],
    anchors: [{ id: 'approach', name: '座椅接近点', kind: 'point', space: 'world', position: [2, 0, 3] }, { id: 'front', name: '座椅前方', kind: 'point', space: 'world', position: [2, 0, 8] }],
    actions: [
      { id: 'run', entityId: 'boy', type: 'move', start: { kind: 'absolute', seconds: 0 }, duration: 6, targetAnchorId: 'approach', clipId: 'run-calibrated', route: { guideIds: ['garden-road'], policy: 'required', locomotion: 'run' }, purpose: '沿石子路到达座椅' },
      { id: 'talk', entityId: 'boy', type: 'dialogue', targetEntityId: 'friend', start: { kind: 'after', id: 'run' }, duration: 3, purpose: '与朋友对话' },
      { id: 'align', entityId: 'boy', type: 'face', targetAnchorId: 'front', start: { kind: 'after', id: 'talk' }, duration: 0.5 },
      { id: 'sit', entityId: 'boy', type: 'sit', start: { kind: 'after', id: 'align' }, duration: 2, clipId: 'sit-calibrated', interaction: { objectId: chair.id, seatNodeId: 'seat', approachAnchorId: 'approach' }, purpose: '坐在指定座面并保持坐姿' },
      { id: 'rest', entityId: 'boy', type: 'hold', start: { kind: 'after', id: 'sit' }, duration: 2.5 }
    ],
    shots: [
      { id: 'follow', name: '沿路跟随', purpose: '看清少年行进与路径', duration: 6, behaviorId: 'run', coveragePurpose: 'follow', camera: { movement: 'tracking', framing: 'wide', subjectId: 'boy', reference: 'subject-motion', view: 'rear-three-quarter', aim: 'body' } },
      { id: 'conversation', name: '双人对话', purpose: '建立双方关系', duration: 3, behaviorId: 'talk', coveragePurpose: 'dialogue', camera: { movement: 'static', framing: 'medium', layout: 'two-shot', subjectId: 'boy', secondaryId: 'friend', reference: 'interaction-axis', view: 'side', aim: 'interaction', aimMode: 'follow' }, transition: { type: 'cut', motivation: 'reestablish' } },
      { id: 'contact', name: '完整坐下', purpose: '展示人与椅子的接触', duration: 3, behaviorId: 'sit', coveragePurpose: 'contact', camera: { movement: 'static', framing: 'wide', subjectId: 'boy', reference: 'subject-facing', view: 'side', aim: 'body', aimMode: 'follow' }, transition: { type: 'cut', motivation: 'action' } },
      { id: 'seated-close', name: '坐姿特写', purpose: '读取坐下后的反应', duration: 2, behaviorId: 'rest', coveragePurpose: 'reaction', camera: { movement: 'static', framing: 'close-up', subjectId: 'boy', reference: 'subject-facing', view: 'front-three-quarter', aim: 'eyes', lensMm: 85 }, transition: { type: 'cut', motivation: 'reaction' } }
    ], constraints: [], worldPatch: [] };
  for (const shot of document.shots) shot.autoDuration = true;
  const resources: CgResources = { models: [], clips: [foundationSitClip(actorModel), foundationRunClip(actorModel)] };
  return { map, document, resources };
}
