import type { CgProject } from '../shared/cgTypes';
import type { PerformancePlan } from '../shared/cgAgentTypes';
import { compileDirector } from '../shared/cgCompiler';
import { ownedDiagnostics } from './cgValidatorAgent';

export class CgPerformanceAgent {
  plan(project: CgProject): { plan: PerformancePlan; bundle: ReturnType<typeof compileDirector> } {
    const bundle = compileDirector(project.document, project.mapSnapshot, project.schemeSnapshot, project.resources, undefined, { performanceOnly: true });
    return { bundle, plan: {
      schemaVersion: 1,
      duration: bundle.performance?.duration ?? bundle.duration,
      behaviors: bundle.actions.map(action => ({ id: action.id, entityId: action.entityId, type: action.type, start: action.start, end: action.end, ...(action.path ? { path: action.path } : {}), ...(action.contact ? { contactObjectId: action.contact.objectId } : {}) })),
      events: bundle.performance?.events ?? [], occupancy: bundle.performance?.occupancy ?? [],
      diagnostics: ownedDiagnostics(bundle.validation.diagnostics, 'performance')
    } };
  }
}
