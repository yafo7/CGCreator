import { randomUUID } from 'node:crypto';
import type { CgClip, CgMapSyncSummary, CgPatchOperation, CgProgress, CgProject, CgResources, CgVec3, DirectorDocument } from '../shared/cgTypes';
import { assertGenerationDescription, emptyPreparation, selectedPreparedVersion, type CgPreparedAssetVersion } from '../shared/cgPreparation';
import { applyDirectorPatch, compileDirector } from '../shared/cgCompiler';
import { stableHash, validateDirectorDocument } from '../shared/cgValidation';
import { getMapBounds, getMapObjectAabbs, getObjectWorldTransforms, sampleTerrainHeight, type EditableMap, type MapAsset } from '../shared/map';
import { buildModelColliderPlan, calculateModelSemanticLandmarks } from '../shared/modelBounds';
import { buildPoseRig } from '../shared/cgPoseEvaluator';
import type { RenderScheme } from '../shared/renderScheme';
import { MODEL_API_BASE, type ChatProvider } from '../shared/protocol';
import { generateModel, llmChat, type ChatMessage } from './modelApi';
import { CgHttpError, CgStore } from './cgStore';
import { CG_CAMERA_GRAMMAR_PROMPT } from '../shared/cgCameraGrammar';
import { buildWorldSemanticIndex } from '../shared/cgWorldSemantics';
import { inspectShotSamples } from '../shared/cgViewSemantics';
import { CG_WORLD_READING_PROMPT, queryWorld, worldSummary } from '../shared/cgWorldQuery';
import { CG_COVERAGE_PROMPT, CG_SHOT_SKILLS, createBehaviorCoverage, performanceForDirector } from '../shared/cgShotSkills';
import { createFoundationDemo } from '../shared/cgFoundationDemo';
import { mapSpatialAnchors } from '../shared/cgSpatialBindings';
import { createCinematicAutopilotPlan } from '../shared/cgCinematicAutopilot';
import { assemblyForMotion, inferSemanticAssembly, inspectMountedAssembly, modelHasEmbeddedProp, planAssemblies, requestMount, requestProductionTool, requestRefine, stripEmbeddedProp, type CgAssemblyArtifact } from './cgProductionAgent';
import { CgOrchestrator, type CgGenerationResult } from './cgOrchestrator';
import { parseLlmJsonObject } from './llmJson';

export interface CgServiceOptions {
  chat?: (messages: ChatMessage[]) => Promise<string>;
  model?: (description: string, seed: number, refs?: unknown[]) => Promise<unknown>;
  animation?: (model: unknown, description: string, duration: number) => Promise<unknown>;
  mount?: (primary: unknown, secondary: unknown, description: string) => Promise<{ modelJson: unknown; mountedGroupId: string }>;
  refine?: (modelJson: unknown, description: string) => Promise<unknown>;
}
type Progress = CgProgress & { running: boolean };
const clone = <T>(value: T): T => structuredClone(value);
function fail(code: string, message: string): never { throw new CgHttpError(422, code, message); }
function bindDirectorPayload(planned: unknown, previous: DirectorDocument, mapId: string, prompt: string): DirectorDocument {
  const creative = planned as Partial<DirectorDocument>;
  return {
    schemaVersion: creative.schemaVersion === 1 ? 1 : 2,
    id: previous.id,
    title: typeof creative.title === 'string' && creative.title.trim() ? creative.title : prompt.slice(0, 120),
    sourcePrompt: typeof creative.sourcePrompt === 'string' ? creative.sourcePrompt : prompt,
    mapId,
    revision: previous.revision + 1,
    seed: previous.seed,
    entities: Array.isArray(creative.entities) ? creative.entities : [],
    anchors: Array.isArray(creative.anchors) ? creative.anchors : [],
    shots: Array.isArray(creative.shots) ? creative.shots : [],
    actions: Array.isArray(creative.actions) ? creative.actions : [],
    constraints: clone(previous.constraints),
    worldPatch: Array.isArray(creative.worldPatch) ? creative.worldPatch : []
  };
}
function bindDirectorMapAuthority(document: DirectorDocument, previous: DirectorDocument, map: EditableMap, semanticAnchors: DirectorDocument['anchors']): DirectorDocument {
  // WorldForge-derived anchors are immutable facts and can be rebound by ID.
  // User-authored anchors remain fail-closed so an AI attempt to modify a hard
  // lock is surfaced instead of silently repaired.
  const canonical = new Map(semanticAnchors.map(anchor => [anchor.id, anchor]));
  const guideIds = new Set(map.guides.map(guide => guide.id));
  const bound = {
    ...document,
    anchors: document.anchors.map(anchor => clone(canonical.get(anchor.id) ?? anchor)),
    actions: document.actions.map(action => action.route ? {
      ...action,
      route: {
        ...action.route,
        guideIds: action.route.guideIds.map(guideId => guideIds.has(guideId) ? guideId : guideId.startsWith('guide:') && guideIds.has(guideId.slice('guide:'.length)) ? guideId.slice('guide:'.length) : guideId)
      }
    } : action),
    constraints: clone(previous.constraints)
  };
  return stabilizeDirectorSpatialStarts(bound, map, semanticAnchors);
}

/** Resolve two common semantic-planning mistakes without inventing geometry:
 * guide centre-lines can pass below a raised bridge, and unrelated named
 * guides can look connected in language while remaining disjoint in space.
 * Every replacement below is an exact WorldForge-derived anchor. */
