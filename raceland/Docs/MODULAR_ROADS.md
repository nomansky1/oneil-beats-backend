# Modular road kit — Atomic Realm

Covers **Modular Roads** by Atomic Realm (itch.io): Bridges, Road Signs and Parking
add-ons. 389 OBJ modules plus FBX/GLB/DAE and `.blend` sources in the SOURCE zips.

---

## ⚠️ Licence: the assets must not be committed

The pack ships an explicit licence (`2. License.png`):

> ✅ You **can** use the assets in commercial and non commercial projects.
> ✅ You **can** edit assets and use them in commercial and non commercial projects.
> ❌ You **can't** repackage, resell or redistribute the assets *(no matter how much
> they are modified)*.

**This repository is public.** Committing the meshes or textures publishes them to
anyone who visits — that is redistribution, and the licence forbids it regardless of
how much they've been edited.

So: the import rules and builders in `Assets/_Project/Editor/` are ours and are
committed. The assets are not. `.gitignore` blocks these paths so they can't be pushed
by accident:

```
/Assets/_Project/Art/ModularRoads/
/Assets/_Project/Art/Voxel/
/Assets/_Project/Art/Rodin/
```

Drop the packs into those folders locally and Unity imports them with the correct
settings automatically.

The same caution applies to the voxel car pack, which ships **no licence file at all** —
absent written terms, assume redistribution is not permitted.

Commercial use in both Raceland and the second racing game is fine: the licence says
"projects", plural, with no per-title limit. Keep the purchase receipt and the licence
image with your records.

---

## What's in it

| | |
|---|---|
| Modules | 389 OBJ (also FBX, GLB, DAE, and `.blend` in the SOURCE zips) |
| Triangles | 28 min / **46 median** / 664 max |
| Scale | **1 unit = 1 metre**, already correct |
| Grid | **12 × 12 m tiles** |
| Pivots | centred in X/Z, base at Y = 0 |
| Textures | 1024 PNG |

Road tiles live in the **Parking** zip, not a base road zip: `Road1` (straight),
`Road1_Curve1`–`4` (four radii), `Road10_90angle_Corner`, `Road2_T`, `Road2_X`,
`Road3_Crossing`, `Road6_CornerL`/`R`, `Road6_End`, shoulders and medians. Bridges adds
arches, beams, a suspension bridge and ramps. Road Signs adds 150 sign modules.

This kit is far better authored than the voxel pack — correct scale, centred pivots,
consistent grid. Almost nothing needs correcting on import, which is why
`ModularRoadPostprocessor` mostly just avoids breaking it.

The one substantive change it makes: **colliders are generated**. The buggy's suspension
raycasts against the road, so tiles need real collision geometry. At a median of 46
triangles a mesh collider is cheap, and a box would flatten every kerb and camber.

---

## Building a circuit

**Raceland → Build Track From Modular Road Kit**

Drag in a straight (`Road1`) and a 90° corner (`Road10_90angle_Corner`), set the side
lengths, press Build.

The grey-box track this replaces is a parametric curve with arbitrary segment lengths —
fine for boxes, useless for a modular kit, because tiles only line up on the grid at
multiples of 90°. So the builder walks a rectangular loop cell by cell instead: N
straights, a corner, M straights, a corner. A rectangle isn't the most interesting
layout, but it is **guaranteed to close**, which a hand-placed loop very often isn't.
The four sides provably sum to zero displacement at any size, in either direction.

The walk records the centre and heading of every tile, so the start line, four
checkpoints and three boost pads are placed against the real racing line — on straights
only, since a gate on a corner is both hard to hit and hard to respawn onto facing the
right way. The RaceManager is rewired automatically.

### If the corners don't line up

Step **Corner rotation** by 90 and rebuild. The kit's corner tile connects two specific
edges and which two depends on how it was authored — I had no way to view the mesh, so
the builder exposes the offset rather than guessing and baking in a wrong answer.

### Not yet used

`Road1_Curve1`–`4` give sweeping corners at four radii, which would drive far better
than 90° hairpins. They need a smarter path walker than a rectangle — worth doing once
the basic loop is confirmed working in-engine.
