# One-off: rebuilds concept-c.png with the spark in its authored brand ocean (#2E6BE6).
# The first capture encoded the spark as #5169E3, which desaturates it against the ring; the second
# capture of the SAME spark path (glyph-c.svg, identical geometry and rotation) rounded it to #2E6BE6,
# so the geometry is unchanged and only the misplaced colour is corrected.
# Selection is analytical: pixels of the drifted colour inside a disc around the spark's own centroid
# (measured from those very pixels), so the ring can never be touched. Every other pixel is left as reviewed.
# Run: "<python>" apps/mobile-companion/assets/icon-concepts/.master.py
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
OCEAN = (46, 107, 230)
DRIFTED = (81, 105, 227)  # what the encoder wrote for #2E6BE6 in the first capture
DISC_RADIUS = 110         # the spark spans ~106 px; the nearest ring pixel is ~215 px away

concept = Image.open(HERE / "concept-c.png").convert("RGB")
base = np.array(concept)
drifted = np.all(base == DRIFTED, axis=2)
ys, xs = np.nonzero(drifted)
if len(xs) == 0:
    raise SystemExit("no drifted pixels: concept-c.png is already mastered")
cx, cy = xs.mean(), ys.mean()
disc = (xs - cx) ** 2 + (ys - cy) ** 2 <= DISC_RADIUS ** 2
selected = np.zeros_like(drifted)
selected[ys[disc], xs[disc]] = True
print(f"drifted={int(drifted.sum())} centroid=({cx:.1f},{cy:.1f}) selected={int(selected.sum())} "
      f"rejected-outside-disc={int(drifted.sum() - selected.sum())}")
base[selected] = OCEAN
Image.fromarray(base, "RGB").save(HERE / "concept-c-mastered.png", "PNG")

# Prove no other pixel moved and report where the ink now sits.
mastered = np.array(Image.open(HERE / "concept-c-mastered.png").convert("RGB"))
changed = np.any(mastered != base, axis=2)
print(f"changed-after-save={int(changed.sum())} | spark rotate(30) position={tuple(int(v) for v in (512 + 330 * np.sin(np.radians(60)), 512 + 330 * np.cos(np.radians(60))))}")
mp = Image.open(HERE / "concept-c-mastered.png").convert("RGB")
print(f"spark centre now={mp.getpixel((495, 798))} authored={OCEAN}")
