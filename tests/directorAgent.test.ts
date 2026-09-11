import { describe, expect, it, vi } from 'vitest';
import {
  normalizeDirectorPlan,
  normalizeDirectorReferences
} from '../src/shared/director';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import { generateDirectorPlan, summarizeDirectorMap } from '../src/server/directorAgent';

describe('director agent', () => {
  it('normalizes a bounded shot plan and derives total duration', () => {
    const plan = normalizeDirectorPlan({
      title: '海岛追逐',
      cast: [{ id: 'duck one', name: '鸭子一', requiredActions: ['奔跑'] }],
      shots: [{
        title: '高空建立镜头',
        durationSeconds: 999,
        camera: { height: 'aerial', framing: 'extreme-wide', movement: 'crane', lensMm: 2 },
        blocking: [],
        transition: 'fade'
      }, {
        title: '主街奔跑',
        durationSeconds: 3.25,
        camera: { height: 'eye-level', framing: 'medium', movement: 'tracking', lensMm: 35 },
        blocking: [{ actorId: 'duck-one', from: '右侧', to: '中心远处', action: '奔跑' }]
      }]
    }, '鸭子们在主街奔跑', 'map-island');

    expect(plan.shots).toHaveLength(2);
    expect(plan.shots[0].durationSeconds).toBe(60);
    expect(plan.shots[0].camera.lensMm).toBe(12);
    expect(plan.estimatedDurationSeconds).toBe(63.25);
    expect(plan.cast[0].id).toBe('duck-one');
  });

  it('keeps only usable marker and camera reference data', () => {
    const references = normalizeDirectorReferences({
      markers: [{ id: 'point 1', label: '街口', position: [1, 2, 3] }],
      cameras: [
        { id: 'camera-a', label: '鸭身高视角', position: [0, 1.2, 2], rotation: [0, 1, 0], focalLength: 999 },
        { id: 'broken', position: ['x'] }
      ],
      screenshots: [{ label: '目标构图' }]
    });

    expect(references.markers[0].id).toBe('point-1');
    expect(references.cameras).toHaveLength(1);
    expect(references.cameras[0].focalLength).toBe(200);
    expect(references.screenshots[0].id).toBe('screenshot-1');
  });

  it('sends compact scene facts and returns a structured plan', async () => {
    const map = createEmptyMap('海岛街区', 'map-island');
    const tavern = createMapObject('酒馆');
    tavern.transform.position = [8, 0, -4];
    map.objects.push(tavern);
    const progress: string[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      content: JSON.stringify({
        title: '幻鸭节开场',
        logline: '鸭子们穿过主街参加庆典。',
        sceneSummary: '先建立街区，再切到鸭身高追随奔跑。',
        cast: [{ id: 'duck-a', name: '庆典鸭', role: '奔跑者', requiredActions: ['run'] }],
        shots: [{
          id: 'shot-1',
          title: '主街跟拍',
          purpose: '建立庆典活力',
          location: '酒馆附近主街',
          durationSeconds: 5,
          camera: {
            height: 'eye-level', framing: 'wide', movement: 'tracking', lensMm: 28,
            direction: '沿主街向前跟拍', subject: '庆典鸭'
          },
          blocking: [{ actorId: 'duck-a', from: '视角右侧', via: [], to: '中心远处', action: '奔跑' }],
          action: '庆典鸭跑过主街。', transition: 'cut', notes: []
        }],
        assumptions: [],
        referenceNeeds: [{ kind: 'camera', label: '鸭身高起始视图', reason: '确认最终构图', shotId: 'shot-1' }]
      })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const plan = await generateDirectorPlan('鸭子们在主街奔跑', map, {
      apiBase: 'https://example.test', fetchImpl, onProgress: (event) => progress.push(event.phase)
    });

    expect(plan.title).toBe('幻鸭节开场');
    expect(plan.shots[0].camera.height).toBe('eye-level');
    expect(plan.referenceNeeds[0].kind).toBe('camera');
    expect(progress).toEqual(['planning', 'consulting', 'consulting', 'validating', 'complete']);
    const request = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    expect(request.messages[0].content).toContain('short, direct Chinese description');
    expect(request.messages[1].content).toContain('酒馆');
  });

  it('summarizes map objects without copying model JSON', () => {
    const map = createEmptyMap('场景', 'map');
    map.objects.push(createMapObject('海滩入口'));
    const summary = summarizeDirectorMap(map);
    expect(JSON.stringify(summary)).toContain('海滩入口');
    expect(JSON.stringify(summary)).not.toContain('modelJson');
  });
});
