import { access } from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/** Starts the pinned sibling editor only on demand. CGCreator remains usable when it is absent. */
export class CgToolHost {
  private child: ChildProcess | null = null;
  private starting: Promise<string> | null = null;

  async open3dEditor(): Promise<string> {
    if (!this.starting) this.starting = this.ensure();
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  private async ensure(): Promise<string> {
    const port = Number(process.env.CG_3D_EDITOR_PORT ?? 8000);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('CG_3D_EDITOR_PORT 无效。');
    const url = `http://127.0.0.1:${port}`;
    if (await available(url)) return url;
    const directory = process.env.CG_3D_GENERATE_DIR ?? path.resolve(process.cwd(), '..', '3d-generate');
    const script = path.join(directory, 'server.py');
    try { await access(script); }
    catch { throw new Error(`找不到 3d-generate 工坊：${directory}`); }
    if (!this.child || this.child.exitCode !== null) {
      this.child = spawn(process.env.PYTHON ?? 'python', [script], {
        cwd: directory,
        env: { ...process.env, PORT: String(port) },
        stdio: 'ignore',
        windowsHide: true
      });
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (await available(url)) return url;
      if (this.child.exitCode !== null) break;
    }
    throw new Error('3d-generate 工坊未能启动。请检查本机 Python 与端口 8000。');
  }
}

async function available(url: string): Promise<boolean> {
  try { return (await fetch(`${url}/api/ip`, { signal: AbortSignal.timeout(600) })).ok; }
  catch { return false; }
}
