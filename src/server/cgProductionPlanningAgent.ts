import type { CgProject } from '../shared/cgTypes';
import type { CgEvidenceRef, PreproductionPlan, ProductionPackage } from '../shared/cgAgentTypes';
import { stableHash } from '../shared/cgValidation';

export class CgProductionPlanningAgent {
  package(project: CgProject, plan: PreproductionPlan): ProductionPackage {
    const allModels = new Map([...(project.mapSnapshot.assets ?? []), ...project.resources.models].map(asset => [asset.id, asset]));
    const models: ProductionPackage['models'] = [];
    const evidence: CgEvidenceRef[] = [];
    const unresolved: ProductionPackage['unresolved'] = [];
    for (const entity of project.document.entities) {
      const object = project.mapSnapshot.objects.find(item => item.id === entity.objectId);
      const added = project.document.worldPatch.find(operation => operation.type === 'object.add' && operation.object.id === entity.objectId);
      const assetId = object?.assetId ?? (added?.type === 'object.add' ? added.object.assetId : undefined) ?? entity.assetId;
      const asset = assetId ? allModels.get(assetId) : undefined;
      const requirement = plan.requirements.find(item => item.id === `model:${entity.id}`)!;
      if (!asset || !assetId) unresolved.push({ requirementId: requirement.id, fidelity: requirement.fidelity, reason: `${entity.name} 缺少可播放模型` });
      else {
        const modelHash = stableHash(asset.modelJson);
        models.push({ entityId: entity.id, assetId, provider: asset.provider ?? (project.mapSnapshot.assets?.some(item => item.id === assetId) ? 'worldforge' : 'unknown'), modelHash });
        evidence.push({ id: `evidence:model:${entity.id}`, source: asset.provider === '3d-generate' ? '3d-generate' : 'worldforge', sourceId: assetId, sourceHash: modelHash, claim: `${entity.name} 已绑定冻结模型`, confidence: 'verified' });
      }
    }
    const motions: ProductionPackage['motions'] = [];
    for (const requirement of plan.requirements.filter(item => item.kind === 'motion')) {
      const action = project.document.actions.find(item => item.id === requirement.actionId);
      const clip = action?.clipId ? project.resources.clips.find(item => item.id === action.clipId && item.entityId === action.entityId) : undefined;
      if (!clip) unresolved.push({ requirementId: requirement.id, fidelity: requirement.fidelity, reason: `${requirement.name} 缺少与角色模型匹配的动作 Clip` });
      else {
        motions.push({ actionId: action!.id, clipId: clip.id, source: clip.source, modelHash: clip.modelHash });
        evidence.push({ id: `evidence:motion:${action!.id}`, source: clip.source === 'generated' ? '3d-generate' : 'compiler', sourceId: clip.id, sourceHash: stableHash(clip), claim: clip.source === 'procedural-fallback' ? `${requirement.name} 使用明确的程序化降级动作` : `${requirement.name} 已烘焙为确定性动作`, confidence: clip.source === 'procedural-fallback' ? 'derived' : 'verified' });
        if (clip.source === 'procedural-fallback') unresolved.push({ requirementId: requirement.id, fidelity: requirement.fidelity, reason: `${requirement.name} 的 3d-generate 动作生成失败，目前只有程序化降级动作` });
      }
    }
    const assemblies = (project.resources.assemblies ?? []).map(item => ({ id: item.id, actorEntityId: item.actorEntityId, propEntityId: item.propEntityId, source: item.source, ...(item.issue ? { issue: item.issue } : {}) }));
    for (const requirement of plan.requirements.filter(item => item.kind === 'assembly')) {
      const action = project.document.actions.find(item => item.id === requirement.actionId);
      const actorIds = new Set([action?.entityId, action?.sourceEntityId, action?.targetEntityId].filter((id): id is string => !!id));
      const propId = action?.type === 'handoff' || action?.type === 'attach' || action?.type === 'detach' ? action.entityId : action?.propEntityId;
      const matches = assemblies.filter(item => item.propEntityId === propId && actorIds.has(item.actorEntityId));
      if (!matches.length) unresolved.push({ requirementId: requirement.id, fidelity: requirement.fidelity, reason: `${requirement.name} 没有经过验证的角色/道具装配` });
      else {
        for (const assembly of matches) evidence.push({ id: `evidence:assembly:${assembly.id}`, source: assembly.source === '3d-generate-mount' ? '3d-generate' : 'compiler', sourceId: assembly.id, sourceHash: stableHash(assembly), claim: `${requirement.name} 的插槽变换已测量`, confidence: assembly.source === '3d-generate-mount' ? 'verified' : 'derived' });
        if (matches.some(item => item.source === 'semantic-node-fallback')) unresolved.push({ requirementId: requirement.id, fidelity: requirement.fidelity, reason: `${requirement.name} 使用语义节点装配降级，未取得 3d-generate mount 结果` });
      }
    }
    return { schemaVersion: 1, resources: structuredClone(project.resources), models, motions, assemblies, evidence, unresolved };
  }
}
