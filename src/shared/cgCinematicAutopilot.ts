import type { CgAnchor, DirectorDocument } from './cgTypes';
import type { EditableMap } from './map';

/**
 * A deterministic recovery planner for a small set of cinematic beats that
 * have a complete executable implementation. It is intentionally narrow: it
 * never invents a world coordinate and only consumes anchors supplied by the
 * current WorldForge snapshot.
 */
export function canAutoplanCinematic(prompt: string): boolean {
  return /飞身|飞跃|屋顶|房顶/i.test(prompt)
    && /桥|bridge/i.test(prompt)
    && /剑|sword/i.test(prompt)
    && /递|交给|交接|give|handoff/i.test(prompt);
}

export function createCinematicAutopilotPlan(input: {
  map: EditableMap;
  previous: DirectorDocument;
  prompt: string;
  anchors: CgAnchor[];
}): DirectorDocument | null {
  if (!canAutoplanCinematic(input.prompt)) return null;
  const byId = new Map(input.anchors.map(anchor => [anchor.id, anchor]));
  const find = (pattern: RegExp, suffix?: ':top' | ':side'): CgAnchor | undefined =>
    input.anchors.find(anchor => pattern.test(anchor.name) && anchor.id.startsWith('map_surface:') && (!suffix || anchor.id.endsWith(suffix)))
      ?? input.anchors.find(anchor => pattern.test(anchor.name));
  const roof = find(/屋顶|房顶|roof|主厅|厅堂|楼阁|房屋|亭|hall|house|pavilion/i, ':top');
  const bridge = find(/桥|bridge/i, ':top');
  const bridgeSide = find(/桥|bridge/i, ':side') ?? bridge;
  const treeSides = input.anchors.filter(anchor => anchor.id.startsWith('map_surface:') && anchor.id.endsWith(':side') && /树|树林|forest|tree/i.test(anchor.name));
  const start = treeSides[0] ?? byId.get('map_stage_start');
  const end = treeSides.find(anchor => anchor.id !== start?.id) ?? byId.get('map_stage_end');
  if (!roof || !bridge || !bridgeSide || !start || !end) return null;
  // Keep only source-provided anchors. This lets the normal planning guard
  // prove every position came from the map snapshot.
  const anchors = [...new Map([roof, bridge, bridgeSide, start, end].map(anchor => [anchor.id, structuredClone(anchor)])).values()];
  return {
    schemaVersion: 2,
    id: input.previous.id,
    mapId: input.map.id,
    revision: input.previous.revision + 1,
    seed: input.previous.seed,
    title: `${input.map.name} · 桥上交剑`,
    sourcePrompt: input.prompt,
    entities: [
      { id: 'hero', name: '侠客', kind: 'actor', assetId: 'auto-hero', startAnchorId: roof.id, height: 1.8, description: '穿深色古装的年轻侠客' },
      { id: 'heroine', name: '古风美女', kind: 'actor', assetId: 'auto-heroine', startAnchorId: bridgeSide.id, height: 1.7, description: '穿浅色古装的年轻女子' },
      { id: 'maid-one', name: '侍女一', kind: 'actor', assetId: 'auto-maid', startAnchorId: start.id, height: 1.58, description: '穿朴素古装的侍女' },
      { id: 'maid-two', name: '侍女二', kind: 'actor', assetId: 'auto-maid', startAnchorId: end.id, height: 1.58, description: '穿朴素古装的侍女' },
      { id: 'sword', name: '佩剑', kind: 'prop', assetId: 'auto-sword', startAnchorId: roof.id, height: 1.05, description: '一把带黑色剑柄的古风长剑' }
    ],
    anchors,
    actions: [
      { id: 'sword-on-back', entityId: 'sword', type: 'attach', targetEntityId: 'hero', socketId: 'back', start: { kind: 'absolute', seconds: 0 }, duration: 0, purpose: '剑挂在侠客背后' },
      { id: 'hero-arrival', entityId: 'hero', type: 'airborne', targetAnchorId: bridge.id, arcHeight: 3.2, start: { kind: 'absolute', seconds: 0 }, duration: 3.6, purpose: '侠客从屋顶飞身落到桥中心' },
      { id: 'hero-flight-body', entityId: 'hero', type: 'animate', clipId: 'clip-hero-flight', start: { kind: 'with', id: 'hero-arrival' }, duration: 3.6, purpose: '屈膝起跳，在空中舒展身体，最后屈膝落地站稳' },
      { id: 'hero-offer-sword', entityId: 'hero', type: 'animate', clipId: 'clip-hero-offer', propEntityId: 'sword', start: { kind: 'after', id: 'hero-arrival', offset: 0.25 }, duration: 2.8, purpose: '右手伸到肩后握住剑柄，将剑取到身前递向面前的人，停留后松手收回' },
      { id: 'heroine-take-sword', entityId: 'heroine', type: 'animate', clipId: 'clip-heroine-take', propEntityId: 'sword', start: { kind: 'with', id: 'hero-offer-sword' }, duration: 2.8, purpose: '伸出右手接住面前的剑，握稳后收回身前' },
      { id: 'sword-to-hand', entityId: 'sword', type: 'attach', targetEntityId: 'hero', socketId: 'right-hand', start: { kind: 'with', id: 'hero-offer-sword', offset: 0.75 }, duration: 0, purpose: '侠客握住剑柄，将剑从背部取下' },
      { id: 'sword-handoff', entityId: 'sword', type: 'handoff', sourceEntityId: 'hero', targetEntityId: 'heroine', socketId: 'right-hand', start: { kind: 'with', id: 'hero-offer-sword', offset: 1.1 }, duration: 1.4, purpose: '剑在双方手部接触后从侠客交到女子手中' },
      { id: 'maid-one-watch-motion', entityId: 'maid-one', type: 'animate', clipId: 'clip-maid-one-watch', start: { kind: 'absolute', seconds: 0 }, duration: 8.6, purpose: '站在原地，身体保持自然，转头看向桥上的两个人' },
      { id: 'maid-two-watch-motion', entityId: 'maid-two', type: 'animate', clipId: 'clip-maid-two-watch', start: { kind: 'absolute', seconds: 0 }, duration: 8.6, purpose: '站在原地，身体保持自然，转头看向桥上的两个人' },
      { id: 'maids-watch', entityId: 'maid-one', type: 'hold', start: { kind: 'absolute', seconds: 0 }, duration: 8.6, purpose: '两个侍女在远处树下旁观' },
      { id: 'maid-two-watch', entityId: 'maid-two', type: 'hold', start: { kind: 'absolute', seconds: 0 }, duration: 8.6, purpose: '两个侍女在远处树下旁观' },
      { id: 'final-reveal', entityId: 'hero', type: 'hold', start: { kind: 'after', id: 'sword-handoff' }, duration: 2.25, purpose: '镜头升起，揭示远处树下的两个侍女' }
    ],
    shots: [], constraints: structuredClone(input.previous.constraints), worldPatch: []
  };
}
