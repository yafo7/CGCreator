---
name: cg-camera-direction
description: Author semantic camera intent for CGCreator shots, grounded in the current WorldForge map and immutable user camera constraints.
---

# CGCreator camera direction

This is original project guidance informed by the sources listed in `../../docs/cgcreator-sources.md`. It is not a copied or vendored third-party skill bundle.

Use when planning or refining a CGCreator camera shot. First inspect the entity IDs, their bounds, the scene geometry, current shot, and user constraints. Express intent in `CgCameraIntent`; do not author arbitrary keyframes.

- Choose an existing subject ID and, for over-shoulder, a second distinct existing entity ID. Describe why the audience needs this view in the shot purpose.
- Select only supported movements: static, dolly, tracking, orbit. Framing is wide, medium, close-up, or over-shoulder. A requested crane or more complex move requires an explicit capability extension or unsupported diagnostic.
- State the reference frame, view, and aim. Travel uses `subject-motion` with `side`, `rear-three-quarter`, or `rear`; use a moving front view only when the purpose explicitly requires reading the face. Reactions use `subject-facing`. Two-person coverage uses `interaction-axis` and stays on one side.
- Start with geography, preserve screen direction, and change camera angle by at least 30 degrees between same-size shots. Give every cut or continuous handoff a motivation: action, look, reaction, reveal, re-establishing geography, or rhythm.
- Close-ups aim at `face` or `eyes`, use actor eye level, and normally use 70–100mm. Let the compiler derive distance from the named head hierarchy; a proportional fallback must be reported for review.
- Derive framing distance and target height from actor scale and semantic landmarks. WorldForge uses metres, Y-up, and quaternion poses; never paste Unreal Z-up centimetre coordinates.
- Keep camera position interpolation and view orientation consistent. Target-based camera intent is resolved by the compiler against actor state at the requested absolute time.
- User camera pose constraints override automatic positioning, orientation, and lens. Do not adjust the pose to hide a collision or improve composition. Explain conflicts through diagnostics.
- A camera-only refinement preserves actor movement, resource IDs, and unrelated shots. Keep stable shot IDs. Timing changes invalidate dependent nodes rather than regenerating the story.
- Validate geometry and preview the beginning, middle, end, and cuts. A mathematically valid pose still needs human visual approval for composition.

The skill supplies directing guidance; `cgCompiler` is responsible for solving geometry, enforcing constraints, and producing deterministic playback.
