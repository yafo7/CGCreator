/**
 * Executable prompt contract for the camera planner. It distils the project's
 * cinematography and continuity skills into the subset the compiler supports.
 */
export const CG_CAMERA_GRAMMAR = {
  coordinateFrames: {
    subjectMotion: 'Use for travel. side/rear/rear-three-quarter remain relative to the performer as the route turns.',
    subjectFacing: 'Use for reactions and stationary performance.',
    interactionAxis: 'Use for two-subject coverage and preserve one side of their axis.',
    world: 'Use only when the map itself supplies the meaningful direction.'
  },
  beats: {
    travelContext: { framing: 'wide', movement: 'tracking', reference: 'subject-motion', views: ['side', 'rear-three-quarter'], aim: 'body' },
    travelDestination: { framing: 'wide', movement: 'tracking', reference: 'subject-motion', views: ['rear', 'rear-three-quarter'], aim: 'body' },
    movingEmotion: { framing: 'medium', movement: 'tracking', reference: 'subject-motion', views: ['front-three-quarter'], aim: 'upper-body', requiresExplicitEmotionReason: true },
    reaction: { framing: 'close-up', movement: 'static', reference: 'subject-facing', views: ['front-three-quarter', 'front'], aim: 'eyes', lensMm: [70, 100] },
    physicalInteraction: { framing: 'medium', movement: 'tracking', reference: 'subject-facing', views: ['side', 'front-three-quarter'], aim: 'upper-body' },
    dialogue: { framing: 'over-shoulder', movement: 'static', reference: 'interaction-axis', views: ['front-three-quarter'], aim: 'face' }
  },
  sequencing: [
    'Establish geography before close coverage unless withholding geography is the dramatic point.',
    'Preserve travel screen direction across a cut until a turn is shown or a re-establishing shot resets it.',
    'Adjacent shots of the same subject must change by at least 30 degrees or change framing size.',
    'Motivate cuts on action, look, reaction, reveal, re-establishing geography or deliberate rhythm.',
    'Use a cut for a decisive change of attention or size; use ease-in-out only for a motivated continuous handoff.'
  ],
  closeUp: [
    'Aim at the named face or eyes landmark, not a percentage of generic object height.',
    'Use subject eye level, including for children and seated actors.',
    'Prefer 70-100mm and derive distance from semantic face height; avoid close wide-angle face distortion.',
    'Keep the full face readable through the shot and reject an occluded or cropped semantic target.'
  ]
} as const;

export const CG_CAMERA_GRAMMAR_PROMPT = `Cinematography grammar (apply it to every shot):\n${JSON.stringify(CG_CAMERA_GRAMMAR)}`;
