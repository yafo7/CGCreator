import type { MapAsset } from './map';
import type { CgClip } from './cgTypes';

/** A user-owned production asset. Its ID is stable while versions are immutable. */
export interface CgPreparedAsset {
  id: string;
  name: string;
  kind: 'actor' | 'prop';
  description: string;
  selectedVersionId: string;
  versionIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** One frozen model revision. Upstream metadata remains inside modelJson unchanged. */
export interface CgPreparedAssetVersion {
  id: string;
  assetId: string;
  parentVersionId?: string;
  source: 'generated' | 'edited' | 'imported' | 'worldforge';
  description: string;
  model: MapAsset;
  modelHash: string;
  capabilities: {
    locomotion: boolean;
    faceCloseup: boolean;
    sit: 'unknown' | 'ready' | 'needs-rig';
    hold: 'unknown' | 'ready' | 'needs-socket';
  };
  createdAt: number;
}

/** A baked motion belongs to a concrete model version, never only to a display name. */
export interface CgPreparedMotion {
  id: string;
  assetVersionId: string;
  name: string;
  description: string;
  naturalDuration: number;
  loop: boolean;
  /** Baked in-place tracks, without a scene-instance owner. */
  clip: Omit<CgClip, 'id' | 'entityId'>;
  createdAt: number;
}

export interface CgPreparation {
  schemaVersion: 1;
  assets: CgPreparedAsset[];
  versions: CgPreparedAssetVersion[];
  motions: CgPreparedMotion[];
}

export const emptyPreparation = (): CgPreparation => ({ schemaVersion: 1, assets: [], versions: [], motions: [] });

export function selectedPreparedVersion(preparation: CgPreparation | undefined, assetId: string | undefined): CgPreparedAssetVersion | undefined {
  if (!preparation || !assetId) return undefined;
  const asset = preparation.assets.find(item => item.id === assetId);
  return asset ? preparation.versions.find(version => version.id === asset.selectedVersionId) : undefined;
}

/** Generation inputs are intentionally short, direct natural-language requests. */
export function assertGenerationDescription(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error('需要一句角色、道具或动作描述。');
  const text = value.trim();
  if (!text || text.length > 180 || /[\r\n]/.test(text)) throw new Error('请使用不超过 180 字的一句话描述。');
}
