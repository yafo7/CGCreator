import { randomUUID } from 'node:crypto';
import type { CgClip, CgMapSyncSummary, CgPatchOperation, CgProgress, CgProject, CgResources, CgVec3, DirectorDocument } from '../shared/cgTypes';
import { assertGenerationDescription, emptyPreparation, selectedPreparedVersion, type CgPreparedAssetVersion } from '../shared/cgPreparation';
import { applyDirectorPatch, compileDirector } from '../shared/cgCompiler';
import { stableHash, validateDirectorDocument } from '../shared/cgValidation';
import { getMapBounds, getMapObjectAabbs, getObjectWorldTransforms, sampleTerrainHeight, type EditableMap, type MapAsset } from '../shared/map';
import { buildModelColliderPlan, calculateModelSemanticLandmarks } from '../shared/modelBounds';
import { buildPoseRig } from '../shared/cgPoseEvaluator';
import type { RenderScheme } from '../shared/renderScheme';
import { MODEL_API_BASE } from '../shared/protocol';
import { generateModel, llmChat, type ChatMessage } from './modelApi';
import { CgHttpError, CgStore } from './cgStore';
import { CG_CAMERA_GRAMMAR_PROMPT } from '../shared/cgCameraGrammar';
import { buildWorldSemanticIndex } from '../shared/cgWorldSemantics';
import { inspectShotSamples } from '../shared/cgViewSemantics';
import { CG_WORLD_READING_PROMPT, queryWorld, worldSummary } from '../shared/cgWorldQuery';
import { CG_COVERAGE_PROMPT, CG_SHOT_SKILLS, createBehaviorCoverage, performanceForDirector } from '../shared/cgShotSkills';
import { createFoundationDemo } from '../shared/cgFoundationDemo';
import { mapSpatialAnchors } from '../shared/cgSpatialBindings';

export interface CgServiceOptions {
  chat?: (messages: ChatMessage[]) => Promise<string>;
  model?: (description: string, seed: number) => Promise<unknown>;
  animation?: (model: unknown, description: string, duration: number) => Promise<unknown>;
}
type Progress = CgProgress & { running: boolean };
const clone = <T>(value: T): T => structuredClone(value);
function fail(code: string, message: string): never { throw new CgHttpError(422, code, message); }

export class CgService {
  readonly progress = new Map<string, Progress>();
  constructor(readonly store: CgStore, private options: CgServiceOptions = {}) {}

  async foundationDemo(): Promise<CgProject> {
    const fixture = createFoundationDemo(), id = `cg_${randomUUID()}`;
    fixture.document.id = `director_${randomUUID()}`;
    const candidate = compileDirector(fixture.document, fixture.map, null, fixture.resources);
    if (!candidate.validation.valid) fail('foundation_demo_failed', candidate.validation.diagnostics.map(d => d.message).join('\n'));
    return this.store.create({ schemaVersion: 1, id, title: fixture.document.title, revision: 0, mapSnapshot: fixture.map, schemeSnapshot: null, document: fixture.document, resources: fixture.resources, candidate, confirmed: null, coveragePending: false, updatedAt: Date.now() });
  }

  async create(map: EditableMap, scheme: RenderScheme | null, title?: string): Promise<CgProject> {
    this.assertMap(map);
    const id = `cg_${randomUUID()}`;
    const document: DirectorDocument = { schemaVersion: 1, id: `director_${randomUUID()}`, title: title?.trim() || `${map.name} · CG`, sourcePrompt: '', revision: 0, seed: map.seed, mapId: map.id, entities: [], anchors: [], shots: [], actions: [], constraints: [], worldPatch: [] };
    return this.store.create({ schemaVersion: 1, id, title: document.title, revision: 0, mapSnapshot: clone(map), schemeSnapshot: clone(scheme), document, resources: { models: [], clips: [] }, preparation: emptyPreparation(), candidate: null, confirmed: null, updatedAt: Date.now() });
  }

  /** Prepare a reusable actor or prop before directing. Generation stays concise; scene rules remain in the compiler. */
  async prepareAsset(id: string, revision: number, input: { name?: string; kind?: unknown; description?: unknown; referenceAssetIds?: unknown }) {
    assertGenerationDescription(input.description);
    const kind = input.kind === 'actor' || input.kind === 'prop' ? input.kind : fail('invalid_asset_kind', '资源类型必须是 actor 或 prop。');
    const description = input.description.trim();
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : description;
    const requestedRefs = Array.isArray(input.referenceAssetIds) ? input.referenceAssetIds.filter((item): item is string => typeof item === 'string').slice(0, 3) : [];
    const base = await this.store.read(id);
    if (base.revision !== revision) throw new CgHttpError(409, 'revision_conflict', '项目已更新，请重新打开最新版本后重试。');
    const basePreparation = base.preparation ?? emptyPreparation();
    const references = requestedRefs.map(assetId => selectedPreparedVersion(basePreparation, assetId)).filter((value): value is CgPreparedAssetVersion => !!value);
    const key = `prepared_model_${stableHash({ description, kind, refs: references.map(item => item.modelHash) })}`;
    // Remote generation deliberately occurs outside project CAS: the cache remains useful if the user edits meanwhile.
    return this.run(id, 'preparing', `制作${kind === 'actor' ? '角色' : '道具'}：${name}`, async () => {
      let modelJson = await this.store.cached<unknown>(key);
      if (!modelJson) {
        modelJson = this.options.model
          ? await this.options.model(description, base.document.seed)
          : await generateModel(description, {
            apiBase: process.env.CG_MODEL_API_BASE,
            mode: 'standard', seeded: false,
            refs: references.map(ref => ({ model: ref.model.modelJson, note: '保持风格' })),
            signal: AbortSignal.timeout(300_000)
          });
        assertModel(modelJson);
        await this.store.cache(key, modelJson);
      }
      assertModel(modelJson);
      return this.store.transaction(id, revision, project => {
      const preparation = project.preparation ?? emptyPreparation();
      const assetId = `asset_${randomUUID()}`, versionId = `assetv_${randomUUID()}`, now = Date.now();
      const model: MapAsset = {
        id: versionId,
        name,
        prompt: description,
        modelJson,
        colliderPlan: buildModelColliderPlan(modelJson),
        mode: 'json', provider: '3d-generate', createdAt: now, updatedAt: now
      };
      const rig = buildPoseRig(modelJson), landmarks = calculateModelSemanticLandmarks(modelJson);
      preparation.assets.push({ id: assetId, name, kind, description, selectedVersionId: versionId, versionIds: [versionId], createdAt: now, updatedAt: now });
      preparation.versions.push({
        id: versionId, assetId, source: 'generated', description, model, modelHash: stableHash(modelJson), createdAt: now,
        capabilities: {
          locomotion: kind === 'actor' && rig.nodes.length > 1,
          faceCloseup: kind === 'actor' && !!landmarks,
          sit: rig.contactProfile ? 'ready' : 'needs-rig',
          hold: rig.nodes.some(node => /hand|手/i.test(node.id)) ? 'ready' : 'needs-socket'
        }
      });
      project.preparation = preparation;
      project.candidate = null;
      });
    });
  }

