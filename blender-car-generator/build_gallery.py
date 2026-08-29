#!/usr/bin/env python3
"""Build a self-contained showroom gallery (output/gallery.html) from manifest.json + previews."""
import base64, json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "output")

with open(os.path.join(OUT, "manifest.json")) as fh:
    man = json.load(fh)

CLASS = {
    "rally": ("Rally",  "Group A / WRC-era — raised stance, overfenders, hood scoop, mud flaps, big wing", "--rally"),
    "sport": ("Sport",  "Street icons — rotary coupes, twin-turbo fastbacks, hatches & mid-ships",         "--sport"),
    "race":  ("Race",   "GT300 / GT500 / Group A track spec — roll cage, canards, slicks, GT wing",        "--race"),
}

def b64(path, folder="previews_web"):
    web = os.path.join(OUT, folder, os.path.basename(path).replace(".png", ".jpg"))
    if os.path.exists(web):
        with open(web, "rb") as f:
            return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()
    p = os.path.join(OUT, path)
    if not os.path.exists(p):
        return ""
    with open(p, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()

vehicles = man["vehicles"]
by_class = {"rally": [], "sport": [], "race": []}
for v in vehicles:
    by_class[v["class"]].append(v)

tot_tris = sum(v["tris"]["lod0"] for v in vehicles)
tot_files = len(vehicles) * 4

def card(v):
    side = b64(v["files"].get("preview_side", v["files"]["preview"]), "previews_web")
    hero = b64(v["files"]["preview"], "previews_web3q")
    t = v["tris"]
    imghtml = (f'<img src="{side}" alt="{v["name"]} side profile" loading="lazy">' if side
               else '<div class="noimg">no preview</div>')
    thumb = f'<img class="thumb" src="{hero}" alt="{v["name"]} 3/4 view" loading="lazy">' if hero else ''
    return f'''
    <article class="card {v['class']}">
      <div class="bay">{imghtml}{thumb}
        <span class="badge">{CLASS[v['class']][0]}</span>
        <span class="swatch" style="--c:{v['color_hex']}"></span>
      </div>
      <div class="meta">
        <div class="namerow"><h3>{v['name']}</h3><span class="code">{v.get('code','')}</span></div>
        <div class="id">{v['id']} · {v.get('body_type','')}</div>
        <div class="specs">
          <div><span class="k">LOD0</span><span class="val">{t['lod0']:,}</span><span class="u">tris</span></div>
          <div><span class="k">LOD1</span><span class="val">{t['lod1']:,}</span><span class="u">tris</span></div>
          <div><span class="k">LOD2</span><span class="val">{t['lod2']:,}</span><span class="u">tris</span></div>
        </div>
        <div class="tags">
          <span class="tag">2 openable doors</span>
          <span class="tag">split glass</span>
          <span class="tag">emissive lights</span>
          <span class="tag">+ kit</span>
        </div>
      </div>
    </article>'''

sections = ""
for cls in ("rally", "sport", "race"):
    label, desc, _ = CLASS[cls]
    cards = "".join(card(v) for v in by_class[cls])
    sections += f'''
    <section>
      <header class="sec {cls}">
        <h2>{label}</h2>
        <p>{desc}</p>
        <span class="count">{len(by_class[cls])} models</span>
      </header>
      <div class="grid">{cards}</div>
    </section>'''

html = f'''<title>'90s JDM Legends — {man['count']} Low-Poly Cars</title>
<style>
:root {{
  --bg:#0e1014; --panel:#161a20; --bay:#0a0c10; --line:#262c35;
  --ink:#eef1f4; --muted:#9aa4b0; --dim:#69727d;
  --accent:#ff7a18;
  --race:#ff3b46; --rally:#e0a52c; --sport:#25c4d8;
  --shadow:0 1px 0 rgba(255,255,255,.03), 0 12px 30px -14px rgba(0,0,0,.7);
}}
:root[data-theme="light"] {{
  --bg:#eceef1; --panel:#ffffff; --bay:#0a0c10; --line:#dce0e6;
  --ink:#141922; --muted:#55606d; --dim:#8a94a0;
  --shadow:0 1px 0 rgba(255,255,255,.6), 0 14px 34px -18px rgba(20,30,50,.35);
}}
@media (prefers-color-scheme: light) {{
  :root:not([data-theme="dark"]) {{
    --bg:#eceef1; --panel:#ffffff; --line:#dce0e6;
    --ink:#141922; --muted:#55606d; --dim:#8a94a0;
    --shadow:0 1px 0 rgba(255,255,255,.6), 0 14px 34px -18px rgba(20,30,50,.35);
  }}
}}
* {{ box-sizing:border-box; }}
body {{
  margin:0; background:var(--bg); color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased; line-height:1.5;
}}
.cond {{ font-family:"Arial Narrow","Roboto Condensed",Oswald,"Helvetica Neue",sans-serif; }}
.wrap {{ max-width:1200px; margin:0 auto; padding:0 24px 80px; }}

/* ---- header ---- */
.top {{
  border-bottom:1px solid var(--line);
  background:
    radial-gradient(120% 140% at 85% -20%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 60%),
    var(--bg);
}}
.top .wrap {{ padding-top:56px; padding-bottom:34px; }}
.eyebrow {{
  font:600 12px/1 -apple-system,sans-serif; letter-spacing:.28em; text-transform:uppercase;
  color:var(--accent); margin:0 0 18px;
}}
h1 {{
  font-family:"Arial Narrow","Roboto Condensed",Oswald,sans-serif;
  font-weight:700; text-transform:uppercase; letter-spacing:.01em;
  font-size:clamp(38px,7vw,78px); line-height:.94; margin:0; text-wrap:balance;
}}
h1 b {{ color:var(--accent); font-weight:700; }}
.lede {{ color:var(--muted); max-width:60ch; margin:18px 0 0; font-size:17px; }}
.stats {{
  display:flex; flex-wrap:wrap; gap:14px; margin-top:30px;
}}
.stat {{
  background:var(--panel); border:1px solid var(--line); border-radius:12px;
  padding:14px 18px; box-shadow:var(--shadow); min-width:120px;
}}
.stat .n {{
  font-family:"Arial Narrow","Roboto Condensed",sans-serif; font-weight:700;
  font-size:30px; line-height:1; font-variant-numeric:tabular-nums;
}}
.stat .l {{ color:var(--dim); font-size:12px; letter-spacing:.12em; text-transform:uppercase; margin-top:6px; }}

/* ---- sections ---- */
section {{ margin-top:56px; }}
.sec {{ display:flex; align-items:baseline; gap:16px; flex-wrap:wrap;
  border-bottom:1px solid var(--line); padding-bottom:12px; margin-bottom:24px; }}
.sec::before {{ content:""; width:10px; height:26px; border-radius:3px; background:var(--cc); align-self:center; }}
.sec.race {{ --cc:var(--race); }} .sec.rally {{ --cc:var(--rally); }} .sec.sport {{ --cc:var(--sport); }}
.sec h2 {{ font-family:"Arial Narrow","Roboto Condensed",sans-serif; text-transform:uppercase;
  letter-spacing:.03em; font-size:30px; margin:0; }}
.sec p {{ color:var(--muted); margin:0; flex:1 1 260px; font-size:14px; }}
.sec .count {{ color:var(--dim); font-size:13px; letter-spacing:.1em; text-transform:uppercase;
  font-variant-numeric:tabular-nums; }}

.grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:18px; }}

/* ---- card ---- */
.card {{
  background:var(--panel); border:1px solid var(--line); border-radius:14px; overflow:hidden;
  box-shadow:var(--shadow); transition:transform .18s ease, border-color .18s ease;
}}
.card:hover {{ transform:translateY(-3px); border-color:color-mix(in srgb, var(--cc) 55%, var(--line)); }}
.card.race {{ --cc:var(--race); }} .card.rally {{ --cc:var(--rally); }} .card.sport {{ --cc:var(--sport); }}
.namerow {{ display:flex; align-items:baseline; justify-content:space-between; gap:8px; }}
.code {{ font-family:"Arial Narrow","Roboto Condensed",sans-serif; font-weight:700; font-size:13px;
  letter-spacing:.08em; color:var(--cc); background:color-mix(in srgb,var(--cc) 14%, transparent);
  border:1px solid color-mix(in srgb,var(--cc) 40%, transparent); padding:2px 7px; border-radius:5px;
  white-space:nowrap; }}
.bay {{
  position:relative; aspect-ratio:2/1; background:
    radial-gradient(90% 90% at 50% 46%, #1a1f27 0%, var(--bay) 72%);
  display:flex; align-items:center; justify-content:center;
}}
.bay > img {{ width:100%; height:100%; object-fit:contain; display:block; }}
.thumb {{ position:absolute; right:8px; bottom:8px; width:38%; border-radius:7px;
  border:1px solid rgba(255,255,255,.12); background:var(--bay);
  box-shadow:0 4px 12px -4px rgba(0,0,0,.7); }}
.noimg {{ color:var(--dim); font-size:13px; }}
.badge {{
  position:absolute; top:10px; left:10px; z-index:2;
  font:600 10.5px/1 -apple-system,sans-serif; letter-spacing:.16em; text-transform:uppercase;
  color:#fff; background:color-mix(in srgb, var(--cc) 85%, black 10%);
  padding:6px 9px; border-radius:6px;
}}
.swatch {{ position:absolute; top:10px; right:10px; width:20px; height:20px; border-radius:50%;
  background:var(--c); border:2px solid rgba(255,255,255,.7); box-shadow:0 2px 6px rgba(0,0,0,.5); }}
.meta {{ padding:14px 16px 16px; }}
.meta h3 {{ font-family:"Arial Narrow","Roboto Condensed",sans-serif; text-transform:uppercase;
  letter-spacing:.02em; font-size:22px; margin:0; }}
.meta .id {{ color:var(--dim); font-size:11.5px; letter-spacing:.1em; margin-top:2px;
  font-variant-numeric:tabular-nums; }}
.specs {{ display:flex; gap:14px; margin:12px 0; padding:10px 0; border-block:1px solid var(--line); }}
.specs > div {{ display:flex; flex-direction:column; gap:1px; }}
.specs .k {{ font-size:10px; letter-spacing:.12em; color:var(--dim); text-transform:uppercase; }}
.specs .val {{ font-family:"Arial Narrow","Roboto Condensed",sans-serif; font-weight:700;
  font-size:18px; font-variant-numeric:tabular-nums; }}
.specs .u {{ font-size:10px; color:var(--dim); }}
.tags {{ display:flex; flex-wrap:wrap; gap:6px; }}
.tag {{ font-size:11px; color:var(--muted); background:color-mix(in srgb, var(--ink) 6%, transparent);
  border:1px solid var(--line); padding:3px 8px; border-radius:20px; }}
footer {{ margin-top:64px; color:var(--dim); font-size:13px; border-top:1px solid var(--line); padding-top:24px; }}
footer code {{ color:var(--muted); background:color-mix(in srgb,var(--ink) 8%, transparent);
  padding:2px 6px; border-radius:5px; }}
</style>

<div class="top"><div class="wrap">
  <p class="eyebrow">Procedural Blender → Three.js asset pack · '90s JDM tribute</p>
  <h1>'90s JDM Legends<br><b>{man['count']} Low-Poly Cars</b></h1>
  <p class="lede">Rally weapons, rotary coupes, twin-turbo fastbacks, mid-ships and GT racers — each
  modelled from its own chassis-specific silhouette and kit. Split windscreens, two UI-openable doors,
  emissive lights that actually cast light, branded tires, a driver dummy and a full customization kit.
  Three LODs per vehicle, glTF materials tuned for Three.js. Original tribute designs — no badging.</p>
  <div class="stats">
    <div class="stat"><div class="n">{man['count']}</div><div class="l">Vehicles</div></div>
    <div class="stat"><div class="n">{tot_files}</div><div class="l">GLB files</div></div>
    <div class="stat"><div class="n">3</div><div class="l">LODs each</div></div>
    <div class="stat"><div class="n">{tot_tris:,}</div><div class="l">Total tris (LOD0)</div></div>
  </div>
</div></div>

<div class="wrap">{sections}
  <footer>
    Generated by <code>generate_cars.py</code> (Blender <code>bpy</code> 5.x, headless) ·
    files under <code>output/models/</code> · catalog in <code>manifest.json</code>.
    Renders are Cycles-CPU previews; the shipped assets are the <code>.glb</code> meshes.
  </footer>
</div>'''

with open(os.path.join(OUT, "gallery.html"), "w") as fh:
    fh.write(html)
print("wrote", os.path.join(OUT, "gallery.html"), f"({len(html)//1024} KB + images)")
