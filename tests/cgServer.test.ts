import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import { evaluateCG, stableHash } from '../src/shared/cgCompiler';
import type { CgClip, CgProject, DirectorDocument } from '../src/shared/cgTypes';
import { BUILTIN_RENDER_SCHEMES } from '../src/shared/renderScheme';
import { CgService, buildSemanticContext, decodeBakedClip } from '../src/server/cgService';
import { CgStore } from '../src/server/cgStore';
import { cgServiceFor, handleCgHttp } from '../src/server/cgHttp';
import { MapStore } from '../src/server/mapStore';
import type { ChatMessage } from '../src/server/modelApi';

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
  it('makes a local scoped camera edit without AI or changing independent action hashes', async () => {
    const chat = vi.fn(async () => { throw new Error('No remote call expected'); });
    const { service, project } = await demo(new CgService(new CgStore(root), { chat }));
    const refined = await service.refine(project.id, project.revision, '这个镜头改成特写', 'demo_shot_push');
    expect(refined.operations).toEqual([{ type: 'shot.update', id: 'demo_shot_push', patch: { camera: { framing: 'close-up' } } }]);
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

  it('protects exact manual anchors from AI and rejects invented locations during planning', async () => {
    const chat = vi.fn(async () => JSON.stringify([{ type: 'anchor.upsert', anchor: { id: 'demo_end', name: 'AI position', kind: 'point', position: [0, 0, 0] } }]));
    const { service, project } = await demo(new CgService(new CgStore(root), { chat }));
    await expect(service.refine(project.id, project.revision, '把终点换个位置')).rejects.toMatchObject({ code: 'invalid_ai_patch' });
    expect(await service.store.read(project.id)).toEqual(project);
    const other = new CgService(new CgStore(path.join(root, 'other')), { chat: async (messages) => { const doc = planFromContext(messages); doc.anchors[0].position = [99, 0, 0]; return JSON.stringify(doc); } });
    const created = await other.create(mapFixture(), null);
    await expect(other.plan(created.id, created.revision, 'A visitor walks')).rejects.toMatchObject({ code: 'invented_anchor' });
    expect(await other.store.read(created.id)).toEqual(created);
  });

  it('uses map semantics and resolves missing assets once, reusing them across camera edits and reopened projects', async () => {
    const chat = vi.fn(async (messages) => JSON.stringify(planFromContext(messages)));
    const model = vi.fn(async () => structuredClone(generatedModel));
    const animation = vi.fn(async () => baked());
    const service = new CgService(new CgStore(root), { chat, model, animation });
    let project = await service.create(mapFixture(), null);
    project = await service.plan(project.id, project.revision, 'A visitor walks and waves.');
    const context = JSON.parse(chat.mock.calls[0][0][1].content);
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
});

describe('3d-generate baked animation decoder', () => {
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
    server = http.createServer((req, res) => { void handleCgHttp(req, res, mapStore).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }); });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/cg`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }); });
  const post = async (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5182' }, body: JSON.stringify(body) });

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
