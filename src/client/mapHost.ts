import * as THREE from 'three';
import { buildEditableMapGroup, type RenderedMap } from './mapRenderer';
import { configureRendererOutput } from './renderOutputPipeline';
import type { EditableMap } from '../shared/map';
import type { RenderScheme } from '../shared/renderScheme';

export interface MapHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly rendered: RenderedMap | null;
  readonly gameplayRoot: THREE.Group;
  setSize(width: number, height: number): void;
  tick(deltaTime: number): void;
  dispose(): void;
}

export interface MapHostOptions {
  scene?: THREE.Scene;
  camera?: THREE.PerspectiveCamera;
  renderer?: THREE.WebGLRenderer;
  map: EditableMap;
  scheme?: RenderScheme | null;
  hdriUrl?: (file: string) => string;
  pixelRatio?: number;
}

/**
 * Embeds WorldForge's authored map renderer into a host-owned Three.js scene.
 * Unlike createMapViewer, this adapter does not create a second canvas or
 * render loop, which makes it suitable for editors and cinematic tools.
 */
export async function createMapHost(options: MapHostOptions): Promise<MapHost> {
  const scene = options.scene ?? new THREE.Scene();
  const camera = options.camera ?? new THREE.PerspectiveCamera(55, 1, 0.1, 3000);
  const renderer = options.renderer ?? new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(options.pixelRatio ?? Math.min(globalThis.devicePixelRatio ?? 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  configureRendererOutput(renderer);

  const gameplayRoot = new THREE.Group();
  gameplayRoot.name = 'worldforge-host-gameplay-root';
  scene.add(gameplayRoot);

  const hemisphere = new THREE.HemisphereLight(0xeaf6ff, 0x30382f, 1.6);
  const sun = new THREE.DirectionalLight(0xfff0ce, 2.5);
  sun.position.set(16, 28, 12);
  sun.castShadow = true;
  scene.add(hemisphere, sun);

  const scheme = options.scheme ?? null;
  if (scheme) {
    const settings = scheme.settings;
    scene.background = new THREE.Color(settings.background);
    scene.fog = settings.fogDensity > 0
      ? new THREE.FogExp2(settings.fogColor, settings.fogDensity)
      : null;
    hemisphere.color.set(settings.hemisphereSkyColor);
    hemisphere.groundColor.set(settings.hemisphereGroundColor);
    hemisphere.intensity = settings.hemisphereIntensity;
    sun.color.set(settings.sunColor);
    sun.intensity = settings.sunIntensity;
    renderer.toneMappingExposure = settings.exposure;
  }

  const rendered = await buildEditableMapGroup(options.map, { scene, renderer });
  scene.add(rendered.group);
  let elapsed = 0;
  let disposed = false;

  return {
    scene,
    camera,
    renderer,
    rendered,
    gameplayRoot,
    setSize(width, height) {
      const safeWidth = Math.max(1, Math.floor(width));
      const safeHeight = Math.max(1, Math.floor(height));
      camera.aspect = safeWidth / safeHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(safeWidth, safeHeight, false);
    },
    tick(deltaTime) {
      if (disposed) return;
      elapsed += Math.max(0, deltaTime);
      rendered.update(deltaTime, camera, 180);
      void elapsed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      rendered.group.removeFromParent();
      rendered.dispose();
      gameplayRoot.removeFromParent();
      hemisphere.removeFromParent();
      sun.removeFromParent();
    }
  };
}
