import type { CgProject } from '../shared/cgTypes';
import type { CgEvidenceRef, PreproductionPlan, WorldKnowledgePackage } from '../shared/cgAgentTypes';
import { buildWorldSemanticIndex } from '../shared/cgWorldSemantics';
import { stableHash } from '../shared/cgValidation';

export class CgWorldAgent {
  read(project: CgProject, plan?: PreproductionPlan): WorldKnowledgePackage {
    const index = buildWorldSemanticIndex(project.mapSnapshot);
    const referenced = new Set<string>();
    for (const entity of project.document.entities) if (entity.objectId) referenced.add(`object:${entity.objectId}`);
    for (const anchor of project.document.anchors) if (anchor.objectId) referenced.add(`object:${anchor.objectId}`);
    for (const action of project.document.actions) {
      for (const guideId of action.route?.guideIds ?? []) referenced.add(`guide:${guideId}`);
      if (action.interaction?.objectId) referenced.add(`object:${action.interaction.objectId}`);
    }
    const byId = new Map(index.entities.map(entity => [entity.id, entity]));
    const evidence: CgEvidenceRef[] = [...referenced].flatMap(id => {
      const entity = byId.get(id);
      return entity ? [{ id: `evidence:world:${id}`, source: entity.source.owner, sourceId: id, sourceHash: stableHash(entity), claim: `${entity.name} 位于地图记录的位置和范围内`, confidence: entity.source.confidence === 'authored' ? 'authored' : entity.source.confidence === 'generated' ? 'generated' : 'derived' } satisfies CgEvidenceRef] : [];
    });
    const unresolved = [...referenced].filter(id => !byId.has(id)).map(id => ({
      requirementId: plan?.requirements.find(requirement => requirement.evidenceRefs.includes(`evidence:world:${id}`))?.id ?? `world:${id}`,
      reason: `WorldForge 语义索引中不存在 ${id}`
    }));
    return { schemaVersion: 1, mapId: index.mapId, mapVersion: index.mapVersion, sourceHash: index.sourceHash, index, referencedEntityIds: [...referenced], evidence, unresolved };
  }
}
