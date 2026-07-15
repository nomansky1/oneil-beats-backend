#!/usr/bin/env python3
"""
Low-Poly Car Generator for Three.js
===================================

Procedurally generates 35 distinct low-poly vehicles (race cars, hypercars and
detailed sports cars) as glTF-Binary (.glb) files ready for Three.js / react-three-fiber.

Every vehicle ships with:
  * A sleek, aerodynamically-lofted body (varying silhouette per archetype)
  * SPLIT meshes: Windshield, RearWindshield, Door_FL, Door_FR
    - door pivots (object origin) are placed on the front hinge so the UI can
      simply animate `rotation.y` to open them.
  * Emissive head-/tail-lights that ACTUALLY emit light
    (emissive PBR material + KHR_lights_punctual spot/point lamps).
  * Defined air intakes (recessed, dark, front + side pods).
  * Branded tires + selectable rim sets (5-spoke / 10-spoke / turbine).
  * Interior: floor pan, seats, dashboard, steering wheel + a driver dummy.
  * Default fitted customization parts: hood, front bumper, rear bumper,
    exhaust tips, rear wing, (+ roll cage / roof scoop by class).
  * 3 Levels Of Detail (LOD0 hi-res, LOD1, LOD2) exported per vehicle.
  * A per-vehicle "customization kit" .glb containing the full parts library:
    alternate hoods, front/rear bumpers, roof scoops, exhaust tips, roll cage,
    rim sets and window-tint swatches.
  * Materials authored for Three.js (glTF PBR metallic-roughness, KHR
    transmission glass, emissive lights).

Run WITHOUT a Blender install (uses the `bpy` PyPI module):
    pip install bpy
    python3 generate_cars.py

Output -> ./output/models/*.glb , ./output/previews/*.png , ./output/manifest.json
"""

import bpy, bmesh, math, os, json, sys, time
from mathutils import Vector

# --------------------------------------------------------------------------- #
#  Paths / config
# --------------------------------------------------------------------------- #
ROOT      = os.path.dirname(os.path.abspath(__file__))
OUT       = os.path.join(ROOT, "output")
MODELS    = os.path.join(OUT, "models")
PREVIEWS  = os.path.join(OUT, "previews")
PREVIEWS_SIDE = os.path.join(OUT, "previews_side")
for d in (OUT, MODELS, PREVIEWS, PREVIEWS_SIDE):
    os.makedirs(d, exist_ok=True)

RENDER_PREVIEWS = "--no-preview" not in sys.argv     # Cycles CPU thumbnails
ONLY = None
for a in sys.argv:
    if a.startswith("--only="):                      # e.g. --only=3  (debug: build N cars)
        ONLY = int(a.split("=", 1)[1])

TAU = math.pi * 2.0

# --------------------------------------------------------------------------- #
#  Scene helpers
# --------------------------------------------------------------------------- #
def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights,
                 bpy.data.cameras, bpy.data.images, bpy.data.node_groups):
        for item in list(coll):
            try: coll.remove(item)
            except Exception: pass

def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj

def new_mesh_obj(name, verts, faces, mats=None, mat_index=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [list(f) for f in faces])
    me.update()
    obj = bpy.data.objects.new(name, me)
    link(obj)
    if mats:
        for m in mats:
            me.materials.append(m)
    if mat_index is not None:
        for i, p in enumerate(me.polygons):
            p.material_index = mat_index[i] if isinstance(mat_index, list) else mat_index
    return obj

def finalize(obj, smooth=True):
    """Recalculate outward normals and set shading."""
    me = obj.data
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    me.update()
    return obj

def set_origin(obj, world_pivot):
    """Move mesh data so `world_pivot` becomes the object origin (for hinges)."""
    piv = Vector(world_pivot)
    for v in obj.data.vertices:
        v.co -= piv
    obj.location = piv

def join(objs, name):
    """Merge a list of objects into the first, rename it."""
    objs = [o for o in objs if o]
    if not objs:
        return None
    if len(objs) == 1:
        objs[0].name = name
        return objs[0]
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    objs[0].name = name
    return objs[0]

# --------------------------------------------------------------------------- #
#  Materials (glTF-friendly)
# --------------------------------------------------------------------------- #
def _principled(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    return m, m.node_tree.nodes.get("Principled BSDF")

def mat_paint(name, color, metallic=0.9, rough=0.32, coat=1.0):
    m, b = _principled(name)
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    for k, v in (("Coat Weight", coat), ("Coat Roughness", 0.05)):
        if k in b.inputs: b.inputs[k].default_value = v
    return m

def mat_glass(name, tint=(0.03, 0.04, 0.05), alpha=0.35, transmission=0.9):
    m, b = _principled(name)
    b.inputs["Base Color"].default_value = (*tint, 1)
    b.inputs["Roughness"].default_value = 0.03
    if "Transmission Weight" in b.inputs: b.inputs["Transmission Weight"].default_value = transmission
    if "IOR" in b.inputs: b.inputs["IOR"].default_value = 1.45
    b.inputs["Alpha"].default_value = alpha
    try: m.blend_method = 'BLEND'
    except Exception: pass
    return m

def mat_emit(name, color, strength=6.0):
    m, b = _principled(name)
    b.inputs["Base Color"].default_value = (*color, 1)
    if "Emission Color" in b.inputs: b.inputs["Emission Color"].default_value = (*color, 1)
    if "Emission Strength" in b.inputs: b.inputs["Emission Strength"].default_value = strength
    b.inputs["Roughness"].default_value = 0.35
    return m

def mat_simple(name, color, metallic=0.0, rough=0.7):
    m, b = _principled(name)
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    return m

# --------------------------------------------------------------------------- #
#  Primitive builders (return objects, unfinalized)
# --------------------------------------------------------------------------- #
def cylinder(name, r, depth, seg, axis='X', center=(0, 0, 0), r2=None, mat=None):
    r2 = r if r2 is None else r2
    verts, faces = [], []
    for cap, rr, off in ((0, r, -depth / 2), (1, r2, depth / 2)):
        for i in range(seg):
            a = TAU * i / seg
            c, s = math.cos(a), math.sin(a)
            if axis == 'X': verts.append((off, rr * c, rr * s))
            elif axis == 'Y': verts.append((rr * c, off, rr * s))
            else: verts.append((rr * c, rr * s, off))
    for i in range(seg):
        j = (i + 1) % seg
        faces.append([i, j, seg + j, seg + i])
    # caps (fans)
    c0 = len(verts); verts.append((-depth / 2 if axis == 'X' else 0,
                                   -depth / 2 if axis == 'Y' else 0,
                                   -depth / 2 if axis == 'Z' else 0))
    c1 = len(verts); verts.append((depth / 2 if axis == 'X' else 0,
                                   depth / 2 if axis == 'Y' else 0,
                                   depth / 2 if axis == 'Z' else 0))
    for i in range(seg):
        j = (i + 1) % seg
        faces.append([c0, j, i])
        faces.append([c1, seg + i, seg + j])
    obj = new_mesh_obj(name, verts, faces, [mat] if mat else None, 0 if mat else None)
    for v in obj.data.vertices:
        v.co += Vector(center)
    return obj

def box(name, sx, sy, sz, center=(0, 0, 0), mat=None):
    x, y, z = sx / 2, sy / 2, sz / 2
    v = [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z),
         (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]
    f = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1],
         [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]
    obj = new_mesh_obj(name, v, f, [mat] if mat else None, 0 if mat else None)
    for vt in obj.data.vertices:
        vt.co += Vector(center)
    return obj

def tube(name, p0, p1, r, seg=8, mat=None):
    """Cylinder between two points (for roll cages / exhaust plumbing)."""
    p0, p1 = Vector(p0), Vector(p1)
    d = (p1 - p0); L = d.length
    if L < 1e-5: return None
    obj = cylinder(name, r, L, seg, axis='Z', mat=mat)
    # orient +Z of cylinder onto d
    up = Vector((0, 0, 1))
    axis = up.cross(d.normalized())
    ang = up.angle(d.normalized())
    if axis.length > 1e-6:
        obj.rotation_mode = 'AXIS_ANGLE'
        obj.rotation_axis_angle = (ang, *axis.normalized())
    obj.location = (p0 + p1) / 2
    return obj

