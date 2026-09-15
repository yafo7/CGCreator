---
name: cg-spatial-direction
description: Ground CGCreator staging, actor routes, camera paths, and view descriptions in a WorldForge semantic index and measured Three.js observations.
---

# CGCreator spatial direction

V2 map_guide and map_seat anchors may contain semantic bindings. Copy them verbatim; they re-resolve after synchronization. A user world anchor without a binding stays fixed. Required road movement must remain within the actor-radius-adjusted guide corridor, reach supported surfaces and use a real gait clip. A sit needs a static named box seat, an explicit cgRig contact profile, a model-matched non-looping clip and arrival at the approach anchor; the solver checks contact and support. A sit persists until the end of this basic release. Do not claim arbitrary model rigging, stand transitions or foot IK exists.

Read `worldUnderstanding` (cg-world-2) before directing: sceneIntent, completeness, issues, exact spatial.shape and full designSemantics. Region bounds and representative points are not entrances, seats or navigation proofs. Keep source-boundary separate from sampled-curve, object-envelope, density-envelope and terrain-mask. Use typed entry-via, exit-via, axis-via and membership relations; geometric origin-in-region is not whole-object containment.

For missing detail return only `{ "worldQueries": [...] }` before the final document or scoped patch. Supported read-only requests are summary, resolve(text), inspect(semanticId), and point(position:[x,z]). At most 6 queries per round and 3 rounds. Use the returned sourceHash consistently. Report unknown/deleted regions and ambiguous matches; never substitute the world origin. Grass point queries measure density; water point queries include terrain clipping. Local model node positions are not world sockets. The current map snapshot, not an older confirmed bundle, owns planning facts after synchronization.

Use the current `WorldSemanticIndex` as scene truth before planning a location, route, interaction, or camera. Resolve the user's nouns to stable semantic IDs: WorldForge groups, focuses, zones, guides, water, grass and placed objects describe geography; each placed asset exposes its 3d-generate model-part hierarchy beneath `object:<id>/node:<id>`.

Prefer authored semantics over generated semantics, and generated semantics over derived geometry. Preserve source and confidence when reporting ambiguity. Do not infer that an object is a pavilion, seat, entrance, face, tree or path from coordinates alone when named data exists. If several entities match, choose using group membership, focus rank, route adjacency and the requested action; surface unresolved ambiguity instead of silently inventing a location.

Plan blocking with stable anchors and high-level actions. Let the compiler find a collision-safe ground path. Ordered `action-route` constraints are user-authored pass-through points, while `action-target` fixes the endpoint. `camera-path` constraints fix ordered camera positions while semantic aim and composition continue to determine orientation. An exact `camera-pose` and a camera path cannot own the same shot.

Use `CgViewObservation` only as mechanical evidence at a specified time and viewport. It can establish which object bounds intersect the frame, screen region, approximate coverage, sampled visibility and likely occluder IDs. It does not prove that a composition is attractive or that every triangle and model part is visible. Review start, middle, end and cuts; use observed occlusion or weak coverage to revise the smallest relevant camera or staging node.

When the user drags a route or camera control point, preserve the resulting anchor and hard constraint exactly. AI refinement may explain or work around it but cannot move, delete or weaken it. Keep automatic compiled paths out of `DirectorDocument`; only user decisions become stable control-point constraints.
