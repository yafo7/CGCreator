import path from 'node:path';
import { CgHttpError } from './cgStore';
import { assertStoreId, atomicWriteJson, listJsonFiles, readJsonFile } from './cgFileStore';
import type { CgGenerationRun } from '../shared/cgRunTypes';

export class CgRunStore {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(readonly rootDir: string) {}

  private filename(id: string): string {
    assertStoreId(id, 'run id');
    return path.join(this.rootDir, 'runs', `${id}.json`);
  }

  async create(run: CgGenerationRun): Promise<CgGenerationRun> {
    await atomicWriteJson(this.filename(run.id), run);
    return structuredClone(run);
  }

  async read(id: string): Promise<CgGenerationRun> {
    try { return await readJsonFile<CgGenerationRun>(this.filename(id)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CgHttpError(404, 'run_not_found', '生成 Run 不存在。');
      throw error;
    }
  }

  async list(projectId: string): Promise<CgGenerationRun[]> {
    assertStoreId(projectId, 'project id');
    const files = await listJsonFiles(path.join(this.rootDir, 'runs'));
    const values = await Promise.all(files.map(file => this.read(file.slice(0, -5))));
    return values.filter(run => run.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt);
  }

  async update(id: string, edit: (run: CgGenerationRun) => void | Promise<void>): Promise<CgGenerationRun> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const queue = previous.then(() => pending);
    this.locks.set(id, queue);
    await previous;
    try {
      const run = await this.read(id);
      await edit(run);
      run.updatedAt = Date.now();
      await atomicWriteJson(this.filename(id), run);
      return structuredClone(run);
    } finally {
      release();
      if (this.locks.get(id) === queue) this.locks.delete(id);
    }
  }
}