# --------------------------------------------------------------------------- #
#  Body profile (aerodynamic loft)
# --------------------------------------------------------------------------- #
def smoothstep(f):
    f = max(0.0, min(1.0, f)); return f * f * (3 - 2 * f)

def sample_profile(ctrl, t):
    """ctrl: list of (t, halfwidth, halfheight, zcenter). Returns interpolated tuple."""
    for k in range(len(ctrl) - 1):
        t0, t1 = ctrl[k][0], ctrl[k + 1][0]
        if t <= t1 or k == len(ctrl) - 2:
            f = smoothstep((t - t0) / (t1 - t0)) if t1 > t0 else 0.0
            return tuple(a + (b - a) * f for a, b in zip(ctrl[k][1:], ctrl[k + 1][1:]))
    return ctrl[-1][1:]

def lerp1(ctrl, x):
    """Interpolate a list of (x, value) control points with smoothstep easing."""
    if x <= ctrl[0][0]: return ctrl[0][1]
    if x >= ctrl[-1][0]: return ctrl[-1][1]
    for k in range(len(ctrl) - 1):
        x0, x1 = ctrl[k][0], ctrl[k + 1][0]
        if x0 <= x <= x1:
            f = smoothstep((x - x0) / (x1 - x0)) if x1 > x0 else 0.0
            return ctrl[k][1] + (ctrl[k + 1][1] - ctrl[k][1]) * f
    return ctrl[-1][1]

# ------------------------------------------------------------------ #
# '90s JDM body types.  Each is a silhouette recipe (roofline z-fraction
# vs. xf), a plan-view width taper, longitudinal stations for the glass /
# doors / axles, and the floor+belt heights.  Individual cars pick a type
# and tweak dimensions + a signature parts kit.
#   coupe_low : FD/FC RX-7, S13/14/15 Silvia, SW20 MR2 (low 2-door)
#   fastback  : A80/A70 Supra, Z32 300ZX, 180SX (long sloping tail)
#   sedan     : Evo, WRX STI, Skyline GT-R sedan (3-box, upright, wing)
#   hatch     : EK9 Civic, AE86, Pulsar GTi-R (upright, boxy)
#   wedge     : NSX, mid-ship (cab-forward, long rear deck)
#   roadster  : NA Roadster (very low, tiny cabin)
# ------------------------------------------------------------------ #
BODY_TYPES = {
    'coupe_low': dict(
        roof=[(0.00, 0.34), (0.06, 0.46), (0.16, 0.55), (0.34, 0.57), (0.42, 0.80),
              (0.55, 0.87), (0.66, 0.85), (0.80, 0.66), (0.92, 0.56), (1.00, 0.46)],
        wf=[(0.00, 0.32), (0.10, 0.84), (0.24, 0.98), (0.52, 1.00), (0.78, 1.00), (0.90, 0.96), (1.00, 0.58)],
        st=dict(cowl=0.40, roof_f=0.48, roof_r=0.66, deck=0.80, ax_f=0.19, ax_r=0.82),
        floor=0.17, belt=0.48),
    'fastback': dict(
        roof=[(0.00, 0.32), (0.06, 0.44), (0.18, 0.54), (0.34, 0.57), (0.44, 0.84),
              (0.54, 0.90), (0.64, 0.87), (0.82, 0.70), (0.94, 0.60), (1.00, 0.50)],
        wf=[(0.00, 0.30), (0.10, 0.82), (0.24, 0.97), (0.50, 1.00), (0.80, 1.00), (0.92, 0.95), (1.00, 0.56)],
        st=dict(cowl=0.42, roof_f=0.50, roof_r=0.64, deck=0.82, ax_f=0.19, ax_r=0.82),
        floor=0.17, belt=0.48),
    'sedan': dict(
        roof=[(0.00, 0.36), (0.07, 0.48), (0.18, 0.56), (0.30, 0.59), (0.37, 0.86),
              (0.44, 0.98), (0.62, 0.98), (0.70, 0.92), (0.77, 0.62), (0.90, 0.60), (1.00, 0.50)],
        wf=[(0.00, 0.32), (0.10, 0.84), (0.22, 0.97), (0.50, 1.00), (0.80, 1.00), (0.92, 0.96), (1.00, 0.62)],
        st=dict(cowl=0.36, roof_f=0.44, roof_r=0.68, deck=0.80, ax_f=0.18, ax_r=0.84),
        floor=0.21, belt=0.52),
    'hatch': dict(
        roof=[(0.00, 0.36), (0.08, 0.50), (0.18, 0.58), (0.28, 0.62), (0.35, 0.90),
              (0.45, 0.98), (0.66, 0.96), (0.80, 0.80), (0.92, 0.66), (1.00, 0.54)],
        wf=[(0.00, 0.32), (0.10, 0.84), (0.22, 0.97), (0.50, 1.00), (0.80, 1.00), (0.92, 0.96), (1.00, 0.64)],
        st=dict(cowl=0.34, roof_f=0.44, roof_r=0.74, deck=0.86, ax_f=0.17, ax_r=0.85),
        floor=0.21, belt=0.52),
    'wedge': dict(
        roof=[(0.00, 0.28), (0.05, 0.40), (0.13, 0.48), (0.22, 0.54), (0.30, 0.82),
              (0.42, 0.88), (0.52, 0.85), (0.64, 0.66), (0.80, 0.60), (1.00, 0.44)],
        wf=[(0.00, 0.28), (0.10, 0.80), (0.22, 0.96), (0.45, 0.98), (0.74, 1.00), (0.88, 0.98), (1.00, 0.58)],
        st=dict(cowl=0.22, roof_f=0.30, roof_r=0.50, deck=0.66, ax_f=0.18, ax_r=0.84),
        floor=0.15, belt=0.46),
    'roadster': dict(
        roof=[(0.00, 0.32), (0.08, 0.46), (0.20, 0.54), (0.34, 0.57), (0.42, 0.70),
              (0.52, 0.72), (0.60, 0.68), (0.74, 0.56), (0.90, 0.50), (1.00, 0.44)],
        wf=[(0.00, 0.30), (0.10, 0.82), (0.24, 0.97), (0.52, 1.00), (0.80, 1.00), (0.92, 0.94), (1.00, 0.56)],
        st=dict(cowl=0.42, roof_f=0.50, roof_r=0.60, deck=0.78, ax_f=0.20, ax_r=0.82),
        floor=0.19, belt=0.48),
}


