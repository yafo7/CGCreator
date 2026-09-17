import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import type { CgAction, CgAssemblyProfile, CgEntity, CgQuat, CgVec3, DirectorDocument } from '../shared/cgTypes';
import { buildPoseRig, evaluateRig } from '../shared/cgPoseEvaluator';
import { stableHash } from '../shared/cgValidation';
import { MODEL_API_BASE } from '../shared/protocol';
import { CgHttpError } from './cgStore';

export interface CgAssemblyRequirement {
  id: string;
  actor: CgEntity;
  prop: CgEntity;
  socketId: string;
  description: string;
}

export interface CgAssemblyArtifact {
  profile: CgAssemblyProfile;
  /** Used only while baking body motion. Playback keeps one external prop. */
  mountedModel: unknown;
}

function fail(code: string, message: string): never { throw new CgHttpError(422, code, message); }

/** Turns attachment and prop-informed motion intent into a small, dependency-
 * ordered tool plan. This is deterministic; the remote model service only
 * executes each explicit mount task. */
export function planAssemblies(document: DirectorDocument): CgAssemblyRequirement[] {
  const entities = new Map(document.entities.map(entity => [entity.id, entity]));
  const requested = new Map<string, CgAssemblyRequirement>();
  const add = (actorId: string | undefined, propId: string, socketId: string | undefined) => {
    const actor = actorId ? entities.get(actorId) : undefined, prop = entities.get(propId);
    if (!actor || actor.kind !== 'actor' || !prop || prop.kind !== 'prop' || !socketId) return;
    const id = `assembly:${actor.id}:${prop.id}:${socketId}`;
    if (requested.has(id)) return;
    requested.set(id, {
      id, actor, prop, socketId,
      description: socketId.includes('back')
        ? `把${prop.name}背在${actor.name}背后，握柄从右肩上方露出`
        : `右手持${prop.name}，剑尖朝下`
    });
  };
  for (const action of document.actions) {
    if (action.type === 'attach') add(action.targetEntityId, action.entityId, action.socketId);
    if (action.type === 'handoff') {
      add(action.sourceEntityId, action.entityId, 'right-hand');
      add(action.targetEntityId, action.entityId, action.socketId);
    }
    if (action.type === 'animate' && action.propEntityId) add(action.entityId, action.propEntityId, 'right-hand');
  }
  return [...requested.values()];
}

export async function requestMount(primary: unknown, secondary: unknown, description: string, apiBase = process.env.CG_MODEL_API_BASE ?? MODEL_API_BASE) {
  const result = await requestProductionTool<{ ok?: boolean; modelJson?: unknown; mountedGroupId?: string; message?: string; error?: string }>(apiBase, '/api/mount', { primary, secondary, description, provider: 'gpt' }, { attempts: 1, timeoutMs: 90_000 });
  if (!result.ok || !result.modelJson || !result.mountedGroupId) fail('mount_generation_failed', result.message ?? result.error ?? '3d-generate 未返回有效装配结果。');
  return { modelJson: result.modelJson, mountedGroupId: result.mountedGroupId } as { modelJson: unknown; mountedGroupId: string };
}

export async function requestRefine(modelJson: unknown, description: string, apiBase = process.env.CG_MODEL_API_BASE ?? MODEL_API_BASE) {
  const result = await requestProductionTool<{ ok?: boolean; modelJson?: unknown; message?: string; error?: string }>(apiBase, '/api/refine/model', { modelJson, description, provider: 'gpt' });
  if (!result.ok || !result.modelJson) fail('model_refine_failed', result.message ?? result.error ?? '3d-generate 未返回有效 Refine 结果。');
  return result.modelJson;
}

/** External creative tools occasionally return an empty/terminated response
 * while their model worker is rotating. Retry only transient transport and
 * service failures; deterministic request errors still fail immediately. */
export async function requestProductionTool<T extends { ok?: boolean; error?: string; errorCode?: string; message?: string }>(apiBase: string, pathname: string, body: unknown, options: { attempts?: number; timeoutMs?: number } = {}): Promise<T> {
  let last = '3d-generate 工具调用失败。';
  const attempts = Math.max(1, Math.min(3, options.attempts ?? 3));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${apiBase}${pathname}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(options.timeoutMs ?? 300_000)
      });
      const text = await response.text();
      let result: T;
      try { result = JSON.parse(text) as T; }
      catch { result = { ok: false, error: text || `HTTP ${response.status}` } as T; }
      if (response.ok && result.ok !== false) return result;
      last = result.message ?? result.error ?? result.errorCode ?? `HTTP ${response.status}`;
      const transient = response.status === 429 || response.status >= 500 || /empty ai response|terminated|timeout|temporar|rate.?limit/i.test(last);
      if (!transient || attempt === attempts - 1) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (attempt === attempts - 1) break;
    }
    await new Promise(resolve => setTimeout(resolve, [400, 1200, 2500][attempt]));
  }
  fail('production_tool_failed', last);
}