  /** Save a full-editor result as a new immutable version; existing confirmed CGs keep their old model. */
  async savePreparedVersion(id: string, revision: number, input: { assetId?: unknown; modelJson?: unknown; description?: unknown }) {
    const suppliedDescription = input.description;
    assertGenerationDescription(suppliedDescription);
    assertModel(input.modelJson);
    return this.store.transaction(id, revision, project => {
      const preparation = project.preparation ?? emptyPreparation();
      const assetId = typeof input.assetId === 'string' ? input.assetId : '';
      const asset = preparation.assets.find(item => item.id === assetId);
      if (!asset) fail('prepared_asset_not_found', '准备资源不存在。');
      const parent = selectedPreparedVersion(preparation, assetId);
      if (!parent) fail('prepared_version_not_found', '准备资源没有可编辑版本。');
      const now = Date.now(), versionId = `assetv_${randomUUID()}`, description = suppliedDescription.trim();
      const model: MapAsset = { ...parent.model, id: versionId, prompt: description, modelJson: clone(input.modelJson), colliderPlan: buildModelColliderPlan(input.modelJson), updatedAt: now };
      const rig = buildPoseRig(input.modelJson), landmarks = calculateModelSemanticLandmarks(input.modelJson);
      preparation.versions.push({ ...parent, id: versionId, parentVersionId: parent.id, source: 'edited', description, model, modelHash: stableHash(input.modelJson), createdAt: now, capabilities: { locomotion: asset.kind === 'actor' && rig.nodes.length > 1, faceCloseup: asset.kind === 'actor' && !!landmarks, sit: rig.contactProfile ? 'ready' : 'needs-rig', hold: rig.nodes.some(node => /hand|手/i.test(node.id)) ? 'ready' : 'needs-socket' } });
      asset.selectedVersionId = versionId; asset.versionIds.push(versionId); asset.description = description; asset.updatedAt = now;
      project.preparation = preparation;
      project.candidate = null;
    });
  }

  /** Bake one reusable motion against the selected immutable model version. */
  async prepareMotion(id: string, revision: number, input: { assetId?: unknown; name?: unknown; description?: unknown }) {
    const suppliedDescription = input.description;
    assertGenerationDescription(suppliedDescription);
    const assetId = typeof input.assetId === 'string' ? input.assetId : '';
    const base = await this.store.read(id);
    if (base.revision !== revision) throw new CgHttpError(409, 'revision_conflict', '项目已更新，请重新打开最新版本后重试。');
    const preparation = base.preparation ?? emptyPreparation();
    const asset = preparation.assets.find(item => item.id === assetId);
    const version = selectedPreparedVersion(preparation, assetId);
    if (!asset || !version) fail('prepared_asset_not_found', '请先选择已准备的角色或道具。');
    const description = suppliedDescription.trim(), name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : description;
    const key = `prepared_motion_${stableHash({ model: version.modelHash, description })}`;
    return this.run(id, 'preparing-motion', `制作动作：${name}`, async () => {
      let template = await this.store.cached<Omit<CgClip, 'id' | 'entityId'>>(key);
      if (!template) {
        const baked = this.options.animation
          ? await this.options.animation(version.model.modelJson, description, 0)
          : await requestBakedAnimation(version.model.modelJson, description);
        const decoded = decodeBakedClip(baked, { id: 'prepared', entityId: 'prepared', modelHash: version.modelHash, description }, version.model.modelJson);
        const { id: _id, entityId: _entityId, ...preparedTemplate } = decoded;
        template = preparedTemplate;
        await this.store.cache(key, template);
      }
      return this.store.transaction(id, revision, project => {
        const current = project.preparation ?? emptyPreparation();
        const currentVersion = selectedPreparedVersion(current, assetId);
        if (!currentVersion || currentVersion.id !== version.id) fail('prepared_version_changed', '角色模型版本已变化，请重新制作动作。');
        const now = Date.now();
        current.motions.push({ id: `motion_${randomUUID()}`, assetVersionId: version.id, name, description, naturalDuration: template!.duration, loop: template!.loop, clip: template!, createdAt: now });
        project.preparation = current;
        project.candidate = null;
      });
    });
  }

  async syncMap(id: string, revision: number, map: EditableMap, scheme: RenderScheme | null): Promise<{ project: CgProject; summary: CgMapSyncSummary }> {
    this.assertMap(map);
    let summary!: CgMapSyncSummary;
    const project = await this.store.transaction(id, revision, (project) => {
      if (map.id !== project.mapSnapshot.id || map.id !== project.document.mapId) fail('map_mismatch', '当前 WorldForge 地图与这个 CG 项目不是同一张地图。');
      summary = summarizeMapSync(project.mapSnapshot, map, project.schemeSnapshot, scheme);
      project.mapSnapshot = clone(map);
      project.schemeSnapshot = clone(scheme);
      project.candidate = null;
      project.mapSync = {
        sourceMapVersion: map.version,
        sourceMapUpdatedAt: map.updatedAt,
        sourceHash: stableHash({ map, scheme }),
        syncedAt: Date.now(),
        summary: clone(summary)
      };
    });
    return { project, summary };
  }