class Body:
    """
    Silhouette-driven car shell.
      * roofline gives the hood/windscreen/roof/deck outline of the body type
      * cross-sections are shouldered: full width at the beltline, tumbling
        inward through the greenhouse -> reads as a real car.
      * spec['ride'] raises the whole shell (rally stance).
    """
    def __init__(self, spec):
        self.spec = spec
        self.cls = spec["cls"]
        self.bt = spec.get("body_type", "coupe_low")
        t = BODY_TYPES[self.bt]
        self.L = spec["length"]
        self.Wh = spec["width"] / 2.0
        self.H = spec["height"]
        self.roof = spec.get("roof", t["roof"])
        self.wf = spec.get("wf", t["wf"])
        self.st = spec.get("st", t["st"])
        self.floor = (t["floor"] + spec.get("ride", 0.0)) * self.H
        self.belt = t["belt"] * self.H
        self.roofmax = max(z for _, z in self.roof) * self.H
        # compatibility attrs used by interior/lights helpers
        self.z0 = self.floor
        self.Hh = self.H

    # --- samplers ---------------------------------------------------
    def x_of(self, xf):        return -self.L / 2 + xf * self.L
    def top_z(self, xf):       return lerp1(self.roof, xf) * self.H

    def width(self, xf):
        w = self.Wh * lerp1(self.wf, xf)
        fl = self.spec.get("flare", 1.0)               # overfender bulge at the axles
        if fl > 1.001:
            R = self.spec["wheel_r"]; W = R * 1.5
            x = self.x_of(xf)
            for axf in (self.st["ax_f"], self.st["ax_r"]):
                dx = (x - self.x_of(axf)) / W
                if abs(dx) < 1.0:
                    w *= 1.0 + (fl - 1.0) * 0.32 * (1.0 - dx * dx)
        return w

    def floor_at(self, xf):
        """Body lower edge: rocker height between wheels, rising into a tight
        semicircular arch cutout over each tyre so the fender hugs the wheel."""
        z = self.floor
        R = self.spec["wheel_r"]; W = R * 1.16
        x = self.x_of(xf)
        for axf in (self.st["ax_f"], self.st["ax_r"]):
            dx = x - self.x_of(axf)
            if abs(dx) < W:
                peak = min(2.0 * R + 0.02, self.top_z(axf) * 0.97)   # never above the local body top
                arch = self.floor + (peak - self.floor) * math.sqrt(max(0.0, 1.0 - (dx / W) ** 2))
                z = max(z, arch)
        return z

    def half_at(self, xf, z):
        """
        Half-width of the shell at station xf and absolute height z.
        Tuned for the reference look: FLAT, slab-sided body (near-vertical sides,
        crisp shoulder) with only a light tumblehome on the greenhouse.
        """
        top = self.top_z(xf)
        Wb = self.width(xf)
        if z <= self.belt:                       # lower body: near-vertical, slight tuck at rocker
            f = (z - self.floor) / max(1e-4, self.belt - self.floor)
            return Wb * (0.90 + 0.10 * smoothstep(max(0.0, min(1.0, f))))
        # greenhouse: only a gentle tumblehome so the glasshouse stays upright/flat
        gh = max(0.0, min(1.0, (top - self.belt) / max(1e-4, self.roofmax - self.belt)))
        top_hw = Wb * (0.93 - 0.15 * gh)
        f = (z - self.belt) / max(1e-4, top - self.belt)
        return Wb + (top_hw - Wb) * smoothstep(max(0.0, min(1.0, f)))

    def surf(self, xf, v, side, out=1.0):
        """Point on the shell side. v in [0,1] maps floor->top at this station."""
        top = self.top_z(xf)
        z = self.floor + (top - self.floor) * v
        return (self.x_of(xf), side * self.half_at(xf, z) * out, z)

    def section(self, t):        # legacy shim for interior/light placement
        top = self.top_z(t)
        zc = (top + self.floor) / 2.0
        return self.half_at(t, zc), (top - self.floor) / 2.0, zc

    # --- mesh -------------------------------------------------------
    def build(self, mat):
        M, NL = 60, 12                                   # stations, vertical samples/side
        verts, faces, rings = [], [], []
        for i in range(M + 1):
            xf = i / M
            top = self.top_z(xf)
            fl = self.floor_at(xf)                        # arch-cut lower edge
            x = self.x_of(xf)
            base = len(verts)
            # right side bottom->top
            for k in range(NL):
                v = k / (NL - 1)
                z = fl + (top - fl) * v
                verts.append((x, self.half_at(xf, z), z))
            # left side top->bottom
            for k in range(NL - 1, -1, -1):
                v = k / (NL - 1)
                z = fl + (top - fl) * v
                verts.append((x, -self.half_at(xf, z), z))
            rings.append(base)
        R = 2 * NL
        for i in range(M):
            a, b = rings[i], rings[i + 1]
            for k in range(R):
                k2 = (k + 1) % R
                faces.append([a + k, a + k2, b + k2, b + k])
        # end caps
        cf = len(verts); verts.append((self.x_of(0), 0, (self.top_z(0) + self.floor) / 2))
        for k in range(R):
            faces.append([cf, rings[0] + (k + 1) % R, rings[0] + k])
        cr = len(verts); verts.append((self.x_of(1), 0, (self.top_z(1) + self.floor) / 2))
        for k in range(R):
            faces.append([cr, rings[M] + k, rings[M] + (k + 1) % R])
        return finalize(new_mesh_obj("Body", verts, faces, [mat], 0), smooth=True)


def make_arch(body, name, cx, side_y, R, tw, mat, flare=1.0):
    """Flared fender blister over a wheel: top cap + side skirt so it reads as a
    real fender, not a floating ring (flare>1 = JDM overfenders)."""
    na = 18
    Rm = R * 1.14
    sgn = 1.0 if side_y >= 0 else -1.0
    inner = side_y - sgn * tw * 0.50                    # tucks toward the body side
    outer = side_y + sgn * tw * (0.50 + 0.40 * flare)  # bulge outward
    ring_in, ring_out, ring_lip = [], [], []
    verts, faces = [], []
    for i in range(na):
        a = math.pi * (i / (na - 1))                    # full semicircle, front->top->rear
        px = cx + Rm * math.cos(a)
        pz = R + Rm * math.sin(a)
        ring_in.append(len(verts));  verts.append((px, inner, pz))
        ring_out.append(len(verts)); verts.append((px, outer, pz))
        skirt_z = max(0.02, pz - 0.55 * R)              # drop the outer lip beside the tyre
        ring_lip.append(len(verts)); verts.append((px, outer - sgn * tw * 0.05, skirt_z))
    for i in range(na - 1):
        faces.append([ring_in[i], ring_out[i], ring_out[i + 1], ring_in[i + 1]])    # top cap
        faces.append([ring_out[i], ring_lip[i], ring_lip[i + 1], ring_out[i + 1]])  # side skirt
    return finalize(new_mesh_obj(name, verts, faces, [mat], 0), smooth=True)


def build_signature(body, spec, mats):
    """Extra '90s JDM kit driven by spec flags; returns a list of welded meshes."""
    objs = []
    L, Wh, st = body.L, body.Wh, body.st
    floor, belt = body.floor, body.belt
    if spec.get("hood_scoop"):
        hxf = 0.24; hz = body.top_z(hxf)
        objs.append(finalize(box("HoodScoop", L * 0.11, body.width(hxf) * 0.5, 0.06,
                                 center=(body.x_of(hxf), 0, hz + 0.03), mat=mats["intake"]), smooth=False))
    if spec.get("roof_vent"):
        xf = st["roof_r"] - 0.02
        objs.append(finalize(box("RoofVent", L * 0.05, body.width(xf) * 0.42, 0.03,
                                 center=(body.x_of(xf), 0, body.top_z(xf) + 0.015), mat=mats["intake"]), smooth=False))
    if spec.get("vgen"):                                # Evo-style roof vortex generators
        xf = st["roof_r"] - 0.01
        for k in range(6):
            y = (k - 2.5) * body.width(xf) * 0.26
            objs.append(finalize(box("VGen", 0.05, 0.014, 0.03,
                                     center=(body.x_of(xf), y, body.top_z(xf) + 0.02), mat=mats["trim"]), smooth=False))
    if spec.get("canards"):                             # front dive planes
        for s in (-1, 1):
            objs.append(finalize(box("Canard", 0.14, 0.10, 0.012,
                                     center=(body.x_of(0.05), s * body.half_at(0.06, floor + 0.1), floor + 0.11),
                                     mat=mats["trim"]), smooth=False))
    if spec.get("mud_flaps"):
        Rw = spec["wheel_r"]
        for xf, tag in ((st["ax_f"], "F"), (st["ax_r"], "R")):
            for s in (-1, 1):
                objs.append(finalize(box("MudFlap_" + tag, 0.02, 0.17, 0.17,
                                         center=(body.x_of(xf) + 0.6 * Rw, s * body.width(xf) * 1.02, 0.10),
                                         mat=mats["intake"]), smooth=False))
    return objs


