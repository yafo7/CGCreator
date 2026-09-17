import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import { buildModelColliderPlan } from '../src/shared/modelBounds';
import { evaluateCG, stableHash } from '../src/shared/cgCompiler';
import type { CgClip, CgProject, DirectorDocument } from '../src/shared/cgTypes';
import { BUILTIN_RENDER_SCHEMES } from '../src/shared/renderScheme';
import { CgService, buildSemanticContext, decodeBakedClip, requestBakedAnimation, summarizeMapSync } from '../src/server/cgService';
import { CgStore } from '../src/server/cgStore';
import { cgServiceFor, handleCgHttp } from '../src/server/cgHttp';
import { MapStore } from '../src/server/mapStore';
import { handleMapHttp } from '../src/server/mapHttp';
import type { ChatMessage } from '../src/server/modelApi';
import { modelHasEmbeddedProp, stripEmbeddedProp } from '../src/server/cgProductionAgent';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'cgcreator-server-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function mapFixture() {
  const map = createEmptyMap('Film stage', 'film-stage', [24, 10, 24]);
  map.seed = 17;
  return map;
}

async function demo(service = new CgService(new CgStore(root))) {
  const created = await service.create(mapFixture(), null);
  const planned = await service.plan(created.id, created.revision, '离线演示', true);
  const compiled = await service.compile(planned.id, planned.revision);
  expect(compiled.candidate?.validation).toEqual({ valid: true, diagnostics: [] });
  return { service, project: compiled };
}

function planFromContext(messages: ChatMessage[]): DirectorDocument {
  const content = messages[messages.length - 1].content;
  if (typeof content !== 'string') throw new Error('Expected a structured text prompt');
  const supplied = JSON.parse(content);
  const anchors = supplied.map.anchors.filter((a: { id: string }) => ['map_stage_start', 'map_stage_end'].includes(a.id));
  return {
    schemaVersion: 1, ...supplied.documentIdentity, title: 'Generated intent', sourcePrompt: supplied.intent,
    entities: [{ id: 'actor', name: 'Visitor', kind: 'actor', assetId: 'generated-actor', startAnchorId: 'map_stage_start', height: 1.8, description: 'A blue-clothed visitor' }],
    anchors,
    shots: [{ id: 'shot-one', name: 'Arrival', purpose: 'Establish the visitor', duration: 4, camera: { movement: 'tracking', framing: 'wide', subjectId: 'actor' } }, { id: 'shot-two', name: 'Reaction', purpose: 'Show a reaction', duration: 3, camera: { movement: 'static', framing: 'medium', subjectId: 'actor' } }],
    actions: [{ id: 'walk', entityId: 'actor', type: 'move', start: { kind: 'absolute', seconds: 0 }, duration: 3, targetAnchorId: 'map_stage_end' }, { id: 'gesture', entityId: 'actor', type: 'animate', start: { kind: 'with', id: 'walk' }, duration: 3, clipId: 'wave' }],
    constraints: [], worldPatch: []
  };
}

const generatedModel = { version: '1.0', nodes: [
  { id: 'body', transform: { pos: [0, 0.9, 0] }, mesh: { type: 'box', params: { width: 0.5, height: 1.8, depth: 0.4 } } },
  { id: 'hand', parent: 'body', transform: { pos: [0.4, 0.2, 0] }, mesh: { type: 'box', params: { width: 0.2, height: 0.2, depth: 0.2 } } }
] };
const baked = () => ({ fps: 2, duration: 3, loop: false, animation: { hand: { rotX: [0, 0.1, 0.3, 0.4, 0.3, 0.1, 0], posX: [0, 0, 0, 0, 0, 0, 0] } } });
const identity: Pick<CgClip, 'id' | 'entityId' | 'modelHash' | 'description'> = { id: 'clip', entityId: 'actor', modelHash: stableHash(generatedModel), description: 'Wave in place' };