export function modelHasEmbeddedProp(modelJson: unknown, propName: string) {
  const propPattern = /剑|刀|枪|弓|盾|sword|blade|knife|gun|bow|shield/i;
  if (!propPattern.test(propName)) return false;
  const explicitWeapon = /(?:mount[_\s-]*)?(?:sword|blade|knife|weapon|gun|bow|shield)|长剑|佩剑|宝剑|剑身|剑柄|刀身|佩刀|长刀|武器|长枪|弓箭|盾牌/i;
  const nodes = (modelJson as { nodes?: Array<{ id?: string; name?: string; label?: string; mounted?: boolean }> })?.nodes ?? [];
  return nodes.some(node => {
    const text = `${node.id ?? ''} ${node.name ?? ''} ${node.label ?? ''}`;
    return !/剑客|刀客|swordsman/i.test(text) && (explicitWeapon.test(text) || node.mounted === true && propPattern.test(text));
  });
}

/** Removes only a clearly named embedded weapon subtree. This is used after
 * the creative Refine endpoint still returns a duplicate prop. The character
 * rig, clothing and unrelated accessories remain byte-for-byte unchanged. */
export function stripEmbeddedProp(modelJson: unknown, propName: string): unknown {
  const value = structuredClone(modelJson) as { nodes?: Array<{ id?: string; name?: string; label?: string; parent?: string; mounted?: boolean }>; _meta?: { mounts?: Array<{ id?: string; mountedGroupId?: string }>; semanticSnapshot?: unknown } };
  if (!Array.isArray(value.nodes) || !/剑|刀|枪|弓|盾|sword|blade|knife|gun|bow|shield/i.test(propName)) return value;
  const explicitWeapon = /(?:mount[_\s-]*)?(?:sword|blade|knife|weapon|gun|bow|shield)|长剑|佩剑|宝剑|剑身|剑柄|刀身|佩刀|长刀|武器|长枪|弓箭|盾牌/i;
  const remove = new Set(value.nodes.filter(node => {
    const text = `${node.id ?? ''} ${node.name ?? ''} ${node.label ?? ''}`;
    return !/剑客|刀客|swordsman/i.test(text) && (node.mounted === true && /剑|刀|枪|弓|盾|sword|blade|knife|weapon|gun|bow|shield/i.test(text) || explicitWeapon.test(text));
  }).flatMap(node => typeof node.id === 'string' ? [node.id] : []));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of value.nodes) if (typeof node.id === 'string' && node.parent && remove.has(node.parent) && !remove.has(node.id)) { remove.add(node.id); changed = true; }
  }
  value.nodes = value.nodes.filter(node => typeof node.id !== 'string' || !remove.has(node.id));
  if (value._meta?.mounts) value._meta.mounts = value._meta.mounts.filter(mount => !remove.has(mount.id ?? '') && !remove.has(mount.mountedGroupId ?? ''));
  if (value._meta) delete value._meta.semanticSnapshot;
  return value;
}

/** Converts a mounted model into an executable socket on an original actor
 * node. The mounted geometry itself is deliberately excluded from playback. */
