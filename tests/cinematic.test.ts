import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDirectorReferences } from '../src/shared/director';
import { MapStore } from '../src/server/mapStore';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('WorldForge cinematic persistence', () => {
  it('stores a director plan under a project and reports map version drift', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-cinematics-'));
    tempDirs.push(rootDir);
    const store = new MapStore({ rootDir });
    const map = await store.createMap({ name: '海岛街区' });
    const document = await store.saveCinematic({
      id: 'cg-opening',
      projectId: 'mandeya',
      mapId: map.id,
      mapVersion: map.version,
      title: '街区开场',
      sourcePrompt: '三只鸭在主街奔跑',
      references: createEmptyDirectorReferences(),
      bindings: { actors: [], props: [] },
      directorPlan: {
        title: '街区开场',
        shots: [{ title: '跟拍', durationSeconds: 4 }]
      }
    });

    expect(document.id).toBe('cg-opening');
    expect(await readFile(path.join(rootDir, 'cinematics', 'mandeya', 'cg-opening.json'), 'utf8')).toContain('worldforge-cinematic');
    expect((await store.listCinematicSummaries('mandeya'))[0]).toMatchObject({
      id: 'cg-opening', mapId: map.id, stale: false, shotCount: 1
    });

    await store.saveMap({ ...map, name: '海岛街区（调整）' });
    expect((await store.listCinematicSummaries('mandeya'))[0].stale).toBe(true);
  });
});