describe('CG project storage and compile lifecycle', () => {
  it('persists the complete visible snapshot and isolates it from callers and the source map', async () => {
    const service = new CgService(new CgStore(root));
    const map = mapFixture();
    const object = createMapObject('Prop'); object.id = 'prop'; object.transform.position = [6, 0, 6]; map.objects.push(object);
    const scheme = structuredClone(BUILTIN_RENDER_SCHEMES[0]);
    const expectedMap = structuredClone(map), expectedScheme = structuredClone(scheme);
    const project = await service.create(map, scheme);
    map.name = 'Changed source'; map.objects[0].transform.position[0] = 9;
    scheme.name = 'Changed style'; project.mapSnapshot.objects[0].visible = false;
    const reopened = await new CgStore(root).read(project.id);
    expect(reopened.mapSnapshot).toEqual(expectedMap);
    expect(reopened.schemeSnapshot).toEqual(expectedScheme);
    expect(await service.store.list()).toEqual([expect.objectContaining({ id: project.id, mapId: map.id, revision: 0, confirmed: false })]);
    expect((await readdir(path.join(root, 'projects'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('compiles the offline demo and confirms precisely the validated preview identity', async () => {
    const { service, project } = await demo();
    const candidate = project.candidate!;
    expect(candidate.documentRevision).toBe(project.document.revision);
    expect(candidate.duration).toBe(11);
    const end = project.document.anchors.find((a) => a.id === 'demo_end')!.position;
    expect(evaluateCG(candidate, 6).entities.demo_actor.position).toEqual(end);
    const confirmed = await service.confirm(project.id, project.revision, candidate.id, candidate.inputHash);
    expect(confirmed.confirmed).toEqual(candidate);
    expect((await service.store.read(project.id)).confirmed).toEqual(candidate);
    expect(confirmed.mapSnapshot.objects).toEqual([]);
    expect(confirmed.candidate!.map.objects.some((o) => o.assetId === 'cg_demo_actor_asset')).toBe(true);
  });

  it('serializes concurrent writes and rejects the second stale revision without lost updates', async () => {
    const service = new CgService(new CgStore(root));
    const project = await service.create(mapFixture(), null);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = service.store.transaction(project.id, 0, async (p) => { entered(); await blocked; p.title = 'First edit'; });
    await started;
    const second = service.store.transaction(project.id, 0, (p) => { p.title = 'Lost update'; });
    const resultsPromise = Promise.allSettled([first, second]);
    release();
    const results = await resultsPromise;
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409, code: 'revision_conflict' } });
    expect(await service.store.read(project.id)).toMatchObject({ revision: 1, title: 'First edit' });
    const next = await service.store.transaction(project.id, 1, (p) => { p.title = 'Next edit'; });
    expect(next.revision).toBe(2);
  });

  it('rolls back failed transactions and releases the project lock', async () => {
    const service = new CgService(new CgStore(root));
    const project = await service.create(mapFixture(), null);
    await expect(service.store.transaction(project.id, 0, (p) => { p.title = 'Discarded'; throw new Error('failed resource generation'); })).rejects.toThrow('failed resource');
    expect(await service.store.read(project.id)).toEqual(project);
    await expect(service.store.transaction(project.id, 0, (p) => { p.title = 'Recovered'; })).resolves.toMatchObject({ revision: 1, title: 'Recovered' });
    await expect(service.store.read('../outside')).rejects.toMatchObject({ status: 400, code: 'invalid_project_id' });
  });

  it('preserves the last confirmation through edits, stale confirms and invalid compilations', async () => {
    const setup = await demo(), service = setup.service;
    let project = setup.project;
    const initial = project.candidate!;
    project = await service.confirm(project.id, project.revision, initial.id, initial.inputHash);
    project = await service.patch(project.id, project.revision, [{ type: 'shot.update', id: 'demo_shot_close', patch: { camera: { lensMm: 80 } } }]);
    await expect(service.confirm(project.id, project.revision, initial.id, initial.inputHash)).rejects.toMatchObject({ code: 'stale_compile' });
    project = await service.patch(project.id, project.revision, [
      { type: 'anchor.upsert', anchor: { id: 'impossible', name: 'Outside the map', kind: 'point', position: [200, 0, 0] } },
      { type: 'constraint.upsert', constraint: { id: 'exact-destination', source: 'user', strength: 'hard', type: 'action-target', targetId: 'demo_move', anchorId: 'impossible' } }
    ]);
    project = await service.compile(project.id, project.revision);
    expect(project.candidate?.validation.valid).toBe(false);
    await expect(service.confirm(project.id, project.revision, project.candidate!.id, project.candidate!.inputHash)).rejects.toMatchObject({ code: 'invalid_compile' });
    expect((await service.store.read(project.id)).confirmed).toEqual(initial);
  });

  it('verifies all frozen inputs again at confirmation', async () => {
    const { service, project } = await demo();
    const candidate = project.candidate!;
    const changed = await service.store.transaction(project.id, project.revision, (p) => { p.resources.models[0].modelJson = { ...generatedModel }; });
    await expect(service.confirm(changed.id, changed.revision, candidate.id, candidate.inputHash)).rejects.toMatchObject({ code: 'stale_compile' });
    expect((await service.store.read(project.id)).confirmed).toBeNull();
  });
});

describe('CG planning, refine and resource resolution', () => {
  it('removes only a duplicate embedded weapon subtree after Refine leaves it behind', () => {
    const model = { nodes: [
      { id: 'body', name: '年轻剑客躯干', mesh: { type: 'box' } },
      { id: 'arm_right', name: '右臂', parent: 'body' },
      { id: 'mount_sword', name: '手持长剑', parent: 'arm_right', mounted: true },
      { id: 'sword_mesh', parent: 'mount_sword', mesh: { type: 'box' } },
      { id: 'hairpin', name: '束发簪', parent: 'body', mesh: { type: 'box' } }
    ], _meta: { mounts: [{ id: 'mount_sword', mountedGroupId: 'mount_sword' }] } };
    expect(modelHasEmbeddedProp(model, '黑柄古风长剑')).toBe(true);
    const cleaned = stripEmbeddedProp(model, '黑柄古风长剑') as typeof model;
    expect(cleaned.nodes.map(node => node.id)).toEqual(['body', 'arm_right', 'hairpin']);
    expect(cleaned._meta.mounts).toEqual([]);
    expect(modelHasEmbeddedProp(cleaned, '黑柄古风长剑')).toBe(false);
  });

  it('chooses coverage only after actual V2 performance validation and does not repeat AI on recompile', async () => {
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const input = JSON.parse(messages.at(-1)!.content as string);
      if (input.performance) {
        expect(input.performance.occupancy).toHaveLength(1);
        expect(input.performance.behaviors.find((b: { id: string }) => b.id === 'sit').contact.nodeId).toBe('seat');
        expect(input.shotSkills.some((s: { id: string }) => s.id === 'dialogue-two')).toBe(true);
        return '[]';
      }
      return JSON.stringify({ ...input.existingDocument, ...input.documentIdentity, shots: [] });
    });
    const service = new CgService(new CgStore(root), { chat });
    let project = await service.foundationDemo();
    project = await service.plan(project.id, project.revision, '先完成行为，再选择镜头');
    expect(project.coveragePending).toBe(true);
    project = await service.compile(project.id, project.revision);
    expect(project.coveragePending).toBe(false);
    expect(project.candidate?.stage).toBe('complete');
    expect(project.candidate?.validation.valid).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
    await service.compile(project.id, project.revision);
    expect(chat).toHaveBeenCalledTimes(2);
  }, 15000);

  it('reuses the validated DirectorDocument when the same durable run is retried', async () => {
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const input = JSON.parse(messages.at(-1)!.content as string);
      return JSON.stringify({ ...input.existingDocument, ...input.documentIdentity, shots: [] });
    });
    const service = new CgService(new CgStore(root), { chat });
    let project = await service.foundationDemo();
    project = await service.plan(project.id, project.revision, '同一段剧情');
    const retried = await service.plan(project.id, project.revision, '同一段剧情');
    expect(retried).toEqual(project);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('keeps camera planning least-authority when the model echoes forbidden timing or behavior edits', async () => {
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const input = JSON.parse(messages.at(-1)!.content as string);
      if (input.performance) return JSON.stringify([
        { type: 'shot.update', id: input.document.shots[0].id, patch: { duration: 99, camera: { side: 'left' } } },
        { type: 'action.update', id: 'run', patch: { duration: 99 } }
      ]);
      return JSON.stringify({ ...input.existingDocument, ...input.documentIdentity, shots: [] });
    });
    const service = new CgService(new CgStore(root), { chat });
    let project = await service.foundationDemo();
    project = await service.plan(project.id, project.revision, '先完成行为，再选择镜头');
    project = await service.compile(project.id, project.revision);
    expect(project.document.shots[0].duration).not.toBe(99);
    expect(project.document.actions.find(action => action.id === 'run')!.duration).toBe(6);
    expect(project.document.shots[0].camera.side).toBe('left');
    expect(project.candidate?.validation.valid).toBe(true);
  }, 15000);

  it('never asks for cameras when the performance is invalid and preserves confirmation', async () => {
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const input = JSON.parse(messages.at(-1)!.content as string);
      return JSON.stringify({ ...input.existingDocument, ...input.documentIdentity, shots: [] });
    });
    const service = new CgService(new CgStore(root), { chat });
    let project = await service.foundationDemo();
    project = await service.confirm(project.id, project.revision, project.candidate!.id, project.candidate!.inputHash);
    const confirmed = structuredClone(project.confirmed);
    project = await service.plan(project.id, project.revision, '准备行为');
    const changedMap = structuredClone(project.mapSnapshot); changedMap.guides = [];
    project = (await service.syncMap(project.id, project.revision, changedMap, null)).project;
    project = await service.compile(project.id, project.revision);
    expect(project.candidate?.stage).toBe('performance');
    expect(project.candidate?.validation.valid).toBe(false);
    expect(project.confirmed).toEqual(confirmed);
    expect(chat).toHaveBeenCalledTimes(1);
    await expect(service.confirm(project.id, project.revision, project.candidate!.id, project.candidate!.inputHash)).rejects.toMatchObject({ code: 'incomplete_compile' });
  });

  it('rejects a coverage response that attempts to change actor behavior', async () => {
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const input = JSON.parse(messages.at(-1)!.content as string);
      return input.performance ? JSON.stringify([{ type: 'action.update', id: 'run', patch: { duration: 20 } }]) : JSON.stringify({ ...input.existingDocument, ...input.documentIdentity, shots: [] });
    });
    const service = new CgService(new CgStore(root), { chat });
    let project = await service.foundationDemo();
    project = await service.plan(project.id, project.revision, '保持行为');
    const before = structuredClone(project.document);
    await expect(service.compile(project.id, project.revision)).rejects.toMatchObject({ code: 'invalid_coverage' });
    expect((await service.store.read(project.id)).document).toEqual(before);
  });

  it('lets the director query exact current regions before returning its validated document', async () => {
    let initial: ChatMessage[] = [];
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      if (!initial.length) {
        initial = structuredClone(messages);
        expect(JSON.parse(messages[1].content as string).map.worldUnderstanding.regions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'zone:pond' })]));
        return JSON.stringify({ worldQueries: [{ type: 'inspect', semanticId: 'zone:pond' }, { type: 'point', position: [5, 5] }] });
      }
      const result = JSON.parse(messages[messages.length - 1].content as string);
      expect(result.worldQueryResults[0].entity.spatial.shape).toEqual({ kind: 'circle', x: 5, z: 5, radius: 2 });
      expect(result.worldQueryResults[1].matches).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'zone:pond' })]));
      expect(result.worldQueryResults[0].sourceHash).toBe(result.worldQueryResults[1].sourceHash);
      return JSON.stringify(planFromContext(initial));
    });
    const service = new CgService(new CgStore(root), { chat });
    const map = mapFixture(); map.visualSemantics.zones.push({ id: 'pond', center: [5, 5], radius: 2, tags: ['water'], intensity: 1 });
    const created = await service.create(map, null);
    const planned = await service.plan(created.id, created.revision, '沿池塘行走');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(planned.document.shots).toHaveLength(2);
    expect(planned.mapSnapshot).toEqual(map);
  });

  it('bounds director world queries and preserves the project after query exhaustion', async () => {
    const chat = vi.fn(async () => JSON.stringify({ worldQueries: [{ type: 'summary' }] }));
    const service = new CgService(new CgStore(root), { chat });
    const created = await service.create(mapFixture(), null);
    await expect(service.plan(created.id, created.revision, '查看地图')).rejects.toMatchObject({ code: 'world_query_limit' });
    expect(chat).toHaveBeenCalledTimes(4);
    expect(await service.store.read(created.id)).toEqual(created);
  });

  it('sends placed spatial semantics while deduplicating repeated asset hierarchies', () => {
    const map = mapFixture();
    const modelJson = {
      nodes: [
        { id: 'trunk', name: '树干', transform: { pos: [0, 1, 0] }, tags: ['wood'] },
        { id: 'canopy', name: '树冠', parent: 'trunk', transform: { pos: [0, 2, 0] }, tags: ['foliage'] }
      ],
      _meta: { semanticSnapshot: { text: '一棵由树干和树冠组成的园林树。' } }
    };
    map.assets = [{
      id: 'garden-tree', name: '园林树', prompt: '中式园林中的树', tags: ['tree'], modelJson,
      colliderPlan: buildModelColliderPlan(modelJson), mode: 'json', createdAt: 1, updatedAt: 1
    }];
    const first = createMapObject('东侧园林树', 'garden-tree'); first.id = 'tree-east'; first.transform.position = [4, 0, 0];
    const second = createMapObject('西侧园林树', 'garden-tree'); second.id = 'tree-west'; second.transform.position = [-4, 0, 0];
    map.objects.push(first, second);

    const context = buildSemanticContext(map);
    expect(context.semanticIndex.spatialEntities.filter((entity) => entity.kind === 'object')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'object:tree-east', assetId: 'garden-tree', worldPosition: [4, 0, 0] }),
      expect.objectContaining({ id: 'object:tree-west', assetId: 'garden-tree', worldPosition: [-4, 0, 0] })
    ]));
    expect(context.semanticIndex.spatialEntities.some((entity) => entity.kind === 'model-part')).toBe(false);
    expect(context.semanticIndex.assetHierarchies).toEqual([expect.objectContaining({
      assetId: 'garden-tree', semanticSummary: '一棵由树干和树冠组成的园林树。',
      nodes: [
        expect.objectContaining({ id: 'trunk', name: '树干' }),
        expect.objectContaining({ id: 'canopy', name: '树冠', parent: 'trunk' })
      ]
    })]);
  });

  it('makes a local scoped camera edit without AI or changing independent action hashes', async () => {
    const chat = vi.fn(async () => { throw new Error('No remote call expected'); });
    const { service, project } = await demo(new CgService(new CgStore(root), { chat }));
    const refined = await service.refine(project.id, project.revision, '这个镜头改成特写', 'demo_shot_push');
    expect(refined.operations).toEqual([{ type: 'shot.update', id: 'demo_shot_push', patch: { camera: { framing: 'close-up', movement: 'static', reference: 'subject-facing', view: 'front-three-quarter', aim: 'eyes', lensMm: 85 } } }]);
    expect(refined.project.document.actions).toEqual(project.document.actions);
    const compiled = await service.compile(project.id, refined.project.revision);
    expect(compiled.candidate!.actions.map((a) => a.inputHash)).toEqual(project.candidate!.actions.map((a) => a.inputHash));
    expect(compiled.candidate!.changedNodeIds).toEqual(['demo_shot_push']);
    expect(chat).not.toHaveBeenCalled();
  });

  it('rejects both local changes to a locked duration and AI modifications outside the target', async () => {
    const chat = vi.fn(async () => JSON.stringify([{ type: 'shot.update', id: 'demo_shot_close', patch: { duration: 5 } }]));
    const { service, project } = await demo(new CgService(new CgStore(root), { chat }));
    const locked = await service.patch(project.id, project.revision, [{ type: 'constraint.upsert', constraint: { id: 'fixed-duration', source: 'user', strength: 'hard', type: 'shot-duration', targetId: 'demo_shot_push', seconds: 4 } }]);
    await expect(service.refine(project.id, locked.revision, '慢一点', 'demo_shot_push')).rejects.toMatchObject({ code: 'invalid_patch', status: 422 });
    expect(await service.store.read(project.id)).toEqual(locked);
    await expect(service.refine(project.id, locked.revision, '加强压迫感', 'demo_shot_push')).rejects.toMatchObject({ code: 'out_of_scope_patch' });
    expect(await service.store.read(project.id)).toEqual(locked);
    await expect(service.plan(project.id, locked.revision, '重新演示', true)).rejects.toMatchObject({ code: 'hard_constraints_present' });
  });

  it('protects manual anchors, restores WorldForge anchor facts by ID and rejects invented locations', async () => {
    const chat = vi.fn(async () => JSON.stringify([{ type: 'anchor.upsert', anchor: { id: 'demo_end', name: 'AI position', kind: 'point', position: [0, 0, 0] } }]));
    const { service, project } = await demo(new CgService(new CgStore(root), { chat }));
    await expect(service.refine(project.id, project.revision, '把终点换个位置')).rejects.toMatchObject({ code: 'invalid_ai_patch' });
    expect(await service.store.read(project.id)).toEqual(project);
    const other = new CgService(new CgStore(path.join(root, 'other')), { chat: async (messages) => { const doc = planFromContext(messages); doc.anchors[0].position = [99, 0, 0]; return JSON.stringify(doc); } });
    const created = await other.create(mapFixture(), null);
    const rebound = await other.plan(created.id, created.revision, 'A visitor walks');
    expect(rebound.document.anchors.find(anchor => anchor.id === 'map_stage_start')?.position).toEqual([0, 0, 0]);
    const invented = new CgService(new CgStore(path.join(root, 'invented')), { chat: async (messages) => {
      const doc = planFromContext(messages.slice(0, 2));
      doc.anchors[0] = { ...doc.anchors[0], id: 'invented_anchor' };
      return JSON.stringify(doc);
    } });
    const inventedProject = await invented.create(mapFixture(), null);
    await expect(invented.plan(inventedProject.id, inventedProject.revision, 'A visitor walks')).rejects.toMatchObject({ code: 'invalid_performance_plan' });
    expect(await invented.store.read(inventedProject.id)).toEqual(inventedProject);
  });

  it('uses map semantics and resolves missing assets once, reusing them across camera edits and reopened projects', async () => {
    const chat = vi.fn(async (messages) => JSON.stringify(planFromContext(messages)));
    const model = vi.fn(async () => structuredClone(generatedModel));
    const animation = vi.fn(async () => baked());
    const service = new CgService(new CgStore(root), { chat, model, animation });
    let project = await service.create(mapFixture(), null);
    project = await service.plan(project.id, project.revision, 'A visitor walks and waves.');
    const context = JSON.parse(chat.mock.calls[0][0][1].content);
    expect(chat.mock.calls[0][0][0].content).toContain('subject-motion');
    expect(chat.mock.calls[0][0][0].content).toContain('30 degrees');
    expect(context.map).toMatchObject({ axis: 'Y-up', units: 'metres', id: 'film-stage' });
    expect(context.map.anchors).toEqual(buildSemanticContext(mapFixture()).anchors);
    project = await service.compile(project.id, project.revision);
    expect(project.candidate?.validation.valid).toBe(true);
    expect(model).toHaveBeenCalledTimes(1); expect(animation).toHaveBeenCalledTimes(1);
    const resources = structuredClone(project.resources);
    const refined = await service.refine(project.id, project.revision, '特写', 'shot-two');
    project = await service.compile(project.id, refined.project.revision);
    expect(project.resources).toEqual(resources);
    expect(model).toHaveBeenCalledTimes(1); expect(animation).toHaveBeenCalledTimes(1);
    const second = await service.create(mapFixture(), null);
    const secondPlan = await service.plan(second.id, second.revision, 'A visitor walks and waves.');
    const secondCompile = await service.compile(second.id, secondPlan.revision);
    expect(secondCompile.candidate?.validation.valid).toBe(true);
    expect(model).toHaveBeenCalledTimes(1); expect(animation).toHaveBeenCalledTimes(1);
    const reopened = new CgService(new CgStore(root), { model, animation });
    await reopened.compile(project.id, project.revision);
    expect(model).toHaveBeenCalledTimes(1); expect(animation).toHaveBeenCalledTimes(1);
  });

  it('retains the draft without claiming success when a resource adapter fails', async () => {
    const service = new CgService(new CgStore(root), { chat: async (messages) => JSON.stringify(planFromContext(messages)), model: async () => { throw new Error('provider unavailable'); } });
    const initial = await service.create(mapFixture(), null);
    const planned = await service.plan(initial.id, 0, 'Generate an actor');
    await expect(service.compile(initial.id, planned.revision)).rejects.toThrow('provider unavailable');
    expect(await service.store.read(initial.id)).toEqual(planned);
    expect(service.progress.get(initial.id)).toMatchObject({ stage: 'error', running: false, message: 'provider unavailable' });
  });

  it('surfaces explicit unsupported intent/refine reasons without rewriting the saved draft', async () => {
    const chat = vi.fn(async () => JSON.stringify({ error: 'unsupported_intent', reason: 'Lip sync is not available.' }));
    const service = new CgService(new CgStore(root), { chat });
    const created = await service.create(mapFixture(), null);
    await expect(service.plan(created.id, 0, 'Make them speak with lip sync')).rejects.toMatchObject({ status: 422, code: 'unsupported_intent', message: 'Lip sync is not available.' });
    expect(await service.store.read(created.id)).toEqual(created);
    const planned = await service.plan(created.id, 0, '离线演示', true);
    chat.mockImplementation(async () => JSON.stringify({ error: 'unsupported_refine', reason: 'Socket attachment is not available.' }));
    await expect(service.refine(planned.id, planned.revision, 'Attach this to his hand')).rejects.toMatchObject({ status: 422, code: 'unsupported_refine', message: 'Socket attachment is not available.' });
    expect(await service.store.read(planned.id)).toEqual(planned);
  });

  it('recovers a roof-to-bridge sword handoff into a playable automatic CG', async () => {
    const map = mapFixture();
    const boxModel = (id: string, width: number, height: number, depth: number) => ({ version: '1.0', nodes: [{ id, name: id, transform: { pos: [0, height / 2, 0] }, mesh: { type: 'box', params: { width, height, depth } } }] });
    const roofAsset = { id: 'roof-model', name: '屋顶', prompt: '屋顶', modelJson: boxModel('roof', 4, 0.5, 4), colliderPlan: buildModelColliderPlan(boxModel('roof', 4, 0.5, 4)), mode: 'json' as const, createdAt: 1, updatedAt: 1 };
    const bridgeAsset = { id: 'bridge-model', name: '桥', prompt: '桥', modelJson: boxModel('deck', 6, 0.35, 2), colliderPlan: buildModelColliderPlan(boxModel('deck', 6, 0.35, 2)), mode: 'json' as const, createdAt: 1, updatedAt: 1 };
    map.assets = [roofAsset, bridgeAsset];
    const roof = createMapObject('屋顶', roofAsset.id); roof.id = 'roof'; roof.transform.position = [-5, 2, 0];
    const bridge = createMapObject('石桥', bridgeAsset.id); bridge.id = 'bridge'; bridge.transform.position = [3, 1, 0];
    map.objects = [roof, bridge];
    const mount = vi.fn(async (primary: unknown, _secondary: unknown, _description: string) => ({
      modelJson: { ...(structuredClone(primary) as object), nodes: [...(structuredClone(primary) as typeof generatedModel).nodes, { id: 'mounted-sword', name: '佩剑挂载组', parent: 'hand', mounted: true, transform: { pos: [0, 0, 0.2], scale: [0.1, 0.1, 0.1] } }] },
      mountedGroupId: 'mounted-sword'
    }));
    const animation = vi.fn(async () => baked());
    const service = new CgService(new CgStore(root), {
      chat: async () => JSON.stringify({ error: 'unsupported_intent', reason: 'legacy director cannot stage the handoff' }),
      model: async () => structuredClone(generatedModel), mount, animation
    });
    const created = await service.create(map, null);
    const planned = await service.plan(created.id, created.revision, '一位侠客从房顶上飞身落地，一直落到桥中心，在桥上已经有一位古风美女在等他。然后侠客从背后取下自己的剑交给美女。最后视角升起到全局，能发现有两个侍女在远处的树下看到了这一幕');
    expect(planned.document.actions.map(action => action.type)).toEqual(expect.arrayContaining(['airborne', 'attach', 'handoff']));
    expect(planned.document.actions.filter(action => action.type === 'animate')).toHaveLength(5);
    expect(planned.document.shots).toHaveLength(3);
    const compiled = await service.compile(planned.id, planned.revision);
    expect(compiled.candidate?.validation).toEqual({ valid: true, diagnostics: [] });
    expect(compiled.resources.assemblies).toHaveLength(3);
    expect(compiled.resources.clips).toHaveLength(5);
    expect(mount).toHaveBeenCalledTimes(3);
    expect(animation).toHaveBeenCalledTimes(4);
    const before = evaluateCG(compiled.candidate!, 4.2).entities.sword;
    const after = evaluateCG(compiled.candidate!, 5.8).entities.sword;
    expect(before.attachedTo).toBe('hero');
    expect(after.attachedTo).toBe('heroine');
    expect(evaluateCG(compiled.candidate!, 1.8).entities.hero.position[1]).toBeGreaterThan(Math.max(roof.transform.position[1], bridge.transform.position[1]));
    const reveal = compiled.candidate!.shots.at(-1)!;
    expect(evaluateCG(compiled.candidate!, reveal.end - 1e-3).camera.position[1]).toBeGreaterThan(evaluateCG(compiled.candidate!, reveal.start).camera.position[1]);
  });
});