  async plan(id: string, revision: number, prompt: string, demo = false) {
    this.requirePrompt(prompt);
    return this.run(id, 'planning', demo ? '创建离线演示意图' : '根据地图语义生成导演文档', () => this.store.transaction(id, revision, async (project) => {
      let document: DirectorDocument;
      if (demo) {
        if (project.document.constraints.length) fail('hard_constraints_present', '已有人工约束，请使用局部修改；离线演示不能替换这些约束。');
        const result = createDemo(project.mapSnapshot, project.document);
        document = result.document;
        project.resources = result.resources;
      } else {
        const semantic = buildSemanticContext(project.mapSnapshot);
        const answer = await this.directorAnswer([
          { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ intent: prompt, map: semantic, preparedAssets: preparedAssetsForDirector(project), documentIdentity: { id: project.document.id, mapId: project.mapSnapshot.id, revision: project.document.revision + 1, seed: project.document.seed }, existingDocument: project.document.shots.length ? project.document : null }) }
        ], project.mapSnapshot);
        assertSupportedAnswer(answer, 'unsupported_intent');
        document = answer as DirectorDocument;
        if (!document || document.id !== project.document.id || document.mapId !== project.mapSnapshot.id || document.revision !== project.document.revision + 1) fail('invalid_ai_identity', 'AI 返回的文档版本或地图引用不正确。');
        if (document.schemaVersion === 2) {
          const draftValidation = validateDirectorDocument(document, { allowNoShots: true });
          if (!draftValidation.valid) fail('invalid_performance_plan', draftValidation.diagnostics.map(d => d.message).join('\n'));
          if (!document.shots.length) document.shots = createBehaviorCoverage(document);
          project.coveragePending = true;
        } else project.coveragePending = false;
        this.assertDocument(document);
        const knownObjects = new Set(project.mapSnapshot.objects.map((o) => o.id));
        const addedObjects = new Set(document.worldPatch.flatMap((op) => op.type === 'object.add' ? [op.object.id] : []));
        for (const entity of document.entities) if (entity.objectId && !knownObjects.has(entity.objectId) && !addedObjects.has(entity.objectId)) fail('invented_object', `AI 引用了不存在的地图物体：${entity.objectId}`);
        const allowedAnchors = new Map([...semantic.anchors, ...project.document.anchors].map((a) => [a.id, a]));
        for (const anchor of document.anchors) if (stableHash(allowedAnchors.get(anchor.id)) !== stableHash(anchor)) fail('invented_anchor', `AI 只能引用地图提供的位置标记：${anchor.id}`);
        if (stableHash(document.constraints) !== stableHash(project.document.constraints)) fail('modified_hard_constraints', 'AI 不允许删除或修改用户的硬约束。');
        for (const c of project.document.constraints) {
          if (c.anchorId && stableHash(document.anchors.find((a) => a.id === c.anchorId)) !== stableHash(project.document.anchors.find((a) => a.id === c.anchorId))) fail('modified_hard_constraints', 'AI 不允许改动锁定的坐标或机位。');
        }
      }
      document.sourcePrompt = prompt;
      this.assertDocument(document);
      project.document = document;
      project.title = document.title;
      project.candidate = null;
    }));
  }

  async patch(id: string, revision: number, operations: CgPatchOperation[]) {
    return this.store.transaction(id, revision, (project) => {
      project.document = this.applyPatch(project.document, operations, 'user');
      project.title = project.document.title;
      // Keep the previous candidate for compiler dependency comparison, but its revision is now stale.
    });
  }

  async refine(id: string, revision: number, prompt: string, targetId?: string) {
    this.requirePrompt(prompt);
    let operations: CgPatchOperation[] = [];
    const project = await this.run(id, 'refining', '生成局部意图修改', () => this.store.transaction(id, revision, async (project) => {
      if (!project.document.shots.length) fail('plan_required', '请先生成导演文档。');
      const allIds = [...project.document.shots, ...project.document.actions, ...project.document.entities].map((n) => n.id);
      if (targetId && !allIds.includes(targetId)) fail('target_not_found', '选中的修改目标不存在。');
      const shotOrdinal = prompt.match(/第([一二三四五六七八九十\d]+)(?:个)?镜头/);
      const ordinal = shotOrdinal ? (/^\d+$/.test(shotOrdinal[1]) ? Number(shotOrdinal[1]) : '一二三四五六七八九十'.indexOf(shotOrdinal[1]) + 1) : null;
      const selected = ordinal ? project.document.shots[ordinal - 1] : project.document.shots.find((s) => s.id === targetId) ?? (project.document.shots.length === 1 ? project.document.shots[0] : undefined);
      const selectedBehavior = project.document.actions.find(a => a.id === targetId);
      const simple = prompt.replace(/第[一二三四五六七八九十\d]+(?:个)?镜头/g, '').replace(/这个镜头|镜头|请|这里|改成|改为|变成|换成|一点|一些|，|。|\s/g, '');
      if (selectedBehavior && ['慢', '慢点', '再慢', '快', '快点'].includes(simple)) {
        operations = [{ type: 'action.update', id: selectedBehavior.id, patch: { duration: Math.min(300, selectedBehavior.duration * (simple.includes('慢') ? 1.25 : 0.8)) } }];
      } else if (!selectedBehavior && selected && ['慢', '慢点', '再慢', '快', '快点', '特写', '近景', '中景', '远景', '全景'].includes(simple)) {
        if (simple.includes('慢') || simple.includes('快')) {
          const compiledShot = project.candidate?.documentRevision === project.document.revision ? project.candidate.shots.find(s => s.id === selected.id) : undefined;
          const duration = compiledShot ? compiledShot.end - compiledShot.start : selected.duration;
          operations = [{ type: 'shot.update', id: selected.id, patch: { duration: Math.min(300, duration * (simple.includes('慢') ? 1.25 : 0.8)) } }];
        }
        else operations = [{ type: 'shot.update', id: selected.id, patch: { camera: ['特写', '近景'].includes(simple)
          ? { framing: 'close-up', movement: 'static', reference: 'subject-facing', view: 'front-three-quarter', aim: 'eyes', lensMm: 85 }
          : { framing: simple === '中景' ? 'medium' : 'wide' } } }];
      } else {
        const result = await this.directorAnswer([
          { role: 'system', content: `${REFINE_SYSTEM_PROMPT}${project.document.schemaVersion === 2 ? '\nV2: the target may be a behavior. action.update additionally supports route, interaction, endBehavior and purpose using existing guide/object/node/anchor IDs. Do not add coordinates. Behavior timing references actions only. shot.update may additionally select a matching skillId/coveragePurpose; camera supports layout solo/two-shot/over-shoulder, aimMode fixed/follow and pitch in radians. Camera edits never edit behaviors. Seated contact persists and unsupported stand/IK/speech must be reported, not invented.' : ''}` },
          { role: 'user', content: JSON.stringify({ intent: prompt, targetId, document: project.document, map: buildSemanticContext(project.mapSnapshot), shotSkills: project.document.schemaVersion === 2 ? CG_SHOT_SKILLS : undefined, performance: project.candidate?.documentRevision === project.document.revision && project.candidate.performance ? performanceForDirector(project.candidate) : undefined, currentView: targetId && project.candidate?.documentRevision === project.document.revision ? compactViewSamples(inspectShotSamples(project.candidate, targetId)) : [] }) }
        ], project.mapSnapshot);
        assertSupportedAnswer(result, 'unsupported_refine');
        if (!Array.isArray(result)) fail('invalid_patch', 'AI 必须返回局部修改数组。');
        operations = result as CgPatchOperation[];
      }
      if (!operations.length || operations.length > 32) fail('invalid_patch', '没有可执行的局部修改，或修改范围过大。');
      for (const op of operations) {
        if (!op || !['shot.update', 'action.update', 'entity.update'].includes(op.type)) fail('invalid_ai_patch', 'AI 局部修改只允许调整现有镜头、动作或角色；坐标和硬约束由人工标注。');
        if (targetId && !ordinal && 'id' in op && op.id !== targetId) fail('out_of_scope_patch', 'AI 试图修改选定目标之外的内容。');
      }
      project.document = this.applyPatch(project.document, operations, 'ai');
    }));
    return { project, operations };
  }

  async compile(id: string, revision: number) {
    return this.run(id, 'resources', '冻结模型和动画资源', () => this.store.transaction(id, revision, async (project) => {
      this.assertDocument(project.document);
      await this.resolveResources(project);
      if (project.document.schemaVersion === 2 && project.coveragePending) {
        this.progress.set(id, { stage: 'performance', message: '先验证路线、交互和持续姿态', running: true });
        const performance = compileDirector(project.document, project.mapSnapshot, project.schemeSnapshot, project.resources, undefined, { performanceOnly: true });
        if (!performance.validation.valid) { project.candidate = performance; return; }
        this.progress.set(id, { stage: 'coverage', message: '导演依据已验证的行为与姿态选择镜头', running: true });
        const answer = await this.directorAnswer([
          { role: 'system', content: `${CG_COVERAGE_PROMPT}\n${CG_WORLD_READING_PROMPT}` },
          { role: 'user', content: JSON.stringify({ document: project.document, performance: performanceForDirector(performance), shotSkills: CG_SHOT_SKILLS, map: buildSemanticContext(project.mapSnapshot) }) }
        ], project.mapSnapshot);
        assertSupportedAnswer(answer, 'unsupported_intent');
        if (!Array.isArray(answer) || answer.length > 128) fail('invalid_coverage', '镜头阶段需要有范围限制的镜头修改数组。');
        for (const op of answer) if (!op || op.type !== 'shot.update' || !project.document.shots.some(s => s.id === op.id) || !op.patch || Object.keys(op.patch).some(k => !['skillId', 'coveragePurpose', 'name', 'purpose', 'camera', 'transition', 'subtitle'].includes(k))) fail('invalid_coverage', '镜头阶段不能修改行为、时间或人工约束。');
        if (answer.length) project.document = this.applyPatch(project.document, answer, 'ai');
        project.coveragePending = false;
      }
      this.progress.set(id, { stage: 'compiling', message: '编译镜头、行动和世界状态并校验硬约束', running: true });
      project.candidate = compileDirector(project.document, project.mapSnapshot, project.schemeSnapshot, project.resources, project.candidate ?? project.confirmed ?? undefined);
    }));
  }

  async confirm(id: string, revision: number, compileId: string, inputHash: string) {
    return this.store.transaction(id, revision, (project) => {
      const candidate = project.candidate;
      if (candidate?.stage === 'performance') fail('incomplete_compile', '行为验证结果尚未完成镜头编译，不能确认。');
      if (!candidate || candidate.id !== compileId || candidate.inputHash !== inputHash || candidate.documentRevision !== project.document.revision) fail('stale_compile', '预览已过期，请重新编译并预览当前版本。');
      if (!candidate.validation.valid) fail('invalid_compile', '编译存在错误，不能确认。');
      const current = compileDirector(project.document, project.mapSnapshot, project.schemeSnapshot, project.resources);
      if (!current.validation.valid || current.id !== compileId || current.inputHash !== inputHash) fail('stale_compile', '编译输入已改变，请重新预览。');
      project.confirmed = clone(candidate);
    });
  }

  private async resolveResources(project: CgProject) {
    const preparation = project.preparation ?? emptyPreparation();
    // The document stores the user-owned asset ID. Resolve it to this selected immutable version.
    for (const asset of preparation.assets) {
      const version = selectedPreparedVersion(preparation, asset.id);
      if (!version) continue;
      const model = { ...clone(version.model), id: asset.id };
      project.resources.models = project.resources.models.filter(item => item.id !== asset.id);
      project.resources.models.push(model);
    }
    const models = new Map([...project.mapSnapshot.assets ?? [], ...project.resources.models].map((a) => [a.id, a]));
    for (const entity of project.document.entities) {
      const object = project.mapSnapshot.objects.find((o) => o.id === entity.objectId);
      const added = project.document.worldPatch.find((op) => op.type === 'object.add' && op.object.id === entity.objectId);
      const assetId = object?.assetId ?? (added?.type === 'object.add' ? added.object.assetId : null) ?? entity.assetId;
      if (!assetId) continue;
      if (!models.has(assetId)) {
        if (!entity.description?.trim()) fail('missing_resource_description', `缺少模型 ${assetId}，请提供角色或道具描述。`);
        const key = `model_${stableHash({ description: entity.description, seed: project.document.seed, mode: 'voxel' })}`;
        this.progress.set(project.id, { stage: 'model', message: `通过 3d-generate 生成：${entity.name}`, running: true });
        let asset = await this.store.cached<MapAsset>(key);
        if (!asset) {
          const modelJson = await (this.options.model ? this.options.model(entity.description, project.document.seed) : generateModel(entity.description, { apiBase: process.env.CG_MODEL_API_BASE, seeded: true, seed: project.document.seed, signal: AbortSignal.timeout(300_000) }));
          assertModel(modelJson);
          asset = { id: assetId, name: entity.name, prompt: entity.description, modelJson, colliderPlan: buildModelColliderPlan(modelJson), mode: 'voxel', provider: '3d-generate', createdAt: Date.now(), updatedAt: Date.now() };
          await this.store.cache(key, asset);
        }
        asset = { ...asset, id: assetId };
        project.resources.models.push(asset);
        models.set(assetId, asset);
      }
      const model = models.get(assetId)!;
      for (const action of project.document.actions.filter((a) => a.entityId === entity.id && (a.type === 'animate' || a.type === 'sit' || a.type === 'move' && a.route))) {
        const clipId = action.clipId!;
        if (!clipId) fail('missing_clip_id', '移动和交互行为需要稳定的 clipId。');
        const modelHash = stableHash(model.modelJson);
        const selectedVersion = selectedPreparedVersion(preparation, entity.assetId);
        const preparedMotion = selectedVersion ? preparation.motions.find(motion => motion.id === clipId && motion.assetVersionId === selectedVersion.id) : undefined;
        if (preparedMotion) {
          if (preparedMotion.clip.modelHash !== modelHash) fail('prepared_motion_mismatch', `动作 ${preparedMotion.name} 与当前模型版本不匹配。`);
          project.resources.clips = project.resources.clips.filter(clip => clip.id !== clipId);
          project.resources.clips.push({ ...preparedMotion.clip, id: clipId, entityId: entity.id, modelHash });
          continue;
        }
        const existing = project.resources.clips.find((c) => c.id === clipId);
        if (existing?.entityId === entity.id && existing.modelHash === modelHash && (action.type !== 'sit' || Math.abs(existing.duration - action.duration) < 1e-4)) continue;
        if (existing && existing.entityId !== entity.id) fail('shared_clip_id', '不同角色不能共享同一个 clipId；动画必须绑定到明确的角色和模型。');
        const description = action.purpose?.trim().slice(0, 180) || (action.type === 'sit' ? '坐下后保持坐姿' : action.type === 'move' ? '原地跑步' : '自然的原地动作');
        const key = `clip_${stableHash({ modelHash, description })}`;
        let clip = await this.store.cached<CgClip>(key);
        if (!clip) {
          this.progress.set(project.id, { stage: 'animation', message: `通过 3d-generate 烘焙动作：${clipId}`, running: true });
          const baked = await (this.options.animation ? this.options.animation(model.modelJson, description, action.duration) : requestBakedAnimation(model.modelJson, description));
          clip = decodeBakedClip(baked, { id: clipId, entityId: entity.id, modelHash, description }, model.modelJson);
          await this.store.cache(key, clip);
        }
        project.resources.clips = project.resources.clips.filter((c) => c.id !== clipId);
        project.resources.clips.push({ ...clip, id: clipId, entityId: entity.id });
      }
    }
  }

  private async directorAnswer(initial: ChatMessage[], map: EditableMap): Promise<unknown> {
    const messages = [...initial], index = buildWorldSemanticIndex(map);
    for (let round = 0; round <= 3; round++) {
      const raw = await this.chat(messages), answer = parseJson(raw);
      if (!answer || typeof answer !== 'object' || Array.isArray(answer) || !('worldQueries' in answer)) return answer;
      const queries = (answer as { worldQueries: unknown }).worldQueries;
      if (round === 3 || !Array.isArray(queries) || !queries.length || queries.length > 6 || Object.keys(answer).some(k => k !== 'worldQueries')) fail('world_query_limit', '导演地图查询超过限制，请缩小问题范围后重试。');
      const results = queries.map(query => {
        try { return queryWorld(map, query, index); }
        catch (error) { return { sourceHash: index.sourceHash, error: 'invalid_world_query', message: error instanceof Error ? error.message : String(error) }; }
      });
      messages.push({ role: 'assistant', content: raw }, { role: 'user', content: JSON.stringify({ worldQueryResults: results, remainingQueryRounds: 2 - round, instruction: 'Use these measured facts, then return the requested final document or patch.' }) });
    }
    return fail('world_query_limit', '导演未能在限定查询次数内形成方案。');
  }

  private chat(messages: ChatMessage[]) { return this.options.chat ? this.options.chat(messages) : llmChat(messages, { apiBase: process.env.CG_MODEL_API_BASE, maxTokens: 12000, signal: AbortSignal.timeout(180_000) }); }
  private applyPatch(document: DirectorDocument, operations: CgPatchOperation[], source: 'user' | 'ai') {
    try { return applyDirectorPatch(document, operations, source); }
    catch (error) { return fail('invalid_patch', error instanceof Error ? error.message : String(error)); }
  }
  private requirePrompt(prompt: string) { if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) fail('invalid_prompt', '请输入 1–16000 字的导演意图。'); }
  private assertMap(map: EditableMap) { if (!map || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,119}$/.test(map.id) || !Array.isArray(map.objects) || !map.box || !map.terrain || !Array.isArray(map.terrain.heights)) fail('invalid_map', '请提供完整的 WorldForge 地图快照。'); }
  private assertDocument(document: unknown) { const result = validateDirectorDocument(document); if (!result.valid) fail('invalid_director_document', result.diagnostics.map((d) => d.message).join('\n')); }
  private async run<T>(id: string, stage: string, message: string, work: () => Promise<T>) {
    this.progress.set(id, { stage, message, running: true });
    try { const result = await work(); this.progress.set(id, { stage: 'ready', message: '完成', running: false }); return result; }
    catch (error) { this.progress.set(id, { stage: 'error', message: error instanceof Error ? error.message : String(error), running: false }); throw error; }
  }
}

