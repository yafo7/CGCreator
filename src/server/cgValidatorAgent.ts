import type { CgDiagnostic, CompiledCG } from '../shared/cgTypes';
import type { CgDiagnosticOwner, ValidationDiagnostic } from '../shared/cgAgentTypes';
import { evaluateCG } from '../shared/cgCompiler';

export class CgValidatorAgent {
  validate(bundle: CompiledCG): ValidationDiagnostic[] {
    const diagnostics = ownedDiagnostics(bundle.validation.diagnostics, 'validation');
    const add = (diagnostic: ValidationDiagnostic) => { if (!diagnostics.some(item => item.code === diagnostic.code && item.nodeIds.join('|') === diagnostic.nodeIds.join('|'))) diagnostics.push(diagnostic); };
    if (bundle.stage === 'performance') add({ severity: 'error', code: 'incomplete_compile', message: '候选仍是仅表演阶段，缺少最终摄影机编译。', nodeIds: [bundle.id], owner: 'compiler', phase: 'validation', repairable: true });
    let cursor = 0;
    for (const shot of bundle.shots) {
      if (Math.abs(shot.start - cursor) > 1e-4 || shot.end <= shot.start) add({ severity: 'error', code: 'timeline_discontinuity', message: '摄影机轨存在空隙、重叠或非正时长。', nodeIds: [shot.id], owner: 'camera', phase: 'validation', repairable: true });
      if (!bundle.initial[shot.camera.subjectId]) add({ severity: 'error', code: 'camera_subject_missing', message: '镜头主体没有可求值的初始状态。', nodeIds: [shot.id, shot.camera.subjectId], owner: 'camera', phase: 'validation', repairable: true });
      cursor = shot.end;
    }
    if (bundle.shots.length && Math.abs(cursor - bundle.duration) > 1e-4) add({ severity: 'error', code: 'timeline_duration_mismatch', message: '镜头轨没有精确覆盖候选演出时长。', nodeIds: [bundle.id], owner: 'camera', phase: 'validation', repairable: true });
    for (const time of [...new Set([0, bundle.duration / 2, bundle.duration])]) {
      try {
        const frame = evaluateCG(bundle, time), values = [...frame.camera.position, ...frame.camera.quaternion, frame.camera.fov, ...Object.values(frame.entities).flatMap(state => [...state.position, ...state.quaternion, ...state.scale])];
        if (values.some(value => !Number.isFinite(value))) add({ severity: 'error', code: 'nonfinite_runtime_state', message: `${time.toFixed(2)} 秒的确定性求值产生了非有限数值。`, nodeIds: [bundle.id], owner: 'compiler', phase: 'validation', repairable: true });
      } catch (error) {
        add({ severity: 'error', code: 'runtime_evaluation_failed', message: error instanceof Error ? error.message : String(error), nodeIds: [bundle.id], owner: 'compiler', phase: 'validation', repairable: true });
      }
    }
    return diagnostics;
  }
}

export function ownedDiagnostics(diagnostics: CgDiagnostic[], phase: ValidationDiagnostic['phase']): ValidationDiagnostic[] {
  return diagnostics.map(item => ({ ...structuredClone(item), owner: diagnosticOwner(item.code), phase, repairable: !['modified_hard_constraints', 'camera_constraint_conflict'].includes(item.code) }));
}

export function diagnosticOwner(code: string): CgDiagnosticOwner {
  if (/camera|shot|coverage|framing|screen|view|landmark|lens|axis/.test(code)) return 'camera';
  if (/resource|model|asset|clip|animation|assembly|socket|mount|rig/.test(code)) return 'production';
  if (/map|world|terrain|anchor|guide|route|seat|object|surface|region/.test(code)) return 'world';
  if (/performance|action|timing|schedule|handoff|attach|collision|clearance|occupancy|locomotion|airborne|contact/.test(code)) return 'performance';
  if (/compile|runtime|dependency|hash/.test(code)) return 'compiler';
  return 'director';
}