export function inspectMountedAssembly(input: {
  actorEntityId: string;
  propEntityId: string;
  socketId: string;
  actorModel: unknown;
  propModel: unknown;
  mountedModel: unknown;
  mountedGroupId: string;
}): CgAssemblyProfile {
  const baseRig = buildPoseRig(input.actorModel), combinedRig = buildPoseRig(input.mountedModel);
  const baseIds = new Set(baseRig.nodes.map(node => node.id)), nodes = new Map(combinedRig.nodes.map(node => [node.id, node]));
  const rawNodes = (input.mountedModel as { nodes?: Array<{ id?: string; mounted?: boolean }> })?.nodes ?? [];
  let mounted = nodes.get(input.mountedGroupId);
  if (!mounted) {
    const raw = rawNodes.find(node => node.mounted === true && typeof node.id === 'string');
    if (raw?.id) mounted = nodes.get(raw.id);
  }
  if (!mounted) fail('mounted_group_missing', `装配结果缺少挂载组 ${input.mountedGroupId}。`);
  let parentId = mounted.parent;
  while (parentId && !baseIds.has(parentId)) parentId = nodes.get(parentId)?.parent;
  if (!parentId) fail('mounted_parent_missing', '装配结果没有连接到原角色的稳定节点。');
  const matrices = evaluateRig(combinedRig), mountedMatrix = matrices.get(mounted.id), parentMatrix = matrices.get(parentId);
  if (!mountedMatrix || !parentMatrix) fail('mounted_transform_missing', '无法解析装配部件的局部变换。');
  const relative = parentMatrix.clone().invert().multiply(mountedMatrix), position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3();
  relative.decompose(position, quaternion, scale);
  const finite = [...position.toArray(), ...quaternion.toArray(), ...scale.toArray()].every(Number.isFinite);
  if (!finite || scale.toArray().some(value => value <= 0)) fail('invalid_mounted_transform', '装配接口返回了无效变换。');
  return {
    id: `assembly:${input.actorEntityId}:${input.propEntityId}:${input.socketId}`,
    actorEntityId: input.actorEntityId, propEntityId: input.propEntityId, socketId: input.socketId,
    nodeId: parentId, position: position.toArray() as CgVec3, quaternion: quaternion.toArray() as CgQuat,
    scale: scale.toArray() as CgVec3, mountedGroupId: mounted.id,
    actorModelHash: stableHash(input.actorModel), propModelHash: stableHash(input.propModel), source: '3d-generate-mount'
  };
}

/** Last-resort local socket when the upstream mount worker is unavailable.
 * It still binds to a real semantic rig node and records the remote failure;
 * callers must surface the resulting warning rather than calling it mounted. */
export function inferSemanticAssembly(input: {
  actor: CgEntity;
  prop: CgEntity;
  socketId: string;
  actorModel: unknown;
  propModel: unknown;
  issue: string;
}): CgAssemblyProfile {
  const actorRig = buildPoseRig(input.actorModel), propRig = buildPoseRig(input.propModel);
  const pattern = input.socketId.includes('back')
    ? /spine|torso|body|躯干|胸|背/i
    : /right.?hand|hand.?right|右手|hand1|right.?arm|arm.?right|arm1|右臂/i;
  const node = actorRig.nodes.find(item => pattern.test(`${item.id} ${item.name}`));
  if (!node) fail('semantic_socket_missing', `${input.actor.name}缺少可用于 ${input.socketId} 的稳定语义节点。`);
  const height = (rig: ReturnType<typeof buildPoseRig>) => {
    const matrices = evaluateRig(rig), bounds = new Box3();
    for (const item of rig.nodes) if (item.bounds) bounds.union(new Box3(new Vector3(...item.bounds.min), new Vector3(...item.bounds.max)).applyMatrix4(matrices.get(item.id)!));
    return bounds.isEmpty() ? 1 : Math.max(0.001, bounds.max.y - bounds.min.y);
  };
  const actorRootScale = (input.actor.height ?? 1.8) / height(actorRig), propWorldScale = (input.prop.height ?? 1) / height(propRig);
  const scale = propWorldScale / Math.max(1e-6, actorRootScale), pointsDown = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
  return {
    id: `assembly:${input.actor.id}:${input.prop.id}:${input.socketId}`,
    actorEntityId: input.actor.id, propEntityId: input.prop.id, socketId: input.socketId, nodeId: node.id,
    position: input.socketId.includes('back') ? [0, 0.35, -0.2] : [0, 0, 0],
    quaternion: pointsDown.toArray() as CgQuat, scale: [scale, scale, scale], mountedGroupId: `semantic:${node.id}`,
    actorModelHash: stableHash(input.actorModel), propModelHash: stableHash(input.propModel), source: 'semantic-node-fallback', issue: input.issue.slice(0, 300)
  };
}

export function assemblyForMotion(action: CgAction, profiles: readonly CgAssemblyProfile[]) {
  if (action.type !== 'animate' || !action.propEntityId) return undefined;
  return profiles.find(profile => profile.actorEntityId === action.entityId && profile.propEntityId === action.propEntityId && profile.socketId === 'right-hand');
}
