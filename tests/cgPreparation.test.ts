import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CgService } from '../src/server/cgService';
import { CgStore } from '../src/server/cgStore';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const root = async () => { const value = await mkdtemp(path.join(os.tmpdir(), 'cg-preparation-')); roots.push(value); return value; };

const actorModel = {
  format: 2,
  nodes: [
    { id: 'body', mesh: { type: 'box', params: { width: 0.8, height: 1.2, depth: 0.4 } }, transform: { pos: [0, 0.6, 0] } },
    { id: 'head', parent: 'body', mesh: { type: 'sphere', params: { radius: 0.25 } }, transform: { pos: [0, 0.8, 0] } },
    { id: 'right_hand', parent: 'body', mesh: { type: 'box', params: { width: 0.15, height: 0.2, depth: 0.15 } }, transform: { pos: [0.5, 0.1, 0] } }
  ],
  _meta: { ai: { provider: 'test' } }
};

describe('CG preparation assets', () => {
  it('creates a stable asset and immutable model version without seeded replay identity', async () => {
    const generated: string[] = [];
    const service = new CgService(new CgStore(await root()), {
      model: async description => { generated.push(description); return structuredClone(actorModel); }
    });
    const project = await service.foundationDemo();
    const prepared = await service.prepareAsset(project.id, project.revision, { kind: 'actor', name: '少年', description: '穿蓝色短衫的少年' });
    expect(generated).toEqual(['穿蓝色短衫的少年']);
    expect(prepared.preparation?.assets).toEqual([expect.objectContaining({ name: '少年', kind: 'actor', versionIds: expect.any(Array) })]);
    const asset = prepared.preparation!.assets[0];
    const version = prepared.preparation!.versions.find(item => item.id === asset.selectedVersionId)!;
    expect(version.source).toBe('generated');
    expect(version.modelHash).toBeTruthy();
    expect(version.model.modelJson).toEqual(actorModel);

    const edited = await service.savePreparedVersion(prepared.id, prepared.revision, { assetId: asset.id, description: '穿深蓝短衫的少年', modelJson: actorModel });
    expect(edited.preparation?.assets[0].versionIds).toHaveLength(2);
    expect(edited.preparation?.versions.find(item => item.id === edited.preparation!.assets[0].selectedVersionId)).toMatchObject({ source: 'edited', parentVersionId: version.id });
    expect(edited.confirmed).toBeNull();
  });

  it('bakes a motion against the selected model version and records its natural duration', async () => {
    const baked = { fps: 2, duration: 1, loop: true, animation: { right_hand: { rotX: [0, 0.2, 0] } } };
    const service = new CgService(new CgStore(await root()), { model: async () => structuredClone(actorModel), animation: async () => baked });
    const project = await service.foundationDemo();
    const prepared = await service.prepareAsset(project.id, project.revision, { kind: 'actor', description: '穿蓝色短衫的少年' });
    const assetId = prepared.preparation!.assets[0].id;
    const motionProject = await service.prepareMotion(prepared.id, prepared.revision, { assetId, description: '原地跑步' });
    expect(motionProject.preparation?.motions).toEqual([expect.objectContaining({ assetVersionId: prepared.preparation!.assets[0].selectedVersionId, description: '原地跑步', naturalDuration: 1, loop: true })]);
    expect(motionProject.preparation?.motions[0].clip.tracks.right_hand.rotation).toHaveLength(3);
  });

  it('keeps the generated resource cache when a concurrent revision makes attachment stale', async () => {
    let resolveGeneration!: (value: unknown) => void;
    const service = new CgService(new CgStore(await root()), { model: () => new Promise(resolve => { resolveGeneration = resolve; }) });
    const project = await service.foundationDemo();
    const pending = service.prepareAsset(project.id, project.revision, { kind: 'prop', description: '一把木椅' });
    const advanced = await service.patch(project.id, project.revision, [{ type: 'entity.update', id: 'boy', patch: { name: '少年' } }]);
    resolveGeneration(actorModel);
    await expect(pending).rejects.toMatchObject({ code: 'revision_conflict' });
    expect((await service.store.read(project.id)).revision).toBe(advanced.revision);
  });
});
