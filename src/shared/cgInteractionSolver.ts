import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { getObjectWorldTransforms, type MapObjectAabb } from './map';
import { buildPoseRig, evaluateRig, poseMatrix, rigLandmark } from './cgPoseEvaluator';
import { supportAt, type CgNavigationWorld } from './cgNavigation';
import type { CgAnchor, CgBinding, CgCompiledAction, CgDiagnostic, CgEntityState, CgQuat, CgVec3, CompiledCG } from './cgTypes';

/** Static box seats + explicitly bound contact rigs. A supplied pose is accepted
 * only after numeric contact, feet support and body clearance checks. */
export function solveSit(bundle: CompiledCG, binding: CgBinding, action: CgCompiledAction, state: CgEntityState, anchors: Map<string, CgAnchor>, world: CgNavigationWorld): CgDiagnostic[] {
  const diagnostics: CgDiagnostic[] = [];
  const error = (code: string, message: string) => diagnostics.push({ code, message, severity: 'error', nodeIds: [action.id] });
  const rig = binding.poseRig, interaction = action.interaction, clip = bundle.resources.clips.find(c => c.id === action.clipId);
  if (!rig?.contactProfile) { error('contact_profile_required', '坐下需要显式绑定臀/大腿接触点及双脚的模型 cgRig 配置。'); return diagnostics; }
  if (!interaction || !clip || clip.entityId !== action.entityId || clip.loop || Math.abs(clip.duration - action.duration) > 1e-4) { error('sit_clip_required', '坐下需要为当前角色烘焙、时长匹配且不循环的动作。'); return diagnostics; }
  if (state.posture === 'seated') { error('already_seated', '角色已经坐下；当前基础版不支持直接更换座位。'); return diagnostics; }
  const seatObject = bundle.map.objects.find(o => o.id === interaction.objectId), transform = getObjectWorldTransforms(bundle.map).get(interaction.objectId);
  const seatAsset = bundle.map.assets?.find(a => a.id === seatObject?.assetId);
  const approach = anchors.get(interaction.approachAnchorId);
  if (!seatObject?.visible || !transform || !seatAsset || !approach) { error('missing_seat', '座位对象、模型或接近点缺失。'); return diagnostics; }
  const seatEntity = bundle.bindings.find(b => b.objectId === seatObject.id);
  if (seatEntity && bundle.document.actions.some(a => a.entityId === seatEntity.entityId && ['move', 'face', 'animate', 'visibility'].includes(a.type))) { error('moving_seat_unsupported', '基础坐下交互只支持静止座位。'); return diagnostics; }
  if (new Vector3(...state.position).distanceTo(new Vector3(...approach.position)) > 0.06) { error('seat_approach_mismatch', '角色必须先沿可行走路线到达指定座位接近点。'); return diagnostics; }
  const seatRig = buildPoseRig(seatAsset.modelJson), seatNode = seatRig.nodes.find(n => n.id === interaction.seatNodeId), matrices = evaluateRig(seatRig);
  if (!seatNode?.bounds || seatNode.geometry !== 'box' || !/seat|坐|座/i.test(`${seatNode.id} ${seatNode.name}`)) { error('unsupported_seat_surface', '当前座面必须是有明确 seat 语义的箱体表面。'); return diagnostics; }
  const root = new Matrix4().compose(new Vector3(...transform.position), new Quaternion().setFromEuler(new Euler(...transform.rotation)), new Vector3(...transform.scale));
  const matrix = root.clone().multiply(matrices.get(seatNode.id)!), inverse = matrix.clone().invert();
  if (new Vector3(0, 1, 0).transformDirection(matrix).y < 0.999) { error('tilted_seat_unsupported', '基础坐下交互只支持水平座面。'); return diagnostics; }
  const localContact = new Vector3((seatNode.bounds.min[0] + seatNode.bounds.max[0]) / 2, seatNode.bounds.max[1], (seatNode.bounds.min[2] + seatNode.bounds.max[2]) / 2);
  const contact = localContact.applyMatrix4(matrix), facing = new Vector3(0, 0, 1).transformDirection(matrix);
  const finalRotation = new Quaternion().setFromEuler(new Euler(0, Math.atan2(facing.x, facing.z), 0));
  const localHip = rigLandmark(rig, 'hips', clip, clip.duration)!;
  const finalPosition = contact.clone().sub(new Vector3(...localHip).multiply(new Vector3(...state.scale)).applyQuaternion(finalRotation));
  if (new Vector3(...state.position).distanceTo(finalPosition) > Math.max(2, binding.height)) { error('sit_warp_too_large', '接近点距入座姿态太远，不能用坐下动作代替行走。'); return diagnostics; }
  const finalPose = { position: finalPosition.toArray() as CgVec3, quaternion: finalRotation.toArray() as CgQuat, scale: state.scale };
  for (const foot of ['leftFoot', 'rightFoot'] as const) {
    const p = new Vector3(...rigLandmark(rig, foot, clip, clip.duration)!).applyMatrix4(poseMatrix(finalPose));
    const support = supportAt(world, p.x, p.z, p.y, 0);
    if (!support || Math.abs(p.y - support.point[1]) > 0.06) error('seated_foot_support', '坐姿脚部与支撑面的误差超出 6 厘米；需要匹配动作或调整座位配置。');
  }
  const seatBounds = seatNode.bounds;
  // Require a usable seat footprint for the actor, rather than a named point.
  const actorHalfWidth = Math.max(0.1, binding.height * 0.10);
  const sx = new Vector3().setFromMatrixColumn(matrix, 0).length(), sz = new Vector3().setFromMatrixColumn(matrix, 2).length();
  if ((seatBounds.max[0] - seatBounds.min[0]) * sx < actorHalfWidth * 2 || (seatBounds.max[2] - seatBounds.min[2]) * sz < binding.height * 0.14) error('seat_too_small', '座面尺寸不足以容纳当前角色。');
  const seatParts = seatRig.nodes.filter(n => n.bounds).map(n => ({ id: n.id, bounds: new Box3(new Vector3(...n.bounds!.min), new Vector3(...n.bounds!.max)).applyMatrix4(root.clone().multiply(matrices.get(n.id)!)) }));
  const otherBoxes: MapObjectAabb[] = world.boxes.filter(b => b.objectId !== seatObject.id);
  const fps = 30, count = Math.ceil(action.duration * fps), positions: CgVec3[] = [], rotations: CgQuat[] = [];
  for (let i = 0; i <= count; i++) {
    const t = Math.min(action.duration, i / fps), u = t / action.duration, blend = u * u * (3 - 2 * u);
    const position = new Vector3(...state.position).lerp(finalPosition, blend), rotation = new Quaternion(...state.quaternion).slerp(finalRotation, blend);
    positions.push(position.toArray()); rotations.push(rotation.toArray());
    const pose = new Matrix4().compose(position, rotation, new Vector3(...state.scale)), nodes = evaluateRig(rig, clip, t);
    for (const node of rig.nodes) if (node.bounds) {
      const box = new Box3(new Vector3(...node.bounds.min), new Vector3(...node.bounds.max)).applyMatrix4(pose.clone().multiply(nodes.get(node.id)!));
      const overlaps = (b: Box3, tolerance: number) => box.min.x < b.max.x - tolerance && box.max.x > b.min.x + tolerance && box.min.y < b.max.y - tolerance && box.max.y > b.min.y + tolerance && box.min.z < b.max.z - tolerance && box.max.z > b.min.z + tolerance;
      if (seatParts.some(p => overlaps(p.bounds, p.id === seatNode.id ? 0.035 : 0.015)) || otherBoxes.some(b => overlaps(new Box3(new Vector3(...b.min), new Vector3(...b.max)), 0.015))) { error('sit_body_collision', '坐下过程穿过座椅或周围几何，不能确认该交互。'); break; }
    }
    if (diagnostics.some(d => d.code === 'sit_body_collision')) break;
  }
  const finalHip = new Vector3(...localHip).applyMatrix4(poseMatrix(finalPose));
  const point = finalHip.clone().applyMatrix4(inverse);
  if (finalHip.distanceTo(contact) > 0.035 || point.x < seatBounds.min[0] || point.x > seatBounds.max[0] || point.z < seatBounds.min[2] || point.z > seatBounds.max[2]) error('seat_contact_error', '最终接触点未落在座面内。');
  const finalNodes = evaluateRig(rig, clip, clip.duration), finalRoot = poseMatrix(finalPose);
  const hasBodySupport = rig.nodes.some(node => {
    if (!node.bounds) return false;
    const box = new Box3(new Vector3(...node.bounds.min), new Vector3(...node.bounds.max)).applyMatrix4(finalRoot.clone().multiply(finalNodes.get(node.id)!));
    return Math.abs(box.min.y - contact.y) <= 0.035 && contact.x >= box.min.x - 0.035 && contact.x <= box.max.x + 0.035 && contact.z >= box.min.z - 0.035 && contact.z <= box.max.z + 0.035;
  });
  if (!hasBodySupport) error('seat_body_support_missing', '虽然标记点对齐，实际身体几何没有接触座面。');
  if (!diagnostics.length) {
    action.rootSamples = { fps, positions, rotations };
    action.contact = { objectId: seatObject.id, nodeId: seatNode.id, position: contact.toArray(), rootPosition: finalPosition.toArray(), rootQuaternion: finalRotation.toArray(), tolerance: 0.035 };
    action.from = [...state.position]; action.to = finalPosition.toArray(); action.endBehavior = 'hold';
  }
  return diagnostics;
}