describe('3d-generate baked animation decoder', () => {
  it('uses a visible semantic-node fallback when a quick animation request fails', async () => {
    const originalFetch = globalThis.fetch;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'GENERATION_FAILED' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    try {
      const rig = { version: '1.0', nodes: [
        { id: 'body', name: 'body', transform: { pos: [0, 0, 0] } },
        { id: 'head', name: 'head', parent: 'body', transform: { pos: [0, 1.5, 0] } },
        { id: 'rightUpperArm', name: '执剑侧上臂', parent: 'body', transform: { pos: [0.4, 1, 0] } },
        { id: 'body_mesh', parent: 'body', transform: { pos: [0, 0.9, 0] }, mesh: { type: 'box', params: { width: 0.5, height: 1.8, depth: 0.4 } } }
      ] };
      const result = await requestBakedAnimation(rig, '转头看向桥上的两个人', 2) as { _cgFallback?: boolean; duration?: number; animation?: Record<string, unknown> };
      expect(result._cgFallback).toBe(true);
      expect(result.duration).toBe(2);
      expect(result.animation).toHaveProperty('head');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('preserves Euler and position deltas with missing axes defaulted, and absolute quaternion tracks', () => {
    const value = baked();
    const clip = decodeBakedClip(value, identity, generatedModel);
    expect(clip).toMatchObject({ ...identity, fps: 2, duration: 3, rootMotion: 'in-place', source: 'generated' });
    expect(clip.tracks.hand.rotation?.[3]).toEqual([0.4, 0, 0]);
    expect(clip.tracks.hand.position?.[3]).toEqual([0, 0, 0]);
    const q = Math.SQRT1_2, values = Array(7).fill(q), zeros = Array(7).fill(0);
    const quaternion = decodeBakedClip({ ...value, animation: { hand: { quatX: zeros, quatY: values, quatZ: zeros, quatW: values, rotX: Array(7).fill(100) } } }, identity, generatedModel);
    expect(quaternion.tracks.hand.quaternion?.[4]).toEqual([0, q, 0, q]);
    expect(quaternion.tracks.hand.rotation).toBeUndefined();
  });

  it.each([
    ['root horizontal motion', { body: { posX: [0, 0, 0, 0.2, 0, 0, 0] } }, 'root_motion_conflict'],
    ['unknown model node', { unknown: { rotX: [0, 0, 0, 0, 0, 0, 0] } }, 'unknown_animation_node'],
    ['unequal arrays', { hand: { rotX: [0, 0, 0, 0, 0, 0, 0], posY: [0, 0] } }, 'invalid_animation_samples'],
    ['nonfinite samples', { hand: { rotX: [0, 0, NaN, 0, 0, 0, 0] } }, 'invalid_animation_samples'],
    ['incomplete quaternion', { hand: { quatX: [0, 0, 0, 0, 0, 0, 0] } }, 'invalid_quaternion_track'],
    ['unnormalized quaternion', { hand: { quatX: Array(7).fill(0), quatY: Array(7).fill(0), quatZ: Array(7).fill(0), quatW: Array(7).fill(2) } }, 'invalid_quaternion_track'],
    ['negative scale', { hand: { scaleX: [1, 1, -1, 1, 1, 1, 1] } }, 'invalid_scale_track'],
    ['unsupported track', { hand: { opacity: [1, 1, 1, 1, 1, 1, 1] } }, 'unsupported_animation_track'],
    ['empty animation', {}, 'empty_animation']
  ])('rejects %s', (_label, animation, code) => {
    expect(() => decodeBakedClip({ ...baked(), animation }, identity, generatedModel)).toThrow(expect.objectContaining({ code }));
  });

  it('strips generated root X/Z drift only when compiling a locomotion cycle', () => {
    const samples = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3];
    const clip = decodeBakedClip({ ...baked(), animation: { body: { posX: samples, posY: Array(7).fill(0.04), posZ: samples } } }, identity, generatedModel, { stripRootHorizontal: true });
    expect(clip.tracks.body.position?.[6]).toEqual([0, 0.04, 0]);
  });

  it('rejects unsupported effects and malformed model definitions', () => {
    expect(() => decodeBakedClip({ ...baked(), effects: [{ type: 'fire' }] }, identity, generatedModel)).toThrow(expect.objectContaining({ code: 'unsupported_clip_effects' }));
    expect(() => decodeBakedClip(baked(), identity, { nodes: [] })).toThrow(expect.objectContaining({ code: 'invalid_generated_model' }));
    expect(() => decodeBakedClip(baked(), identity, { nodes: [null] })).toThrow(expect.objectContaining({ code: 'invalid_generated_model' }));
  });
});

describe('CG HTTP API', () => {
  let server: http.Server;
  let base: string;
  let mapStore: MapStore;
  beforeEach(async () => {
    mapStore = new MapStore({ rootDir: path.join(root, 'maps'), starterDataDir: null });
    server = http.createServer((req, res) => {
      void (async () => {
        if (await handleCgHttp(req, res, mapStore)) return;
        if (await handleMapHttp(req, res, mapStore)) return;
        res.writeHead(404); res.end();
      })().catch(() => { res.writeHead(500); res.end(); });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/cg`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }); });
  const post = async (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5182' }, body: JSON.stringify(body) });

  it('exposes the standalone foundation demo through the complete confirm/export/reopen protocol', async () => {
    const created = await post(`${base}/foundation-demo`, {});
    expect(created.status).toBe(201);
    const project: CgProject = await created.json();
    expect(project.document.schemaVersion).toBe(2);
    expect(project.candidate?.validation.valid).toBe(true);
    expect(evaluateCG(project.candidate!, 13).entities.boy.posture).toBe('seated');
    expect(project.confirmed).toBeNull();
    const confirmed = await post(`${base}/projects/${project.id}/confirm`, { revision: project.revision, compileId: project.candidate!.id, inputHash: project.candidate!.inputHash });
    expect(confirmed.status).toBe(200);
    const exported = await (await fetch(`${base}/projects/${project.id}/export`)).json();
    expect(exported.performance.occupancy).toHaveLength(1);
    const reopened = await (await fetch(`${base}/projects/${project.id}`)).json();
    expect(reopened.confirmed.id).toBe(exported.id);
  });

  it('serves read-only world queries and rejects stale geometry after map synchronization', async () => {
    const map = mapFixture(); map.visualSemantics.zones.push({ id: 'stage', center: [5, 5], radius: 2, tags: ['clear'], intensity: 1 });
    const project: CgProject = await (await post(`${base}/projects`, { map })).json();
    const url = `${base}/projects/${project.id}`;
    const world = await (await fetch(`${url}/world`)).json();
    expect(world.regions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'zone:stage' })]));
    const query = { revision: project.revision, sourceHash: world.sourceHash, query: { type: 'point', position: [5, 5] } };
    const response = await post(`${url}/world-query`, query);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ matches: expect.arrayContaining([expect.objectContaining({ id: 'zone:stage' })]) });
    expect(await (await fetch(url)).json()).toEqual(project);
    expect((await post(`${url}/world-query`, { ...query, query: { type: 'point', position: [1] } })).status).toBe(400);
    map.visualSemantics.zones[0].center = [-5, -5];
    const sync = await (await post(`${url}/sync-map`, { revision: project.revision, map })).json();
    expect((await post(`${url}/world-query`, query)).status).toBe(409);
    expect((await post(`${url}/world-query`, { ...query, revision: sync.project.revision })).status).toBe(409);
    const next = await (await fetch(`${url}/world`)).json();
    expect(next.sourceHash).not.toBe(world.sourceHash);
    expect(next.regions.find((r: { id: string }) => r.id === 'zone:stage').spatial.shape).toMatchObject({ x: -5, z: -5 });
  });

  it('keeps WorldForge transactions isolated from CG projects and rejects retired director routes', async () => {
    const editor = base.replace('/api/cg', '/api/editor');
    const created = await post(`${editor}/maps`, { name: 'Independent WorldForge map', size: [24, 10, 24] });
    expect(created.status).toBe(201);
    const { map } = await created.json();
    const object = createMapObject('Stage marker');
    const transaction = await post(`${editor}/maps/${map.id}/transactions`, {
      source: 'manual', label: 'Place marker', operations: [{ type: 'object.add', object }]
    });
    expect(transaction.status).toBe(200);
    const source = await (await fetch(`${editor}/maps/${map.id}`)).json();
    expect(source.map.objects).toHaveLength(1);
    const response = await post(`${base}/projects`, { map: source.map, scheme: null });
    expect(response.status).toBe(201);
    const project: CgProject = await response.json();
    const planned = await post(`${base}/projects/${project.id}/plan`, { revision: project.revision, prompt: '离线演示', demo: true });
    expect(planned.status).toBe(200);
    expect((await planned.json()).document.shots.length).toBeGreaterThan(0);
    expect(await (await fetch(`${editor}/maps/${map.id}`)).json()).toEqual(source);
    const capabilities = await (await fetch(`${base}/capabilities`)).json();
    expect(capabilities.constraints).toEqual(expect.arrayContaining(['action-route', 'camera-path']));
    for (const response of [
      await fetch(`${editor}/cinematics`),
      await post(`${editor}/cinematics`, {}),
      await post(`${editor}/maps/${map.id}/director/plan`, { prompt: 'Retired endpoint must not invoke AI' })
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'not_found' });
    }
    expect(await readdir(path.join(root, 'maps'))).not.toContain('cinematics');
  });

  it('syncs a newer WorldForge snapshot while preserving director intent, hard constraints, resources and confirmation', async () => {
    const setup = await demo(), service = setup.service;
    let project = await service.confirm(setup.project.id, setup.project.revision, setup.project.candidate!.id, setup.project.candidate!.inputHash);
    project = await service.patch(project.id, project.revision, [{ type: 'constraint.upsert', constraint: { id: 'fixed-opening', source: 'user', strength: 'hard', type: 'shot-duration', targetId: 'demo_shot_wide', seconds: 6 } }]);
    const before = structuredClone(project);
    const map = structuredClone(project.mapSnapshot);
    const prop = createMapObject('New pavilion prop'); prop.id = 'new-prop'; prop.transform.position = [3, 0, -2];
    map.objects.push(prop);
    map.terrain.heights[0] += 0.5;
    map.version += 1;
    map.updatedAt += 1000;
    const scheme = structuredClone(BUILTIN_RENDER_SCHEMES[0]);
    const result = await service.syncMap(project.id, project.revision, map, scheme);
    expect(result.summary).toMatchObject({ addedObjectIds: ['new-prop'], removedObjectIds: [], changedObjectIds: [], worldChanged: true, schemeChanged: true });
    expect(result.project.mapSnapshot).toEqual(map);
    expect(result.project.schemeSnapshot).toEqual(scheme);
    expect(result.project.document).toEqual(before.document);
    expect(result.project.resources).toEqual(before.resources);
    expect(result.project.confirmed).toEqual(before.confirmed);
    expect(result.project.candidate).toBeNull();
    expect(result.project.mapSync).toMatchObject({ sourceMapVersion: map.version, sourceMapUpdatedAt: map.updatedAt, summary: result.summary });
    const compiled = await service.compile(result.project.id, result.project.revision);
    expect(compiled.candidate?.validation.valid).toBe(true);
    expect(compiled.candidate?.map.objects.some((object) => object.id === 'new-prop')).toBe(true);
    expect(compiled.confirmed).toEqual(before.confirmed);
  });

  it('rejects synchronizing a different WorldForge map and reports stable object-level differences', async () => {
    const service = new CgService(new CgStore(root));
    const project = await service.create(mapFixture(), null);
    const other = mapFixture(); other.id = 'another-map';
    await expect(service.syncMap(project.id, project.revision, other, null)).rejects.toMatchObject({ code: 'map_mismatch' });
    expect(await service.store.read(project.id)).toEqual(project);
    const changed = structuredClone(project.mapSnapshot);
    const object = createMapObject('Rock'); object.id = 'rock'; changed.objects.push(object);
    const next = structuredClone(changed); next.objects[0].visible = false;
    expect(summarizeMapSync(changed, next, null, null)).toMatchObject({ addedObjectIds: [], removedObjectIds: [], changedObjectIds: ['rock'], worldChanged: false, schemeChanged: false });
  });

  it('keeps the last confirmed playback when a synchronized map removes a bound object', async () => {
    const service = new CgService(new CgStore(root));
    const map = mapFixture();
    const bound = createMapObject('Bound actor', 'cg_demo_actor_asset'); bound.id = 'bound-actor'; map.objects.push(bound);
    let project = await service.create(map, null);
    project = await service.plan(project.id, project.revision, '离线演示', true);
    project = await service.store.transaction(project.id, project.revision, (draft) => { draft.document.entities[0].objectId = 'bound-actor'; });
    project = await service.compile(project.id, project.revision);
    expect(project.candidate?.validation.valid).toBe(true);
    project = await service.confirm(project.id, project.revision, project.candidate!.id, project.candidate!.inputHash);
    const confirmed = structuredClone(project.confirmed);
    const nextMap = structuredClone(project.mapSnapshot); nextMap.objects = []; nextMap.version += 1; nextMap.updatedAt += 1;
    const synced = await service.syncMap(project.id, project.revision, nextMap, null);
    project = await service.compile(synced.project.id, synced.project.revision);
    expect(project.candidate?.validation.valid).toBe(false);
    expect(project.candidate?.validation.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_object', message: expect.stringContaining('bound-actor'), nodeIds: expect.arrayContaining(['demo_actor']) })]));
    expect(project.confirmed).toEqual(confirmed);
  });

  it('serves the complete demo → compile → confirm → export → reopen flow', async () => {
    let response = await post(`${base}/projects`, { map: mapFixture(), scheme: null });
    expect(response.status).toBe(201); expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5182');
    let project: CgProject = await response.json();
    expect((await fetch(`${base}/projects/${project.id}/export`)).status).toBe(409);
    response = await post(`${base}/projects/${project.id}/plan`, { revision: project.revision, prompt: '离线演示', demo: true }); project = await response.json();
    expect(response.status).toBe(200);
    response = await post(`${base}/projects/${project.id}/compile`, { revision: project.revision }); project = await response.json();
    expect(response.status).toBe(200); expect(project.candidate?.validation.valid).toBe(true);
    response = await post(`${base}/projects/${project.id}/confirm`, { revision: project.revision, compileId: project.candidate!.id, inputHash: project.candidate!.inputHash }); project = await response.json();
    expect(response.status).toBe(200);
    const exported = await fetch(`${base}/projects/${project.id}/export`);
    expect(exported.headers.get('content-disposition')).toContain('.cg.json');
    expect(await exported.json()).toEqual(project.confirmed);
    expect(await (await fetch(`${base}/projects/${project.id}`)).json()).toEqual(project);
    expect(await (await fetch(`${base}/projects`)).json()).toMatchObject({ projects: [{ id: project.id, confirmed: true }] });
    expect(await (await fetch(`${base}/projects/${project.id}/progress`)).json()).toMatchObject({ stage: 'ready', running: false });
    expect((await fetch(`${base}/capabilities`)).status).toBe(200);
  });

  it('exposes durable one-click runs and their immutable artifacts', async () => {
    let response = await post(`${base}/projects`, { map: mapFixture(), scheme: null });
    let project: CgProject = await response.json();
    response = await post(`${base}/projects/${project.id}/runs`, { revision: project.revision, prompt: '角色走向场景中央，镜头跟随并切换到特写。', demo: true });
    expect(response.status).toBe(200);
    const generated = await response.json();
    project = generated.project;
    expect(generated.run).toMatchObject({ projectId: project.id, status: 'preview-ready', phase: 'preview-ready' });
    expect(project.candidate!.validation.valid).toBe(true);
    const history = await (await fetch(`${base}/projects/${project.id}/runs`)).json();
    expect(history.runs[0].id).toBe(generated.run.id);
    const reopened = await (await fetch(`${base}/projects/${project.id}/runs/${generated.run.id}`)).json();
    expect(reopened.tasks.every((task: { status: string }) => task.status === 'completed')).toBe(true);
    const artifactId = reopened.artifacts.find((item: { kind: string }) => item.kind === 'world-knowledge').id;
    const artifact = await (await fetch(`${base}/projects/${project.id}/runs/${generated.run.id}/artifacts/${artifactId}`)).json();
    expect(artifact).toMatchObject({ id: artifactId, producer: 'world', content: { mapId: mapFixture().id } });
    response = await post(`${base}/projects/${project.id}/confirm`, { revision: project.revision, compileId: project.candidate!.id, inputHash: project.candidate!.inputHash });
    expect(response.status).toBe(200);
    expect((await (await fetch(`${base}/projects/${project.id}/runs/${generated.run.id}`)).json()).status).toBe('confirmed');
  });

  it('syncs the current WorldForge snapshot through the project API and invalidates only the candidate', async () => {
    let response = await post(`${base}/projects`, { map: mapFixture(), scheme: null });
    let project: CgProject = await response.json();
    response = await post(`${base}/projects/${project.id}/plan`, { revision: project.revision, prompt: '离线演示', demo: true }); project = await response.json();
    response = await post(`${base}/projects/${project.id}/compile`, { revision: project.revision }); project = await response.json();
    response = await post(`${base}/projects/${project.id}/confirm`, { revision: project.revision, compileId: project.candidate!.id, inputHash: project.candidate!.inputHash }); project = await response.json();
    const confirmed = structuredClone(project.confirmed);
    const map = structuredClone(project.mapSnapshot);
    const marker = createMapObject('Synced marker'); marker.id = 'synced-marker'; map.objects.push(marker); map.version += 1; map.updatedAt += 1;
    response = await post(`${base}/projects/${project.id}/sync-map`, { revision: project.revision, map, scheme: BUILTIN_RENDER_SCHEMES[0] });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.summary.addedObjectIds).toEqual(['synced-marker']);
    expect(result.project).toMatchObject({ candidate: null, confirmed, mapSnapshot: { id: map.id, version: map.version } });
  });

  it('returns actionable status codes for bad revisions, bad patches, missing assets and remote origins', async () => {
    const { project } = await demo(cgServiceFor(mapStore));
    let response = await post(`${base}/projects/${project.id}/compile`, {});
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: 'revision_required' });
    response = await post(`${base}/projects/${project.id}/compile`, { revision: 0 });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: 'revision_conflict' });
    response = await post(`${base}/projects/${project.id}/patch`, { revision: project.revision, operations: [{ type: 'shot.update', id: 'not-a-shot', patch: { duration: 4 } }] });
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: 'invalid_patch' });
    const missing = mapFixture(); missing.objects.push(createMapObject('Missing', 'missing-asset'));
    response = await post(`${base}/projects`, { map: missing });
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: 'missing_map_asset' });
    response = await fetch(`${base}/projects`, { headers: { Origin: 'https://untrusted.example' } });
    expect(response.status).toBe(403);
    response = await fetch(`${base}/projects`, { method: 'POST', body: '{' }); expect(response.status).toBe(400);
    response = await fetch(`${base}/projects/${project.id}/patch`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5182' } });
    expect(response.status).toBe(204);
  });
});
