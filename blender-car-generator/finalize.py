#!/usr/bin/env python3
"""Post-process: compress previews (side + 3/4) for the web gallery."""
from PIL import Image
import os, glob

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")

def compress(src_dir, dst_dir, size, q=82):
    os.makedirs(os.path.join(OUT, dst_dir), exist_ok=True)
    tot = 0
    for p in sorted(glob.glob(os.path.join(OUT, src_dir, "*.png"))):
        im = Image.open(p).convert("RGB").resize(size, Image.LANCZOS)
        out = os.path.join(OUT, dst_dir, os.path.basename(p).replace(".png", ".jpg"))
        im.save(out, "JPEG", quality=q, optimize=True)
        tot += os.path.getsize(out)
    print(f"  {dst_dir}: {tot // 1024} KB")

print("compressing previews …")
compress("previews_side", "previews_web", (660, 330))     # side hero
compress("previews", "previews_web3q", (380, 250))         # 3/4 thumbnail
print("done")