function stabilizeDirectorSpatialStarts(document: DirectorDocument, map: EditableMap, semanticAnchors: DirectorDocument['anchors']): DirectorDocument {
  const result = clone(document);
  // 3d-generate models use authoring units rather than guaranteed metres.
  // Freeze a semantic real-world height so collision, navigation and camera
  // solvers do not interpret a valid character as a four-metre performer.
  for (const entity of result.entities) if (entity.height === undefined) {
    const label = `${entity.name} ${entity.description ?? ''}`;
    entity.height = entity.kind === 'actor'
      ? /少年|男孩|boy|child/i.test(label) ? 1.45
        : /女子|美女|侍女|woman|girl|maid/i.test(label) ? 1.68
          : /侠客|男人|男子|man|male|swordsman/i.test(label) ? 1.78 : 1.7
      : /剑|刀|sword|blade/i.test(label) ? 1.05 : 1;
  }
  const canonical = new Map(semanticAnchors.map(anchor => [anchor.id, anchor]));
  const included = new Set(result.anchors.map(anchor => anchor.id));
  const include = (id: string) => {
    if (included.has(id)) return;
    const anchor = canonical.get(id);
    if (anchor) { result.anchors.push(clone(anchor)); included.add(id); }
  };
  const usedStarts = new Set(result.entities.map(entity => entity.startAnchorId).filter((id): id is string => !!id));
  const raisedSurface = /桥|bridge|平台|platform|deck|屋顶|roof|露台|terrace/i;
  const horizontalDistance = (left: CgVec3, right: CgVec3) => Math.hypot(left[0] - right[0], left[2] - right[2]);

  // A bridge guide often describes its plan-view centre-line at terrain or
  // pond-bed height. Bind actors to the measured collision-envelope surface.
  for (const entity of result.entities) {
    if (entity.kind !== 'actor' || !entity.startAnchorId) continue;
    const source = canonical.get(entity.startAnchorId);
    if (!source?.binding || source.binding.kind !== 'guide' || !raisedSurface.test(source.name)) continue;
    const candidates = semanticAnchors.filter(anchor =>
      anchor.id.startsWith('map_surface:') && raisedSurface.test(anchor.name)
      && anchor.position[1] > source.position[1] + 0.25
      && horizontalDistance(anchor.position, source.position) <= 3
    ).sort((left, right) =>
      horizontalDistance(left.position, source.position) - horizontalDistance(right.position, source.position)
      || Number(left.id.endsWith(':side')) - Number(right.id.endsWith(':side'))
      || left.id.localeCompare(right.id)
    );
    const replacement = candidates.find(anchor => !usedStarts.has(anchor.id)) ?? candidates[0];
    if (!replacement) continue;
    usedStarts.delete(entity.startAnchorId!);
    entity.startAnchorId = replacement.id;
    usedStarts.add(replacement.id);
    include(replacement.id);
  }

  const guides = new Map(map.guides.map(guide => [guide.id, guide]));
  const guidesTouch = (leftId: string, rightId: string) => {
    if (leftId === rightId) return true;
    const left = guides.get(leftId), right = guides.get(rightId);
    if (!left || !right) return false;
    const leftEnds = [left.points[0], left.points.at(-1)!], rightEnds = [right.points[0], right.points.at(-1)!];
    return leftEnds.some(a => rightEnds.some(b => Math.hypot(a[0] - b[0], a[1] - b[1]) <= (left.width + right.width) / 2 + 0.75));
  };
  const routeConnects = (ids: string[], from: string, to: string) => {
    const allowed = [...new Set(ids.filter(id => guides.has(id)))];
    const seen = new Set([from]), queue = [from];
    while (queue.length) {
      const current = queue.shift()!;
      if (current === to) return true;
      for (const next of allowed) if (!seen.has(next) && guidesTouch(current, next)) { seen.add(next); queue.push(next); }
    }
    return false;
  };

  // Repair only the first travel beat for an actor. Later moves begin from the
  // preceding action state and must not rewrite the entity's initial anchor.
  const repairedActors = new Set<string>();
  for (const action of result.actions) {
    if (action.type !== 'move' || !action.route || repairedActors.has(action.entityId)) continue;
    repairedActors.add(action.entityId);
    const entity = result.entities.find(item => item.id === action.entityId);
    const source = entity?.startAnchorId ? canonical.get(entity.startAnchorId) : undefined;
    const target = action.targetAnchorId ? canonical.get(action.targetAnchorId) : undefined;
    if (!entity || !source?.binding || source.binding.kind !== 'guide' || !target?.binding || target.binding.kind !== 'guide') continue;
    const fromGuide = source.binding.guideId, toGuide = target.binding.guideId;
    const targetProgress = target.binding.progress;
    const alternatives = semanticAnchors.filter(anchor => anchor.binding?.kind === 'guide' && anchor.binding.guideId === toGuide && anchor.id !== target.id)
      .sort((left, right) => horizontalDistance(left.position, target.position) - horizontalDistance(right.position, target.position) || Math.abs((right.binding as { progress: number }).progress - targetProgress) - Math.abs((left.binding as { progress: number }).progress - targetProgress) || left.id.localeCompare(right.id));
    const defaultMaxSpeed = action.route.locomotion === 'run' ? 7 : 2.5;
    const sameGuideTooFast = fromGuide === toGuide && horizontalDistance(source.position, target.position) / Math.max(0.001, action.duration) > defaultMaxSpeed;
    // Keep a same-guide trip on that guide alone. A model-supplied speed cap is
    // not a user constraint and can contradict the authored duration.
    if (fromGuide === toGuide) {
      const { maxSpeed: _discardedModelGuess, ...route } = action.route;
      action.route = { ...route, guideIds: [toGuide] };
      if (!sameGuideTooFast) continue;
    } else if (routeConnects(action.route.guideIds, fromGuide, toGuide)) continue;
    const replacement = alternatives.find(anchor => !usedStarts.has(anchor.id)) ?? alternatives[0];
    if (!replacement) continue;
    usedStarts.delete(entity.startAnchorId!);
    entity.startAnchorId = replacement.id;
    usedStarts.add(replacement.id);
    include(replacement.id);
    const { maxSpeed: _discardedModelGuess, ...route } = action.route;
    action.route = { ...route, guideIds: [toGuide] };
  }
  return result;
}
function directorPlanProblems(document: DirectorDocument, previous: DirectorDocument, map: EditableMap, semanticAnchors: DirectorDocument['anchors']): string[] {
  const validation = validateDirectorDocument(document, document.schemaVersion === 2 ? { allowNoShots: true } : undefined);
  const problems = validation.diagnostics.map(item => item.message);
  const knownObjects = new Set(map.objects.map(object => object.id));
  const knownGuides = new Set(map.guides.map(guide => guide.id));
  const addedObjects = new Set(document.worldPatch.flatMap(operation => operation.type === 'object.add' ? [operation.object.id] : []));
  for (const entity of document.entities) {
    if (entity.objectId && !knownObjects.has(entity.objectId) && !addedObjects.has(entity.objectId)) problems.push(`Entity ${entity.id} references unknown map object ${entity.objectId}.`);
  }
  for (const action of document.actions) for (const guideId of action.route?.guideIds ?? []) {
    if (!knownGuides.has(guideId)) problems.push(`Action ${action.id} references unknown route guide ${guideId}; use an exact WorldForge guide ID.`);
  }
  const allowedAnchors = new Map([...semanticAnchors, ...previous.anchors].map(anchor => [anchor.id, anchor]));
  for (const anchor of document.anchors) {
    if (stableHash(allowedAnchors.get(anchor.id)) !== stableHash(anchor)) problems.push(`Anchor ${anchor.id} was invented or modified; copy an exact supplied anchor object.`);
  }
  if (stableHash(document.constraints) !== stableHash(previous.constraints)) problems.push('Manual constraints were removed or modified; copy them verbatim.');
  for (const constraint of previous.constraints) {
    if (constraint.anchorId && stableHash(document.anchors.find(anchor => anchor.id === constraint.anchorId)) !== stableHash(previous.anchors.find(anchor => anchor.id === constraint.anchorId))) {
      problems.push(`Locked anchor ${constraint.anchorId} was removed or modified.`);
    }
  }
  return [...new Set(problems)];
}
function cgChatProvider(): ChatProvider {
  const configured = process.env.CG_CHAT_PROVIDER?.trim();
  if (configured === 'gpt' || configured === 'glm' || configured === 'fireworks' || configured === 'deepseek-v4-pro') return configured;
  return 'gpt';
}
function invalidationRoot(operations: CgPatchOperation[]): string[] {
  if (operations.every(operation => operation.type === 'shot.update' || operation.type === 'constraint.upsert' && ['camera-pose', 'camera-path', 'shot-duration'].includes(operation.constraint.type))) return ['camera'];
  if (operations.every(operation => operation.type === 'action.update' || operation.type === 'constraint.upsert' && ['action-target', 'action-route', 'action-time'].includes(operation.constraint.type) || operation.type === 'anchor.upsert' || operation.type === 'constraint.remove')) return ['performance'];
  return ['preproduction'];
}

function namespaceSharedActorClipIds(document: DirectorDocument): void {
  const owners = new Map<string, Set<string>>();
  for (const action of document.actions) if (action.clipId) {
    const set = owners.get(action.clipId) ?? new Set<string>();
    set.add(action.entityId); owners.set(action.clipId, set);
  }
  const shared = new Set([...owners].filter(([, entityIds]) => entityIds.size > 1).map(([clipId]) => clipId));
  for (const action of document.actions) if (action.clipId && shared.has(action.clipId)) action.clipId = `${action.clipId}:${action.entityId}`;
}

