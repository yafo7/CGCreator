import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function assertStoreId(id: string, label = 'id'): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(id)) throw new Error(`Invalid ${label}.`);
}

export async function readJsonFile<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, 'utf8')) as T;
}

export async function listJsonFiles(directory: string): Promise<string[]> {
  return (await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter(file => file.endsWith('.json'));
}

/** Complete the write before replacing the visible file. Windows scanners and
 * editor previews can hold a short-lived handle, so replacement is retried. */
export async function atomicWriteJson(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    await writeFile(temp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    await renameWithRetry(temp, filename);
    committed = true;
  } finally {
    if (committed) await rm(temp, { force: true });
  }
}

export async function writeJsonExclusive(filename: string, value: unknown): Promise<boolean> {
  await mkdir(path.dirname(filename), { recursive: true });
  try {
    await writeFile(filename, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES']);
  const delays = [20, 50, 100, 200, 400, 800, 1200];
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !retryable.has(code) || attempt >= delays.length) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