# --------------------------------------------------------------------------- #
#  Glass / doors (split meshes)
# --------------------------------------------------------------------------- #
def make_windshield(body, xf0, xf1, v0, v1, mat, name):
    """Curved glass panel spanning two roofline stations (3 spans for a subtle curve)."""
    n = 4
    verts, faces = [], []
    for i in range(n):
        f = i / (n - 1)
        xf = xf0 + (xf1 - xf0) * f
        v = v0 + (v1 - v0) * f
        top = body.top_z(xf)
        z = body.floor + (top - body.floor) * v
        hw = body.half_at(xf, z) * 1.005
        verts.append((body.x_of(xf), hw, z)); verts.append((body.x_of(xf), -hw, z))
    for i in range(n - 1):
        a = 2 * i
        faces.append([a, a + 1, a + 3, a + 2])
    return finalize(new_mesh_obj(name, verts, faces, [mat], 0), smooth=True)

def make_door(body, side, mat_paint_, mat_glass_, name):
    """Front-hinged door: painted lower + glass upper, origin on the front hinge."""
    st = body.st
    xf0, xf1 = st["cowl"] + 0.02, st["roof_r"]         # front hinge .. B-pillar
    nt, nv = 6, 6
    vlo, vhi = 0.05, 0.92
    belt_v = (body.belt - body.floor) / (body.top_z((xf0 + xf1) / 2) - body.floor)
    verts, faces, midx = [], [], []
    grid = []
    for it in range(nt):
        xf = xf0 + (xf1 - xf0) * it / (nt - 1)
        row = []
        for iv in range(nv):
            v = vlo + (vhi - vlo) * iv / (nv - 1)
            row.append(len(verts))
            verts.append(body.surf(xf, v, side, 1.02))
        grid.append(row)
    for it in range(nt - 1):
        for iv in range(nv - 1):
            a, b, c, d = grid[it][iv], grid[it][iv + 1], grid[it + 1][iv + 1], grid[it + 1][iv]
            faces.append([a, b, c, d])
            vmid = vlo + (vhi - vlo) * (iv + 0.5) / (nv - 1)
            midx.append(1 if vmid > belt_v else 0)     # 1 = glass (above beltline)
    obj = new_mesh_obj(name, verts, faces, [mat_paint_, mat_glass_], midx)
    finalize(obj, smooth=True)
    set_origin(obj, body.surf(xf0, 0.3, side, 1.02))   # hinge on the front vertical edge
    return obj

# --------------------------------------------------------------------------- #
#  Wheels (rims + branded tires)
# --------------------------------------------------------------------------- #
def make_wheel(name, r, width, style, mat_tire, mat_rim, mat_brand, side=1):
    """Deep-dish stanced wheel: recessed spoke face + polished outer lip toward
    the outboard side (side=+1 left / -1 right)."""
    parts = []
    hw = width / 2.0
    # tyre carcass
    parts.append(cylinder(name + "_tire", r, width, 28, axis='Y', mat=mat_tire))
    # branded sidewalls
    for s in (-1, 1):
        parts.append(cylinder(name + "_brand", r * 0.84, width * 0.05, 44, axis='Y',
                              center=(0, s * hw * 0.94, 0), mat=mat_brand))
    # inner barrel
    parts.append(cylinder(name + "_barrel", r * 0.66, width * 0.92, 24, axis='Y', mat=mat_rim))
    # polished outer lip (dish) toward the outboard face
    parts.append(cylinder(name + "_lip", r * 0.72, width * 0.14, 44, axis='Y',
                          center=(0, side * hw * 0.82, 0), mat=mat_rim))
    face_y = -side * hw * 0.18                          # spoke face recessed inboard -> visible dish
    parts.append(cylinder(name + "_hub", r * 0.14, width, 12, axis='Y', center=(0, face_y, 0), mat=mat_rim))
    spokes = {'5spoke': 5, '10spoke': 10, 'turbine': 6, 'mesh': 12}.get(style, 5)
    for k in range(spokes):
        a = TAU * k / spokes
        sp = box(name + "_spoke", r * 0.58, width * 0.32, r * 0.10, center=(0, face_y, r * 0.36), mat=mat_rim)
        sp.rotation_euler = (a, 0, 0)
        for v in sp.data.vertices:                     # bake rotation into verts
            v.co = sp.rotation_euler.to_matrix() @ v.co
        sp.rotation_euler = (0, 0, 0)
        parts.append(sp)
    w = join(parts, name)
    finalize(w, smooth=False)
    return w

# --------------------------------------------------------------------------- #
#  Lights (emissive + real lamps)
# --------------------------------------------------------------------------- #
def add_light_lamp(name, ltype, loc, energy, color, spot=0.8, direction=None):
    ld = bpy.data.lights.new(name, type=ltype)
    ld.energy = energy
    ld.color = color
    if ltype == 'SPOT':
        ld.spot_size = spot
        ld.spot_blend = 0.4
    obj = bpy.data.objects.new(name, ld)
    obj.location = loc
    if direction:
        d = Vector(direction).normalized()
        obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    link(obj)
    return obj

# --------------------------------------------------------------------------- #
#  Interior + driver dummy
# --------------------------------------------------------------------------- #
def build_interior(body, mats):
    objs = []
    L, Wh, st = body.L, body.Wh, body.st
    cabin_c = (st["cowl"] + st["roof_r"]) / 2.0
    cx = body.x_of(cabin_c)
    z_floor = body.floor + 0.03
    roof_z = body.top_z(st["roof_f"])
    belt = body.belt
    dx = body.x_of(st["cowl"] + 0.02)
    dy = Wh * 0.42                                      # driver offset (LHD)
    objs.append(box("Interior_Floor", L * 0.30, Wh * 1.4, 0.03, center=(cx, 0, z_floor), mat=mats["interior"]))
    objs.append(box("Interior_Dashboard", 0.10, Wh * 1.3, (belt - z_floor) * 0.9,
                    center=(dx, 0, (z_floor + belt) / 2), mat=mats["interior"]))
    seat_h = belt - z_floor
    for s in (-1, 1):
        objs.append(box("Interior_Seat", L * 0.12, Wh * 0.5, 0.10,
                        center=(cx, s * dy, z_floor + 0.06), mat=mats["seat"]))
        objs.append(box("Interior_SeatBack", 0.05, Wh * 0.5, seat_h * 0.9,
                        center=(cx - L * 0.06, s * dy, z_floor + seat_h * 0.5), mat=mats["seat"]))
    objs.append(cylinder("Interior_Wheel", 0.14, 0.03, 18, axis='X',
                         center=(dx + 0.12, dy, belt * 0.9), mat=mats["interior"]))
    # driver dummy, kept beneath the roofline
    objs.append(box("Driver_Hips", 0.22, 0.30, 0.14, center=(cx, dy, z_floor + 0.10), mat=mats["driver"]))
    objs.append(box("Driver_Torso", 0.18, 0.26, 0.30, center=(cx - 0.02, dy, z_floor + 0.30), mat=mats["driver"]))
    head_z = min(z_floor + 0.52, roof_z - 0.10)
    objs.append(cylinder("Driver_Head", 0.10, 0.20, 12, axis='Z', center=(cx - 0.03, dy, head_z), mat=mats["driver"]))
    grp = join(objs, "Interior"); finalize(grp, smooth=False); return grp