export function summarizeMapSync(before: EditableMap, after: EditableMap, beforeScheme: RenderScheme | null, afterScheme: RenderScheme | null): CgMapSyncSummary {
  const oldObjects = new Map(before.objects.map((object) => [object.id, object]));
  const newObjects = new Map(after.objects.map((object) => [object.id, object]));
  const oldAssets = new Map((before.assets ?? []).map((asset) => [asset.id, asset]));
  const newAssets = new Map((after.assets ?? []).map((asset) => [asset.id, asset]));
  const ids = (values: Iterable<string>) => [...values].sort();
  const addedObjectIds = ids([...newObjects.keys()].filter((id) => !oldObjects.has(id)));
  const removedObjectIds = ids([...oldObjects.keys()].filter((id) => !newObjects.has(id)));
  const changedObjectIds = ids([...newObjects.keys()].filter((id) => oldObjects.has(id) && stableHash(oldObjects.get(id)) !== stableHash(newObjects.get(id))));
  const changedAssetIds = ids(new Set([
    ...[...newAssets.keys()].filter((id) => !oldAssets.has(id) || stableHash(oldAssets.get(id)) !== stableHash(newAssets.get(id))),
    ...[...oldAssets.keys()].filter((id) => !newAssets.has(id))
  ]));
  const worldView = (map: EditableMap) => ({ ...map, objects: [], assets: [], version: 0, updatedAt: 0 });
  return {
    addedObjectIds,
    removedObjectIds,
    changedObjectIds,
    changedAssetIds,
    worldChanged: stableHash(worldView(before)) !== stableHash(worldView(after)),
    schemeChanged: stableHash(beforeScheme) !== stableHash(afterScheme)
  };
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
  catch { return fail('invalid_ai_json', 'AI 返回了无法解析的 JSON；项目原版本已保留。'); }
}

