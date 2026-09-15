import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { CgCameraPose, CgClip, CgFrame, CompiledCG } from '../shared/cgTypes';
import { sampleTerrainHeight, type EditableMap } from '../shared/map';
import type { CgSemanticEntity } from '../shared/cgWorldSemantics';
import type { RenderScheme } from '../shared/renderScheme';
import { evaluateCG } from '../shared/cgCompiler';
import { smoothPathPolyline } from '../shared/cgPath';
import { sampleLocalPose, type CgLocalPose } from '../shared/cgPoseEvaluator';
import { createMapViewer, type MapViewer } from './mapViewer';
import { serverHttpBase } from './serverEndpoint';

interface NodeBaseline {
  node: THREE.Object3D;
  position: THREE.Vector3;
  rotation: THREE.Euler;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

export interface CgEditablePathPoint {
  operation: 'move' | 'insert';
  kind: 'actor' | 'camera';
  targetId: string;
  pointId: string;
  index: number;
  count: number;
  position: [number, number, number];
  path: Array<[number, number, number]>;
  pointIds: string[];
}

export interface CgPathSelection { kind: 'actor' | 'camera'; targetId: string; editing: boolean }

export function cgFilmViewport(width: number, height: number, cinematic: boolean) {
  const w = Math.max(1, width), h = Math.max(1, height);
  if (!cinematic) return { width: w, height: h, left: 0, top: 0 };
  const filmWidth = Math.min(w, h * 16 / 9), filmHeight = filmWidth * 9 / 16;
  return { width: filmWidth, height: filmHeight, left: (w - filmWidth) / 2, top: (h - filmHeight) / 2 };
}

/** Samples baked model-local tracks. Every evaluation starts from the captured rest pose. */
export function applyCgClip(nodes: Map<string, NodeBaseline>, clip: CgClip | undefined, time: number, weight = 1): void {
  for (const [id, base] of nodes) {
    const rest: CgLocalPose = { position: base.position.toArray(), quaternion: base.quaternion.toArray(), scale: base.scale.toArray() };
    const pose = sampleLocalPose(rest, clip?.tracks[id], clip, time, weight);
    base.node.position.fromArray(pose.position);
    base.node.quaternion.fromArray(pose.quaternion);
    base.node.scale.fromArray(pose.scale);
  }
}

export class CgPlaybackRuntime {
  readonly controls: OrbitControls;
  private bundle: CompiledCG | null = null;
  private nodes = new Map<string, Map<string, NodeBaseline>>();
  private marker = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 10), new THREE.MeshBasicMaterial({ color: 0x79f3ce, depthTest: false }));
  private effects = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffd58a, size: 0.095, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  private pathRoot = new THREE.Group();
  private worldHighlight: THREE.Line | null = null;
  private pathControls: THREE.Mesh[] = [];
  private pathLines: THREE.Line[] = [];
  private transform: TransformControls;
  private pathEditing = false;
  private selectedPathKey = '';
  private editingPathKey = '';
  private pathChanged: ((point: CgEditablePathPoint) => void) | null = null;
  private manual = false;
  private disposed = false;
  private sceneQueue: Promise<void> = Promise.resolve();
  private viewportSize = { width: 1, height: 1 };

  private constructor(readonly viewer: MapViewer) {
    this.controls = new OrbitControls(viewer.camera, viewer.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.enabled = true;
    this.controls.minDistance = 0.2;
    this.controls.maxDistance = 2000;
    this.transform = new TransformControls(viewer.camera, viewer.renderer.domElement);
    this.transform.setMode('translate');
    this.transform.setSpace('world');
    this.transform.addEventListener('dragging-changed', (event) => { this.controls.enabled = !(event.value as boolean) && (this.manual || !this.bundle || this.pathEditing); });
    this.transform.addEventListener('objectChange', () => this.updatePathLine(this.transform.object));
    this.transform.addEventListener('mouseUp', () => this.commitPathPoint());
    this.marker.visible = false;
    this.marker.renderOrder = 1000;
    viewer.scene.add(this.marker, this.effects, this.pathRoot, this.transform as unknown as THREE.Object3D);
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
      this.clearPathGuides();
      this.clearWorldHighlight();
      await this.viewer.setMap(map);
      if (this.disposed) return;
      this.viewer.setRenderScheme(scheme);
      this.bundle = bundle;
      this.resize(this.viewportSize.width, this.viewportSize.height);
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
    this.buildPathGuides(bundle);
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
    this.controls.enabled = enabled || !this.bundle || this.pathEditing;
    if (enabled && this.bundle) {
      const camera = this.viewer.camera;
      this.controls.target.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(4));
      this.controls.update();
    }
  }

  setPathEditing(enabled: boolean, onChange?: (point: CgEditablePathPoint) => void): void {
    const entering = enabled && !this.pathEditing;
    this.pathEditing = enabled;
    this.pathChanged = enabled ? onChange ?? this.pathChanged : null;
    this.pathRoot.visible = !!this.bundle;
    if (!enabled) { this.selectedPathKey = ''; this.editingPathKey = ''; this.transform.detach(); }
    this.refreshPathAppearance();
    this.controls.enabled = enabled || this.manual || !this.bundle;
    if (entering) {
      const bounds = new THREE.Box3().setFromObject(this.pathRoot);
      if (!bounds.isEmpty()) {
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const span = Math.max(4, size.x, size.y * 1.6, size.z);
        this.viewer.camera.position.copy(center).add(new THREE.Vector3(span * 0.62, span * 0.52, span * 0.62));
        this.controls.target.copy(center);
      } else this.controls.target.copy(this.viewer.camera.position).add(this.viewer.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(4));
      this.controls.update();
    }
  }

  pickPathControl(clientX: number, clientY: number): boolean {
    if (!this.pathEditing || !this.editingPathKey || !this.pathControls.length) return false;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), this.viewer.camera);
    const hit = ray.intersectObjects(this.pathControls.filter((point) => point.visible), false)[0];
    if (!hit) return false;
    this.transform.attach(hit.object);
    return true;
  }

  selectPath(clientX: number, clientY: number): CgPathSelection | null {
    if (!this.pathEditing) return null;
    const hit = this.screenPathHit(clientX, clientY);
    if (!hit) { this.selectedPathKey = ''; this.editingPathKey = ''; this.transform.detach(); this.refreshPathAppearance(); return null; }
    const line = hit.line;
    this.selectedPathKey = line.userData.pathKey;
    if (this.editingPathKey !== this.selectedPathKey) { this.editingPathKey = ''; this.transform.detach(); }
    this.refreshPathAppearance();
    return { kind: line.userData.pathKind, targetId: line.userData.targetId, editing: this.editingPathKey === this.selectedPathKey };
  }

  editSelectedPath(): CgPathSelection | null {
    if (!this.pathEditing || !this.selectedPathKey) return null;
    this.editingPathKey = this.selectedPathKey;
    this.refreshPathAppearance();
    const line = this.pathLines.find((item) => item.userData.pathKey === this.selectedPathKey)!;
    return { kind: line.userData.pathKind, targetId: line.userData.targetId, editing: true };
  }

  insertPathPoint(clientX: number, clientY: number): boolean {
    if (!this.pathEditing || !this.editingPathKey || !this.pathChanged) return false;
    const line = this.pathLines.find((item) => item.userData.pathKey === this.editingPathKey);
    if (!line) return false;
    const hit = this.screenPathHit(clientX, clientY, [line]);
    if (!hit) return false;
    const group = line.parent!;
    const controls = this.pathPoints(group);
    if (controls.length < 2) return false;
    let after = 0, best = Infinity;
    for (let index = 0; index < controls.length - 1; index++) {
      const segment = new THREE.Line3(controls[index].position, controls[index + 1].position);
      const closest = segment.closestPointToPoint(hit.point, true, new THREE.Vector3());
      const distance = closest.distanceToSquared(hit.point);
      if (distance < best) { best = distance; after = index; }
    }
    const path = controls.map((point) => point.position.toArray() as [number, number, number]);
    const pointIds = controls.map((point) => point.userData.pathPoint.pointId as string);
    const index = after + 1;
    const pointId = `user-${line.userData.pathKind}-path-${line.userData.targetId}-${crypto.randomUUID()}`;
    path.splice(index, 0, hit.point.toArray() as [number, number, number]);
    pointIds.splice(index, 0, pointId);
    this.pathChanged({ operation: 'insert', kind: line.userData.pathKind, targetId: line.userData.targetId, pointId, index, count: path.length, position: path[index], path, pointIds });
    return true;
  }

  cancelPathPointEditing(): boolean {
    if (!this.editingPathKey) return false;
    this.editingPathKey = '';
    this.transform.detach();
    this.refreshPathAppearance();
    return true;
  }

  private screenPathHit(clientX: number, clientY: number, lines = this.pathLines): { line: THREE.Line; point: THREE.Vector3 } | null {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(clientX - rect.left, clientY - rect.top);
    let best: { line: THREE.Line; point: THREE.Vector3; distance: number } | null = null;
    this.viewer.scene.updateMatrixWorld(true);
    for (const line of lines) {
      const positions = line.geometry.getAttribute('position');
      for (let index = 0; index < positions.count - 1; index++) {
        const worldA = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(line.matrixWorld);
        const worldB = new THREE.Vector3().fromBufferAttribute(positions, index + 1).applyMatrix4(line.matrixWorld);
        const projectedA = worldA.clone().project(this.viewer.camera), projectedB = worldB.clone().project(this.viewer.camera);
        if ((projectedA.z < -1 && projectedB.z < -1) || (projectedA.z > 1 && projectedB.z > 1)) continue;
        const a = new THREE.Vector2((projectedA.x + 1) * rect.width / 2, (1 - projectedA.y) * rect.height / 2);
        const b = new THREE.Vector2((projectedB.x + 1) * rect.width / 2, (1 - projectedB.y) * rect.height / 2);
        const ab = b.clone().sub(a);
        const t = ab.lengthSq() ? THREE.MathUtils.clamp(mouse.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1) : 0;
        const distance = a.clone().addScaledVector(ab, t).distanceTo(mouse);
        if (distance <= 14 && (!best || distance < best.distance)) best = { line, point: worldA.lerp(worldB, t), distance };
      }
    }
    return best && { line: best.line, point: best.point };
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
        applyCgClip(this.nodes.get(binding.entityId) ?? new Map(), clip, state.clipTime ?? 0, state.clipWeight ?? 1);
        group.updateMatrixWorld(true);
        rendered?.syncObjectTransform(binding.objectId);
      }
      if (!this.manual && !this.pathEditing) {
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


  private buildPathGuides(bundle: CompiledCG): void {
    this.clearPathGuides();
    for (const action of bundle.actions) if (action.type === 'move' && action.path?.length) {
      const controls = action.pathControls ?? editableActorPath(action.path).map((position, index, points) => ({ id: `auto-actor:${action.id}:${index}`, position, role: index === 0 ? 'start' as const : index === points.length - 1 ? 'end' as const : 'via' as const, source: 'auto' as const }));
      const displayed = action.pathInterpolation === 'smooth' ? smoothPathPolyline(action.path) : action.path;
      this.addPathGuide('actor', action.id, controls.map((point) => point.position), controls.map((point) => point.id), 0x5ee6a8, action.pathInterpolation === 'smooth', displayed);
    }
    for (const shot of bundle.shots) {
      const duration = Math.max(1e-4, shot.end - shot.start);
      // Automatic moves expose the director-friendly minimum: start, shaping via,
      // and end. Users can add more controls by double-clicking the curve.
      const sampleCount = shot.camera.movement === 'static' && !shot.path ? 1 : 3;
      const sampleTimes = Array.from({ length: sampleCount }, (_, index) => shot.start + duration * index / Math.max(1, sampleCount - 1));
      const points = sampleTimes.map((time) => evaluateCG(bundle, Math.min(bundle.duration, Math.max(0, time - (time === shot.end ? 1e-5 : 0)))).camera.position);
      const path = shot.pathControlIds?.length && shot.path?.length ? shot.path : points;
      const pointIds = shot.pathControlIds?.length === path.length ? shot.pathControlIds : path.map((_, index) => `auto-camera:${shot.id}:${index}`);
      const displayed = shot.cameraSamples?.poses.map(pose => pose.position) ?? (shot.path?.length ? smoothPathPolyline(shot.path) : undefined);
      this.addPathGuide('camera', shot.id, path, pointIds, 0x6fb7ff, path.length >= 3, displayed);
    }
    this.setPathEditing(this.pathEditing, this.pathChanged ?? undefined);
  }

  private addPathGuide(kind: 'actor' | 'camera', targetId: string, path: Array<[number, number, number]>, pointIds: string[], color: number, smooth: boolean, displayed?: Array<[number, number, number]>): void {
    if (!path.length) return;
    const group = new THREE.Group();
    const pathKey = `${kind}:${targetId}`;
    group.userData.pathKind = kind;
    group.userData.targetId = targetId;
    group.userData.pathKey = pathKey;
    const displayPath = displayed ?? (smooth ? smoothPathPolyline(path) : path);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(displayPath.map((point) => new THREE.Vector3(...point))), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55, depthTest: false }));
    line.renderOrder = 900;
    line.userData.pathLine = true;
    line.userData.pathKey = pathKey;
    line.userData.pathKind = kind;
    line.userData.targetId = targetId;
    line.userData.smooth = smooth;
    group.add(line);
    const pathBounds = new THREE.Box3().setFromPoints(path.map((position) => new THREE.Vector3(...position)));
    const markerRadius = Math.max(kind === 'camera' ? 0.26 : 0.2, pathBounds.getSize(new THREE.Vector3()).length() * 0.018);
    path.forEach((position, index) => {
      const point = new THREE.Mesh(new THREE.SphereGeometry(markerRadius, 14, 10), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      point.position.fromArray(position);
      point.renderOrder = 901;
      point.visible = false;
      point.userData.baseRadius = markerRadius;
      point.userData.pathPoint = { kind, targetId, index, pointId: pointIds[index] ?? `auto-${pathKey}:${index}` };
      point.add(this.makePointLabel(index + 1, color, markerRadius));
      group.add(point);
      if (kind === 'camera' || index > 0) this.pathControls.push(point);
    });
    this.pathLines.push(line);
    this.pathRoot.add(group);
  }

  private updatePathLine(object: THREE.Object3D | undefined): void {
    const group = object?.parent;
    const line = group?.children.find((child) => child.userData.pathLine) as THREE.Line<THREE.BufferGeometry> | undefined;
    if (!group || !line) return;
    const points = this.pathPoints(group).map((child) => child.position.toArray() as [number, number, number]);
    const displayPath = line.userData.smooth ? smoothPathPolyline(points) : points;
    line.geometry.setFromPoints(displayPath.map((point) => new THREE.Vector3(...point)));
  }

  private commitPathPoint(): void {
    const object = this.transform.object as THREE.Mesh | undefined;
    const data = object?.userData.pathPoint as { kind: 'actor' | 'camera'; targetId: string; index: number; pointId: string } | undefined;
    const group = object?.parent;
    if (!object || !data || !group || !this.pathChanged) return;
    const controls = this.pathPoints(group);
    const path = controls.map((child) => child.position.toArray() as [number, number, number]);
    const pointIds = controls.map((child) => child.userData.pathPoint.pointId as string);
    this.pathChanged({ operation: 'move', ...data, count: path.length, position: object.position.toArray(), path, pointIds });
  }

  private pathPoints(group: THREE.Object3D): THREE.Mesh[] {
    return group.children.filter((child): child is THREE.Mesh => Boolean(child.userData.pathPoint)).sort((left, right) => left.userData.pathPoint.index - right.userData.pathPoint.index);
  }

  private refreshPathAppearance(): void {
    this.pathRoot.visible = this.pathEditing && !!this.bundle;
    for (const line of this.pathLines) {
      const material = line.material as THREE.LineBasicMaterial;
      const selected = line.userData.pathKey === this.selectedPathKey;
      material.opacity = selected ? 1 : 0.55;
    }
    for (const group of this.pathRoot.children) for (const point of this.pathPoints(group)) {
      point.visible = this.pathEditing && group.userData.pathKey === this.editingPathKey;
      const baseRadius = point.userData.baseRadius as number;
      const desiredRadius = Math.max(baseRadius, point.getWorldPosition(new THREE.Vector3()).distanceTo(this.viewer.camera.position) * 0.015);
      point.scale.setScalar(desiredRadius / baseRadius);
    }
  }

  private makePointLabel(index: number, color: number, radius: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const context = canvas.getContext('2d')!;
    context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    context.beginPath(); context.arc(32, 32, 27, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#071018'; context.font = 'bold 30px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(String(index), 32, 34);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false }));
    sprite.position.set(0, radius * 2.1, 0); sprite.scale.setScalar(radius * 2.2); sprite.renderOrder = 902;
    return sprite;
  }

  private clearPathGuides(): void {
    this.transform.detach();
    this.pathControls = [];
    this.pathLines = [];
    this.selectedPathKey = '';
    this.editingPathKey = '';
    for (const child of [...this.pathRoot.children]) {
      child.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const material of materials) { const map = (material as THREE.SpriteMaterial).map; map?.dispose(); material.dispose(); }
      });
      this.pathRoot.remove(child);
    }
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

  focusWorldEntity(entity: CgSemanticEntity, map: EditableMap): void {
    this.clearWorldHighlight();
    const shape = entity.spatial?.shape;
    let points: Array<[number, number]> = [];
    if (shape?.kind === 'circle') points = Array.from({ length: 65 }, (_, i) => [shape.x + Math.cos(i * Math.PI / 32) * shape.radius, shape.z + Math.sin(i * Math.PI / 32) * shape.radius]);
    else if (shape) points = shape.kind === 'polygon' ? [...shape.points, shape.points[0]] : shape.points;
    const at = entity.worldPosition ?? [0, 0, 0];
    if (!points.length) points = [[at[0] - 0.5, at[2]], [at[0] + 0.5, at[2]], [at[0], at[2]], [at[0], at[2] - 0.5], [at[0], at[2] + 0.5]];
    const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x, z]) => new THREE.Vector3(x, (entity.kind === 'water' ? at[1] : sampleTerrainHeight(map, x, z)) + 0.12, z)));
    this.worldHighlight = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xffda76, depthTest: false, depthWrite: false }));
    this.worldHighlight.renderOrder = 1100;
    this.viewer.scene.add(this.worldHighlight);
    const b = entity.spatial?.bounds;
    const size = b ? Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], 4) : 6;
    this.setManual(true);
    this.controls.target.set(...at);
    this.viewer.camera.position.set(at[0] + size * 0.25, at[1] + size * 1.3, at[2] + size * 0.75);
    this.viewer.camera.fov = 50;
    this.viewer.camera.updateProjectionMatrix();
    this.controls.update();
  }
  clearWorldHighlight(): void {
    if (!this.worldHighlight) return;
    this.worldHighlight.removeFromParent(); this.worldHighlight.geometry.dispose();
    (this.worldHighlight.material as THREE.Material).dispose(); this.worldHighlight = null;
  }
  resize(width: number, height: number): void {
    this.viewportSize = { width, height };
    const gate = cgFilmViewport(width, height, this.bundle?.evaluationVersion === 2), canvas = this.viewer.renderer.domElement;
    canvas.style.width = `${gate.width}px`; canvas.style.height = `${gate.height}px`;
    canvas.style.position = 'absolute'; canvas.style.left = `${gate.left}px`; canvas.style.top = `${gate.top}px`;
    this.viewer.setSize(gate.width, gate.height);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controls.dispose();
    this.marker.geometry.dispose();
    this.marker.material.dispose();
    this.effects.geometry.dispose();
    this.effects.material.dispose();
    this.clearPathGuides();
    this.clearWorldHighlight();
    this.transform.dispose();
    void this.sceneQueue.then(() => this.viewer.dispose());
  }
}

function simplifyPath(path: Array<[number, number, number]>, threshold = 0.12): Array<[number, number, number]> {
  if (path.length <= 2) return path.map((point) => [...point]);
  const result: Array<[number, number, number]> = [[...path[0]]];
  for (let index = 1; index < path.length - 1; index++) {
    const before = new THREE.Vector3(...path[index - 1]), point = new THREE.Vector3(...path[index]), after = new THREE.Vector3(...path[index + 1]);
    const first = point.clone().sub(before).normalize(), second = after.clone().sub(point).normalize();
    if (first.angleTo(second) > threshold) result.push([...path[index]]);
  }
  result.push([...path[path.length - 1]]);
  if (result.length <= 12) return result;
  return result.filter((_, index) => index === 0 || index === result.length - 1 || index % Math.ceil(result.length / 10) === 0);
}

function editableActorPath(path: Array<[number, number, number]>): Array<[number, number, number]> {
  const simplified = simplifyPath(path);
  if (simplified.length !== 2) return simplified;
  return [simplified[0], new THREE.Vector3(...simplified[0]).lerp(new THREE.Vector3(...simplified[1]), 0.5).toArray(), simplified[1]];
}