# --------------------------------------------------------------------------- #
#  Fitted customization parts (default set, welded into the car)
# --------------------------------------------------------------------------- #
def build_fitted_parts(body, spec, mats):
    parts = {}
    L, Wh, st = body.L, body.Wh, body.st
    floor, belt = body.floor, body.belt
    # Hood: flush panel over the hood surface
    hxf = 0.20; htop = body.top_z(hxf)
    hood = box("Hood", L * 0.22, body.width(hxf) * 1.45, 0.035,
               center=(body.x_of(hxf), 0, htop - 0.015), mat=mats["paint"])
    if spec.get("hood_vents"):
        for s in (-1, 1):
            hood = join([hood, box("Hood_Vent", L * 0.05, body.width(hxf) * 0.26, 0.02,
                        center=(body.x_of(hxf), s * body.width(hxf) * 0.4, htop + 0.005), mat=mats["intake"])], "Hood")
    parts["Hood"] = finalize(hood, smooth=True)
    # Front bumper + splitter
    fxf = 0.03
    parts["FrontBumper"] = finalize(box("FrontBumper", L * 0.05, body.width(fxf) * 2.0, 0.03,
                                        center=(body.x_of(fxf), 0, floor + 0.02), mat=mats["trim"]), smooth=False)
    # Rear bumper + diffuser
    rxf = 0.97
    parts["RearBumper"] = finalize(box("RearBumper", L * 0.05, body.width(rxf) * 1.7, (belt - floor) * 0.5,
                                       center=(body.x_of(rxf), 0, floor + (belt - floor) * 0.25), mat=mats["trim"]), smooth=False)
    # Exhaust tips
    ex = []
    n_ex = spec.get("exhaust", 2)
    for i in range(n_ex):
        off = (i - (n_ex - 1) / 2.0) * 0.13
        ex.append(cylinder("Exhaust_Tip", 0.045, 0.14, 12, axis='X',
                            center=(body.x_of(1.0) - 0.02, off, floor + 0.05), mat=mats["chrome"]))
    parts["Exhaust"] = finalize(join(ex, "Exhaust"), smooth=False)
    # Rear wing / spoiler — per-car style
    wing = spec.get("wing", "lip")
    xw = body.x_of(0.90)
    if wing in ("gt", "gt2"):
        h = 0.30 if wing == "gt2" else 0.20
        wz = body.top_z(st["deck"]) + h
        plane = box("RearWing_Plane", L * 0.11, body.width(0.85) * 1.75, 0.03, center=(xw, 0, wz), mat=mats["trim"])
        legh = max(0.05, wz - body.top_z(0.90))
        legs = [box("RearWing_Leg", 0.05, 0.04, legh,
                    center=(xw, s * body.width(0.90) * 0.66, (wz + body.top_z(0.90)) / 2), mat=mats["trim"])
                for s in (-1, 1)]
        pieces = [plane] + legs
        if wing == "gt2":                              # end plates + second element
            pieces += [box("RearWing_EndPlate", L * 0.12, 0.02, h * 0.9,
                           center=(xw, s * body.width(0.85) * 0.88, wz - 0.02), mat=mats["trim"]) for s in (-1, 1)]
            pieces.append(box("RearWing_Gurney", L * 0.10, body.width(0.85) * 1.75, 0.02,
                              center=(xw - L * 0.045, 0, wz + 0.05), mat=mats["trim"]))
        parts["RearWing"] = finalize(join(pieces, "RearWing"), smooth=False)
    elif wing == "lip":
        dz = body.top_z(0.88)
        parts["RearWing"] = finalize(box("RearWing", L * 0.05, body.width(0.88) * 1.6, 0.05,
                                         center=(xw, 0, dz + 0.015), mat=mats["trim"]), smooth=False)
    # Roof scoop
    if spec.get("roof_scoop"):
        rf = st["roof_f"]
        parts["RoofScoop"] = finalize(box("RoofScoop", L * 0.10, body.width(rf) * 0.5, 0.10,
                                          center=(body.x_of(rf + 0.05), 0, body.top_z(rf + 0.05) + 0.03),
                                          mat=mats["intake"]), smooth=False)
    # Roll cage
    if spec.get("roll_cage"):
        zf = floor + 0.05; top = body.top_z(st["roof_f"]) - 0.05; w = body.width(0.5) * 0.62
        xa, xb = body.x_of(st["roof_f"]), body.x_of(st["roof_r"])
        tubes = [tube("Cage", (xb, w, zf), (xa, w, top), 0.022, mat=mats["cage"]),
                 tube("Cage", (xb, -w, zf), (xa, -w, top), 0.022, mat=mats["cage"]),
                 tube("Cage", (xa, w, top), (xa, -w, top), 0.022, mat=mats["cage"]),
                 tube("Cage", (xb, w, zf), (xb, -w, zf), 0.022, mat=mats["cage"])]
        parts["RollCage"] = finalize(join(tubes, "RollCage"), smooth=False)
    return parts

# --------------------------------------------------------------------------- #
#  Head/tail-lights + intakes (welded)
# --------------------------------------------------------------------------- #
def build_lights_intakes(body, spec, mats):
    objs, lamps = [], []
    L, Wh = body.L, body.Wh
    floor, belt = body.floor, body.belt
    # headlights: expressive units sitting on the front fascia
    hxf = 0.05
    hz = floor + (belt - floor) * 0.7
    fw = body.half_at(hxf, hz)
    for s in (-1, 1):
        hl = box("Headlight", 0.05, min(0.26, fw * 0.7), (belt - floor) * 0.26,
                 center=(body.x_of(hxf) - 0.01, s * fw * 0.6, hz), mat=mats["head"])
        objs.append(finalize(hl, smooth=True))
        lamps.append(add_light_lamp("Headlamp", 'SPOT',
                     (body.x_of(0) - 0.15, s * fw * 0.6, hz), 45.0, (1.0, 0.96, 0.9),
                     spot=1.0, direction=(-1, 0, -0.12)))
    # taillight bar on the rear fascia
    txf = 0.97; tz = floor + (belt - floor) * 0.68
    tl = box("Taillight", 0.04, body.width(txf) * 1.5, (belt - floor) * 0.2,
             center=(body.x_of(1.0) - 0.02, 0, tz), mat=mats["tail"])
    objs.append(finalize(tl, smooth=True))
    lamps.append(add_light_lamp("Taillamp", 'POINT', (body.x_of(1.0) + 0.1, 0, tz), 8.0, (1.0, 0.05, 0.05)))
    # shallow side intakes ahead of the rear wheels (mid-engine / turbo)
    if spec.get("side_intake"):
        ixf = 0.62; iz = floor + (belt - floor) * 0.4
        for s in (-1, 1):
            iy = body.half_at(ixf, iz)
            objs.append(finalize(box("SideIntake", L * 0.10, 0.04, (belt - floor) * 0.34,
                                     center=(body.x_of(ixf), s * (iy - 0.02), iz), mat=mats["intake"]), smooth=False))
    # rally auxiliary light pod (4 round driving lamps on the front bar)
    if spec.get("light_pod"):
        pz = floor + (belt - floor) * 0.55
        for k in range(4):
            y = (k - 1.5) * 0.20
            lens = cylinder("LightPod", 0.075, 0.06, 16, axis='X',
                            center=(body.x_of(0.02) - 0.03, y, pz), mat=mats["head"])
            objs.append(finalize(lens, smooth=True))
        objs.append(finalize(box("LightPod_Bar", 0.03, 0.9, 0.03, center=(body.x_of(0.03), 0, pz - 0.10),
                                 mat=mats["trim"]), smooth=False))
        lamps.append(add_light_lamp("Podlamp", 'SPOT', (body.x_of(0) - 0.2, 0, pz), 60.0, (1, 0.97, 0.9),
                                    spot=1.1, direction=(-1, 0, -0.05)))
    heads = join(objs, "Lights_Intakes")
    return heads, lamps

