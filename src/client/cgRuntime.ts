import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CgCameraPose, CgClip, CgFrame, CompiledCG } from '../shared/cgTypes';
import type { EditableMap } from '../shared/map';
import type { RenderScheme } from '../shared/renderScheme';
import { evaluateCG } from '../shared/cgCompiler';
import { createMapViewer, type MapViewer } from './mapViewer';
import { serverHttpBase } from './serverEndpoint';

interface NodeBaseline {
  node: THREE.Object3D;
  position: THREE.Vector3;
  rotation: THREE.Euler;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

/** Samples baked model-local tracks. Every evaluation starts from the captured rest pose. */
export function applyCgClip(nodes: Map<string, NodeBaseline>, clip: CgClip | undefined, time: number): void {
  for (const base of nodes.values()) {
    base.node.position.copy(base.position);
    base.node.quaternion.copy(base.quaternion);
    base.node.scale.copy(base.scale);
  }
  if (!clip) return;
  const t = clip.loop && clip.duration > 0 ? ((time % clip.duration) + clip.duration) % clip.duration : Math.max(0, Math.min(clip.duration, time));
  const index = t * clip.fps;
  for (const [id, track] of Object.entries(clip.tracks)) {
    const base = nodes.get(id);
    if (!base) continue;
    const sampleVector = (values: number[][], defaultValue: THREE.Vector3): THREE.Vector3 => {
      if (!values.length) return defaultValue;
      const a = Math.min(Math.floor(index), values.length - 1);
      const b = Math.min(a + 1, values.length - 1);
      return new THREE.Vector3().fromArray(values[a]).lerp(new THREE.Vector3().fromArray(values[b]), index - Math.floor(index));
    };
    if (track.position?.length) base.node.position.add(sampleVector(track.position, new THREE.Vector3()));
    if (track.rotation?.length) {
      const euler = sampleVector(track.rotation, new THREE.Vector3());
      // 3d-generate bakes additive XYZ Euler channels, not local quaternion deltas.
      base.node.rotation.set(base.rotation.x + euler.x, base.rotation.y + euler.y, base.rotation.z + euler.z, 'XYZ');
    }
    if (track.quaternion?.length) {
      const a = Math.min(Math.floor(index), track.quaternion.length - 1);
      const b = Math.min(a + 1, track.quaternion.length - 1);
      base.node.quaternion.fromArray(track.quaternion[a]).slerp(new THREE.Quaternion().fromArray(track.quaternion[b]), index - Math.floor(index));
    }
    if (track.scale?.length) base.node.scale.multiply(sampleVector(track.scale, new THREE.Vector3(1, 1, 1)));
  }
}

export class CgPlaybackRuntime {
  readonly controls: OrbitControls;
  private bundle: CompiledCG | null = null;
  private nodes = new Map<string, Map<string, NodeBaseline>>();
  private marker = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 10), new THREE.MeshBasicMaterial({ color: 0x79f3ce, depthTest: false }));
  private effects = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffd58a, size: 0.095, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  private manual = false;
  private disposed = false;
  private sceneQueue: Promise<void> = Promise.resolve();

  private constructor(readonly viewer: MapViewer) {
    this.controls = new OrbitControls(viewer.camera, viewer.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.enabled = true;
    this.controls.minDistance = 0.2;
    this.controls.maxDistance = 2000;
    this.marker.visible = false;
    this.marker.renderOrder = 1000;
    viewer.scene.add(this.marker, this.effects);
  }

  static async create(canvas: HTMLCanvasElement, map: EditableMap, scheme: RenderScheme | null): Promise<CgPlaybackRuntime> {
    const viewer = await createMapViewer({ canvas, map, scheme, autoStart: false, quality: 'balanced',
      hdriUrl: file => `${serverHttpBase(location, import.meta.env.DEV)}/api/editor/hdri/${encodeURIComponent(file)}` });
    const runtime = new CgPlaybackRuntime(viewer);
    runtime.frameMap(map);
    return runtime;
  }

  load(bundle: CompiledCG): Promise<void> {
    // Bound objects must be standalone, including initially hidden props. The immutable bundle is untouched.
    const map = structuredClone(bundle.map);
    const bound = new Set(bundle.bindings.map(binding => binding.objectId));
    for (const object of map.objects) if (bound.has(object.id)) {
      object.visible = true;
      object.behavior = { ...object.behavior, kind: object.behavior?.kind ?? 'static', locomotion: object.behavior?.locomotion ?? 'static', animation: { state: 'cg-owned', speed: 0, phase: 0 } };
    }
    return this.queueScene(map, bundle.scheme, bundle);
  }

  reset(map: EditableMap, scheme: RenderScheme | null): Promise<void> {
    return this.queueScene(structuredClone(map), scheme, null);
  }

  private queueScene(map: EditableMap, scheme: RenderScheme | null, bundle: CompiledCG | null): Promise<void> {
    const operation = this.sceneQueue.then(async () => {
      if (this.disposed) return;
      this.bundle = null;
      this.nodes.clear();
      this.marker.visible = false;
      this.effects.visible = false;
      await this.viewer.setMap(map);
      if (this.disposed) return;
      this.viewer.setRenderScheme(scheme);
      this.bundle = bundle;
      if (!bundle) { this.setManual(false); this.frameMap(map); this.sample(0); return; }
    for (const binding of bundle.bindings) {
      const group = this.viewer.runtime.rendered?.objectGroups.get(binding.objectId);
      const nodes = new Map<string, NodeBaseline>();
      group?.traverse(node => {
        const id = node.userData.nodeId;
        if (typeof id === 'string') nodes.set(id, { node, position: node.position.clone(), rotation: node.rotation.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone() });
      });
      this.nodes.set(binding.entityId, nodes);
    }
    this.setManual(false);
    this.sample(0);
    });
    // Serialize scene replacement, and let disposal wait for the current asynchronous builder.
    this.sceneQueue = operation.catch(() => undefined);
    return operation;
  }

  private frameMap(map: EditableMap): void {
    const camera = this.viewer.camera;
    camera.fov = 50;
    camera.updateProjectionMatrix();
    if (map.sceneMode === 'indoor' && map.room) {
      const [x, y, z] = map.room.position;
      const eye = y + Math.min(1.6, map.room.size[1] * 0.55);
      camera.position.set(x + map.room.size[0] * 0.3, eye, z + map.room.size[2] * 0.3);
      this.controls.target.set(x, eye - 0.15, z);
    } else {
      const span = Math.max(map.box.size[0], map.box.size[2], 10);
      camera.position.set(span * 0.48, span * 0.42, span * 0.48);
      this.controls.target.set(0, 0, 0);
    }
    this.controls.update();
  }

  setManual(enabled: boolean): void {
    this.manual = enabled;
    this.controls.enabled = enabled || !this.bundle;
    if (enabled && this.bundle) {
      const camera = this.viewer.camera;
      this.controls.target.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(4));
      this.controls.update();
    }
  }

  sample(time: number): CgFrame | null {
    if (this.disposed) return null;
    let frame: CgFrame | null = null;
    if (this.bundle) {
      frame = evaluateCG(this.bundle, time);
      const rendered = this.viewer.runtime.rendered;
      // Parents are applied before children so their world-to-local conversion sees this frame.
      const bindings = [...this.bundle.bindings].sort((a, b) => this.objectDepth(a.objectId) - this.objectDepth(b.objectId));
      for (const binding of bindings) {
        const group = rendered?.objectGroups.get(binding.objectId);
        const state = frame.entities[binding.entityId];
        if (!group || !state) continue;
        group.parent?.updateWorldMatrix(true, false);
        const world = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(state.position), new THREE.Quaternion().fromArray(state.quaternion), new THREE.Vector3().fromArray(state.scale));
        if (group.parent) world.premultiply(group.parent.matrixWorld.clone().invert());
        world.decompose(group.position, group.quaternion, group.scale);
        group.visible = state.visible;
        const clip = this.bundle.resources.clips.find(value => value.id === state.clipId);
        applyCgClip(this.nodes.get(binding.entityId) ?? new Map(), clip, state.clipTime ?? 0);
        group.updateMatrixWorld(true);
        rendered?.syncObjectTransform(binding.objectId);
      }
      if (!this.manual) {
        this.viewer.camera.position.fromArray(frame.camera.position);
        this.viewer.camera.quaternion.fromArray(frame.camera.quaternion);
        this.viewer.camera.fov = frame.camera.fov;
        this.viewer.camera.updateProjectionMatrix();
      }
      this.sampleEffects(frame);
    }
    // WorldForge ambient simulations use a frozen time. All CG tracks use the absolute evaluator above.
    this.viewer.runtime.renderFrame(0, 0);
    return frame;
  }

  captureCamera(): CgCameraPose {
    const camera = this.viewer.camera;
    return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov, target: this.controls.target.toArray() };
  }

  pick(clientX: number, clientY: number): [number, number, number] | null {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), this.viewer.camera);
    this.viewer.scene.updateMatrixWorld(true);
    const hits = ray.intersectObjects(this.viewer.runtime.rendered?.pickables ?? [], true);
    const hit = hits.find(value => {
      let node: THREE.Object3D | null = value.object;
      while (node) { if (!node.visible) return false; node = node.parent; }
      return true;
    });
    if (!hit) return null;
    this.marker.position.copy(hit.point);
    this.marker.visible = true;
    return hit.point.toArray();
  }

  private objectDepth(id: string): number {
    let depth = 0;
    let object = this.viewer.runtime.rendered?.objectGroups.get(id)?.parent;
    while (object) { depth++; object = object.parent; }
    return depth;
  }

  private sampleEffects(frame: CgFrame): void {
    const positions: number[] = [];
    for (const effect of frame.effects) {
      if (effect.age < 0 || effect.age > 1.25) continue;
      let seed = effect.seed >>> 0;
      const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      for (let n = 0; n < 32; n++) {
        const angle = random() * Math.PI * 2;
        const speed = 0.6 + random() * 1.3;
        const up = 0.4 + random() * 1.8;
        positions.push(effect.position[0] + Math.cos(angle) * speed * effect.age, effect.position[1] + up * effect.age - 1.6 * effect.age * effect.age, effect.position[2] + Math.sin(angle) * speed * effect.age);
      }
    }
    this.effects.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.effects.geometry.computeBoundingSphere();
    this.effects.visible = positions.length > 0;
  }

  resize(width: number, height: number): void { this.viewer.setSize(width, height); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controls.dispose();
    this.marker.geometry.dispose();
    this.marker.material.dispose();
    this.effects.geometry.dispose();
    this.effects.material.dispose();
    void this.sceneQueue.then(() => this.viewer.dispose());
  }
}