/** 3d-generate responds best to one short, object-only phrase. Director
 * descriptions may also contain blocking, interaction and camera context;
 * those clauses belong to the timeline and must never become model geometry. */
function conciseModelDescription(entity: DirectorDocument['entities'][number]): string {
  const source = entity.description?.trim() || entity.name;
  const context = /沿|走|跑|来到|站在|位于|适合|用于|动作|表现|递|交给|接剑|接住|查看|举起|确认|场景|镜头|交谈|坐下|飞身|落地/i;
  const kept: string[] = [];
  for (const raw of source.split(/[，。；;\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    if (kept.length && context.test(part)) break;
    kept.push(part);
    if (kept.join('，').length >= 120) break;
  }
  const core = (kept.length ? kept.join('，') : entity.name).slice(0, 150);
  return `${entity.kind === 'actor' ? '单个' : '单件'}${core}`;
}

export class CgService {
  readonly progress = new Map<string, Progress>();
  readonly orchestrator: CgOrchestrator;
  constructor(readonly store: CgStore, private options: CgServiceOptions = {}) {
    this.orchestrator = new CgOrchestrator(this);
  }

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
    const project = await this.run(id, 'preparing', `制作${kind === 'actor' ? '角色' : '道具'}：${name}`, async () => {
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
    await this.orchestrator.invalidate(id, ['production']);
    return project;
  }

  /** Save a full-editor result as a new immutable version; existing confirmed CGs keep their old model. */
  async savePreparedVersion(id: string, revision: number, input: { assetId?: unknown; modelJson?: unknown; description?: unknown }) {
    const suppliedDescription = input.description;
    assertGenerationDescription(suppliedDescription);
    assertModel(input.modelJson);
    const project = await this.store.transaction(id, revision, project => {
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
    await this.orchestrator.invalidate(id, ['production']);
    return project;
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
    const project = await this.run(id, 'preparing-motion', `制作动作：${name}`, async () => {
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
    await this.orchestrator.invalidate(id, ['production']);
    return project;
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
    await this.orchestrator.invalidate(id, ['world-deep-read']);
    return { project, summary };
  }

  async plan(id: string, revision: number, prompt: string, demo = false) {
    this.requirePrompt(prompt);
    const existing = await this.store.read(id);
    if (existing.revision !== revision) throw new CgHttpError(409, 'revision_conflict', '项目已更新，请重新打开最新版本后重试。');
    // A durable Run may be resumed after Production or validation failed. The
    // already validated DirectorDocument is the input to that retry; asking the
    // creative model to rewrite it makes retries non-deterministic and can turn
    // merely pending resources into a false unsupported-intent refusal.
    if (!demo && existing.document.schemaVersion === 2 && existing.document.sourcePrompt === prompt && existing.document.entities.length && existing.document.actions.length && existing.document.shots.length) {
      this.progress.set(id, { stage: 'ready', message: '复用已验证的导演文档', running: false });
      return existing;
    }
    return this.run(id, 'planning', demo ? '创建离线演示意图' : '根据地图语义生成导演文档', () => this.store.transaction(id, revision, async (project) => {
      let document: DirectorDocument;
      if (demo) {
        if (project.document.constraints.length) fail('hard_constraints_present', '已有人工约束，请使用局部修改；离线演示不能替换这些约束。');
        const result = createDemo(project.mapSnapshot, project.document);
        document = result.document;
        project.resources = result.resources;
      } else {
        const semantic = buildSemanticContext(project.mapSnapshot);
        const documentIdentity = { id: project.document.id, mapId: project.mapSnapshot.id, revision: project.document.revision + 1, seed: project.document.seed };
        const directorMessages: ChatMessage[] = [
          { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ intent: prompt, map: semantic, preparedAssets: preparedAssetsForDirector(project), documentIdentity, existingDocument: project.document.shots.length ? project.document : null }) }
        ];
        let answer: unknown;
        let automatic = createCinematicAutopilotPlan({ map: project.mapSnapshot, previous: project.document, prompt, anchors: semantic.anchors });
        if (!automatic) try {
          answer = await this.directorAnswer(directorMessages, project.mapSnapshot);
          if (isUnsupportedIntent(answer)) automatic = createCinematicAutopilotPlan({ map: project.mapSnapshot, previous: project.document, prompt, anchors: semantic.anchors });
        } catch (error) {
          // A recognised cinematic request should remain one-click even if the
          // optional LLM planning service is momentarily unavailable. The
          // deterministic path only accepts verified map anchors and retains
          // all manual constraints, so it is safe to use as this fallback.
          automatic = createCinematicAutopilotPlan({ map: project.mapSnapshot, previous: project.document, prompt, anchors: semantic.anchors });
          if (!automatic) throw error;
        }
        if (answer !== undefined) assertSupportedAnswer(answer, 'unsupported_intent', !!automatic);
        let planned = automatic ?? answer;
        if (!planned || typeof planned !== 'object' || Array.isArray(planned)) fail('invalid_ai_document', 'AI 没有返回可用的导演文档。');
        // Document identity is storage authority, not creative model output.
        // Models may omit, copy incorrectly, or attempt to rewrite these fields;
        // always bind the generated content to the current project transaction.
        document = bindDirectorMapAuthority(bindDirectorPayload(planned, project.document, project.mapSnapshot.id, prompt), project.document, project.mapSnapshot, semantic.anchors);
        let planProblems = directorPlanProblems(document, project.document, project.mapSnapshot, semantic.anchors);
        if (planProblems.length && !automatic) {
          for (let repairAttempt = 1; repairAttempt <= 3 && planProblems.length; repairAttempt++) {
            answer = await this.directorAnswer([
              ...directorMessages,
              { role: 'assistant', content: JSON.stringify(answer) },
              { role: 'user', content: JSON.stringify({
                task: 'repair-director-document',
                attempt: repairAttempt,
                documentIdentity,
                validationErrors: planProblems,
                allowedAnchorIds: semantic.anchors.map(anchor => anchor.id),
                instruction: 'Return one complete corrected DirectorDocument JSON object. Give every entity, action and shot a unique ASCII ID and update every reference. Remove protocol fields not listed in the schema. Every anchor must be copied verbatim from the supplied map and use one of allowedAnchorIds; never rename or synthesize an anchor. Preserve all manual constraints.'
              }) }
            ], project.mapSnapshot);
            assertSupportedAnswer(answer, 'unsupported_intent');
            planned = answer;
            if (!planned || typeof planned !== 'object' || Array.isArray(planned)) fail('invalid_ai_document', 'AI 没有返回可用的导演文档。');
            document = bindDirectorMapAuthority(bindDirectorPayload(planned, project.document, project.mapSnapshot.id, prompt), project.document, project.mapSnapshot, semantic.anchors);
            planProblems = directorPlanProblems(document, project.document, project.mapSnapshot, semantic.anchors);
          }
        }
        if (planProblems.length) fail('invalid_performance_plan', planProblems.join('\n'));
        if (document.schemaVersion === 2) {
          if (!document.shots.length) document.shots = createBehaviorCoverage(document);
          if (automatic) for (const shot of document.shots) {
            const action = document.actions.find(item => item.id === shot.behaviorId);
            shot.skillId = action?.type === 'airborne' ? 'airborne-side' : action?.type === 'handoff' ? 'handoff-two' : action?.type === 'hold' ? 'reveal-high' : undefined;
          }
          project.coveragePending = !automatic;
        } else project.coveragePending = false;
        this.assertDocument(document);
      }
      document.sourcePrompt = prompt;
      this.assertDocument(document);
      project.document = document;
      project.title = document.title;
      project.candidate = null;
    }));
  }

  /** One-click generation entry point. The durable orchestrator owns the
   * multi-agent phases while this service remains the compatibility facade. */
  async generate(id: string, revision: number, prompt: string, demo = false): Promise<CgGenerationResult> {
    this.requirePrompt(prompt);
    return this.orchestrator.start(id, revision, prompt, demo);
  }

  /** Freeze Production Agent outputs as their own project revision before
   * performance/camera planning. Repeated calls reuse content-addressed
   * resources and therefore do not invoke 3d-generate twice. */
  async prepareResources(id: string, revision: number): Promise<CgProject> {
    return this.run(id, 'preparing-resources', '准备角色、道具、装配和动作', () => this.store.transaction(id, revision, async project => {
      this.assertDocument(project.document);
      await this.resolveResources(project);
      project.candidate = null;
    }));
  }

  async patch(id: string, revision: number, operations: CgPatchOperation[]) {
    const project = await this.store.transaction(id, revision, (project) => {
      project.document = this.applyPatch(project.document, operations, 'user');
      project.title = project.document.title;
      // Keep the previous candidate for compiler dependency comparison, but its revision is now stale.
    });
    await this.orchestrator.invalidate(id, invalidationRoot(operations));
    return project;
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
    await this.orchestrator.invalidate(id, invalidationRoot(operations));
    return { project, operations };
  }

  async compile(id: string, revision: number) {
    return this.run(id, 'resources', '冻结模型和动画资源', () => this.store.transaction(id, revision, async (project) => {
      this.assertDocument(project.document);
      await this.resolveResources(project);
      // Compatibility path for callers that still invoke plan + compile. The
      // multi-agent Run calls prepareCameraCoverage first, so its compiler
      // branch is deterministic and never invokes the director model.
      if (!await this.resolveCoverage(project)) return;
      this.progress.set(id, { stage: 'compiling', message: '编译镜头、行动和世界状态并校验硬约束', running: true });
      project.candidate = compileDirector(project.document, project.mapSnapshot, project.schemeSnapshot, project.resources, project.candidate ?? project.confirmed ?? undefined);
    }));
  }

  async prepareCameraCoverage(id: string, revision: number): Promise<CgProject> {
    const current = await this.store.read(id);
    if (current.revision !== revision) throw new CgHttpError(409, 'revision_conflict', '项目已更新，请重新打开最新版本后重试。');
    if (current.document.schemaVersion !== 2 || !current.coveragePending) return current;
    return this.run(id, 'camera-planning', '摄影 Agent 根据已求解表演选择镜头', () => this.store.transaction(id, revision, async project => {
      this.assertDocument(project.document);
      if (!await this.resolveCoverage(project)) fail('performance_invalid', project.candidate?.validation.diagnostics.map(item => item.message).join('\n') || '表演求解未通过。');
    }));
  }

  async confirm(id: string, revision: number, compileId: string, inputHash: string) {
    const project = await this.store.transaction(id, revision, (project) => {
      const candidate = project.candidate;
      if (candidate?.stage === 'performance') fail('incomplete_compile', '行为验证结果尚未完成镜头编译，不能确认。');
      if (!candidate || candidate.id !== compileId || candidate.inputHash !== inputHash || candidate.documentRevision !== project.document.revision) fail('stale_compile', '预览已过期，请重新编译并预览当前版本。');
      if (!candidate.validation.valid) fail('invalid_compile', '编译存在错误，不能确认。');
      const current = compileDirector(project.document, project.mapSnapshot, project.schemeSnapshot, project.resources);
      if (!current.validation.valid || current.id !== compileId || current.inputHash !== inputHash) fail('stale_compile', '编译输入已改变，请重新预览。');
      project.confirmed = clone(candidate);
    });
    await this.orchestrator.markConfirmed(id, compileId);
    return project;
  }

  private async resolveCoverage(project: CgProject): Promise<boolean> {
    if (project.document.schemaVersion !== 2 || !project.coveragePending) return true;
    this.progress.set(project.id, { stage: 'performance-planning', message: '先验证路线、交互和持续姿态', running: true });
    const performance = compileDirector(project.document, project.mapSnapshot, project.schemeSnapshot, project.resources, undefined, { performanceOnly: true });
    if (!performance.validation.valid) { project.candidate = performance; return false; }
    this.progress.set(project.id, { stage: 'camera-planning', message: '摄影 Agent 依据已验证的行为与姿态选择镜头', running: true });
    const answer = await this.directorAnswer([
      { role: 'system', content: `${CG_COVERAGE_PROMPT}\n${CG_WORLD_READING_PROMPT}` },
      { role: 'user', content: JSON.stringify({ document: project.document, performance: performanceForDirector(performance), shotSkills: CG_SHOT_SKILLS, map: buildSemanticContext(project.mapSnapshot) }) }
    ], project.mapSnapshot);
    assertSupportedAnswer(answer, 'unsupported_intent');
    const operations = sanitizeCoverageOperations(answer, project.document);
    if (operations.length) project.document = this.applyPatch(project.document, operations, 'ai');
    project.coveragePending = false;
    return true;
  }

  private async resolveResources(project: CgProject) {
    // Animation clips are model-bound. Natural director language often calls
    // every actor's gait `walk_in_place`; namespace only IDs shared by distinct
    // actors while retaining reuse within one actor.
    namespaceSharedActorClipIds(project.document);
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
    // Use the same short model descriptions as 3d-generate, while carrying a
    // few eligible WorldForge asset references for visual continuity.
    const styleRefs = (project.mapSnapshot.assets ?? []).filter(asset => {
      const meta = asset.modelJson as { _meta?: { ai?: unknown } };
      return !!meta?._meta?.ai && asset.tags?.includes('cg-style-reference');
    }).slice(0, 3).map(asset => asset.modelJson);
    const assetIdFor = (entity: DirectorDocument['entities'][number]) => {
      const object = project.mapSnapshot.objects.find((item) => item.id === entity.objectId);
      const added = project.document.worldPatch.find((operation) => operation.type === 'object.add' && operation.object.id === entity.objectId);
      return object?.assetId ?? (added?.type === 'object.add' ? added.object.assetId : null) ?? entity.assetId;
    };
    // Phase 1: every actor and prop exists before an assembly or motion task is
    // allowed to start. This prevents document ordering from changing output.
    for (const entity of project.document.entities) {
      const assetId = assetIdFor(entity);
      if (!assetId) continue;
      if (!models.has(assetId)) {
        if (!entity.description?.trim()) fail('missing_resource_description', `缺少模型 ${assetId}，请提供角色或道具描述。`);
        const description = conciseModelDescription(entity);
        const key = `model_${stableHash({ description, seed: project.document.seed, mode: 'voxel', refs: styleRefs.map(model => stableHash(model)) })}`;
        this.progress.set(project.id, { stage: 'model', message: `通过 3d-generate 生成：${entity.name}`, running: true });
        let asset = await this.store.cached<MapAsset>(key);
        if (!asset) {
          const modelJson = await (this.options.model ? this.options.model(description, project.document.seed, styleRefs) : generateModel(description, { apiBase: process.env.CG_MODEL_API_BASE, seeded: true, seed: project.document.seed, refs: styleRefs.map(model => ({ model, note: '保持场景风格' })), signal: AbortSignal.timeout(300_000) }));
          assertModel(modelJson);
          asset = { id: assetId, name: entity.name, prompt: description, modelJson, colliderPlan: buildModelColliderPlan(modelJson), mode: 'voxel', provider: '3d-generate', createdAt: Date.now(), updatedAt: Date.now() };
          await this.store.cache(key, asset);
        }
        asset = { ...asset, id: assetId };
        project.resources.models.push(asset);
        models.set(assetId, asset);
      }
    }

    const assemblyPlan = planAssemblies(project.document);
    // Remove an accidentally embedded weapon before creating the authoritative
    // external prop. Otherwise playback would visibly contain two swords.
    for (const requirement of assemblyPlan) {
      const actorAssetId = assetIdFor(requirement.actor);
      const actorAsset = actorAssetId ? models.get(actorAssetId) : undefined;
      if (!actorAsset || !modelHasEmbeddedProp(actorAsset.modelJson, requirement.prop.name)) continue;
      const description = `移除${requirement.actor.name}模型自带的${requirement.prop.name}，保留人物、服装和可活动肢体`;
      const key = `refined_model_${stableHash({ model: stableHash(actorAsset.modelJson), description })}`;
      this.progress.set(project.id, { stage: 'refine', message: `通过 3d-generate 修正角色：${description}`, running: true });
      let modelJson = await this.store.cached<unknown>(key);
      if (!modelJson) {
        modelJson = await (this.options.refine ? this.options.refine(actorAsset.modelJson, description) : requestRefine(actorAsset.modelJson, description));
        assertModel(modelJson); await this.store.cache(key, modelJson);
      }
      assertModel(modelJson);
      if (modelHasEmbeddedProp(modelJson, requirement.prop.name)) modelJson = stripEmbeddedProp(modelJson, requirement.prop.name);
      if (modelHasEmbeddedProp(modelJson, requirement.prop.name)) fail('embedded_prop_remains', `Refine 后 ${requirement.actor.name} 仍含有重复的${requirement.prop.name}。`);
      const refined = { ...actorAsset, modelJson, colliderPlan: buildModelColliderPlan(modelJson), updatedAt: Date.now() };
      models.set(actorAsset.id, refined);
      project.resources.models = project.resources.models.filter(item => item.id !== actorAsset.id);
      project.resources.models.push(refined);
    }

    // Phase 2: ask 3d-generate to mount the one real prop onto each required
    // actor/socket combination. The combined model is a motion-authoring
    // reference; playback stores only its measured node-local socket.
    const assemblyArtifacts = new Map<string, CgAssemblyArtifact>();
    project.resources.assemblies ??= [];
    for (const requirement of assemblyPlan) {
      const actorAssetId = assetIdFor(requirement.actor), propAssetId = assetIdFor(requirement.prop);
      const actorModel = actorAssetId ? models.get(actorAssetId)?.modelJson : undefined;
      const propModel = propAssetId ? models.get(propAssetId)?.modelJson : undefined;
      if (!actorModel || !propModel) fail('missing_assembly_resource', `无法装配 ${requirement.actor.name} 与 ${requirement.prop.name}。`);
      const key = `assembly_${stableHash({ id: requirement.id, actor: stableHash(actorModel), prop: stableHash(propModel), description: requirement.description })}`;
      let artifact = await this.store.cached<CgAssemblyArtifact>(key);
      if (!artifact) {
        this.progress.set(project.id, { stage: 'mount', message: `通过 3d-generate 装配：${requirement.description}`, running: true });
        let mounted: { modelJson: unknown; mountedGroupId: string } | undefined, fallbackIssue: string | undefined;
        if (this.options.mount) mounted = await this.options.mount(actorModel, propModel, requirement.description);
        else {
          try { mounted = await requestMount(actorModel, propModel, requirement.description); }
          catch (primaryError) {
            // Some valid standalone assets are too complex for the mount
            // planner to reuse directly. The documented text-secondary path
            // produces an authoring reference only; playback still binds the
            // original, single prop model through the measured socket.
            this.progress.set(project.id, { stage: 'mount', message: `修复装配：${requirement.description}`, running: true });
            const accessory = /剑|sword/i.test(`${requirement.prop.name} ${requirement.prop.description ?? ''}`) ? '一把剑' : requirement.prop.name;
            try { mounted = await requestMount(actorModel, accessory, requirement.description); }
            catch (repairError) { fallbackIssue = [primaryError, repairError].map(error => error instanceof Error ? error.message : String(error)).join(' / '); }
          }
        }
        artifact = {
          mountedModel: mounted?.modelJson ?? actorModel,
          profile: mounted ? inspectMountedAssembly({
            actorEntityId: requirement.actor.id, propEntityId: requirement.prop.id, socketId: requirement.socketId,
            actorModel, propModel, mountedModel: mounted.modelJson, mountedGroupId: mounted.mountedGroupId
          }) : inferSemanticAssembly({ actor: requirement.actor, prop: requirement.prop, socketId: requirement.socketId, actorModel, propModel, issue: fallbackIssue ?? '3d-generate mount unavailable' })
        };
        await this.store.cache(key, artifact);
      }
      assemblyArtifacts.set(artifact.profile.id, artifact);
      project.resources.assemblies = project.resources.assemblies.filter(item => item.id !== artifact!.profile.id);
      project.resources.assemblies.push(clone(artifact.profile));
    }

    // Phase 3: bake every declared body motion. A prop-informed motion uses
    // the mounted reference model, then strips mounted geometry tracks so the
    // runtime still renders exactly one prop entity.
    for (const entity of project.document.entities) {
      const assetId = assetIdFor(entity);
      if (!assetId) continue;
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
        const description = action.type === 'move'
          ? `${action.route?.locomotion === 'walk' ? '原地走路' : '原地跑步'}循环，根节点保持不动`
          : action.purpose?.trim().slice(0, 180) || (action.type === 'sit' ? '坐下后保持坐姿' : '自然的原地动作');
        const assembly = assemblyForMotion(action, project.resources.assemblies);
        const artifact = assembly ? assemblyArtifacts.get(assembly.id) : undefined;
        if (action.propEntityId && !artifact) fail('missing_motion_assembly', `动作 ${action.id} 缺少已经验证的道具装配模型。`);
        const motionModel = artifact?.mountedModel ?? model.modelJson;
        const key = `clip_${stableHash({ modelHash, motionModelHash: stableHash(motionModel), description })}`;
        let clip = await this.store.cached<CgClip>(key);
        if (!clip) {
          this.progress.set(project.id, { stage: 'animation', message: `通过 3d-generate 烘焙动作：${clipId}`, running: true });
          const baked = await (this.options.animation ? this.options.animation(motionModel, description, action.duration) : requestBakedAnimation(motionModel, description, action.duration));
          clip = decodeBakedClip(baked, { id: clipId, entityId: entity.id, modelHash, description }, model.modelJson, { ignoreUnknownNodes: !!artifact, stripRootHorizontal: action.type === 'move' });
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

  private chat(messages: ChatMessage[]) {
    return this.options.chat
      ? this.options.chat(messages)
      : llmChat(messages, {
        apiBase: process.env.CG_MODEL_API_BASE,
        provider: cgChatProvider(),
        maxTokens: 12000,
        signal: AbortSignal.timeout(180_000)
      });
  }
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
  const unwrapped = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try { return JSON.parse(unwrapped); }
  catch {
    const rootAt = text.search(/[\[{]/);
    if (rootAt >= 0 && text[rootAt] === '[') {
      let depth = 0, inString = false, escaped = false;
      for (let index = rootAt; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === '[') depth += 1;
        else if (char === ']' && --depth === 0) {
          try { return JSON.parse(text.slice(rootAt, index + 1)); }
          catch { break; }
        }
      }
    }
    try { return parseLlmJsonObject(text, 'invalid_ai_json'); }
    catch { return fail('invalid_ai_json', 'AI 返回了无法解析的 JSON；项目原版本已保留。'); }
  }
}

function isUnsupportedIntent(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'error' in value && value.error === 'unsupported_intent';
}

/** Camera generation is a least-authority stage. Models occasionally echo a
 * shot duration or an action edit alongside an otherwise valid camera choice;
 * retain only the explicitly authorized camera fields instead of allowing that
 * harmless protocol drift to block the complete one-click run. */
function sanitizeCoverageOperations(value: unknown, document: DirectorDocument): CgPatchOperation[] {
  const wrapper = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const named = wrapper ? ['operations', 'patches', 'updates', 'shotUpdates', 'cameraUpdates'].map(key => wrapper[key]).find(Array.isArray) : undefined;
  const compatible = wrapper ? Object.values(wrapper).find(candidate => Array.isArray(candidate) && candidate.some(item => item && typeof item === 'object' && ('type' in item || 'patch' in item))) : undefined;
  const payload = Array.isArray(value) ? value
    : Array.isArray(named) ? named
      : Array.isArray(compatible) ? compatible
        : wrapper && (wrapper.type === 'shot.update' || ['update-shot', 'shot.update'].includes(String(wrapper.op)) || typeof wrapper.id === 'string' && (wrapper.patch || wrapper.camera)) ? [wrapper] : null;
  if (!payload || payload.length > 128) {
    const shape = wrapper ? Object.fromEntries(Object.entries(wrapper).slice(0, 12).map(([key, item]) => [key, Array.isArray(item) ? `array:${item.length}` : typeof item])) : typeof value;
    fail('invalid_coverage', `镜头阶段需要有范围限制的镜头修改数组。响应结构：${JSON.stringify(shape)}`);
  }
  const shotIds = new Set(document.shots.map(shot => shot.id));
  const patchKeys = ['skillId', 'coveragePurpose', 'name', 'purpose', 'camera', 'transition', 'subtitle'] as const;
  const cameraKeys = ['movement', 'framing', 'layout', 'subjectId', 'secondaryId', 'side', 'lensMm', 'distance', 'height', 'azimuth', 'pitch', 'reference', 'view', 'aim', 'aimMode', 'screenPosition'] as const;
  const transitionKeys = ['type', 'duration', 'motivation'] as const;
  const pick = (source: unknown, keys: readonly string[]) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
    return Object.fromEntries(keys.filter(key => key in source).map(key => [key, (source as Record<string, unknown>)[key]]));
  };
  const operations: CgPatchOperation[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const operation = raw as Record<string, unknown>;
    if (operation.type !== undefined && operation.type !== 'shot.update' || operation.op !== undefined && !['update-shot', 'shot.update'].includes(String(operation.op)) || typeof operation.id !== 'string' || !shotIds.has(operation.id)) continue;
    const patch = pick(operation.patch ?? operation, patchKeys);
    if (!patch) continue;
    if ('camera' in patch) patch.camera = pick(patch.camera, cameraKeys);
    if ('transition' in patch) patch.transition = pick(patch.transition, transitionKeys);
    operations.push({ type: 'shot.update', id: operation.id, patch: patch as CgPatchOperation & never });
  }
  if (payload.length && !operations.length) {
    const sample = payload.slice(0, 3).map(item => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([key]) => ['type', 'op', 'id'].includes(key))) : typeof item);
    fail('invalid_coverage', `摄影 Agent 没有返回任何授权范围内的镜头修改。响应标识：${JSON.stringify(sample)}`);
  }
  return operations;
}

function assertSupportedAnswer(value: unknown, code: 'unsupported_intent' | 'unsupported_refine', allowRecovery = false) {
  if (allowRecovery && code === 'unsupported_intent' && isUnsupportedIntent(value)) return;
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
  // A source object origin is not necessarily a playable surface. These
  // anchors expose the verified collision-envelope top for planning such
  // beats as roof launches and bridge landings; the compiler still decides
  // whether a ground route is legal.
  const objectBoxes = new Map<string, { min: CgVec3; max: CgVec3 }>();
  for (const box of getMapObjectAabbs(map)) {
    const current = objectBoxes.get(box.objectId);
    objectBoxes.set(box.objectId, current ? {
      min: [Math.min(current.min[0], box.min[0]), Math.min(current.min[1], box.min[1]), Math.min(current.min[2], box.min[2])],
      max: [Math.max(current.max[0], box.max[0]), Math.max(current.max[1], box.max[1]), Math.max(current.max[2], box.max[2])]
    } : { min: [...box.min], max: [...box.max] });
  }
  for (const object of map.objects) {
    const bounds = objectBoxes.get(object.id);
    if (!bounds) continue;
    const asset = map.assets?.find(item => item.id === object.assetId);
    const nodeNames = (asset?.modelJson as { nodes?: Array<{ name?: unknown; label?: unknown; id?: unknown }> } | undefined)?.nodes?.flatMap(node => [node.name, node.label, node.id].filter((value): value is string => typeof value === 'string')).slice(0, 24).join(' ') ?? '';
    const semanticLabel = [object.name, asset?.name, nodeNames].filter(Boolean).join(' · ');
    anchors.push({ id: `map_surface:${object.id}:top`, name: `${semanticLabel} 顶部可用表面`, kind: 'point', position: [(bounds.min[0] + bounds.max[0]) / 2, bounds.max[1], (bounds.min[2] + bounds.max[2]) / 2], space: 'world', objectId: object.id });
    const dx = bounds.max[0] - bounds.min[0], dz = bounds.max[2] - bounds.min[2];
    if (Math.max(dx, dz) >= 1.2) {
      const offset = Math.min(Math.max(dx, dz) * 0.24, Math.max(0.35, Math.min(dx, dz) * 0.35));
      const centerX = (bounds.min[0] + bounds.max[0]) / 2, centerZ = (bounds.min[2] + bounds.max[2]) / 2;
      const point: CgVec3 = dx >= dz ? [centerX + offset, bounds.max[1], centerZ] : [centerX, bounds.max[1], centerZ + offset];
      anchors.push({ id: `map_surface:${object.id}:side`, name: `${semanticLabel} 顶部交互站位`, kind: 'point', position: point, space: 'world', objectId: object.id });
    }
  }
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
Entity: {id,name,kind:'actor'|'prop',objectId?,assetId?,startAnchorId?,description?,height?}. Anchor: exact supplied object. Shots are sequential {id,name,purpose,duration,camera,transition?,subtitle?}. Camera is semantic {movement:'static'|'dolly'|'tracking'|'orbit'|'crane',framing:'wide'|'medium'|'close-up'|'over-shoulder',subjectId,secondaryId?,side?:'left'|'right',lensMm?,distance?,height?,azimuth?,reference?:'world'|'subject-facing'|'subject-motion'|'interaction-axis',view?:'front'|'front-three-quarter'|'side'|'rear-three-quarter'|'rear',aim?:'body'|'upper-body'|'face'|'eyes'|'interaction',screenPosition?:[x,y]}. Every moving-subject shot must state reference, view and aim. Travel/context defaults to a side or rear-three-quarter view in subject-motion space; arrival defaults to rear or rear-three-quarter. Use a moving front view only when the purpose explicitly needs the face during motion. A close-up must aim at face/eyes in subject-facing space, use a 70–100mm lens, and normally omit distance/height so semantic landmarks determine both. A crane is for a deliberate vertical reveal and must keep a wide framing. Over-shoulder requires two distinct subjects and interaction-axis. Transition is {type:'cut'|'ease-in-out',duration?,motivation:'action'|'look'|'reaction'|'reestablish'|'rhythm'}; omit it on the first shot and use a motivated value afterward. Preserve screen direction and the 30-degree rule. Favor stable composition and restrained movement; camera movement cannot own actor motion.
Actions own the performance timeline: {id,entityId,type:'move'|'airborne'|'face'|'animate'|'visibility'|'effect'|'attach'|'detach'|'handoff'|'sit'|'dialogue'|'hold',start:{kind:'absolute',seconds}|{kind:'after'|'with',id,offset?},duration,targetAnchorId?,targetEntityId?,sourceEntityId?,socketId?,arcHeight?,clipId?,propEntityId?,visible?,effect?:'spark',purpose?,route?,interaction?,endBehavior?}. V2 timing references other actions, NEVER shots. A move requires targetAnchorId; when using a road add route:{guideIds:[exact existing guide IDs],policy:'required'|'preferred',locomotion:'walk'|'run',maxSpeed?} and clipId for its own in-place gait. An airborne action is an actor-only cinematic arc from its exact start anchor to an exact landing anchor; give arcHeight and add a simultaneous animate action for the actor's takeoff/airborne/landing body motion. Attach binds a prop entity to a known actor and socket such as back or right-hand. Handoff has the prop as entityId and exact sourceEntityId, targetEntityId and receiving socketId. Any actor animation authored around a prop declares that prop as propEntityId so the production agent can mount the real prop before baking motion. Give both participants explicit synchronized animate actions for a handoff; the handoff state change alone is not an acted exchange. Use provided map anchors verbatim, including bindings. A sit requires clipId and interaction:{objectId,seatNodeId,approachAnchorId}; first move to that exact approach anchor and orient the actor. Sit is supported only for a stationary named box seat and an actor with explicit contactProfile hips/leftFoot/rightFoot landmarks; the solver must validate the actual clip and feet support. Never pretend an unprofiled model is contact-ready. Sit persists; hold keeps the seated state. Dialogue requires targetEntityId for a distinct participant and means staged facing/turns only, not speech or lip sync. Animate supports endBehavior:'restore'|'hold'. A face needs a target entity or anchor. Effects support only spark. Do not invent attachment, physics, IK or unsupported motion. Do not overlap competing root actions or full-body animations. Preserve manual time and camera locks.
worldPatch is a declarative WorldForge transaction array applied only to a CG snapshot. Supported operations: object.update {objectId,patch:{visible?,transform?}}, object.remove {objectId}, object.add {object:{id,name,assetId,parentId:null,visible:true,locked:false,transform:{position,rotation,scale,size}}}, sun.set {point}. Use existing transforms or supplied anchor positions, not arbitrary coordinates. Other world operations require an explicit supported schema and must not be guessed. Source map locked objects must be preserved. Default worldPatch:[]. constraints defaults to [] only for a new document. Keep the first version short (10–30 seconds, 2–4 shots), grounded in the user intent. An unsupported request must return {error:'unsupported_intent',reason:'...'} instead of silently approximating it.
${CG_CAMERA_GRAMMAR_PROMPT}
${CG_WORLD_READING_PROMPT}`;

const REFINE_SYSTEM_PROMPT = `Return only a JSON array of narrowly scoped CgPatchOperation objects, never a replacement document. Existing IDs are immutable. Allowed operations: {type:'shot.update',id,patch:{name?,purpose?,duration?,transition?:{type,motivation,duration?},subtitle?,camera?:{movement?,framing?,subjectId?,secondaryId?,side?,lensMm?,distance?,height?,azimuth?,reference?,view?,aim?,screenPosition?}}}, {type:'action.update',id,patch:{start?,duration?,targetAnchorId?,targetEntityId?,clipId?,visible?}}, {type:'entity.update',id,patch:{name?,description?,startAnchorId?}}. Use exact IDs and existing anchors. If targetId is supplied, modify only that ID. Never modify user constraints, anchors used by locks, or locked values. Preserve unrelated actions and camera intent. currentView contains mechanically measured beginning/middle/end observations for the selected compiled shot: screen region, coverage, visible fraction and occluder IDs. Use these facts to diagnose framing, but do not claim they prove artistic quality. Axis is Y-up metres and azimuth is radians. Supported camera movement static/dolly/tracking/orbit; framing wide/medium/close-up/over-shoulder. When changing to close-up also set movement static, reference subject-facing, view front-three-quarter, aim eyes and lensMm 70–100; omit distance and height unless explicitly requested. Travel follows use subject-motion with side/rear-three-quarter rather than front unless the intent explicitly asks to read the face during motion. Slow a selected shot by changing only its duration unless the user explicitly requests an action timing change. Unsupported requests return {error:'unsupported_refine',reason:'...'} and no fake success.
${CG_CAMERA_GRAMMAR_PROMPT}
${CG_WORLD_READING_PROMPT}`;

export async function requestBakedAnimation(modelJson: unknown, description: string, requestedDuration?: number) {
  const mode = /坐下|飞身|起跳|空中|落地|取剑|拔剑|递|交|接剑|接住|交谈/.test(description) ? 'pro' : 'quick';
  const apiBase = process.env.CG_MODEL_API_BASE ?? MODEL_API_BASE;
  const request = async (requestMode: 'pro' | 'quick', requestDescription: string, attempts: number) => {
    try {
      const result = await requestProductionTool<{ ok?: boolean; baked?: unknown; error?: string; errorCode?: string }>(
        apiBase,
        '/api/generate/animation',
        { mode: requestMode, modelJson, description: requestDescription, provider: 'gpt', emitParticles: false },
        { attempts, timeoutMs: 180_000 }
      );
      return result.ok !== false && result.baked ? result.baked : undefined;
    } catch {
      return undefined;
    }
  };
  const primary = await request(mode, description, 1);
  if (primary) return primary;
  if (mode === 'quick') return createProceduralBakedAnimation(modelJson, description, requestedDuration);
  const quickDescription = /飞身|起跳|空中|落地/.test(description)
    ? 'jump into the air and land in a crouch'
    : /接剑|接住/.test(description)
      ? 'reach forward with the right hand, grasp an offered sword, then draw it back'
      : /取剑|拔剑|递|交/.test(description)
        ? 'reach behind with the right hand, draw a sword, offer it forward, then release and withdraw the hand'
        : description;
  const quick = await request('quick', quickDescription, 2);
  if (quick) return quick;
  return createProceduralBakedAnimation(modelJson, description, requestedDuration);
}

function assertModel(value: unknown): asserts value is { nodes: Array<{ id: string; parent?: string }> } {
  const nodes = (value as { nodes?: Array<{ id?: unknown; mesh?: unknown }> })?.nodes;
  if (!Array.isArray(nodes) || !nodes.length || nodes.some((n) => !n || typeof n !== 'object' || typeof n.id !== 'string') || !nodes.some((n) => n.mesh) || new Set(nodes.map((n) => n.id)).size !== nodes.length) fail('invalid_generated_model', '生成模型缺少可渲染节点或稳定节点 ID。');
}

/** Adapter for 3d-generate CodeAnimPlayer baked arrays. No remote code executes in CGCreator. */
export function decodeBakedClip(value: unknown, identity: Pick<CgClip, 'id' | 'entityId' | 'modelHash' | 'description'>, modelJson: unknown, options: { ignoreUnknownNodes?: boolean; stripRootHorizontal?: boolean } = {}): CgClip {
  assertModel(modelJson);
  const baked = value as { fps?: number; duration?: number; loop?: boolean; animation?: Record<string, Record<string, number[]>>; effects?: unknown; particles?: unknown; _cgFallback?: boolean };
  if (!baked || !Number.isFinite(baked.fps) || baked.fps! < 1 || baked.fps! > 240 || !Number.isFinite(baked.duration) || baked.duration! <= 0 || baked.duration! > 1200 || !baked.animation || typeof baked.animation !== 'object') fail('invalid_baked_clip', '动画烘焙格式无效。');
  if (baked.effects || baked.particles) fail('unsupported_clip_effects', '烘焙动画包含未受支持的特效；需要使用独立的确定性效果轨。');
  const nodes = new Map(modelJson.nodes.map((n) => [n.id, n]));
  const tracks: CgClip['tracks'] = {};
  const allowed = new Set(['rotX', 'rotY', 'rotZ', 'posX', 'posY', 'posZ', 'quatX', 'quatY', 'quatZ', 'quatW', 'scaleX', 'scaleY', 'scaleZ']);
  for (const [id, raw] of Object.entries(baked.animation)) {
    if (!nodes.has(id)) {
      if (options.ignoreUnknownNodes) continue;
      fail('unknown_animation_node', `动画引用未知模型节点：${id}`);
    }
    if (!raw || Object.keys(raw).some((k) => !allowed.has(k))) fail('unsupported_animation_track', `动画 ${id} 包含未受支持的轨道。`);
    const lengths = Object.values(raw).map((v) => Array.isArray(v) && v.every(Number.isFinite) ? v.length : -1);
    const expected = Math.ceil(baked.duration! * baked.fps!) + 1;
    if (!lengths.length || lengths.some((n) => n < 2 || n !== lengths[0]) || Math.abs(lengths[0] - expected) > 1) fail('invalid_animation_samples', `动画 ${id} 采样数组不一致。`);
    const rootHorizontal = !nodes.get(id)?.parent && [...raw.posX ?? [], ...raw.posZ ?? []].some((v) => Math.abs(v) > 1e-5);
    if (rootHorizontal && !options.stripRootHorizontal) fail('root_motion_conflict', '生成动画带有根节点水平位移；请生成 in-place 动画，世界路径由 CG 编译器控制。');
    const track: CgClip['tracks'][string] = {};
    const read = (prefix: string, axes: string[], defaults: number[]) => Array.from({ length: lengths[0] }, (_, i) => axes.map((axis, j) => options.stripRootHorizontal && !nodes.get(id)?.parent && prefix === 'pos' && (axis === 'X' || axis === 'Z') ? 0 : raw[`${prefix}${axis}`]?.[i] ?? defaults[j]));
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
  return { ...identity, duration: baked.duration!, fps: baked.fps!, loop: baked.loop === true, rootMotion: 'in-place', source: baked._cgFallback ? 'procedural-fallback' : 'generated', tracks };
}

/** Deterministic last-resort body motion. It is intentionally visible and
 * model-node aware, and is tagged builtin so validation/UI never presents it
 * as a successful 3d-generate animation. */
function createProceduralBakedAnimation(modelJson: unknown, description: string, requestedDuration = 2.4) {
  const nodes = (modelJson as { nodes?: Array<{ id?: string; name?: string; mesh?: unknown }> })?.nodes ?? [];
  const groups = nodes.filter(node => typeof node.id === 'string' && !node.mesh);
  const find = (pattern: RegExp) => groups.find(node => pattern.test(`${node.id} ${node.name ?? ''}`))?.id;
  const rightArm = find(/right.*(?:arm|hand)|(?:arm|hand).*right|arm.?r\b|hand.?r\b|arm1|hand1|右臂|右袖|右手|右上臂|右前臂/i), leftArm = find(/left.*(?:arm|hand)|(?:arm|hand).*left|arm.?l\b|hand.?l\b|arm-1|hand-1|左臂|左袖|左手|左上臂|左前臂/i);
  const rightLeg = find(/right.?leg|leg.?right|leg1|右腿|右足/i), leftLeg = find(/left.?leg|leg.?left|leg-1|左腿|左足/i);
  const body = find(/body|torso|躯干|长袍|古装/i) ?? groups[0]?.id, head = find(/head|face|头|脸/i);
  if (!body || !rightArm) fail('procedural_motion_rig_missing', '角色模型缺少生成降级动作所需的身体或右臂语义节点。');
  const fps = 30, duration = Math.max(0.5, Math.min(30, requestedDuration || 2.4)), count = Math.ceil(duration * fps) + 1;
  const wave = (keyframes: Array<[number, number]>) => Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1); let next = keyframes.findIndex(point => point[0] >= t); if (next < 0) next = keyframes.length - 1;
    const a = keyframes[Math.max(0, next - 1)], b = keyframes[next], u = b[0] === a[0] ? 1 : (t - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * u;
  });
  const zero = () => Array(count).fill(0), animation: Record<string, Record<string, number[]>> = {};
  const rotation = (id: string | undefined, x: number[], y = zero(), z = zero()) => { if (id) animation[id] = { rotX: x, rotY: y, rotZ: z }; };
  if (/飞身|起跳|空中|落地/.test(description)) {
    rotation(body, wave([[0, 0], [0.12, 0.22], [0.38, -0.25], [0.72, 0.12], [1, 0]]));
    rotation(rightArm, wave([[0, 0], [0.2, -1.15], [0.65, 0.55], [1, 0]]), zero(), wave([[0, 0], [0.25, -0.45], [0.7, 0.3], [1, 0]]));
    rotation(leftArm, wave([[0, 0], [0.2, -1.0], [0.65, 0.45], [1, 0]]), zero(), wave([[0, 0], [0.25, 0.45], [0.7, -0.3], [1, 0]]));
    rotation(rightLeg, wave([[0, 0], [0.15, 0.75], [0.55, -0.35], [0.82, 0.55], [1, 0]]));
    rotation(leftLeg, wave([[0, 0], [0.15, 0.55], [0.55, -0.5], [0.82, 0.7], [1, 0]]));
  } else if (/接剑|接住/.test(description)) {
    rotation(rightArm, wave([[0, 0], [0.25, -0.7], [0.58, -1.05], [0.75, -1.05], [1, -0.35]]), zero(), wave([[0, 0], [0.4, -0.3], [1, -0.1]]));
    rotation(body, zero(), wave([[0, 0], [0.45, -0.16], [1, 0]]));
  } else if (/取剑|拔剑|递|交/.test(description)) {
    rotation(rightArm, wave([[0, 0], [0.18, 1.15], [0.42, 0.25], [0.67, -1.05], [0.82, -1.05], [1, 0]]), zero(), wave([[0, 0], [0.18, 0.7], [0.55, -0.25], [1, 0]]));
    rotation(body, zero(), wave([[0, 0], [0.25, 0.22], [0.65, -0.12], [1, 0]]));
  } else {
    rotation(head ?? body, zero(), wave([[0, 0], [0.25, 0.28], [0.78, 0.28], [1, 0]]));
  }
  return { fps, duration, loop: false, animation, _cgFallback: true };
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
