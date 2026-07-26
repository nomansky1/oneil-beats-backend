# Voxel car pack — import and use

Covers **VOXEL RACING CAR ASSETS** by VoxelGameAssets (itch.io, purchased 2026-07-26).
29 chassis colour variants, 30 wheel sets, VoxEdit-exported OBJ + MTL + PNG palette.

Measured from the pack itself, not assumed:

| | Value | Budget | |
|---|---|---|---|
| Chassis | 6,174 tris, 12,348 verts | 3k–8k | ✅ |
| Wheel | 1,100 tris | 200–1500 | ✅ |
| Chassis texture | 256×256 palette | 512–1024 | ✅ |
| Wheel texture | 64×32 palette | 512–1024 | ✅ |
| Full vehicle | ~10,600 tris (chassis + 4 wheels) | — | fine for mobile |

At the pack's native voxel units the chassis is 215 × 105 × 47 and a wheel is 35 across.

---

## Scale: 1 voxel = 2 cm

`VoxelAssetPostprocessor.VoxelToMetres = 0.02`. That produces:

- Chassis **4.30 m long, 2.10 m wide, 0.94 m tall** — a real sports car
- Wheel **0.70 m diameter, 0.30 m wide**

This wasn't picked to be tidy; it's what makes the models come out life-sized, and the
chassis and wheels agree with each other at that factor. Changing it means re-tuning the
physics, because wheel radius feeds both the suspension raycast and the ride height.

The models are already **Y-up**, which matches Unity, so no axis conversion is needed.

---

## Import: put them under a `Voxel` folder

Anything under a folder named `Voxel` — e.g.
`Assets/_Project/Art/Voxel/Cars/` — gets the right settings applied automatically by
`Editor/VoxelAssetPostprocessor.cs`. Drop the pack in and it's handled.

### Why voxel needs different settings

Every Unity default is wrong for this art, and two of them are wrong in ways that look
like the asset is bad rather than like a settings problem:

- **Filter Mode → Point.** These textures are palette strips where one pixel is a whole
  car panel. Bilinear filtering blends neighbouring palette entries, so a red car picks
  up a smear of whatever colour sits beside red in the strip. Every panel edge goes muddy.
- **Compression → None.** Does the same damage, permanently. Affordable here precisely
  because the textures are tiny — a 256×256 uncompressed palette is 256 KB.
- **Mipmaps → off.** Distance mips average palette entries together, so cars change
  colour as they drive away from the camera.
- **Wrap Mode → Clamp.** A repeating palette samples the far end of the strip at the
  edges and produces stray colours along seams.
- **Normal smoothing angle → 0.** Voxel art wants hard, faceted shading. Unity's default
  rounds lighting across voxel corners and the blocky look goes soft and waxy.

---

## Building a car: `Raceland → Build Buggy From Voxel Assets`

Drag in one chassis `.obj` and one wheel `.obj`, press Build. Everything else — wheel
radius, wheelbase, track width, ride height, spring rate, damping, centre of mass — is
measured from those two models rather than hardcoded, so swapping chassis doesn't
silently leave the physics tuned for the old one.

Tick **Replace buggy in scene** and it also re-points the chase camera and race manager
at the new vehicle.

### The wheel pivot problem

VoxEdit exports with the origin at the corner of the bounding box, not at the axle.
`WheelVisual` rotates each wheel about its pivot — so an uncorrected wheel **orbits a
point on the ground instead of spinning**. It looks like the wheels have come loose.

The builder nests the wheel mesh under a pivot object and offsets it by minus its own
bounds centre, putting the axle exactly on the pivot. Left-hand wheels also get a 180°
yaw so any asymmetric rim detail faces outward on both sides.

If you ever wire a wheel up by hand, this is the step people miss.

### Spring rates are solved, not guessed

The builder computes:

```
springStrength = (mass / 4) × gravity / (restLength × staticCompression)
springDamper   = dampingRatio × 2 × √(springStrength × mass / 4)
```

So "25% static compression, 0.5 damping ratio" stays true at any mass or wheel size.
Raise mass and the spring stiffens to match instead of the car sinking onto its bump
stops. Console prints the resulting numbers on every build.

---

## What this pack does NOT cover

| Brief asset | Covered? |
|---|---|
| 1. Hero vehicle | ✅ chassis (29 variants) |
| 2. Wheels | ✅ 30 sets |
| 3. Boost ramp | ❌ |
| 4. Jump kicker | ❌ |
| 5. Destructible obstacles | ❌ |
| 6. Track segment | ❌ |
| 7. Environment prop | ❌ |
| 8. Skybox | ❌ |

Assets 3–8 are still grey boxes from the scene builder.

**No Bang Parts.** Each chassis is a single mesh with no separable panels, so there is
nothing to tear off. `VoxelBuggyBuilder` deliberately does not add `DamageableBody` —
adding it with an empty panel list would do nothing and just look like a bug.

The damage system still works and is still wired for it; it needs a chassis authored in
separable pieces. Options: split one chassis in Blender along panel lines, or generate
the hero vehicle with Rodin Bang Parts as originally planned and keep the voxel pack for
opponent/variant cars.

---

## Licence — check before shipping

**The zip contains no licence file.** No `LICENSE`, no readme, no terms — only meshes,
materials and textures. I can't tell you what the licence permits, and I'm not going to
guess on a question that matters commercially.

Two things to confirm on the itch.io product page (or by emailing VoxelGameAssets):

1. **Multi-project use.** This pack is planned for Raceland *and* a second racing game.
   Many itch.io asset licences cover unlimited projects by the purchaser; some are
   per-project or per-title. Worth two minutes to check rather than finding out later.
2. **Attribution.** Some packs require crediting the author in-game or in the store
   listing. If so, it goes in the credits screen before release.

Keep a copy of the purchase receipt and licence text with the project.
