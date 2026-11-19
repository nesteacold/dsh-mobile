# Derives the two glyph inputs of .build.py from the reviewed artwork. Nothing here is hand-drawn.
# concept-glyph.png keeps only the concept's ALPHA EDGE: any pixel that is essentially the flat navy field
# becomes fully transparent, any pixel that is essentially an ink (mist ring / ocean star) stays fully
# opaque, and only anti-aliased edge pixels keep partial alpha. On an edge pixel the platform shows
#   field*(1-a) + ink*a  (alpha compositing, sRGB values straight from theme.ts's hex codes)
# so the coverage is the least-squares blend that reproduces the concept's encoded colour, solved per
# pixel over both candidate inks, minus the encoder's own colour shift (measured by .probe.mjs; the only
# shift that matters on this artwork is navy #06172B -> (13,22,42), i.e. +7 on R).

from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
AUTHORED_FIELD = np.array([6, 23, 43], dtype=np.float64)   # theme.ts brand.navy #06172B
ENCODE_SHIFT = np.array([7, -1, -1], dtype=np.float64)     # navy #06172B -> (13,22,42): +7 R, -1 G, -1 B
INKS = (np.array([191, 214, 255], dtype=np.float64),       # brand.mist  #BFD6FF
        np.array([46, 107, 230], dtype=np.float64))        # brand.ocean #2E6BE6
SAFE_R = 338
# Android shows at most a 72dp circle of the 108dp layer (r=338 of 512), so every ink pixel must fit there.
# The concept's ink runs from r=353 (ring inner edge at 50% alpha) to r~448 (ring outer edge; the star and a
# faint letterbox fringe reach 488). Scaling the whole silhouette by 338/488 would shrink the ring to r=299
# and leave the adaptive tile half empty, so the scale instead maps the ring's INNER edge onto a safely
# clear radius: INNER_ON = 338 - OUTER_39, chosen so the ring's outer edge (94.5 px further out) lands at
# 415, inside the mask's curvature at every angle. Nothing is clipped; the round validation below fails if
# any pixel ends up beyond r=338.
RING_INNER = 353.3      # measured: lowest radius at which the concept's ring is >= 50% coverage
RING_WIDTH = 94.5       # measured: ink band 353.3..447.8
INNER_ON = SAFE_R - RING_WIDTH - 8

concept = np.asarray(Image.open(HERE / "concept-c-mastered.png").convert("RGB")).astype(np.float64)
encoded_field = AUTHORED_FIELD + ENCODE_SHIFT
d = concept - encoded_field                                  # per pixel
alpha = np.zeros(d.shape[:2])
err_best = np.full(d.shape[:2], np.inf)
for ink in INKS:
    v = ink - AUTHORED_FIELD
    t = np.clip((d @ v) / (v @ v), 0.0, 1.0)
    for shift in (np.zeros(3), ENCODE_SHIFT):               # either the field or the ink was shifted
        pred = (AUTHORED_FIELD + shift) * (1 - t[..., None]) + ink * t[..., None]
        err = np.linalg.norm(concept - pred, axis=2)
        better = err < err_best
        err_best = np.where(better, err, err_best)
        alpha = np.where(better, t, alpha)

a8 = (alpha * 255).round().astype(np.uint8)
concept_u8 = concept.astype(np.uint8)
is_field = np.all(concept_u8 == encoded_field, axis=2)       # 786,255 px: the exact navy plateau
is_ink = np.all(concept_u8 == np.array([199, 213, 254]), axis=2) | np.all(concept_u8 == np.array([46, 107, 230]), axis=2)
a8 = np.where(is_field, 0, np.where(is_ink, 255, np.maximum(a8, 1))).astype(np.uint8)
edge = int(((a8 > 0) & (a8 < 255)).sum())
print(f"edge pixels kept: {edge} (field {int(is_field.sum())}, ink {int(is_ink.sum())})")
print(f"per-edge-pixel reconstruction error: max={err_best.max():.2f} mean={err_best.mean():.2f}")

# concept-glyph.png is the decoded artwork: the concept's own RGB everywhere it is ink or edge (so a navy
# composite reproduces concept-c byte for byte), with coverage in alpha for the platform layers.
glyph_rgb = np.where(is_ink[..., None] | ((a8 > 0) & (a8 < 255))[..., None], concept_u8, encoded_field.astype(np.uint8))
glyph = Image.fromarray(np.dstack([glyph_rgb, np.full((1024, 1024, 1), 255, np.uint8)]).astype(np.uint8), "RGBA")
glyph.putalpha(Image.fromarray(a8, "L"))
glyph.save(HERE / "concept-glyph.png", "PNG")
a = a8.astype(np.float64)[..., None] / 255.0
rebuilt = np.clip(np.asarray(glyph)[:, :, :3] * a + encoded_field * (1 - a), 0, 255).round().astype(np.uint8)
diff = np.abs(rebuilt.astype(int) - concept_u8.astype(int)).max(axis=2)
print(f"round-trip vs concept: pixels differing={int((diff > 0).sum())} worst={int(diff.max())}")

ys, xs = np.nonzero(a8)
content_r = float(np.hypot(xs - 511.5, ys - 511.5).max())
factor = INNER_ON / RING_INNER
size = int(round(1024 * factor))
adaptive = Image.new("RGBA", (1024, 1024), (191, 214, 255, 0))
adaptive.alpha_composite(glyph.resize((size, size), Image.LANCZOS), ((1024 - size) // 2,) * 2)
adaptive.save(HERE / "adaptive-glyph.png", "PNG")
aa = np.asarray(adaptive.getchannel("A"))
ys, xs = np.nonzero(aa)
mass_r = np.hypot(xs - 511.5, ys - 511.5)
print(f"concept-glyph outer radius={content_r:.1f} scale={factor:.4f} bbox={adaptive.getchannel('A').getbbox()} "
      f"| adaptive max ink radius={mass_r.max():.1f} (safe {SAFE_R})")
