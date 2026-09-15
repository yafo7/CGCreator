import type { CgBinding, CgClip, CgDiagnostic } from './cgTypes';
import { stableHash } from './cgValidation';

export function validateMotion(clip: CgClip | undefined, binding: CgBinding, model: unknown, actionId: string): CgDiagnostic[] {
  const diagnostics: CgDiagnostic[] = [];
  const fail = (code: string, message: string) => diagnostics.push({ code, message, severity: 'error', nodeIds: [actionId, clip?.id ?? 'missing-clip'] });
  if (!clip) { fail('missing_clip', '行为缺少实际烘焙动画。'); return diagnostics; }
  if (clip.entityId !== binding.entityId || clip.modelHash !== stableHash(model)) fail('clip_model_mismatch', '动画与当前角色或模型内容不匹配。');
  if (clip.rootMotion !== 'in-place' || !Number.isFinite(clip.duration) || clip.duration <= 0 || !Number.isFinite(clip.fps) || clip.fps < 1 || clip.fps > 240 || !clip.tracks || !Object.keys(clip.tracks).length) { fail('invalid_clip', '无效的烘焙动画元数据。'); return diagnostics; }
  const nodes = new Map((binding.poseRig?.nodes ?? []).map(n => [n.id, n]));
  for (const [id, track] of Object.entries(clip.tracks)) {
    if (!nodes.has(id)) fail('missing_clip_node', `动画节点 ${id} 不在模型中。`);
    if (!track || typeof track !== 'object' || !Object.keys(track).length) { fail('invalid_clip_samples', '动画轨道为空。'); continue; }
    for (const [channel, samples] of Object.entries(track)) {
      if (!['position', 'rotation', 'quaternion', 'scale'].includes(channel) || !Array.isArray(samples) || samples.length < 2 || Math.abs(samples.length - (Math.ceil(clip.duration * clip.fps) + 1)) > 1 || samples.some(p => !Array.isArray(p) || p.length !== (channel === 'quaternion' ? 4 : 3) || !p.every(Number.isFinite) || channel === 'quaternion' && Math.abs(Math.hypot(...p) - 1) > 0.001 || channel === 'scale' && p.some(v => v <= 0))) fail('invalid_clip_samples', `动画节点 ${id} 的采样无效。`);
    }
    if (!nodes.get(id)?.parent && track.position?.some(p => Array.isArray(p) && (Math.abs(p[0]) > 1e-5 || Math.abs(p[2]) > 1e-5))) fail('duplicate_root_motion', '局部动画不能同时拥有根节点 X/Z 位移。');
  }
  if (clip.locomotion && (!['walk', 'run'].includes(clip.locomotion.kind) || ![clip.locomotion.nominalSpeed, clip.locomotion.minRate, clip.locomotion.maxRate].every(v => Number.isFinite(v) && v > 0) || clip.locomotion.maxRate < clip.locomotion.minRate)) fail('invalid_locomotion_profile', '步态速度配置无效。');
  return diagnostics;
}