# --------------------------------------------------------------------------- #
#  Customization kit (separate library .glb)
# --------------------------------------------------------------------------- #
def build_kit(spec, mats):
    """A laid-out parts library the app can swap onto the car."""
    L = spec["length"]
    items = []
    x = 0.0
    def place(obj, gap=0.8):
        nonlocal x
        if obj:
            obj.location.x = x
            x += gap
            items.append(obj)
    # hood styles
    for i, style in enumerate(("Flat", "Vented", "Scooped")):
        h = box(f"Kit_Hood_{style}", 1.2, 1.0, 0.06, mat=mats["paint"])
        if style == "Vented":
            h = join([h, box("v", 0.15, 0.5, 0.03, center=(0, 0, 0.05), mat=mats["intake"])], f"Kit_Hood_{style}")
        if style == "Scooped":
            h = join([h, box("s", 0.4, 0.3, 0.15, center=(0, 0, 0.1), mat=mats["intake"])], f"Kit_Hood_{style}")
        place(finalize(h, smooth=True))
    # front bumpers
    for style in ("Street", "GT", "Aero"):
        b = box(f"Kit_FrontBumper_{style}", 0.4, 1.6, 0.4, mat=mats["trim"])
        place(finalize(b, smooth=False))
    # rear bumpers
    for style in ("Street", "Diffuser"):
        b = box(f"Kit_RearBumper_{style}", 0.4, 1.5, 0.4, mat=mats["trim"])
        place(finalize(b, smooth=False))
    # roof scoops
    for style in ("Low", "Ram", "Snorkel"):
        s = box(f"Kit_RoofScoop_{style}", 0.4, 0.4, 0.25, mat=mats["intake"])
        place(finalize(s, smooth=False), 0.6)
    # exhaust tips
    for style, n in (("Single", 1), ("Dual", 2), ("Quad", 4)):
        tips = [cylinder("t", 0.05, 0.18, 12, axis='X', center=(0, (k - (n - 1) / 2) * 0.14, 0), mat=mats["chrome"]) for k in range(n)]
        place(finalize(join(tips, f"Kit_Exhaust_{style}"), smooth=False), 0.7)
    # roll cage
    cg = [tube("c", (-0.3, 0.4, 0), (-0.3, 0.4, 0.6), 0.03, mat=mats["cage"]),
          tube("c", (-0.3, -0.4, 0), (-0.3, -0.4, 0.6), 0.03, mat=mats["cage"]),
          tube("c", (-0.3, 0.4, 0.6), (-0.3, -0.4, 0.6), 0.03, mat=mats["cage"])]
    place(finalize(join(cg, "Kit_RollCage"), smooth=False))
    # rim sets
    for style in ("5spoke", "10spoke", "turbine"):
        w = make_wheel(f"Kit_Rim_{style}", 0.34, 0.24, style, mats["tire"], mats["rim"], mats["brand"])
        w.rotation_euler = (0, 0, math.radians(90))
        place(w, 0.9)
    # window tint swatches
    for name, tint, alpha in (("Light", (0.2, 0.22, 0.25), 0.55),
                              ("Medium", (0.05, 0.06, 0.07), 0.4),
                              ("Limo", (0.01, 0.01, 0.01), 0.75)):
        gm = mat_glass(f"Tint_{name}", tint=tint, alpha=alpha)
        sw = box(f"Kit_Tint_{name}", 0.5, 0.02, 0.5, mat=gm)
        place(finalize(sw, smooth=True), 0.6)
    return items

# --------------------------------------------------------------------------- #
#  Assemble one full vehicle
# --------------------------------------------------------------------------- #
def build_vehicle(spec):
    clear_scene()
    color = spec["color"]
    mats = {
        "paint":     mat_paint("Paint_" + spec["id"], color, metallic=spec.get("metallic", 0.9)),
        "glass":     mat_glass("Glass_" + spec["id"], tint=spec.get("tint", (0.03, 0.04, 0.05)),
                               alpha=spec.get("tint_alpha", 0.35)),
        "tire":      mat_simple("Tire", (0.02, 0.02, 0.02), rough=0.9),
        "brand":     mat_simple("TireBrand", (0.5, 0.5, 0.5), rough=0.6),
        "rim":       mat_paint("Rim", spec.get("rim_color", (0.75, 0.76, 0.8)), metallic=1.0, rough=0.2, coat=0),
        "head":      mat_emit("Headlight_Emit", (0.95, 0.97, 1.0), strength=spec.get("head_strength", 7)),
        "tail":      mat_emit("Taillight_Emit", (1.0, 0.05, 0.05), strength=6),
        "intake":    mat_simple("Intake", (0.03, 0.03, 0.03), rough=0.8),
        "trim":      mat_paint("Trim", (0.05, 0.05, 0.05), metallic=0.6, rough=0.4, coat=0),
        "chrome":    mat_paint("Chrome", (0.85, 0.85, 0.88), metallic=1.0, rough=0.15, coat=0),
        "interior":  mat_simple("Interior", (0.06, 0.06, 0.07), rough=0.6),
        "seat":      mat_simple("Seat", (0.12, 0.03, 0.03), rough=0.7),
        "driver":    mat_simple("Driver", (0.1, 0.1, 0.12), rough=0.5),
        "cage":      mat_paint("Cage", (0.8, 0.3, 0.2), metallic=0.7, rough=0.3, coat=0),
    }
    body = Body(spec)
    body.build(mats["paint"])
    st = body.st

    # split greenhouse glass (raked windscreen + rear window)
    make_windshield(body, st["cowl"], st["roof_f"], 0.86, 0.99, mats["glass"], "Windshield")
    make_windshield(body, st["roof_r"], st["deck"], 0.99, 0.80, mats["glass"], "RearWindshield")
    # split doors (front-hinged, UI-openable)
    make_door(body, 1, mats["paint"], mats["glass"], "Door_FL")
    make_door(body, -1, mats["paint"], mats["glass"], "Door_FR")

    # wheels tucked into flared fender wells at the axles (slammed + cambered)
    R = spec["wheel_r"]; TW = spec["wheel_w"]
    style = spec["rim_style"]
    flare = spec.get("flare", 1.0)
    cam = math.radians(spec.get("camber", 2.5))         # negative camber (top tucked in)
    fx = body.x_of(st["ax_f"]); rx = body.x_of(st["ax_r"])
    fwy = body.width(st["ax_f"]) * 0.98
    rwy = body.width(st["ax_r"]) * 0.98
    for nm, px, py, sd in (("Wheel_FL", fx, fwy, 1), ("Wheel_FR", fx, -fwy, -1),
                           ("Wheel_RL", rx, rwy, 1), ("Wheel_RR", rx, -rwy, -1)):
        w = make_wheel(nm, R, TW, style, mats["tire"], mats["rim"], mats["brand"], side=sd)
        w.location = (px, py, R)
        w.rotation_euler = (cam * sd, 0, 0)             # negative camber (top inboard)
        # the body's arch cutout is the fender; add only a thin lip for overfender cars
        if flare > 1.05:
            make_arch(body, "Fender", px, py, R, TW, mats["paint"], flare=flare * 0.6)

    build_interior(body, mats)
    build_lights_intakes(body, spec, mats)
    build_fitted_parts(body, spec, mats)
    for o in build_signature(body, spec, mats):        # JDM signature kit
        pass
    return body, mats

# --------------------------------------------------------------------------- #
#  glTF export helpers
# --------------------------------------------------------------------------- #
def export_glb(filepath):
    kwargs = dict(filepath=filepath, export_format='GLB', use_selection=False,
                  export_apply=True, export_yup=True, export_lights=True,
                  export_extras=True)
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        bpy.ops.export_scene.gltf(filepath=filepath, export_format='GLB')

def bake_decimate(ratio):
    for obj in list(bpy.data.objects):
        if obj.type != 'MESH' or len(obj.data.polygons) < 60:
            continue
        m = obj.modifiers.new("dec", 'DECIMATE')
        m.decimate_type = 'COLLAPSE'; m.ratio = ratio
        deg = bpy.context.evaluated_depsgraph_get()      # fresh graph AFTER adding modifier
        ev = obj.evaluated_get(deg)
        newme = bpy.data.meshes.new_from_object(ev)
        obj.modifiers.remove(m)
        old = obj.data; obj.data = newme
        try: bpy.data.meshes.remove(old)
        except Exception: pass

def tri_count():
    n = 0
    for o in bpy.data.objects:
        if o.type == 'MESH':
            for p in o.data.polygons:
                n += len(p.vertices) - 2
    return n

def remove_render_helpers():
    for nm in ("PreviewCam", "PreviewGround", "PreviewSun", "PreviewFill"):
        o = bpy.data.objects.get(nm)
        if o: bpy.data.objects.remove(o, do_unlink=True)

