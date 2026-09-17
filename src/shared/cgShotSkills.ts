import type { CgAction, CgCameraIntent, CgShot, CompiledCG, DirectorDocument } from './cgTypes';
import { schedulePerformance, sampleEntities } from './cgPerformance';

export interface CgShotSkill {
  id: string; name: string; behaviors: CgAction['type'][]; purposes: NonNullable<CgShot['coveragePurpose']>[];
  participants: 1 | 2; camera: Partial<CgCameraIntent>;
}
/** Typed recipes are executable capabilities, not arbitrary skill-supplied code. */
export const CG_SHOT_SKILLS: readonly CgShotSkill[] = [
  { id: 'airborne-side', name: '飞身侧面全景', behaviors: ['airborne'], purposes: ['follow', 'geography'], participants: 1, camera: { movement: 'tracking', framing: 'wide', reference: 'subject-motion', view: 'side', aim: 'body', layout: 'solo', aimMode: 'follow' } },
  { id: 'travel-rear', name: '后侧跟拍', behaviors: ['move'], purposes: ['follow', 'destination'], participants: 1, camera: { movement: 'tracking', framing: 'wide', reference: 'subject-motion', view: 'rear-three-quarter', aim: 'body', layout: 'solo', aimMode: 'follow' } },
  { id: 'travel-side', name: '侧面跟拍', behaviors: ['move'], purposes: ['follow', 'geography'], participants: 1, camera: { movement: 'tracking', framing: 'wide', reference: 'subject-motion', view: 'side', aim: 'body', layout: 'solo', aimMode: 'follow' } },
  { id: 'travel-establish', name: '固定高位全景', behaviors: ['move', 'hold'], purposes: ['geography', 'destination'], participants: 1, camera: { movement: 'static', framing: 'wide', reference: 'world', view: 'side', aim: 'body', pitch: Math.PI / 4, distance: 14, layout: 'solo', aimMode: 'follow' } },
  { id: 'moving-emotion', name: '奔跑中的表情', behaviors: ['move'], purposes: ['emotion'], participants: 1, camera: { movement: 'tracking', framing: 'medium', reference: 'subject-motion', view: 'front-three-quarter', aim: 'upper-body', layout: 'solo', aimMode: 'follow' } },
  { id: 'dialogue-two', name: '平视双人', behaviors: ['dialogue'], purposes: ['dialogue', 'geography'], participants: 2, camera: { movement: 'static', framing: 'medium', reference: 'interaction-axis', view: 'side', aim: 'interaction', layout: 'two-shot', aimMode: 'follow' } },
  { id: 'dialogue-ots', name: '越肩对话', behaviors: ['dialogue'], purposes: ['dialogue', 'reaction'], participants: 2, camera: { movement: 'static', framing: 'medium', reference: 'interaction-axis', view: 'front-three-quarter', aim: 'face', layout: 'over-shoulder', aimMode: 'follow' } },
  { id: 'reaction-close', name: '动态眼平反应特写', behaviors: ['dialogue', 'hold', 'sit'], purposes: ['reaction', 'emotion'], participants: 1, camera: { movement: 'static', framing: 'close-up', reference: 'subject-facing', view: 'front-three-quarter', aim: 'eyes', lensMm: 85, layout: 'solo', aimMode: 'follow' } },
  { id: 'reaction-face-follow', name: '转身面部跟随特写', behaviors: ['face', 'dialogue', 'hold'], purposes: ['reaction', 'emotion'], participants: 1, camera: { movement: 'tracking', framing: 'close-up', reference: 'subject-facing', view: 'front-three-quarter', aim: 'eyes', lensMm: 85, layout: 'solo', aimMode: 'follow' } },
  { id: 'contact-side', name: '侧面交互全景', behaviors: ['sit'], purposes: ['contact'], participants: 1, camera: { movement: 'static', framing: 'wide', reference: 'subject-facing', view: 'side', aim: 'body', layout: 'solo', aimMode: 'follow' } },
  { id: 'contact-front', name: '前侧交互全景', behaviors: ['sit'], purposes: ['contact'], participants: 1, camera: { movement: 'static', framing: 'wide', reference: 'subject-facing', view: 'front-three-quarter', aim: 'body', layout: 'solo', aimMode: 'follow' } }
  ,{ id: 'handoff-two', name: '双人交接中景', behaviors: ['handoff'], purposes: ['contact', 'dialogue'], participants: 2, camera: { movement: 'static', framing: 'medium', reference: 'interaction-axis', view: 'side', aim: 'interaction', layout: 'two-shot', aimMode: 'follow' } }
  ,{ id: 'reveal-high', name: '升起全景揭示', behaviors: ['hold'], purposes: ['geography', 'reaction'], participants: 1, camera: { movement: 'crane', framing: 'wide', reference: 'world', view: 'side', aim: 'body', pitch: Math.PI / 4, distance: 16, height: 6, layout: 'solo', aimMode: 'follow' } }
];

