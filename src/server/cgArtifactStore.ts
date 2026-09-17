import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CgAgentName } from '../shared/cgAgentTypes';
import type { CgArtifactEnvelope, CgArtifactKind, CgArtifactRef } from '../shared/cgRunTypes';
import { assertStoreId, readJsonFile, writeJsonExclusive } from './cgFileStore';

const canonical = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
};

export function artifactContentHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export interface CreateArtifactInput<T> {
  kind: CgArtifactKind;
  producer: CgAgentName;
  runId: string;
  projectId: string;
  projectRevision: number;
  mapId: string;
  mapVersion: number;
  inputRefs?: string[];
  provenance?: Array<{ source: string; sourceId: string; hash: string }>;
  content: T;
}

export class CgArtifactStore {
  constructor(readonly rootDir: string) {}
  private filename(id: string): string {
    assertStoreId(id, 'artifact id');
    return path.join(this.rootDir, 'artifacts', `${id}.json`);
  }

  async create<T>(input: CreateArtifactInput<T>): Promise<CgArtifactRef> {
    const contentHash = artifactContentHash(input.content);
    const id = `artifact_${input.kind.replaceAll('-', '_')}_${randomUUID()}`;
    const envelope: CgArtifactEnvelope<T> = {
      schemaVersion: 1,
      id,
      kind: input.kind,
      contentHash,
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      mapId: input.mapId,
      mapVersion: input.mapVersion,
      createdAt: Date.now(),
      producer: input.producer,
      runId: input.runId,
      inputRefs: [...(input.inputRefs ?? [])],
      provenance: structuredClone(input.provenance ?? []),
      content: structuredClone(input.content)
    };
    if (!await writeJsonExclusive(this.filename(id), envelope)) throw new Error('Artifact ID collision.');
    return reference(envelope);
  }

  async read<T = unknown>(id: string): Promise<CgArtifactEnvelope<T>> {
    return readJsonFile<CgArtifactEnvelope<T>>(this.filename(id));
  }
}

function reference(value: CgArtifactEnvelope): CgArtifactRef {
  const { id, kind, contentHash, projectId, projectRevision, mapId, mapVersion, createdAt } = value;
  return { id, kind, contentHash, projectId, projectRevision, mapId, mapVersion, createdAt };
}

