import { describe, expect, it } from 'vitest';
import { Object3D, Euler, Quaternion } from 'three';
import { applyCgClip } from '../src/client/cgRuntime';
import { createPointConstraintPatch, parseCgTarget } from '../src/client/cgWorkspace';
import { createDemo } from '../src/server/cgService';
import { createEmptyMap } from '../src/shared/map';
import { applyDirectorPatch } from '../src/shared/cgCompiler';
import type { CgClip, DirectorDocument } from '../src/shared/cgTypes';

describe('CG model-local sampling and manual point contracts', () => {
  it('adds baked XYZ Euler channels to rest pose and restores after arbitrary seeks', () => {
    const node = new Object3D(); node.rotation.set(0.3, -0.4, 0.2); node.position.set(2, 3, 4);
    const base = { node, rotation: node.rotation.clone(), quaternion: node.quaternion.clone(), position: node.position.clone(), scale: node.scale.clone() };
    const nodes = new Map([['body', base]]);
    const clip: CgClip = { id: 'clip', entityId: 'actor', modelHash: 'hash', description: '', duration: 1, fps: 1, loop: false, rootMotion: 'in-place', source: 'builtin', tracks: { body: { rotation: [[0, 0, 0], [0.6, 0.2, -0.4]], position: [[0, 0, 0], [0, 0.2, 0]] } } };
    applyCgClip(nodes, clip, 0.5);
    const expected = new Quaternion().setFromEuler(new Euler(0.6, -0.3, 0));
    expect(node.quaternion.angleTo(expected)).toBeLessThan(1e-7);
    const middle = node.position.toArray();
    applyCgClip(nodes, clip, 1); applyCgClip(nodes, clip, 0); applyCgClip(nodes, clip, 0.5);
    expect(node.position.toArray()).toEqual(middle);
    applyCgClip(nodes, undefined, 0);
    expect(node.position.toArray()).toEqual([2, 3, 4]);
    expect(node.quaternion.angleTo(base.quaternion)).toBeLessThan(1e-7);
  });
  it('preserves colon IDs and creates a valid movement endpoint lock without entity scope', () => {
    const map = createEmptyMap('Test', 'test-map');
    const base = { schemaVersion: 1, id: 'doc', title: '', sourcePrompt: '', revision: 0, seed: 1, mapId: map.id, entities: [], anchors: [], shots: [], actions: [], constraints: [], worldPatch: [] } as DirectorDocument;
    const { document } = createDemo(map, base);
    document.actions.find((a) => a.id === 'demo_move')!.id = 'walk:to:point';
    document.actions.find((a) => a.id === 'demo_walk')!.start = { kind: 'with', id: 'walk:to:point' };
    document.actions.find((a) => a.id === 'demo_turn')!.start = { kind: 'after', id: 'walk:to:point' };
    expect(parseCgTarget('action:walk:to:point')).toEqual({ kind: 'action', targetId: 'walk:to:point' });
    const ops = createPointConstraintPatch(document, 'action:walk:to:point', [1, 0, 2], 'user-point');
    const patched = applyDirectorPatch(document, ops);
    expect(patched.constraints[0]).toMatchObject({ type: 'action-target', targetId: 'walk:to:point' });
    expect(patched.constraints[0]).not.toHaveProperty('scope');
  });
});