export function cameraCandidates(shot: CgShot, behavior?: CgAction): Array<{ skillId: string; camera: CgCameraIntent }> {
  if (shot.skillId === 'authored-intent') return [{ skillId: shot.skillId, camera: structuredClone(shot.camera) }];
  const matching = CG_SHOT_SKILLS.filter(s => (!shot.skillId || s.id === shot.skillId) && !!behavior && s.behaviors.includes(behavior.type) && (!shot.coveragePurpose || s.purposes.includes(shot.coveragePurpose)) && (s.participants === 1 || !!shot.camera.secondaryId));
  const result = shot.skillId ? [] : [{ skillId: 'authored-intent', camera: structuredClone(shot.camera) }];
  for (const skill of matching) for (const side of ['right', 'left'] as const) result.push({ skillId: skill.id, camera: { ...shot.camera, ...skill.camera, side } });
  // A close-up authored before the performance is solved may span a real
  // turn. Keep the static authored choice first, then offer a face-relative
  // tracking alternative whose path is validated against the frozen world.
  if (!shot.skillId && shot.camera.framing === 'close-up' && shot.camera.reference === 'subject-facing') {
    const skill = CG_SHOT_SKILLS.find(candidate => candidate.id === 'reaction-face-follow')!;
    for (const side of ['right', 'left'] as const) result.push({ skillId: skill.id, camera: { ...shot.camera, ...skill.camera, side } });
  }
  return result;
}

/** Provisional slots, replaced only by scoped coverage choices after solving. */
export function createBehaviorCoverage(document: DirectorDocument): CgShot[] {
  const schedule = schedulePerformance(document);
  if (schedule.diagnostics.length) throw new Error(schedule.diagnostics.map(d => d.message).join('\n'));
  const primary = document.actions.filter(a => ['move', 'airborne', 'sit', 'dialogue', 'handoff', 'hold'].includes(a.type)).sort((a, b) => schedule.times.get(a.id)!.start - schedule.times.get(b.id)!.start || a.id.localeCompare(b.id));
  const slots = primary.filter((a, i) => !i || schedule.times.get(a.id)!.start > schedule.times.get(primary[i - 1].id)!.start);
  return slots.map((action, i) => {
    const start = i ? schedule.times.get(action.id)!.start : 0, end = i + 1 < slots.length ? schedule.times.get(slots[i + 1].id)!.start : schedule.duration;
    const skill = CG_SHOT_SKILLS.find(s => s.id === (action.type === 'airborne' ? 'airborne-side' : action.type === 'move' ? 'travel-rear' : action.type === 'dialogue' ? 'dialogue-two' : action.type === 'handoff' ? 'handoff-two' : action.type === 'sit' ? 'contact-side' : 'reveal-high'))!;
    const subjectId = action.type === 'handoff' ? action.sourceEntityId! : action.entityId;
    const secondaryId = action.type === 'handoff' ? action.targetEntityId : action.targetEntityId;
    return { id: `coverage:${action.id}`, name: `${i + 1} · ${skill.name}`, purpose: action.purpose ?? skill.name, behaviorId: action.id, duration: end - start, autoDuration: true, coveragePurpose: skill.purposes[0], camera: { movement: 'static', framing: 'wide', subjectId, ...(secondaryId ? { secondaryId } : {}), ...skill.camera }, ...(i ? { transition: { type: 'cut' as const, motivation: action.type === 'dialogue' ? 'reestablish' as const : ['sit', 'handoff', 'airborne'].includes(action.type) ? 'action' as const : 'reveal' as const } } : {}) };
  });
}

export function performanceForDirector(bundle: CompiledCG) {
  return { duration: bundle.performance?.duration, events: bundle.performance?.events, occupancy: bundle.performance?.occupancy, diagnostics: bundle.validation.diagnostics,
    behaviors: bundle.actions.filter(a => ['move', 'airborne', 'sit', 'dialogue', 'handoff', 'hold'].includes(a.type)).map(a => ({ id: a.id, entityId: a.entityId, type: a.type, purpose: a.purpose, start: a.start, end: a.end, route: a.route, pathLength: a.path?.slice(1).reduce((sum, p, i) => sum + Math.hypot(...p.map((v, k) => v - a.path![i][k])), 0), contact: a.contact, samples: [a.start, (a.start + a.end) / 2, a.end].map(time => ({ time, states: sampleEntities(bundle, time) })) })) };
}

export const CG_COVERAGE_PROMPT = `You choose camera coverage only AFTER a verified performance has been solved. Return ONLY a CgPatchOperation array of shot.update entries against the supplied stable shot IDs. Do not change behavior, entities, anchors, hard constraints, shot IDs or durations. Each patch may contain only skillId, coveragePurpose, name, purpose, camera, transition, subtitle. Inspect the actual states, posture, dynamic eyes, contact events, interaction participants and timeline. Select from shotSkills whose behavior and participant requirements match; choose the narrative purpose, not a single keyword mapping. Travel can use side/rear follows or establishing shots. Dialogue can use a two-shot, OTS, or reaction if justified. Contact coverage must show the sit action rather than hiding contact errors. Manual locks win. [] is valid when the provisional coverage is appropriate. Return {error:'unsupported_intent',reason:'...'} if no supported coverage can satisfy the request.`;
