# Asset pipeline — Rodin → Blender → Unity

Nothing in this document has been executed. No Rodin generation, no Blender processing,
no inventory scan — the container this project was written in had none of those tools and
no access to the Downloads folder or the Unity Asset Store library. This is the process
written down and wired into the project, ready to run.

The Unity side of it **is** in place: the import rules in
`Assets/_Project/Editor/RodinAssetPostprocessor.cs` apply automatically to anything
dropped under a `Rodin/` folder, and the grey-box scene gives every asset a defined slot
to drop into.

---

## Phase 0 — Inventory before you generate

Reuse beats regenerate. Only send Rodin the gaps.

1. Scan the Downloads folder for `.fbx`, `.glb`, `.gltf`, `.obj`, `.unitypackage` —
   wasteland/desert kits, scrap props, skyboxes, road pieces.
2. Browse the Unity Asset Store library (owned + free) for post-apocalyptic / desert /
   low-poly prop packs, skyboxes, road kits.
3. Fill in the table below.
4. Mark each of the 8 core assets REUSE or GENERATE. Only generate the gaps.

### Inventory

| Asset name | Source | Game role | Style match? | Verdict |
|---|---|---|---|---|
| | | | | |

### The 8 core assets

| # | Asset | Bang Parts | Grey-box object it replaces | REUSE / GENERATE |
|---|---|---|---|---|
| 1 | Hero buggy | **YES** | `Buggy/ChassisVisual` + `RamBumper` + `Panels/*` | |
| 2 | Wheels (standalone) | No | `Buggy/Wheels/Wheel_*/Mesh` | |
| 3 | Boost ramp | No | `Track/BoostPads/*/GlowStrip` | |
| 4 | Jump kicker | No | `Track/JumpKicker` | |
| 5 | Crash barriers / obstacles | **YES — 2 parts** | `Track/Obstacles/Wreck_*` | |
| 6 | Track segment | No | `Track/Road/Road_*` | |
| 7 | Environment prop (billboard) | No | `Track/Scenery/Billboard_*` | |
| 8 | Skybox / backdrop | No | scene lighting settings | |

---

## Phase 1 — Rodin generation

### The fixed prefix — word for word, every asset

Consistent description wording is what makes the set look like one family. Do not
paraphrase it between assets.

```
Low-poly stylized post-apocalyptic wasteland arcade asset, rusted welded
scrap-metal, sun-bleached desert palette of orange/tan/rust-brown, dust and
grime, clean low-poly geometry, subtle PBR detail, consistent stylized
proportions, optimized for mobile, neutral even lighting, single cohesive
art style —
[OBJECT CLAUSE]
```

### Object clauses

| Asset | Object clause |
|---|---|
| Vehicle | `a chunky low-poly wasteland racing buggy with exposed tube-frame roll cage, welded scrap-metal armor panels, exposed engine, exhaust stacks, front ram bumper, and four oversized knobbly tires` |
| Wheels | `a set of four oversized knobbly off-road tires on rusted rims` |
| Boost ramp | `a makeshift boost ramp welded from scrap metal plates with a glowing edge strip` |
| Jump kicker | `a broken highway ramp / dirt launch mound` |
| Obstacles | `a burnt-out wrecked car / stack of old tires / cracked concrete block` |
| Track | `a modular cracked desert asphalt road segment with clean tiling edges` |
| Prop | `a rusted roadside billboard on a leaning steel frame` |
| Skybox | `a hazy dusty orange post-apocalyptic desert sky` |

Keep assets original and genre-generic. Do not prompt for specific vehicles, logos, or
characters from any film franchise — the vibe, built from scratch.

### Process, every asset

1. Description = fixed prefix + correct object clause.
2. Bang Parts **on** for the buggy and obstacles. Off otherwise.
3. PBR slider at **maximum**.
4. All output/generation settings on **high quality**.
5. Generate. Confirm it matches the family; regenerate if the style drifts.
6. Download.
7. **Screenshot at the download step, every time**, confirming materials are exporting
   for every material.
