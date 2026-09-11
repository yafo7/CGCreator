import {
  createEmptyDirectorReferences,
  normalizeDirectorPlan,
  type DirectorPlan,
  type DirectorReferenceContext
} from '../shared/director';
import type { EditableMap } from '../shared/map';
import type { AgentProgressEvent, ChatProvider } from '../shared/protocol';
import { parseLlmJsonObject } from './llmJson';
import { llmChat } from './modelApi';

export interface DirectorAgentOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  references?: DirectorReferenceContext;
  onProgress?: (event: AgentProgressEvent) => void;
}

export async function generateDirectorPlan(
  prompt: string,
  map: EditableMap,
  options: DirectorAgentOptions = {}
): Promise<DirectorPlan> {
  const cleanPrompt = prompt.trim().slice(0, 4_000);
  if (!cleanPrompt) throw new Error('missing_director_prompt');
  const references = options.references ?? createEmptyDirectorReferences();
  const system = buildDirectorSystemPrompt();
  const context = {
    userBrief: cleanPrompt,
    scene: summarizeDirectorMap(map),
    references: summarizeReferences(references)
  };
  let previous = '';
  options.onProgress?.({ phase: 'planning', label: '导演 Agent 正在理解剧情、镜头和角色调度' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    options.signal?.throwIfAborted();
    const content = await llmChat([
      { role: 'system', content: system },
      {
        role: 'user',
        content: attempt === 0
          ? JSON.stringify(context)
          : [
              'Repair the previous response into one valid DirectorPlan JSON object.',
              'Preserve the original user brief and scene facts. Do not return markdown.',
              `Previous response: ${previous}`
            ].join('\n')
      }
    ], {
      apiBase: options.apiBase,
      provider: options.provider ?? 'gpt',
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      temperature: 0.25,
      maxTokens: 6_000,
      onProgress: options.onProgress
    });
    previous = content;
    options.onProgress?.({ phase: 'validating', label: '检查镜头、时长、机位和演员走位' });
    try {
      const plan = normalizeDirectorPlan(parseLlmJsonObject(content, 'invalid_director_plan_json'), cleanPrompt, map.id);
      options.onProgress?.({ phase: 'complete', label: `CG 策划完成：${plan.shots.length} 个镜头` });
      return plan;
    } catch (error) {
      if (attempt === 1) throw error;
      options.onProgress?.({
        phase: 'replanning',
        label: '策划稿格式或镜头信息不完整，正在自动修正',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }
  throw new Error('invalid_director_plan');
}

export function summarizeDirectorMap(map: EditableMap): Record<string, unknown> {
  const assetsById = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  return {
    id: map.id,
    name: map.name,
    version: map.version,
    sceneMode: map.sceneMode,
    sizeMetres: map.box.size,
    playerHeightMetres: map.playerHeight,
    spawnPoints: map.spawnPoints.slice(0, 8),
    objects: map.objects.slice(0, 120).map((object) => ({
      id: object.id,
      name: object.name,
      asset: object.assetId ? assetsById.get(object.assetId)?.name ?? object.assetId : null,
      position: object.transform.position,
      visible: object.visible,
      behavior: object.behavior ? {
        kind: object.behavior.kind,
        locomotion: object.behavior.locomotion,
        animationState: object.behavior.animation?.state
      } : undefined
    })),
    guides: map.guides.slice(0, 60).map((guide) => ({
      id: guide.id,
      name: guide.name,
      tags: guide.tags,
      pointCount: guide.points.length
    })),
    assetCatalog: (map.assets ?? []).slice(0, 100).map((asset) => ({
      id: asset.id,
      name: asset.name,
      tags: asset.tags ?? [],
      sizeClass: asset.sizeClass,
      animation: asset.libraryMetadata?.tags?.filter((tag) => /character|creature|npc|animated/i.test(tag)) ?? []
    }))
  };
}

function summarizeReferences(references: DirectorReferenceContext): DirectorReferenceContext {
  return {
    markers: references.markers.slice(0, 64).map((marker) => ({ ...marker, description: marker.description?.slice(0, 300) })),
    cameras: references.cameras.slice(0, 24).map((camera) => ({ ...camera, description: camera.description?.slice(0, 300) })),
    screenshots: references.screenshots.slice(0, 24).map((shot) => ({ ...shot, description: shot.description?.slice(0, 300) }))
  };
}

function buildDirectorSystemPrompt(): string {
  return [
    'You are the WorldForge real-time cutscene Director Agent.',
    'The creator usually gives a short, direct Chinese description. Expand it into an executable production brief without changing the story.',
    'Think like a game cinematic director: split narrative beats into shots, choose precise camera height/framing/movement/lens/duration, and describe every actor movement in screen-readable terms.',
    'Use only scene objects and places present in the supplied scene context. Never invent a precise landmark, route, marker, camera pose, animation clip or screenshot that was not supplied.',
    'When exact staging or composition cannot be grounded, still make a useful provisional shot and add a referenceNeeds entry asking for a marker, camera, or screenshot.',
    'References are authoritative. Refer to supplied markers and cameras by their exact id in blocking or camera reference fields.',
    'Preserve numbered sections and subtitles from the user. Convert vague changes such as “normal duck height” into eye-level camera plans.',
    'Prefer direct cuts between substantially different viewpoints. Give every shot a clear dramatic purpose and a duration between 0.5 and 60 seconds.',
    'For every moving actor, include one blocking entry with actorId, from, via, to, action, facing and timing. Screen-relative directions may be used when no spatial marker exists, but request a marker when the final position matters.',
    'Lens guidance: 18-24mm environmental wide, 28-40mm natural movement, 50-70mm medium/close character coverage, 85mm+ compressed close-up. Avoid extreme lenses unless the brief asks for them.',
    'This stage plans a cutscene; it does not claim animation clips were generated or that the result is already playable.',
    'Return exactly one JSON object and no markdown. Use Chinese for all human-facing text.',
    'Required shape:',
    JSON.stringify({
      title: '演出标题',
      logline: '一句话剧情目标',
      sceneSummary: '按时间顺序说明完整演出',
      cast: [{
        id: 'actor-stable-id',
        name: '角色名称',
        role: '剧情职责',
        sourceObjectId: 'optional existing scene object id',
        appearance: '外观或状态',
        requiredActions: ['run', 'look-around']
      }],
      shots: [{
        id: 'shot-1',
        title: '镜头标题',
        purpose: '叙事目的',
        location: '已有地点或待标注位置',
        durationSeconds: 4,
        camera: {
          height: 'aerial | high | eye-level | low',
          framing: 'extreme-wide | wide | medium | close-up | over-shoulder | pov',
          movement: 'static | pan | tilt | dolly | tracking | orbit | crane | handheld | cut',
          lensMm: 35,
          direction: '机位、朝向、起止和运动说明',
          subject: '画面主体',
          startReferenceId: 'optional camera reference id',
          endReferenceId: 'optional camera reference id'
        },
        blocking: [{
          actorId: 'actor-stable-id',
          from: '起点或屏幕方向',
          via: ['optional marker ids'],
          to: '终点或屏幕方向',
          action: '动作和状态变化',
          facing: '结束朝向',
          timing: '相对镜头时间'
        }],
        action: '镜头内完整动作说明',
        dialogue: 'optional spoken dialogue',
        subtitle: 'optional subtitle',
        transition: 'cut | blend | match-cut | fade',
        notes: ['连续性或实现约束']
      }],
      assumptions: ['没有改变剧情的临时假设'],
      referenceNeeds: [{
        kind: 'marker | camera | screenshot',
        label: '需要补充的参考名称',
        reason: '为什么这能提高准确性',
        shotId: 'optional shot id'
      }]
    })
  ].join('\n');
}
