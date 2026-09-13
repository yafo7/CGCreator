import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CgProject, CgProjectSummary } from '../shared/cgTypes';

export class CgHttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** One process owns the local project store. A project transaction serializes CAS and the atomic rename. */
export class CgStore {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(readonly rootDir: string) {}
  private filename(id: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id)) throw new CgHttpError(400, 'invalid_project_id', '项目 ID 无效。');
    return path.join(this.rootDir, 'projects', `${id}.json`);
  }
  async read(id: string): Promise<CgProject> {
    try { return JSON.parse(await readFile(this.filename(id), 'utf8')) as CgProject; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CgHttpError(404, 'project_not_found', 'CG 项目不存在。');
      throw error;
    }
  }
  async list(): Promise<CgProjectSummary[]> {
    const files = await readdir(path.join(this.rootDir, 'projects')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const projects = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => this.read(f.slice(0, -5))));
    return projects.map((p) => ({ id: p.id, title: p.title, mapId: p.mapSnapshot.id, revision: p.revision, confirmed: !!p.confirmed, updatedAt: p.updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async create(project: CgProject) {
    await this.atomicWrite(this.filename(project.id), project);
    return structuredClone(project);
  }
  async transaction(id: string, revision: number, edit: (project: CgProject) => Promise<void> | void): Promise<CgProject> {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new CgHttpError(400, 'revision_required', '需要当前项目 revision。');
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const queue = previous.then(() => pending);
    this.locks.set(id, queue);
    await previous;
    try {
      const project = await this.read(id);
      if (project.revision !== revision) throw new CgHttpError(409, 'revision_conflict', '项目已更新，请重新打开最新版本后重试。');
      await edit(project);
      project.revision += 1;
      project.updatedAt = Date.now();
      await this.atomicWrite(this.filename(id), project);
      return structuredClone(project);
    } finally {
      release();
      if (this.locks.get(id) === queue) this.locks.delete(id);
    }
  }
  async cached<T>(key: string): Promise<T | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('Invalid resource cache key.');
    try { return JSON.parse(await readFile(path.join(this.rootDir, 'resources', `${key}.json`), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async cache(key: string, value: unknown) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('Invalid resource cache key.');
    await this.atomicWrite(path.join(this.rootDir, 'resources', `${key}.json`), value);
  }
  private async atomicWrite(filename: string, value: unknown) {
    await mkdir(path.dirname(filename), { recursive: true });
    const temp = `${filename}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(value), 'utf8'); await rename(temp, filename); }
    finally { await rm(temp, { force: true }); }
  }
}