8. Verify mesh **and** the full material set before moving on.

### Per-asset checklist

Copy one block per generated asset.

```
ASSET: __________________________
[ ] Description = template + correct object clause
[ ] Bang Parts set correctly (YES for buggy + obstacles, No otherwise)
[ ] PBR slider at maximum
[ ] Output settings on high quality
[ ] Generated + style matches the wasteland family
[ ] Downloaded
[ ] Screenshot at download step (materials confirmed exporting)
[ ] MESH present
[ ] MATERIAL set present (all materials)
[ ] Filed into Assets/_Project/Art/Rodin/<name>/ with a clear name
```

---

## Phase 2 — Blender

1. Import the Rodin export (glTF/FBX).
2. Retopologise to budget: **buggy 3k–8k tris, props 200–1500 tris**.
3. **Fix scale and orientation, and lock scale early.** 1 Blender unit = 1 metre,
   +Z up in Blender, apply all transforms before export. This is the alignment
   headache from Global Drift — consistent scale and pivots now prevents it.
   The Unity importer enforces the same standard on the way in, but it cannot fix a
   mesh whose pivot is in the wrong place.
4. Apply consistent materials in the wasteland palette.
5. **Buggy** — keep the Bang Parts split. Panels, wheels and bumper stay separate objects
   with sensible pivots. A wheel's pivot must be at its axle centre or it will wobble.
   **Obstacles** — keep the 2-part split so the halves can separate.
6. Auto-render a preview of each asset for approval before Unity.
7. Export Unity-ready (FBX, +Y up, −Z forward, apply transforms).

### Pivots the code depends on

| Object | Pivot must be at |
|---|---|
| Wheel | axle centre |
| Body panel | its own centre of mass, roughly |
| Obstacle half | its own centre |
| Buggy root | ground level, centred between the wheels |

Wrong pivots don't error — they just make wheels wobble and debris spin oddly, which is
much harder to diagnose later.

---

## Phase 3 — Into Unity

1. Drop the Blender FBX into `Assets/_Project/Art/Rodin/<asset>/`. Import settings apply
   automatically.
2. Check the console. An over-budget mesh warns with its triangle count.
3. Convert materials to URP: `Window > Rendering > Render Pipeline Converter`, or set
   the shader to `Universal Render Pipeline/Lit` by hand.
4. Replace the grey box, using the table in Phase 0 above:
   - Swap the mesh onto the existing GameObject, keeping its transform, **or**
   - Parent the new mesh under the grey box's object and delete the primitive's
     MeshRenderer/MeshFilter.
   - **Keep the colliders and the component references.** The physics is tuned against
     the primitive collider shapes; changing them changes the handling.
5. For the buggy specifically:
   - Wheel meshes go under the four `Wheel_*` pivot objects, at local position zero.
     The pivot is what the code drives; the mesh hangs off it. This is why a mesh with
     an odd baked orientation still works — put the correction on the mesh's local
     rotation.
   - Panels replace the `Panels/*` boxes. Update `detachImpulse` per panel on
     `DamageableBody` — bumpers should be tougher than door panels.
   - Set the wheel `radius` on `BuggyController` to match the real mesh. Getting this
     wrong makes the buggy float or sink.
6. For obstacles: the new halves go in the `halves` array on `Destructible`, disabled,
   with the intact mesh in `intact`.

---

## Performance budget

| Item | Budget |
|---|---|
| Frame rate | 60 fps target, 30 fps hard floor, mid-tier phone |
| Buggy | 3k–8k tris |
| Props | 200–1500 tris |
| Textures | 512–1024, atlased where possible |
| Draw calls | Keep low — static batching is already set on road, barriers and scenery |

Fog is on and tuned to the theme, cutting draw distance to 320 m and hiding low-poly
pop-in. The camera far plane matches it — drawing past the fog wall is wasted work.

Bake lighting once the real meshes are in. One warm directional sun is already set up.