# --------------------------------------------------------------------------- #
#  Cycles-CPU preview render
# --------------------------------------------------------------------------- #
def render_preview(spec, body):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 24
    try: scene.cycles.use_denoising = True
    except Exception: pass
    scene.render.resolution_x = 640
    scene.render.resolution_y = 420
    scene.render.film_transparent = False
    # world
    world = bpy.data.worlds.new("PW") if not bpy.data.worlds else bpy.data.worlds[0]
    scene.world = world; world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg: bg.inputs[0].default_value = (0.05, 0.06, 0.08, 1); bg.inputs[1].default_value = 0.6
    # ground
    g = box("PreviewGround", body.L * 4, body.width_full * 4 if hasattr(body, 'width_full') else 12, 0.02,
            center=(0, 0, -0.01), mat=mat_simple("GroundMat", (0.08, 0.08, 0.09), rough=0.9))
    finalize(g)
    # sun + fill
    add_light_lamp("PreviewSun", 'SUN', (4, 4, 8), 4.0, (1, 0.98, 0.95), direction=(-0.5, -0.5, -1))
    add_light_lamp("PreviewFill", 'AREA', (-4, -3, 4), 200.0, (0.6, 0.7, 1.0))
    cam_d = bpy.data.cameras.new("PreviewCam"); cam = bpy.data.objects.new("PreviewCam", cam_d)
    link(cam); scene.camera = cam
    scene.render.image_settings.file_format = 'PNG'
    zc = body.z0 + body.Hh * 0.36
    # --- true side profile (matches the reference poster) ---
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = body.L * 1.18
    cam.location = (0.0, -body.L * 1.6, zc)
    cam.rotation_euler = (Vector((0, 0, zc)) - Vector(cam.location)).to_track_quat('-Z', 'Y').to_euler()
    scene.render.resolution_x = 760; scene.render.resolution_y = 380
    scene.render.filepath = os.path.join(PREVIEWS_SIDE, spec["id"] + ".png")
    bpy.ops.render.render(write_still=True)
    # --- 3/4 hero ---
    cam.data.type = 'PERSP'; cam.data.lens = 52
    dist = body.L * 1.7
    cam.location = (-dist * 0.72, -dist * 0.72, body.Hh + body.z0 + body.L * 0.30)
    cam.rotation_euler = (Vector((0, 0, zc)) - Vector(cam.location)).to_track_quat('-Z', 'Y').to_euler()
    scene.render.resolution_x = 640; scene.render.resolution_y = 420
    scene.render.filepath = os.path.join(PREVIEWS, spec["id"] + ".png")
    bpy.ops.render.render(write_still=True)

# --------------------------------------------------------------------------- #
#  Vehicle catalog (35 specs)
# --------------------------------------------------------------------------- #
# Iconic '90s JDM colours
COL = dict(
    white=(0.92, 0.92, 0.93), champ=(0.95, 0.95, 0.96), bayside=(0.05, 0.22, 0.62),
    red=(0.74, 0.03, 0.05), rblue=(0.04, 0.15, 0.55), yellow=(0.95, 0.78, 0.03),
    silver=(0.62, 0.64, 0.68), gun=(0.17, 0.19, 0.23), black=(0.03, 0.03, 0.04),
    orange=(0.93, 0.40, 0.02), green=(0.03, 0.40, 0.22), sonic=(0.09, 0.45, 0.85),
    purple=(0.30, 0.06, 0.42), pearl=(0.88, 0.86, 0.82),
)
GOLD = (0.72, 0.58, 0.16); BRONZE = (0.45, 0.32, 0.12)
DARKRIM = (0.10, 0.10, 0.11); SILVERRIM = (0.76, 0.77, 0.80)

# Per body-type default dimensions (metres)
BT_DIM = dict(   # big wheels + low ride = the slammed reference stance
    coupe_low=dict(length=4.42, width=1.80, height=1.23, wheel_r=0.345, wheel_w=0.31),
    fastback =dict(length=4.62, width=1.83, height=1.26, wheel_r=0.345, wheel_w=0.31),
    sedan    =dict(length=4.56, width=1.79, height=1.40, wheel_r=0.350, wheel_w=0.30),
    hatch    =dict(length=4.08, width=1.72, height=1.36, wheel_r=0.335, wheel_w=0.29),
    wedge    =dict(length=4.48, width=1.83, height=1.17, wheel_r=0.345, wheel_w=0.31),
    roadster =dict(length=3.98, width=1.70, height=1.21, wheel_r=0.325, wheel_w=0.28),
)

# The 30 cars.  cls groups the fleet (rally / sport / race); bt is the shell.
# Names use enthusiast chassis codes — original tribute designs, no badging.
JDM = [
    # ---------------- RALLY (Group A / WRC-era, raised, overfenders) ----------------
    dict(cls="rally", code="CE9A", name="AWD Rally Sedan · Evo III", bt="sedan", color=COL["white"],
         rim=GOLD, ride=0.08, flare=1.45, wing="gt", hood_scoop=1, mud_flaps=1, roof_vent=1, vgen=1),
    dict(cls="rally", code="CP9A", name="AWD Rally Sedan · Evo VI", bt="sedan", color=COL["red"],
         rim=GOLD, ride=0.08, flare=1.45, wing="gt2", hood_scoop=1, canards=1, mud_flaps=1, vgen=1),
    dict(cls="rally", code="GC8", name="Boxer AWD · Type-RA STi", bt="sedan", color=COL["rblue"],
         rim=GOLD, ride=0.08, flare=1.55, wing="gt", hood_scoop=1, mud_flaps=1),
    dict(cls="rally", code="RNN14", name="Turbo AWD Hatch · Pulsar GTi-R", bt="hatch", color=COL["black"],
         rim=BRONZE, ride=0.09, flare=1.4, wing="gt", hood_scoop=1, mud_flaps=1),
    dict(cls="rally", code="ST205", name="Turbo AWD Liftback · GT-Four", bt="fastback", color=COL["white"],
         rim=SILVERRIM, ride=0.07, flare=1.4, wing="gt", hood_scoop=1, light_pod=1, mud_flaps=1),
    dict(cls="rally", code="BG8Z", name="Compact AWD · Familia GT-R", bt="hatch", color=COL["red"],
         rim=SILVERRIM, ride=0.09, flare=1.35, wing="gt", hood_scoop=1, mud_flaps=1, light_pod=1),
    dict(cls="rally", code="AE86", name="RWD Rally Coupe · Group A", bt="hatch", color=COL["white"],
         rim=SILVERRIM, ride=0.07, flare=1.3, wing="lip", light_pod=1, mud_flaps=1),
    dict(cls="rally", code="ST185", name="Safari AWD Liftback · Celica", bt="fastback", color=COL["rblue"],
         rim=SILVERRIM, ride=0.10, flare=1.4, wing="gt", hood_scoop=1, light_pod=1, mud_flaps=1),

    # ---------------- SPORT (street icons) ----------------
    dict(cls="sport", code="FD3S", name="Twin-Rotor Coupe · RX Type-R", bt="coupe_low", color=COL["yellow"],
         rim=SILVERRIM, flare=1.15, wing="gt", tint=(0.03, 0.03, 0.04), tint_alpha=0.32),
    dict(cls="sport", code="FC3S", name="Rotary Coupe · Turbo II", bt="coupe_low", color=COL["white"],
         rim=SILVERRIM, wing="lip"),
    dict(cls="sport", code="A80", name="Twin-Turbo Fastback · 2JZ", bt="fastback", color=COL["red"],
         rim=SILVERRIM, flare=1.1, wing="gt"),
    dict(cls="sport", code="Z32", name="T-Bar Twin-Turbo · 300", bt="fastback", color=COL["black"],
         rim=SILVERRIM, wing="lip"),
    dict(cls="sport", code="NA1", name="Mid-Ship V6 · VTEC", bt="wedge", color=COL["red"],
         rim=SILVERRIM, side_intake=1, wing="lip"),
    dict(cls="sport", code="SW20", name="Mid-Ship Turbo · GT-S", bt="wedge", color=COL["yellow"],
         rim=SILVERRIM, side_intake=1, wing="gt"),
    dict(cls="sport", code="S13", name="Drift Coupe · Silvia K's", bt="coupe_low", color=COL["silver"],
         rim=DARKRIM, wing="lip"),
    dict(cls="sport", code="S14", name="Drift Coupe · Kouki", bt="coupe_low", color=COL["sonic"],
         rim=DARKRIM, flare=1.2, wing="gt"),
    dict(cls="sport", code="S15", name="Drift Coupe · Spec-R", bt="coupe_low", color=COL["purple"],
         rim=BRONZE, flare=1.2, wing="gt", canards=1),
    dict(cls="sport", code="180SX", name="Pop-up Fastback · Type-X", bt="fastback", color=COL["green"],
         rim=SILVERRIM, wing="lip"),
    dict(cls="sport", code="AE86", name="Hachi-Roku Coupe · Trueno", bt="hatch", color=COL["white"],
         rim=SILVERRIM, wing="lip"),
    dict(cls="sport", code="EK9", name="VTEC Hatch · Type-R", bt="hatch", color=COL["champ"],
         rim=GOLD, wing="lip"),
    dict(cls="sport", code="DC2", name="VTEC Coupe · Integra Type-R", bt="coupe_low", color=COL["champ"],
         rim=GOLD, wing="gt"),
    dict(cls="sport", code="NA6", name="Roadster · 1.6 Convertible", bt="roadster", color=COL["red"],
         rim=SILVERRIM, wing="none"),
    dict(cls="sport", code="JZZ30", name="GT Coupe · Twin-Turbo Soarer", bt="fastback", color=COL["pearl"],
         rim=SILVERRIM, wing="lip"),
    dict(cls="sport", code="R32", name="AWD Icon · Skyline GT-R", bt="coupe_low", color=COL["gun"],
         rim=GOLD, flare=1.3, wing="gt"),
    dict(cls="sport", code="R33", name="AWD Icon · GT-R V-Spec", bt="coupe_low", color=COL["silver"],
         rim=GOLD, flare=1.3, wing="gt"),
    dict(cls="sport", code="R34", name="AWD Icon · GT-R Nür", bt="coupe_low", color=COL["bayside"],
         rim=SILVERRIM, flare=1.3, wing="gt2", vgen=1),

    # ---------------- RACE (GT300/GT500/Group A track spec) ----------------
    dict(cls="race", code="FD3S", name="GT300 Rotary · Race", bt="coupe_low", color=COL["orange"],
         rim=DARKRIM, ride=-0.02, flare=1.6, wing="gt2", canards=1, roll_cage=1, wheel_w=0.34, head_strength=5),
    dict(cls="race", code="A80", name="GT500 Fastback · Race", bt="fastback", color=COL["white"],
         rim=DARKRIM, ride=-0.02, flare=1.6, wing="gt2", canards=1, roll_cage=1, wheel_w=0.34, head_strength=5),
    dict(cls="race", code="CP9A", name="Super-Taikyu Sedan · Race", bt="sedan", color=COL["red"],
         rim=DARKRIM, ride=-0.01, flare=1.5, wing="gt2", canards=1, roll_cage=1, wheel_w=0.32, head_strength=5),
    dict(cls="race", code="R32", name="Group A Legend · Race", bt="coupe_low", color=COL["white"],
         rim=DARKRIM, ride=-0.02, flare=1.55, wing="gt2", canards=1, roll_cage=1, wheel_w=0.34, head_strength=5),
]

