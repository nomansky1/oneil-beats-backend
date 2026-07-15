# '90s JDM Low-Poly Car Generator (Blender / `bpy` → Three.js)

Procedurally generates **30 distinct low-poly '90s JDM cars** — rally weapons, street
sports icons and GT racers — as glTF-Binary (`.glb`) files ready for **Three.js /
react-three-fiber**.

Each car is modelled from its **own chassis-specific silhouette** (one of six body
types — low coupe, fastback, sedan, hatch, mid-ship wedge, roadster) plus a signature
parts kit (hood scoop, roof vent, vortex generators, canards, mud flaps, light pod,
overfenders, GT wing). Names use enthusiast chassis codes — these are **original
tribute designs with no manufacturer badging**.

Fleet: 8 rally · 18 sport · 4 race. Chassis represented include FD3S, A80, R32/R33/R34,
NA1, SW20, S13/S14/S15, AE86, EK9, DC2, Z32, Evo (CE9A/CP9A), GC8, ST205 and more.

## What each vehicle ships with

| Feature | Detail |
|---|---|
| **Aerodynamic body** | Silhouette-driven shell: hood → raked windscreen → roof → rear deck, shouldered cross-sections with greenhouse tumblehome. A different profile per chassis, drawn from six body types. |
| **Split meshes** | `Windshield`, `RearWindshield`, `Door_FL`, `Door_FR` are separate objects/nodes. |
| **UI-openable doors** | Each door's origin sits on the **front hinge**, so the app animates `door.rotation.y` to swing it open. |
| **Emissive lights that emit** | Head-/tail-lights use emissive PBR materials **and** real `KHR_lights_punctual` spot/point lamps (exported), so they cast light in-engine. |
| **Air intakes** | Front fascia + shallow side pods (mid-ships / turbo). |
| **Wheels** | Branded tire (raised sidewall band) + selectable rim style (`5spoke` / `10spoke` / `turbine`), tucked into fender flares. |
| **Interior** | Floor pan, seats, dashboard, steering wheel + a driver dummy. |
| **Fitted parts** | Hood (+vents), front bumper/splitter, rear bumper/diffuser, exhaust tips, rear wing/ducktail, roll cage (race), roof scoop. |
| **Body types** | coupe_low · fastback · sedan · hatch · wedge · roadster — each a distinct silhouette. |
| **Signature kit** | hood scoop, roof vent, vortex generators, canards, mud flaps, rally light pod, overfenders, GT wing (lip / gt / gt2). |
| **LODs** | `*.glb` (LOD0, hi-res), `*_lod1.glb` (~55%), `*_lod2.glb` (~28%). |
| **Customization kit** | `*_customization_kit.glb` — a laid-out parts library: 3 hoods, 3 front + 2 rear bumpers, 3 roof scoops, 3 exhaust tips, roll cage, 3 rim sets, 3 window-tint swatches. |
| **Three.js materials** | glTF PBR metallic-roughness paint w/ clcoat, `KHR_materials_transmission` glass, emissive lights. |

## Requirements

No Blender install needed — uses the `bpy` PyPI wheel:

```bash
pip install bpy          # Blender 5.x as a Python module (Python 3.11)
```

## Usage

```bash
python3 generate_cars.py                 # all 30 vehicles + previews
python3 generate_cars.py --no-preview     # skip Cycles thumbnails (faster)
python3 generate_cars.py --only=3         # build the first 3 (debug)
```

Output:

```
output/
├── models/
│   ├── <id>.glb                       # LOD0 hi-res
│   ├── <id>_lod1.glb                  # LOD1
│   ├── <id>_lod2.glb                  # LOD2
│   └── <id>_customization_kit.glb     # parts library
├── previews/<id>.png                  # Cycles render
├── manifest.json                      # full catalog + file map + tri counts
└── gallery.html                       # self-contained preview gallery
```

`id` is `rally_00 … rally_07`, `sport_00 … sport_17`, `race_00 … race_03`.

## Loading in Three.js

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const gltf = await new GLTFLoader().loadAsync('/models/sport_00.glb'); // FD3S RX-7
scene.add(gltf.scene);

// open a door
const door = gltf.scene.getObjectByName('Door_FL');
door.rotation.y = -1.1;                 // hinge is already at the door origin

// swap a rim set / hood from the kit
const kit = await new GLTFLoader().loadAsync('/models/sport_00_customization_kit.glb');
const hood = kit.scene.getObjectByName('Kit_Hood_Vented');
```

Emissive lights are already in the scene as `Headlamp` / `Taillamp` nodes (needs a
loader with `KHR_lights_punctual`, which three's GLTFLoader supports by default).

## Manifest

`manifest.json` lists, per vehicle: `id`, `name`, `code` (chassis), `class`, `body_type`, `color_hex`,
file paths (lod0/1/2/kit/preview), triangle counts per LOD, the split-mesh and
openable-door node names, light node names and the customization categories.