function assertSupportedAnswer(value: unknown, code: 'unsupported_intent' | 'unsupported_refine') {
  if (value && typeof value === 'object' && 'error' in value && value.error === code) {
    const reason = 'reason' in value && typeof value.reason === 'string' ? value.reason.trim().slice(0, 2000) : '';
    fail(code, reason || '当前编译器不支持这项演出要求，请调整意图后重试。');
  }
}

export function buildSemanticContext(map: EditableMap) {
  const transforms = getObjectWorldTransforms(map);
  const anchors: DirectorDocument['anchors'] = [
    ...map.spawnPoints.map((p, index) => ({ id: `map_spawn_${index}`, name: `出生点 ${index + 1}`, kind: 'point' as const, position: [p[0], sampleTerrainHeight(map, p[0], p[2]), p[2]] as CgVec3, space: 'world' as const })),
    ...map.objects.map((o) => ({ id: `map_object:${o.id}`, name: o.name, kind: 'point' as const, position: clone(transforms.get(o.id)?.position ?? o.transform.position), space: 'world' as const, objectId: o.id }))
  ];
  anchors.push(...mapSpatialAnchors(map));
  const [from, to] = demoPath(map);
  anchors.push({ id: 'map_stage_start', name: '可用演出起点', kind: 'point', position: from, space: 'world' }, { id: 'map_stage_end', name: '可用演出终点', kind: 'point', position: to, space: 'world' });
  const fullIndex = buildWorldSemanticIndex(map);
  const spatialEntities = fullIndex.entities.filter((entity) => entity.kind !== 'model-part').map((entity) => ({ ...entity, description: entity.description?.slice(0, 600) }));
  const assetHierarchies = (map.assets ?? []).map((asset) => {
    const model = asset.modelJson as { nodes?: Array<{ id?: unknown; name?: unknown; label?: unknown; parent?: unknown; tags?: unknown; transform?: { pos?: unknown } }>; _meta?: { semanticSnapshot?: { text?: unknown } } };
    return {
      assetId: asset.id, name: asset.name, description: asset.prompt.slice(0, 600), tags: asset.tags ?? [],
      nodes: (model.nodes ?? []).flatMap((node) => typeof node.id === 'string' ? [{ id: node.id, name: typeof node.name === 'string' ? node.name : typeof node.label === 'string' ? node.label : node.id, ...(typeof node.parent === 'string' ? { parent: node.parent } : {}), ...(Array.isArray(node.tags) ? { tags: node.tags } : {}), ...(Array.isArray(node.transform?.pos) ? { position: node.transform.pos } : {}) }] : []),
      semanticSummary: typeof model._meta?.semanticSnapshot?.text === 'string' ? model._meta.semanticSnapshot.text.slice(0, 4000) : undefined,
      contactProfile: (asset.modelJson as { _meta?: { cgRig?: unknown } })?._meta?.cgRig ?? null
    };
  });
  return { id: map.id, name: map.name, axis: 'Y-up', units: 'metres', bounds: getMapBounds(map), sceneMode: map.sceneMode, layout: map.layout, worldUnderstanding: worldSummary(fullIndex), designSemantics: fullIndex.designSemantics, semanticIndex: { schemaVersion: 1, mapId: map.id, mapVersion: map.version, sourceHash: fullIndex.sourceHash, spatialEntities, assetHierarchies }, objects: map.objects.map((o) => ({ id: o.id, name: o.name, assetId: o.assetId, visible: o.visible, locked: o.locked, worldTransform: transforms.get(o.id), tags: map.assets?.find((a) => a.id === o.assetId)?.tags ?? [] })), anchors };
}

