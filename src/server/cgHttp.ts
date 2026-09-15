import type http from 'node:http';
import path from 'node:path';
import type { CgPatchOperation } from '../shared/cgTypes';
import { CG_CAPABILITIES } from '../shared/cgCapabilities';
import type { EditableMap } from '../shared/map';
import type { RenderScheme } from '../shared/renderScheme';
import { CgService } from './cgService';
import { CgHttpError, CgStore } from './cgStore';
import type { MapStore } from './mapStore';
import { queryWorld, validateWorldQuery, worldSummary } from '../shared/cgWorldQuery';
import { buildWorldSemanticIndex } from '../shared/cgWorldSemantics';

const services = new WeakMap<MapStore, CgService>();
export function cgServiceFor(mapStore: MapStore) {
  let service = services.get(mapStore);
  if (!service) { service = new CgService(new CgStore(path.join(mapStore.rootDir, 'cgcreator'))); services.set(mapStore, service); }
  return service;
}

/** Dedicated routes are handled before WorldForge routes; project storage never mutates source maps. */
export async function handleCgHttp(req: http.IncomingMessage, res: http.ServerResponse, mapStore: MapStore): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/api/cg/')) return false;
  const send = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    const origin = req.headers.origin;
    if (origin) {
      let hostname = '';
      try { hostname = new URL(origin).hostname; } catch { /* Rejected below. */ }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) throw new CgHttpError(403, 'local_origin_required', 'CG 项目 API 仅接受本机编辑器请求。');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    const remote = req.socket.remoteAddress;
    if (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw new CgHttpError(403, 'local_request_required', 'CG 项目 API 仅限本机访问。');
    const parts = url.pathname.split('/').filter(Boolean);
    const service = cgServiceFor(mapStore);
    if (parts.length === 3 && parts[2] === 'capabilities' && req.method === 'GET') { send(200, CG_CAPABILITIES); return true; }
    if (parts.length === 3 && parts[2] === 'foundation-demo' && req.method === 'POST') { send(201, await service.foundationDemo()); return true; }
    if (parts[2] !== 'projects') { send(404, { error: 'route_not_found' }); return true; }
    if (parts.length === 3 && req.method === 'GET') { send(200, { projects: await service.store.list() }); return true; }
    if (parts.length === 3 && req.method === 'POST') {
      const body = await readJson(req);
      const map = body.map as EditableMap;
      if (!map || !Array.isArray(map.objects)) throw new CgHttpError(400, 'map_required', '请提供当前 WorldForge 地图快照。');
      send(201, await service.create(await hydrateMapAssets(map, mapStore), (body.scheme ?? null) as RenderScheme | null, typeof body.title === 'string' ? body.title : undefined));
      return true;
    }
    const id = parts[3];
    if (!id) { send(404, { error: 'route_not_found' }); return true; }
    if (parts.length === 4 && req.method === 'GET') { send(200, await service.store.read(id)); return true; }
    if (parts.length === 5 && parts[4] === 'world' && req.method === 'GET') {
      const project = await service.store.read(id);
      send(200, { projectRevision: project.revision, ...worldSummary(buildWorldSemanticIndex(project.mapSnapshot)) });
      return true;
    }
    if (parts.length === 5 && req.method === 'GET' && parts[4] === 'progress') {
      await service.store.read(id);
      send(200, service.progress.get(id) ?? { stage: 'idle', message: '等待操作', running: false });
      return true;
    }
    if (parts.length === 5 && req.method === 'GET' && parts[4] === 'export') {
      const project = await service.store.read(id);
      if (!project.confirmed) throw new CgHttpError(409, 'confirmation_required', '请先确认一个通过验证的 CG 版本。');
      res.setHeader('Content-Disposition', `attachment; filename="${id}.cg.json"`);
      send(200, project.confirmed);
      return true;
    }
    if (parts.length !== 5 || req.method !== 'POST') { send(404, { error: 'route_not_found' }); return true; }
    const body = await readJson(req);
    const revision = body.revision as number;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new CgHttpError(400, 'revision_required', '需要当前项目 revision。');
    switch (parts[4]) {
      case 'world-query': {
        const project = await service.store.read(id);
        const index = buildWorldSemanticIndex(project.mapSnapshot);
        if (revision !== project.revision || body.sourceHash !== index.sourceHash) throw new CgHttpError(409, 'stale_world_query', '地图版本已变化，请重新读取地图语义后查询。');
        try { validateWorldQuery(body.query); }
        catch (error) { throw new CgHttpError(400, 'invalid_world_query', error instanceof Error ? error.message : String(error)); }
        send(200, queryWorld(project.mapSnapshot, body.query, index));
        break;
      }
      case 'sync-map': {
        const map = body.map as EditableMap;
        if (!map || !Array.isArray(map.objects)) throw new CgHttpError(400, 'map_required', '请提供当前 WorldForge 地图快照。');
        send(200, await service.syncMap(id, revision, await hydrateMapAssets(map, mapStore), (body.scheme ?? null) as RenderScheme | null));
        break;
      }
      case 'plan': send(200, await service.plan(id, revision, body.prompt as string, body.demo === true)); break;
      case 'refine': send(200, await service.refine(id, revision, body.prompt as string, typeof body.targetId === 'string' ? body.targetId : undefined)); break;
      case 'patch': {
        if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 64) throw new CgHttpError(400, 'invalid_patch', '需要 1–64 个局部修改操作。');
        send(200, await service.patch(id, revision, body.operations as CgPatchOperation[]));
        break;
      }
      case 'compile': send(200, await service.compile(id, revision)); break;
      case 'confirm': send(200, await service.confirm(id, revision, body.compileId as string, body.inputHash as string)); break;
      default: send(404, { error: 'route_not_found' });
    }
  } catch (error) {
    const status = error instanceof CgHttpError ? error.status : error instanceof SyntaxError ? 400 : 500;
    send(status, { error: error instanceof CgHttpError ? error.code : status === 400 ? 'invalid_json' : 'cg_operation_failed', message: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

async function hydrateMapAssets(map: EditableMap, mapStore: MapStore): Promise<EditableMap> {
  // Current editor assets win; hydrate only missing assets without replacing current transforms.
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  for (const object of map.objects) if (object.assetId && !assets.has(object.assetId)) {
    try { assets.set(object.assetId, await mapStore.loadAsset(object.assetId)); }
    catch { throw new CgHttpError(422, 'missing_map_asset', `地图缺少模型资源：${object.assetId}`); }
  }
  return { ...map, assets: [...assets.values()] };
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new CgHttpError(413, 'request_too_large', '项目请求超过 32 MB。');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CgHttpError(400, 'invalid_body', '请求需要 JSON 对象。');
  return value as Record<string, unknown>;
}
