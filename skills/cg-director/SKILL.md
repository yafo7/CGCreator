---
name: cg-director
description: Plan or refine a structured, editable CGCreator realtime cutscene from story intent and a WorldForge scene snapshot.
---

# CGCreator director

For new projects use DirectorDocument schemaVersion 2. Actions are the authoritative high-level performance plan: road-constrained move (with its own gait clip), dialogue staging, sit, hold and the existing primitives. V2 action times reference actions, never camera shots. Return shots:[] for a new performance; the service creates stable coverage slots, validates the solved performance, then asks for camera-only coverage choices. Never hide a behavior failure with a different camera. Read `../cg-spatial-direction/SKILL.md` for location and contact limits and the registered camera skill catalog supplied by the service. Unsupported stand/IK/speech remains unsupported.

Read the current project before changing it: map snapshot, semantic entities, resources, DirectorDocument revision, hard constraints, candidate validation, and confirmed bundle identity.

Use `cg-spatial-direction` when the request depends on named locations, model parts, actor routes, camera paths, or what a camera currently sees.

1. Ground every reference in a stable map object, asset, entity, anchor, shot, or action ID. Request missing models or clips with descriptions through the resource adapter. Never invent an already available resource.
2. Produce a `DirectorDocument` with separate shot and action lists. A shot expresses purpose, framing, subject, movement, and duration. Actions express movement, facing, in-place animation, visibility, and supported effects with absolute or relative timing.
3. Keep scene modifications in `worldPatch`. They apply to the CG snapshot. Preserve the source WorldForge map.
4. Compile resources and intent, then validate, preview, and confirm the same compiled identity. Generation failures and constraint conflicts leave the previous confirmed version available.
5. Refine with typed scoped operations against the current revision. Retain stable IDs. AI cannot remove or rewrite user constraints or change their anchors. Request a clear manual unlock when an instruction cannot coexist with an existing lock; do not silently weaken either instruction.

Determinism means the same frozen input resolves to the same semantic frame at time t, including seeking backwards. It does not promise identical GPU pixels across devices. Ambient WorldForge animations are frozen in CG playback; supported actor and effect motion is evaluated by the CG clock.

V1 excludes verified socket attachment, IK contact solving, lip sync, complex particle systems, and automatic artistic approval. Return actionable unsupported diagnostics where these are required.
