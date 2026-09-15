import { describe, expect, it } from 'vitest';
import { compileDirector, evaluateCG } from '../src/shared/cgCompiler';
import { createFoundationDemo } from '../src/shared/cgFoundationDemo';
import { bakedFrameIndex, buildPoseRig, rigLandmark, sampleLocalPose } from '../src/shared/cgPoseEvaluator';
import { schedulePerformance } from '../src/shared/cgPerformance';
import { regionContains } from '../src/shared/cgSpatialRegions';
import { queryWorld } from '../src/shared/cgWorldQuery';

describe('foundation performance pipeline', () => {
  it('evaluates dynamic landmarks and local tracks without mutable seek history', () => {
    expect(bakedFrameIndex(2.05, 2.05, 30, 63)).toBe(62);
    expect(bakedFrameIndex(2.04, 2.05, 30, 63)).toBeCloseTo(61.4);
    const { map, resources } = createFoundationDemo(), rig = buildPoseRig(map.assets![0].modelJson), clip = resources.clips[0];
    const rest = rigLandmark(rig, 'leftFoot')!, seated = rigLandmark(rig, 'leftFoot', clip, 2)!;
    expect(seated[2]).toBeGreaterThan(rest[2] + 0.3);
    expect(rigLandmark(rig, 'leftFoot', clip, 2)).toEqual(seated);
    expect(sampleLocalPose({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, { position: [[0, 0, 0], [0, -1, 0]] }, { duration: 1, fps: 1, loop: false }, 0.5).position).toEqual([0, -0.5, 0]);
  });
  it('solves the explicit road, dialogue, seat contact and persistent seated state', () => {
    const { map, document, resources } = createFoundationDemo();
    const result = compileDirector(document, map, null, resources);
    expect(result.validation.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    const path = result.actions.find(a => a.id === 'run')!.path!;
    expect(path.length).toBeGreaterThan(10);
    expect(path.every(p => regionContains({ kind: 'path', points: map.guides[0].points, width: 1.6 }, [p[0], p[2]]))).toBe(true);
    expect(evaluateCG(result, 6).entities.boy.position).toEqual([2, 0, 3]);
    const seated = evaluateCG(result, 13);
    expect(seated.entities.boy.posture).toBe('seated');
    expect(seated.entities.boy.clipTime).toBe(2);
    expect(seated.entities.boy.landmarks?.eyes?.[1]).toBeLessThan(evaluateCG(result, 0).entities.boy.landmarks!.eyes![1]);
    expect(seated.entities.boy.landmarks?.leftFoot?.[1]).toBeCloseTo(0, 2);
    evaluateCG(result, 2); expect(evaluateCG(result, 13)).toEqual(seated);
    expect(result.performance?.occupancy).toHaveLength(1);
    expect(result.shots.every(s => !!s.cameraSamples?.poses.length)).toBe(true);
    const frozenCamera = evaluateCG(result, 3).camera;
    result.shots[0].camera.distance = 999;
    expect(evaluateCG(result, 3).camera).toEqual(frozenCamera);
  });
  it('does not change behavior timing when camera duration is edited', () => {
    const { document } = createFoundationDemo();
    const before = schedulePerformance(document); document.shots[0].duration = 10;
    expect(schedulePerformance(document).events).toEqual(before.events);
  });
  it('reflows automatic coverage after a behavior duration edit without changing its camera recipe', () => {
    const f = createFoundationDemo();
    f.document.actions[0].duration = 7.5;
    const result = compileDirector(f.document, f.map, null, f.resources);
    expect(result.validation.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(result.shots[0].end).toBe(7.5);
    expect(result.actions.find(a => a.id === 'sit')?.end).toBe(13);
    expect(result.shots[2].end).toBe(13);
    expect(result.duration).toBe(15.5);
  });
  it('rejects missing roads and unprofiled contacts rather than fabricating success', () => {
    const { map, document, resources } = createFoundationDemo();
    map.guides = [];
    expect(compileDirector(document, map, null, resources).validation.diagnostics.some(d => d.code === 'unreachable_target')).toBe(true);
    expect(queryWorld(map, { type: 'inspect', semanticId: 'guide:garden-road' })).toMatchObject({ found: false });
  });
});