function preparedAssetsForDirector(project: CgProject) {
  const preparation = project.preparation ?? emptyPreparation();
  return preparation.assets.flatMap(asset => {
    const version = selectedPreparedVersion(preparation, asset.id);
    if (!version) return [];
    const model = version.model.modelJson as { nodes?: Array<{ id?: unknown; name?: unknown; label?: unknown; parent?: unknown; tags?: unknown }>; _meta?: { semanticSnapshot?: { text?: unknown } } };
    return [{
      id: asset.id, name: asset.name, kind: asset.kind, description: asset.description, selectedVersionId: version.id,
      capabilities: version.capabilities,
      motions: preparation.motions.filter(motion => motion.assetVersionId === version.id).map(motion => ({ id: motion.id, name: motion.name, description: motion.description, naturalDuration: motion.naturalDuration, loop: motion.loop })),
      semanticSummary: typeof model._meta?.semanticSnapshot?.text === 'string' ? model._meta.semanticSnapshot.text.slice(0, 1000) : undefined,
      nodes: (model.nodes ?? []).flatMap(node => typeof node.id === 'string' ? [{ id: node.id, name: typeof node.name === 'string' ? node.name : typeof node.label === 'string' ? node.label : node.id, ...(typeof node.parent === 'string' ? { parent: node.parent } : {}), ...(Array.isArray(node.tags) ? { tags: node.tags } : {}) }] : [])
    }];
  });
}

function compactViewSamples(samples: ReturnType<typeof inspectShotSamples>) {
  return samples.map((sample) => ({ ...sample, items: sample.items.map(({ semanticParts: _parts, ...item }) => item) }));
}

export const DIRECTOR_SYSTEM_PROMPT = `You direct an editable real-time 3D cutscene in WorldForge. Return ONLY a DirectorDocument JSON object. No code, video, prose, keyframes, executable expressions or invented map object IDs. Coordinates are Y-up metres; camera looks along its local -Z. Work from the supplied semantic map and exact existing IDs. semanticIndex.spatialEntities identifies placed objects and WorldForge group/focus/viewpoint/zone/guide/water/grass geography. semanticIndex.assetHierarchies preserves each reusable 3d-generate asset's model-part names and parents once; join it to placed instances by assetId. preparedAssets are explicitly user-prepared actors and props: when one fits, use its exact id as entity.assetId and do not generate a duplicate. Ground location language such as pavilion, pond, forest, entrance or seat in those stable semantic IDs before choosing supplied anchors. Use supplied named anchors verbatim; never invent coordinates. New entities may reference a new stable assetId plus a precise description for 3d-generate; never pretend the model already exists. Prefer existing assets. New actors require startAnchorId. Existing map objects use objectId.
Use the supplied documentIdentity unchanged, schemaVersion:2, title, sourcePrompt, entities, anchors, shots, actions, constraints, worldPatch. This is the PERFORMANCE planning stage: first ground actors, props, behavior goals, route choices, timing and interactions. For a NEW document return shots:[]; the service derives stable coverage slots and chooses cameras AFTER verifying the actual performance. Retain existing shots when replanning a document with camera locks. Every ID must be unique across nodes, ASCII letters/digits/_/-/:. Preserve every existing manual hard constraint and its anchor verbatim. A constraint cannot be dropped when replanning.
Entity: {id,name,kind:'actor'|'prop',objectId?,assetId?,startAnchorId?,description?,height?}. Anchor: exact supplied object. Shots are sequential {id,name,purpose,duration,camera,transition?,subtitle?}. Camera is semantic {movement:'static'|'dolly'|'tracking'|'orbit',framing:'wide'|'medium'|'close-up'|'over-shoulder',subjectId,secondaryId?,side?:'left'|'right',lensMm?,distance?,height?,azimuth?,reference?:'world'|'subject-facing'|'subject-motion'|'interaction-axis',view?:'front'|'front-three-quarter'|'side'|'rear-three-quarter'|'rear',aim?:'body'|'upper-body'|'face'|'eyes'|'interaction',screenPosition?:[x,y]}. Every moving-subject shot must state reference, view and aim. Travel/context defaults to a side or rear-three-quarter view in subject-motion space; arrival defaults to rear or rear-three-quarter. Use a moving front view only when the purpose explicitly needs the face during motion. A close-up must aim at face/eyes in subject-facing space, use a 70–100mm lens, and normally omit distance/height so semantic landmarks determine both. Over-shoulder requires two distinct subjects and interaction-axis. Transition is {type:'cut'|'ease-in-out',duration?,motivation:'action'|'look'|'reaction'|'reveal'|'reestablish'|'rhythm'}; omit it on the first shot and use a motivated value afterward. Preserve screen direction and the 30-degree rule. Favor stable composition and restrained movement; camera movement cannot own actor motion.
Actions own the performance timeline: {id,entityId,type:'move'|'face'|'animate'|'visibility'|'effect'|'sit'|'dialogue'|'hold',start:{kind:'absolute',seconds}|{kind:'after'|'with',id,offset?},duration,targetAnchorId?,targetEntityId?,clipId?,visible?,effect?:'spark',purpose?,route?,interaction?,endBehavior?}. V2 timing references other actions, NEVER shots. A move requires targetAnchorId; when using a road add route:{guideIds:[exact existing guide IDs],policy:'required'|'preferred',locomotion:'walk'|'run',maxSpeed?} and clipId for its own in-place gait. Do not overlay a second gait animate action. Use provided map_guide and map_seat anchors verbatim, including bindings. A sit requires clipId and interaction:{objectId,seatNodeId,approachAnchorId}; first move to that exact approach anchor and orient the actor. Sit is supported only for a stationary named box seat and an actor with explicit contactProfile hips/leftFoot/rightFoot landmarks; the solver must validate the actual clip and feet support. Never pretend an unprofiled model is contact-ready. Sit persists; hold keeps the seated state. Do not move or replace a seated actor's whole-body animation without a supported stand transition (currently unavailable). Dialogue requires targetEntityId for a distinct participant and means staged facing/turns only, not speech or lip sync. Animate supports endBehavior:'restore'|'hold'. A face needs a target entity or anchor. Effects support only spark. Do not invent attachment, physics, IK or unsupported motion. Do not overlap competing root actions or full-body animations. Preserve manual time and camera locks.
worldPatch is a declarative WorldForge transaction array applied only to a CG snapshot. Supported operations: object.update {objectId,patch:{visible?,transform?}}, object.remove {objectId}, object.add {object:{id,name,assetId,parentId:null,visible:true,locked:false,transform:{position,rotation,scale,size}}}, sun.set {point}. Use existing transforms or supplied anchor positions, not arbitrary coordinates. Other world operations require an explicit supported schema and must not be guessed. Source map locked objects must be preserved. Default worldPatch:[]. constraints defaults to [] only for a new document. Keep the first version short (10–30 seconds, 2–4 shots), grounded in the user intent. An unsupported request must return {error:'unsupported_intent',reason:'...'} instead of silently approximating it.
${CG_CAMERA_GRAMMAR_PROMPT}
${CG_WORLD_READING_PROMPT}`;

