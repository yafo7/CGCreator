/** Public negotiation surface. A skill may recommend only capabilities enabled here. */
export const CG_CAPABILITIES = {
  schemaVersion: 1,
  version: 'cgcreator-0.2.0',
  coordinateSystem: { up: 'Y', unit: 'metre', cameraRotation: 'quaternion', cameraFov: 'vertical-degrees' },
  camera: {
    movements: ['static', 'dolly', 'tracking', 'orbit'],
    framings: ['wide', 'medium', 'close-up', 'over-shoulder'],
    references: ['world', 'subject-facing', 'subject-motion', 'interaction-axis'],
    views: ['front', 'front-three-quarter', 'side', 'rear-three-quarter', 'rear'],
    aims: ['body', 'upper-body', 'face', 'eyes', 'interaction'],
    transitions: ['cut', 'ease-in-out'],
    authoredAspectRatio: '16:9'
  },
  actions: ['move', 'face', 'animate', 'visibility', 'effect'],
  effects: ['spark'],
  constraints: ['entity-position', 'action-target', 'camera-pose', 'action-time', 'shot-duration'],
  timing: ['absolute', 'after', 'with'],
  animation: { format: 'baked-node-tracks', rootMotion: 'in-place' },
  worldOperations: ['object.add', 'object.update', 'object.remove', 'terrain.set', 'terrain.brush', 'room.set', 'sun.set', 'reference.set'],
  unsupported: ['attach', 'detach', 'ik-contact', 'lip-sync', 'crane', 'generic-vfx'],
  limits: { entities: 64, shots: 128, actions: 512, anchors: 256, constraints: 512, worldOperations: 256 },
  evaluation: 'absolute-time',
  ambientPlayback: 'frozen'
} as const;
