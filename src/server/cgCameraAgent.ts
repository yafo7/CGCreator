import type { CompiledCG, DirectorDocument } from '../shared/cgTypes';
import type { CameraPlan } from '../shared/cgAgentTypes';
import { cameraCandidates } from '../shared/cgShotSkills';
import { ownedDiagnostics } from './cgValidatorAgent';

export class CgCameraAgent {
  plan(document: DirectorDocument, performance: CompiledCG): CameraPlan {
    let cursor = 0;
    const shots = document.shots.map(shot => {
      const behavior = performance.actions.find(item => item.id === shot.behaviorId);
      const authoredBehavior = document.actions.find(item => item.id === shot.behaviorId);
      const start = behavior?.start ?? cursor;
      const duration = shot.autoDuration && behavior ? Math.max(0.05, behavior.end - behavior.start) : shot.duration;
      const end = start + duration;
      cursor = Math.max(cursor, end);
      const candidates = cameraCandidates(shot, authoredBehavior).map(candidate => ({ skillId: candidate.skillId, score: candidate.skillId === shot.skillId ? 1 : 0, feasible: true }));
      return { id: shot.id, ...(shot.behaviorId ? { behaviorId: shot.behaviorId } : {}), ...(shot.skillId ? { skillId: shot.skillId } : {}), start, end, subjectId: shot.camera.subjectId, ...(shot.camera.secondaryId ? { secondaryId: shot.camera.secondaryId } : {}), framing: shot.camera.framing, movement: shot.camera.movement, ...(candidates.length ? { candidateScores: candidates } : {}) };
    });
    return { schemaVersion: 1, duration: Math.max(performance.duration, cursor), shots, stagingRequests: [], diagnostics: ownedDiagnostics(performance.validation.diagnostics, 'camera').filter(item => item.owner === 'camera') };
  }
}