const REFINE_SYSTEM_PROMPT = `Return only a JSON array of narrowly scoped CgPatchOperation objects, never a replacement document. Existing IDs are immutable. Allowed operations: {type:'shot.update',id,patch:{name?,purpose?,duration?,transition?:{type,motivation,duration?},subtitle?,camera?:{movement?,framing?,subjectId?,secondaryId?,side?,lensMm?,distance?,height?,azimuth?,reference?,view?,aim?,screenPosition?}}}, {type:'action.update',id,patch:{start?,duration?,targetAnchorId?,targetEntityId?,clipId?,visible?}}, {type:'entity.update',id,patch:{name?,description?,startAnchorId?}}. Use exact IDs and existing anchors. If targetId is supplied, modify only that ID. Never modify user constraints, anchors used by locks, or locked values. Preserve unrelated actions and camera intent. currentView contains mechanically measured beginning/middle/end observations for the selected compiled shot: screen region, coverage, visible fraction and occluder IDs. Use these facts to diagnose framing, but do not claim they prove artistic quality. Axis is Y-up metres and azimuth is radians. Supported camera movement static/dolly/tracking/orbit; framing wide/medium/close-up/over-shoulder. When changing to close-up also set movement static, reference subject-facing, view front-three-quarter, aim eyes and lensMm 70–100; omit distance and height unless explicitly requested. Travel follows use subject-motion with side/rear-three-quarter rather than front unless the intent explicitly asks to read the face during motion. Slow a selected shot by changing only its duration unless the user explicitly requests an action timing change. Unsupported requests return {error:'unsupported_refine',reason:'...'} and no fake success.
${CG_CAMERA_GRAMMAR_PROMPT}
${CG_WORLD_READING_PROMPT}`;

