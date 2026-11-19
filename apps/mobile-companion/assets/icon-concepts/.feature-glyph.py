# Finishes the Play feature graphic (never shipped as a source, only the final image is):
#   final-feature-2x.png (2048x1000, captured at DPR 2 by .final-render.mjs) -> 1024x500 LANCZOS
#   -> assets/store/play-feature-graphic.png (opaque, no alpha: Play rejects transparency)
# Doing the text at 2x and sampling down keeps the 86 px wordmark as clean as a real 4x export.
# Run: "<python>" assets/icon-concepts/.feature-glyph.py
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
STORE = HERE.parent / "store"

hi = Image.open(HERE / "final-feature-2x.png").convert("RGB")
if hi.size != (2048, 1000):
    raise SystemExit(f"final-feature-2x.png is {hi.size}, expected 2048x1000")
out = hi.resize((1024, 500), Image.LANCZOS)
STORE.mkdir(exist_ok=True)
out.save(STORE / "play-feature-graphic.png", "PNG")
saved = Image.open(STORE / "play-feature-graphic.png")
print(f"play-feature-graphic.png {saved.size[0]}x{saved.size[1]} mode={saved.mode} colour-type={STORE.joinpath('play-feature-graphic.png').read_bytes()[25]}")