def make_catalog():
    specs = []
    ctr = {}
    for c in JDM:
        cls = c["cls"]; i = ctr.get(cls, 0); ctr[cls] = i + 1
        bt = c["bt"]
        s = dict(cls=cls, body_type=bt, id=f"{cls}_{i:02d}", code=c["code"], name=c["name"],
                 color=c["color"], metallic=c.get("metallic", 0.85),
                 rim_style=c.get("rim_style", ("5spoke", "10spoke", "turbine")[i % 3]),
                 rim_color=c.get("rim", SILVERRIM), wing=c.get("wing", "lip"),
                 exhaust=c.get("exhaust", 2), tint=c.get("tint", (0.04, 0.05, 0.06)),
                 tint_alpha=c.get("tint_alpha", 0.4), head_strength=c.get("head_strength", 7),
                 ride=c.get("ride", 0.0), flare=c.get("flare", 1.0))
        s.update(BT_DIM[bt])
        for k in ("length", "width", "height", "wheel_r", "wheel_w"):
            if k in c: s[k] = c[k]
        for f in ("hood_scoop", "roof_vent", "vgen", "canards", "mud_flaps",
                  "light_pod", "side_intake", "roll_cage", "roof_scoop"):
            if c.get(f): s[f] = True
        specs.append(s)
    return specs

# --------------------------------------------------------------------------- #
#  Main
# --------------------------------------------------------------------------- #
def main():
    t_start = time.time()
    specs = make_catalog()
    if ONLY:
        specs = specs[:ONLY]
    manifest = {"generator": "generate_cars.py", "count": len(specs),
                "format": "glb", "up_axis": "Y", "vehicles": []}
    for idx, spec in enumerate(specs):
        t0 = time.time()
        print(f"[{idx+1}/{len(specs)}] {spec['name']} ({spec['id']}) …", flush=True)
        body, mats = build_vehicle(spec)
        body.width_full = spec["width"]
        lod0 = tri_count()
        # LOD0
        f0 = os.path.join(MODELS, spec["id"] + ".glb"); export_glb(f0)
        # preview (before decimation / helpers pollute LOD1)
        if RENDER_PREVIEWS:
            try: render_preview(spec, body)
            except Exception as e: print("   preview failed:", e)
            remove_render_helpers()
            # renders switch engine; nothing else needed
        # LOD1
        bake_decimate(0.55); lod1 = tri_count()
        export_glb(os.path.join(MODELS, spec["id"] + "_lod1.glb"))
        # LOD2
        bake_decimate(0.5); lod2 = tri_count()
        export_glb(os.path.join(MODELS, spec["id"] + "_lod2.glb"))
        # customization kit (fresh scene)
        clear_scene()
        kit_mats = {
            "paint": mat_paint("KPaint", spec["color"]),
            "trim": mat_paint("KTrim", (0.05, 0.05, 0.05), coat=0),
            "intake": mat_simple("KIntake", (0.03, 0.03, 0.03), rough=0.8),
            "chrome": mat_paint("KChrome", (0.85, 0.85, 0.88), metallic=1, rough=0.15, coat=0),
            "cage": mat_paint("KCage", (0.8, 0.3, 0.2), coat=0),
            "tire": mat_simple("KTire", (0.02, 0.02, 0.02), rough=0.9),
            "brand": mat_simple("KBrand", (0.5, 0.5, 0.5)),
            "rim": mat_paint("KRim", spec["rim_color"], metallic=1, rough=0.2, coat=0),
        }
        build_kit(spec, kit_mats)
        export_glb(os.path.join(MODELS, spec["id"] + "_customization_kit.glb"))
        manifest["vehicles"].append({
            "id": spec["id"], "name": spec["name"], "class": spec["cls"],
            "code": spec.get("code", ""), "body_type": spec.get("body_type", ""),
            "color_hex": "#%02x%02x%02x" % tuple(int(c * 255) for c in spec["color"]),
            "files": {
                "lod0": f"models/{spec['id']}.glb",
                "lod1": f"models/{spec['id']}_lod1.glb",
                "lod2": f"models/{spec['id']}_lod2.glb",
                "kit":  f"models/{spec['id']}_customization_kit.glb",
                "preview": f"previews/{spec['id']}.png",
                "preview_side": f"previews_side/{spec['id']}.png",
            },
            "tris": {"lod0": lod0, "lod1": lod1, "lod2": lod2},
            "split_meshes": ["Windshield", "RearWindshield", "Door_FL", "Door_FR"],
            "openable_doors": ["Door_FL", "Door_FR"],
            "lights": ["Headlamp", "Taillamp"],
            "customization": ["Hood", "FrontBumper", "RearBumper", "RoofScoop",
                              "Exhaust", "RollCage", "RearWing", "WindowTint", "RimSet"],
        })
        print(f"   done  tris L0={lod0} L1={lod1} L2={lod2}  ({time.time()-t0:.1f}s)", flush=True)

    with open(os.path.join(OUT, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"\nAll done: {len(specs)} vehicles in {time.time()-t_start:.1f}s -> {OUT}")

if __name__ == "__main__":
    main()