async function requestBakedAnimation(modelJson: unknown, description: string) {
  const mode = /坐下|递交|交谈/.test(description) ? 'pro' : 'quick';
  const response = await fetch(`${process.env.CG_MODEL_API_BASE ?? MODEL_API_BASE}/api/generate/animation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, modelJson, description, provider: 'gpt', emitParticles: false }), signal: AbortSignal.timeout(300_000) });
  const result = await response.json() as { ok?: boolean; baked?: unknown; error?: string; errorCode?: string };
  if (!response.ok || !result.ok || !result.baked) fail('animation_generation_failed', result.error ?? result.errorCode ?? '3d-generate 未返回可冻结的 baked 动画。');
  return result.baked;
}

function assertModel(value: unknown): asserts value is { nodes: Array<{ id: string; parent?: string }> } {
  const nodes = (value as { nodes?: Array<{ id?: unknown; mesh?: unknown }> })?.nodes;
  if (!Array.isArray(nodes) || !nodes.length || nodes.some((n) => !n || typeof n !== 'object' || typeof n.id !== 'string') || !nodes.some((n) => n.mesh) || new Set(nodes.map((n) => n.id)).size !== nodes.length) fail('invalid_generated_model', '生成模型缺少可渲染节点或稳定节点 ID。');
}

/** Adapter for 3d-generate CodeAnimPlayer baked arrays. No remote code executes in CGCreator. */
export function decodeBakedClip(value: unknown, identity: Pick<CgClip, 'id' | 'entityId' | 'modelHash' | 'description'>, modelJson: unknown): CgClip {
  assertModel(modelJson);
  const baked = value as { fps?: number; duration?: number; loop?: boolean; animation?: Record<string, Record<string, number[]>>; effects?: unknown; particles?: unknown };
  if (!baked || !Number.isFinite(baked.fps) || baked.fps! < 1 || baked.fps! > 240 || !Number.isFinite(baked.duration) || baked.duration! <= 0 || baked.duration! > 1200 || !baked.animation || typeof baked.animation !== 'object') fail('invalid_baked_clip', '动画烘焙格式无效。');
  if (baked.effects || baked.particles) fail('unsupported_clip_effects', '烘焙动画包含未受支持的特效；需要使用独立的确定性效果轨。');
  const nodes = new Map(modelJson.nodes.map((n) => [n.id, n]));
  const tracks: CgClip['tracks'] = {};
  const allowed = new Set(['rotX', 'rotY', 'rotZ', 'posX', 'posY', 'posZ', 'quatX', 'quatY', 'quatZ', 'quatW', 'scaleX', 'scaleY', 'scaleZ']);
  for (const [id, raw] of Object.entries(baked.animation)) {
    if (!nodes.has(id)) fail('unknown_animation_node', `动画引用未知模型节点：${id}`);
    if (!raw || Object.keys(raw).some((k) => !allowed.has(k))) fail('unsupported_animation_track', `动画 ${id} 包含未受支持的轨道。`);
    const lengths = Object.values(raw).map((v) => Array.isArray(v) && v.every(Number.isFinite) ? v.length : -1);
    const expected = Math.ceil(baked.duration! * baked.fps!) + 1;
    if (!lengths.length || lengths.some((n) => n < 2 || n !== lengths[0]) || Math.abs(lengths[0] - expected) > 1) fail('invalid_animation_samples', `动画 ${id} 采样数组不一致。`);
    if (!nodes.get(id)?.parent && [...raw.posX ?? [], ...raw.posZ ?? []].some((v) => Math.abs(v) > 1e-5)) fail('root_motion_conflict', '生成动画带有根节点水平位移；请生成 in-place 动画，世界路径由 CG 编译器控制。');
    const track: CgClip['tracks'][string] = {};
    const read = (prefix: string, axes: string[], defaults: number[]) => Array.from({ length: lengths[0] }, (_, i) => axes.map((axis, j) => raw[`${prefix}${axis}`]?.[i] ?? defaults[j]));
    if (raw.posX || raw.posY || raw.posZ) track.position = read('pos', ['X', 'Y', 'Z'], [0, 0, 0]) as CgVec3[];
    if (raw.quatX || raw.quatY || raw.quatZ || raw.quatW) {
      if (!raw.quatX || !raw.quatY || !raw.quatZ || !raw.quatW) fail('invalid_quaternion_track', '四元数动画需要完整的四个分量。');
      const values = read('quat', ['X', 'Y', 'Z', 'W'], [0, 0, 0, 1]) as [number, number, number, number][];
      if (values.some((q) => Math.abs(Math.hypot(...q) - 1) > 0.001)) fail('invalid_quaternion_track', '动画四元数必须归一化。');
      track.quaternion = values;
    } else if (raw.rotX || raw.rotY || raw.rotZ) track.rotation = read('rot', ['X', 'Y', 'Z'], [0, 0, 0]) as CgVec3[];
    if (raw.scaleX || raw.scaleY || raw.scaleZ) { track.scale = read('scale', ['X', 'Y', 'Z'], [1, 1, 1]) as CgVec3[]; if (track.scale.some((v) => v.some((n) => n <= 0))) fail('invalid_scale_track', '缩放动画必须为正。'); }
    tracks[id] = track;
  }
  if (!Object.keys(tracks).length) fail('empty_animation', '3d-generate 返回了空动画。');
  return { ...identity, duration: baked.duration!, fps: baked.fps!, loop: baked.loop === true, rootMotion: 'in-place', source: 'generated', tracks };
}

function demoPath(map: EditableMap): [CgVec3, CgVec3] {
  const bounds = getMapBounds(map), boxes = getMapObjectAabbs(map), radius = 0.7;
  const candidates = [...map.spawnPoints.map((p) => [p[0], p[2]]), [0, 0]];
  for (let z = bounds.minZ + 2; z < bounds.maxZ - 2; z += 2) for (let x = bounds.minX + 2; x < bounds.maxX - 2; x += 2) candidates.push([x, z]);
  for (const [x, z] of candidates.slice(0, 10000)) for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
    const tx = x + dx, tz = z + dz;
    if (Math.min(x, tx) < bounds.minX + 1 || Math.max(x, tx) > bounds.maxX - 1 || Math.min(z, tz) < bounds.minZ + 1 || Math.max(z, tz) > bounds.maxZ - 1) continue;
    const from: CgVec3 = [x, sampleTerrainHeight(map, x, z), z], to: CgVec3 = [tx, sampleTerrainHeight(map, tx, tz), tz];
    if (Math.abs(from[1] - to[1]) > 0.6) continue;
    if (boxes.some((b) => b.max[1] > Math.min(from[1], to[1]) + 0.2 && b.min[1] < Math.max(from[1], to[1]) + 2 && b.max[0] + radius > Math.min(x, tx) && b.min[0] - radius < Math.max(x, tx) && b.max[2] + radius > Math.min(z, tz) && b.min[2] - radius < Math.max(z, tz))) continue;
    return [from, to];
  }
  const p = map.spawnPoints[0] ?? [0, 0, 0];
  const from: CgVec3 = [p[0], sampleTerrainHeight(map, p[0], p[2]), p[2]];
  return [from, [from[0] + 0.5, from[1], from[2]]];
}

export function createDemo(map: EditableMap, previous: DirectorDocument): { document: DirectorDocument; resources: CgResources } {
  const node = (id: string, pos: number[], size: number[], color: number) => ({ id, transform: { pos, quat: [0, 0, 0, 1] }, mesh: { type: 'box', params: { width: size[0], height: size[1], depth: size[2] }, color } });
  const modelJson = { nodes: [node('body', [0, 1.04, 0], [0.52, 0.7, 0.3], 0x3899de), node('head', [0, 1.61, 0], [0.36, 0.36, 0.34], 0xf1c8a3), node('left_arm', [-0.37, 1.05, 0], [0.18, 0.62, 0.2], 0x267cba), node('right_arm', [0.37, 1.05, 0], [0.18, 0.62, 0.2], 0x267cba), node('left_leg', [-0.15, 0.35, 0], [0.21, 0.68, 0.25], 0x293855), node('right_leg', [0.15, 0.35, 0], [0.21, 0.68, 0.25], 0x293855), node('eyes', [0, 1.65, 0.178], [0.22, 0.045, 0.025], 0x182033)] };
  const asset: MapAsset = { id: 'cg_demo_actor_asset', name: '离线演示演员', prompt: 'CGCreator 内置离线方块演员', modelJson, colliderPlan: buildModelColliderPlan(modelJson), mode: 'builtin-demo', createdAt: 0, updatedAt: 0 };
  const fps = 30, duration = 1;
  const rotation = (phase: number): CgVec3[] => Array.from({ length: 31 }, (_, i) => [Math.sin(i / fps * Math.PI * 2 + phase) * 0.5, 0, 0]);
  const clip: CgClip = { id: 'demo_walk_clip', entityId: 'demo_actor', modelHash: stableHash(modelJson), description: '内置原地步行循环', duration, fps, loop: true, rootMotion: 'in-place', source: 'builtin', tracks: { left_arm: { rotation: rotation(0) }, right_arm: { rotation: rotation(Math.PI) }, left_leg: { rotation: rotation(Math.PI) }, right_leg: { rotation: rotation(0) } } };
  const [from, to] = demoPath(map);
  return { resources: { models: [asset], clips: [clip] }, document: { ...clone(previous), revision: previous.revision + 1, title: `${map.name} · 离线演示`, sourcePrompt: '离线演示：演员走入场景，镜头跟拍，再推进特写，出现火花。', entities: [{ id: 'demo_actor', name: '演员', kind: 'actor', assetId: asset.id, startAnchorId: 'demo_start', height: 1.8, description: '蓝色外套的演示演员' }], anchors: [{ id: 'demo_start', name: '演员起点', kind: 'point', position: from, space: 'world' }, { id: 'demo_end', name: '演员终点', kind: 'point', position: to, space: 'world' }], shots: [{ id: 'demo_shot_wide', name: '01 · 入场', purpose: '从后侧建立演员前进方向和场景空间', duration: 4, camera: { movement: 'tracking', framing: 'wide', subjectId: 'demo_actor', reference: 'subject-motion', view: 'rear-three-quarter', aim: 'body', side: 'right' }, subtitle: '一段发生在这张地图里的故事。' }, { id: 'demo_shot_push', name: '02 · 靠近', purpose: '保持运动方向并靠近角色', duration: 4, transition: { type: 'cut', motivation: 'action' }, camera: { movement: 'dolly', framing: 'medium', subjectId: 'demo_actor', reference: 'subject-motion', view: 'side', aim: 'upper-body', side: 'right' } }, { id: 'demo_shot_close', name: '03 · 发现', purpose: '用眼平特写捕捉反应', duration: 3, transition: { type: 'cut', motivation: 'reaction' }, camera: { movement: 'static', framing: 'close-up', subjectId: 'demo_actor', reference: 'subject-facing', view: 'front-three-quarter', aim: 'eyes', lensMm: 85, side: 'right' }, subtitle: '此刻，故事开始。' }], actions: [{ id: 'demo_move', entityId: 'demo_actor', type: 'move', start: { kind: 'absolute', seconds: 0 }, duration: 6, targetAnchorId: 'demo_end' }, { id: 'demo_walk', entityId: 'demo_actor', type: 'animate', start: { kind: 'with', id: 'demo_move' }, duration: 6, clipId: clip.id }, { id: 'demo_turn', entityId: 'demo_actor', type: 'face', start: { kind: 'after', id: 'demo_move' }, duration: 1, targetAnchorId: 'demo_start' }, { id: 'demo_spark', entityId: 'demo_actor', type: 'effect', start: { kind: 'with', id: 'demo_shot_close', offset: 0.5 }, duration: 1.2, effect: 'spark' }], constraints: [], worldPatch: [] } };
}
