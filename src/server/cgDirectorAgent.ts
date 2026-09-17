import type { CgProject, DirectorDocument } from '../shared/cgTypes';
import type { FinalDirectorPackage, PreproductionPlan, ProductionPackage, ReadinessGateResult, RepairPlan, ValidationDiagnostic, WorldKnowledgePackage } from '../shared/cgAgentTypes';

const coreBehavior = new Set(['move', 'airborne', 'sit', 'dialogue', 'handoff', 'attach', 'detach', 'animate']);

export class CgDirectorAgent {
  preproduction(project: CgProject, prompt: string): PreproductionPlan {
    const document = project.document;
    const requirements: PreproductionPlan['requirements'] = [];
    for (const entity of document.entities) requirements.push({
      id: `model:${entity.id}`, kind: 'model', name: entity.name,
      description: entity.description?.trim() || `${entity.name}演出模型`, fidelity: 'required', entityId: entity.id, evidenceRefs: []
    });
    for (const anchor of document.anchors) {
      const semanticId = anchor.objectId ? `object:${anchor.objectId}` : undefined;
      requirements.push({ id: `world:${anchor.id}`, kind: 'world-location', name: anchor.name, description: `核实 ${anchor.name} 的准确位置`, fidelity: 'required', evidenceRefs: semanticId ? [`evidence:world:${semanticId}`] : [`evidence:user:${anchor.id}`] });
    }
    for (const action of document.actions) {
      if (action.clipId) requirements.push({ id: `motion:${action.id}`, kind: 'motion', name: action.purpose ?? action.id, description: action.purpose ?? `${action.type} 动作`, fidelity: coreBehavior.has(action.type) ? 'required' : 'approximable', entityId: action.entityId, actionId: action.id, evidenceRefs: [] });
      if (['attach', 'detach', 'handoff'].includes(action.type) || action.propEntityId) requirements.push({ id: `assembly:${action.id}`, kind: 'assembly', name: action.purpose ?? action.id, description: '验证角色、道具和插槽的装配关系', fidelity: 'approximable', entityId: action.entityId, actionId: action.id, evidenceRefs: [] });
      if (coreBehavior.has(action.type)) requirements.push({ id: `performance:${action.id}`, kind: 'performance', name: action.purpose ?? action.id, description: '在确定性时间轴上求解此行为', fidelity: 'required', entityId: action.entityId, actionId: action.id, evidenceRefs: [] });
    }
    for (const shot of document.shots) requirements.push({ id: `camera:${shot.id}`, kind: 'camera', name: shot.name, description: shot.purpose, fidelity: 'required', actionId: shot.behaviorId, evidenceRefs: [] });
    return {
      schemaVersion: 1, prompt, documentId: document.id, documentRevision: document.revision,
      synopsis: document.title || prompt.slice(0, 120), requirements: dedupe(requirements),
      worldQuestions: document.actions.flatMap(action => action.route?.guideIds.map(guideId => ({ id: `question:${action.id}:${guideId}`, question: `路径 ${guideId} 是否能承载 ${action.purpose ?? action.id}`, relatedIds: [action.id, `guide:${guideId}`] })) ?? []),
      protectedConstraintIds: document.constraints.map(constraint => constraint.id)
    };
  }

  readiness(plan: PreproductionPlan, world: WorldKnowledgePackage, production: ProductionPackage): ReadinessGateResult {
    const worldFailures = new Map(world.unresolved.map(item => [item.requirementId, item.reason]));
    const productionFailures = new Map(production.unresolved.map(item => [item.requirementId, item]));
    const evidence = new Set([...world.evidence, ...production.evidence].map(item => item.id));
    const checks = plan.requirements.map(requirement => {
      const failure = worldFailures.get(requirement.id) ?? productionFailures.get(requirement.id)?.reason;
      const presentEvidence = requirement.evidenceRefs.filter(id => evidence.has(id) || id.startsWith('evidence:user:'));
      if (failure) return { requirementId: requirement.id, fidelity: requirement.fidelity, status: requirement.fidelity === 'required' ? 'blocked' as const : 'fallback' as const, message: failure, evidenceRefs: presentEvidence };
      return { requirementId: requirement.id, fidelity: requirement.fidelity, status: 'ready' as const, message: '准备完成', evidenceRefs: presentEvidence };
    });
    return { schemaVersion: 1, ready: !checks.some(check => check.status === 'blocked'), checks };
  }

  finalize(document: DirectorDocument, readinessArtifactId: string, worldArtifactId: string, productionArtifactId: string): FinalDirectorPackage {
    return { schemaVersion: 1, document: structuredClone(document), readinessArtifactId, worldArtifactId, productionArtifactId, protectedConstraintIds: document.constraints.map(item => item.id) };
  }

  repair(diagnostics: ValidationDiagnostic[], attempt: number): RepairPlan {
    const owners = [...new Set(diagnostics.filter(item => item.repairable).map(item => item.owner))];
    return { schemaVersion: 1, attempt, diagnostics: structuredClone(diagnostics), assignments: owners.map(owner => ({ owner, diagnosticCodes: diagnostics.filter(item => item.owner === owner).map(item => item.code), action: repairAction(owner) })) };
  }
}

function dedupe(requirements: PreproductionPlan['requirements']): PreproductionPlan['requirements'] {
  const ids = new Set<string>();
  return requirements.filter(item => !ids.has(item.id) && !!ids.add(item.id));
}

function repairAction(owner: ValidationDiagnostic['owner']): string {
  if (owner === 'world') return '重新查询准确区域、锚点、道路或接触面；不得编造坐标。';
  if (owner === 'production') return '补做或修复模型、动作和装配资源，然后重新通过准备门。';
  if (owner === 'performance') return '只调整相关行为的走位、朝向、接触或时间。';
  if (owner === 'camera') return '只重选相关镜头技能、机位或轨迹。';
  if (owner === 'compiler') return '修复确定性编译输入或运行时能力。';
  return '导演仲裁冲突，并保持全部人工硬约束。';
}
