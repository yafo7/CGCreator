import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import { buildModelColliderPlan } from '../src/shared/modelBounds';
import type { DirectorDocument } from '../src/shared/cgTypes';
import type { ChatMessage } from '../src/server/modelApi';
import { CgDirectorAgent } from '../src/server/cgDirectorAgent';
import { buildWorldSemanticIndex } from '../src/shared/cgWorldSemantics';
import { CgArtifactStore, artifactContentHash } from '../src/server/cgArtifactStore';
import { CgRunStore } from '../src/server/cgRunStore';
import { createCgTaskGraph, assertTaskCanStart, downstreamTaskIds } from '../src/server/cgTaskGraph';
import { CgService } from '../src/server/cgService';
import { CgStore } from '../src/server/cgStore';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'cgcreator-agents-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('durable multi-agent generation kernel', () => {
  it('writes immutable content-hashed artifacts with provenance', async () => {
    const store = new CgArtifactStore(root);
    const content = { answer: 42, nested: { stable: true } };
    const ref = await store.create({ kind: 'world-bootstrap', producer: 'world', runId: 'run_one', projectId: 'cg_one', projectRevision: 2, mapId: 'map_one', mapVersion: 3, provenance: [{ source: 'worldforge', sourceId: 'map_one', hash: 'source-hash' }], content });
    content.nested.stable = false;
    const saved = await store.read<typeof content>(ref.id);
    expect(saved.content).toEqual({ answer: 42, nested: { stable: true } });
    expect(saved.contentHash).toBe(artifactContentHash(saved.content));
    expect(saved).toMatchObject({ producer: 'world', runId: 'run_one', projectRevision: 2, mapVersion: 3, provenance: [{ source: 'worldforge' }] });
  });

  it('enforces dependencies and calculates only downstream invalidation', () => {
    const tasks = createCgTaskGraph();
    expect(() => assertTaskCanStart(tasks, 'production')).toThrow('waiting for preproduction');
    tasks.find(task => task.id === 'world-bootstrap')!.status = 'completed';
    expect(assertTaskCanStart(tasks, 'preproduction').agent).toBe('director');
    expect(downstreamTaskIds(tasks, ['camera'])).toEqual(['camera', 'negotiation', 'compile', 'validate', 'preview']);
    expect(downstreamTaskIds(tasks, ['production'])).toContain('readiness');
    expect(downstreamTaskIds(tasks, ['production'])).not.toContain('world-deep-read');
  });

  it('blocks required production fallbacks but permits an explicit approximable fallback', () => {
    const director = new CgDirectorAgent(), map = createEmptyMap('Gate', 'gate-map');
    const baseRequirement = { id: 'motion:hero-jump', kind: 'motion' as const, name: '飞身', description: '飞身落地', entityId: 'hero', actionId: 'hero-jump', evidenceRefs: [] };
    const plan = { schemaVersion: 1 as const, prompt: '飞身', documentId: 'director', documentRevision: 1, synopsis: '飞身', requirements: [{ ...baseRequirement, fidelity: 'required' as const }], worldQuestions: [], protectedConstraintIds: [] };
    const index = buildWorldSemanticIndex(map);
    const world = { schemaVersion: 1 as const, mapId: map.id, mapVersion: map.version, sourceHash: index.sourceHash, index, referencedEntityIds: [], evidence: [], unresolved: [] };
    const production = { schemaVersion: 1 as const, resources: { models: [], clips: [] }, models: [], motions: [], assemblies: [], evidence: [], unresolved: [{ requirementId: baseRequirement.id, fidelity: 'required' as const, reason: '只有程序化降级动作' }] };
    expect(director.readiness(plan, world, production)).toMatchObject({ ready: false, checks: [{ status: 'blocked' }] });
    const approximable = { ...plan, requirements: [{ ...baseRequirement, fidelity: 'approximable' as const }] };
    expect(director.readiness(approximable, world, { ...production, unresolved: [{ ...production.unresolved[0], fidelity: 'approximable' as const }] })).toMatchObject({ ready: true, checks: [{ status: 'fallback' }] });
  });

  it('runs the complete one-click workflow, survives restart and records confirmation', async () => {
    const service = new CgService(new CgStore(root));
    const map = createEmptyMap('Agent stage', 'agent-stage', [24, 10, 24]);
    const created = await service.create(map, null);
    const result = await service.generate(created.id, created.revision, '角色走向场景中央，镜头跟随并切换到特写。', true);
    expect(result.run.status).toBe('preview-ready');
    expect(result.run.phase).toBe('preview-ready');
    expect(result.run.tasks.every(task => task.status === 'completed')).toBe(true);
    expect(result.run.artifacts.map(item => item.kind)).toEqual(expect.arrayContaining(['world-bootstrap', 'preproduction-plan', 'world-knowledge', 'production-package', 'readiness-gate', 'director-document', 'performance-plan', 'camera-plan', 'compiled-cg', 'validation-report', 'timeline']));
    expect(result.project.candidate?.validation.valid).toBe(true);
    expect(result.project.candidate?.stage).not.toBe('performance');

    const restartedRuns = new CgRunStore(root);
    expect(await restartedRuns.read(result.run.id)).toEqual(result.run);
    const artifact = await new CgArtifactStore(root).read(result.run.artifacts[0].id);
    expect(artifact.contentHash).toBe(result.run.artifacts[0].contentHash);

    const confirmed = await service.confirm(result.project.id, result.project.revision, result.project.candidate!.id, result.project.candidate!.inputHash);
    expect(confirmed.confirmed?.id).toBe(result.project.candidate!.id);
    expect((await restartedRuns.read(result.run.id)).status).toBe('confirmed');
  });

  it('resumes a failed run after a service restart', async () => {
    const first = new CgService(new CgStore(root));
    const created = await first.create(createEmptyMap('Resume stage', 'resume-stage', [20, 8, 20]), null);
    const now = Date.now(), runId = 'run_resume_fixture';
    await first.orchestrator.runs.create({
      schemaVersion: 1, id: runId, projectId: created.id, projectRevision: created.revision, mapId: created.mapSnapshot.id, mapVersion: created.mapSnapshot.version,
      prompt: '角色走向场景中央，镜头跟随。', demo: true, status: 'failed', phase: 'failed', tasks: createCgTaskGraph(), artifacts: [], diagnostics: [],
      negotiationRound: 0, maxNegotiationRounds: 2, repairAttempt: 0, maxRepairAttempts: 2, createdAt: now, updatedAt: now, completedAt: now
    });
    const restarted = new CgService(new CgStore(root));
    const result = await restarted.orchestrator.resume(runId);
    expect(result.run).toMatchObject({ id: runId, status: 'preview-ready', projectId: created.id });
    expect(result.run.tasks.every(task => task.status === 'completed')).toBe(true);
    expect(result.project.candidate?.validation.valid).toBe(true);
  });

  it('creates a new garden performance through all five planning agents', async () => {
    const box = (id: string, width: number, height: number, depth: number) => ({ version: '1.0', nodes: [{ id, name: id, transform: { pos: [0, height / 2, 0] }, mesh: { type: 'box', params: { width, height, depth } } }] });
    const map = createEmptyMap('中式园林测试场', 'garden-agent-stage', [30, 10, 24]);
    const pavilionModel = box('pavilion-floor', 4, 0.4, 4), pondModel = box('pond-edge', 2, 0.3, 2);
    map.assets = [
      { id: 'pavilion-asset', name: '凉亭', prompt: '中式木制凉亭', tags: ['凉亭', 'pavilion'], modelJson: pavilionModel, colliderPlan: buildModelColliderPlan(pavilionModel), mode: 'json', provider: 'worldforge', createdAt: 1, updatedAt: 1 },
      { id: 'pond-edge-asset', name: '池塘边', prompt: '池塘边石台', tags: ['池塘', '石台'], modelJson: pondModel, colliderPlan: buildModelColliderPlan(pondModel), mode: 'json', provider: 'worldforge', createdAt: 1, updatedAt: 1 }
    ];
    const pavilion = createMapObject('凉亭', 'pavilion-asset'); pavilion.id = 'pavilion'; pavilion.transform.position = [-6, 0, -4];
    const pondEdge = createMapObject('池塘边石台', 'pond-edge-asset'); pondEdge.id = 'pond-edge'; pondEdge.transform.position = [9, 0, 5];
    map.objects = [pavilion, pondEdge];
    map.guides.push({ id: 'garden-path', name: '园林石子路', points: [[-8, 2], [0, 2], [6, 2]], curve: 'catmull-rom', closed: false, width: 2.4, tags: ['道路', '石子路', 'walkable'] });
    map.guides.push({ id: 'pavilion-path', name: '凉亭通向池塘的小路', points: [[-3, -4], [-2, -1], [0, 2]], curve: 'catmull-rom', closed: false, width: 2.2, tags: ['道路', '凉亭', 'walkable'] });

    const actorModel = { version: '1.0', nodes: [
      { id: 'body', name: 'body', transform: { pos: [0, 0.9, 0] }, mesh: { type: 'box', params: { width: 0.55, height: 1.8, depth: 0.4 } } },
      { id: 'right_arm', name: 'right arm', parent: 'body', transform: { pos: [0.42, 0.2, 0] } },
      { id: 'right_hand', name: 'right hand', parent: 'right_arm', transform: { pos: [0, -0.45, 0] } },
      { id: 'head', name: 'head face eyes', parent: 'body', transform: { pos: [0, 0.75, 0.02] }, mesh: { type: 'box', params: { width: 0.35, height: 0.35, depth: 0.35 } } }
    ] };
    const baked = (duration: number) => {
      const count = Math.ceil(duration * 2) + 1;
      return { fps: 2, duration, loop: false, animation: { right_arm: { rotX: Array.from({ length: count }, (_, index) => Math.sin(index / Math.max(1, count - 1) * Math.PI) * -0.7) } } };
    };
    let directorCalls = 0;
    const chat = async (messages: ChatMessage[]) => {
      directorCalls += 1;
      if (directorCalls > 1) return '[]';
      const context = JSON.parse(messages.at(-1)!.content as string);
      const anchors = context.map.anchors as DirectorDocument['anchors'];
      const pathStart = anchors.find(anchor => anchor.id === 'map_guide:garden-path:start')!;
      const pathMiddle = anchors.find(anchor => anchor.id === 'map_guide:garden-path:middle')!;
      const pathEnd = anchors.find(anchor => anchor.id === 'map_guide:garden-path:end')!;
      const pavilionPathStart = anchors.find(anchor => anchor.id === 'map_guide:pavilion-path:start')!;
      const pavilionPathEnd = anchors.find(anchor => anchor.id === 'map_guide:pavilion-path:end')!;
      const pavilionSide = anchors.find(anchor => anchor.id === 'map_surface:pavilion:side')!;
      const document: DirectorDocument = {
        schemaVersion: 2, ...context.documentIdentity, title: '园林灯笼相遇', sourcePrompt: context.intent,
        entities: [
          { id: 'girl', name: '青衣少女', kind: 'actor', assetId: 'asset-girl', startAnchorId: pathStart.id, height: 1.68, description: '穿青色古装的年轻女子' },
          { id: 'elder', name: '提灯老人', kind: 'actor', assetId: 'asset-elder', startAnchorId: pavilionPathStart.id, height: 1.72, description: '穿深色长袍的老人' },
          { id: 'lantern', name: '灯笼', kind: 'prop', assetId: 'asset-lantern', startAnchorId: pavilionSide.id, height: 0.55, description: '暖黄色中式手提灯笼' }
        ],
        anchors: [pathStart, pathMiddle, pathEnd, pavilionPathStart, pavilionPathEnd, pavilionSide],
        actions: [
          { id: 'lantern-in-hand', entityId: 'lantern', type: 'attach', targetEntityId: 'elder', socketId: 'right-hand', start: { kind: 'absolute', seconds: 0 }, duration: 0, purpose: '老人右手提着灯笼' },
          { id: 'girl-walk', entityId: 'girl', type: 'move', start: { kind: 'absolute', seconds: 0 }, duration: 8, targetAnchorId: pathEnd.id, clipId: 'clip-girl-walk', route: { guideIds: ['garden-path'], policy: 'required', locomotion: 'walk', maxSpeed: 2 }, purpose: '少女沿石子路走到池塘边' },
          { id: 'elder-walk', entityId: 'elder', type: 'move', start: { kind: 'absolute', seconds: 1.2 }, duration: 4.5, targetAnchorId: pavilionPathEnd.id, clipId: 'clip-elder-walk', route: { guideIds: ['pavilion-path'], policy: 'required', locomotion: 'walk', maxSpeed: 1.7 }, purpose: '老人从凉亭方向沿小路走来' },
          { id: 'elder-raise-lantern', entityId: 'elder', type: 'animate', clipId: 'clip-elder-raise', propEntityId: 'lantern', start: { kind: 'after', id: 'elder-walk' }, duration: 1.8, purpose: '老人举起右手的灯笼为少女照亮' },
          { id: 'girl-turn', entityId: 'girl', type: 'face', start: { kind: 'after', id: 'girl-walk' }, duration: 0.6, targetAnchorId: pathMiddle.id, purpose: '少女转身看向老人' },
          { id: 'girl-nod', entityId: 'girl', type: 'animate', clipId: 'clip-girl-nod', start: { kind: 'after', id: 'girl-turn' }, duration: 1.2, purpose: '少女向老人自然点头' },
          { id: 'garden-reveal', entityId: 'girl', type: 'hold', start: { kind: 'after', id: 'girl-nod' }, duration: 2.2, purpose: '从两人身后升起，同时揭示池塘、假山和凉亭' }
        ], shots: [], constraints: [], worldPatch: []
      };
      return JSON.stringify(document);
    };
    const service = new CgService(new CgStore(root), {
      chat,
      model: async () => structuredClone(actorModel),
      animation: async (_model, _description, duration) => baked(duration),
      mount: async primary => ({ modelJson: { ...(structuredClone(primary) as typeof actorModel), nodes: [...(structuredClone(primary) as typeof actorModel).nodes, { id: 'mounted-lantern', name: 'mounted lantern', parent: 'right_hand', mounted: true, transform: { pos: [0, 0, 0.2], scale: [0.2, 0.2, 0.2] } }] }, mountedGroupId: 'mounted-lantern' })
    });
    const created = await service.create(map, null);
    const prompt = '一位穿青衣的少女沿园林石子路走到池塘边。一个提着灯笼的老人从凉亭方向走来，举起灯笼为她照亮。少女转身向老人点头，最后镜头从两人身后缓慢升起，同时拍到池塘、假山和凉亭。';
    const result = await service.generate(created.id, created.revision, prompt);
    expect(result.run.status).toBe('preview-ready');
    expect(result.project.candidate?.validation.valid).toBe(true);
    expect(result.project.candidate?.validation.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'uncalibrated_locomotion', severity: 'warning' })]));
    expect(result.project.resources.models).toHaveLength(3);
    expect(result.project.resources.clips.map(clip => clip.source)).toEqual(['generated', 'generated', 'generated', 'generated']);
    expect(result.project.resources.assemblies).toEqual([expect.objectContaining({ actorEntityId: 'elder', propEntityId: 'lantern', source: '3d-generate-mount' })]);
    expect(result.project.candidate?.actions.find(action => action.id === 'girl-walk')?.path?.length).toBeGreaterThan(2);
    expect(result.project.candidate?.shots.at(-1)?.camera.movement).toBe('crane');
    expect(directorCalls).toBe(2);
  }, 60_000);
});
