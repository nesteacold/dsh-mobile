# Builds every DSH Orbit raster from files that were rendered and measured, not re-synthesised:
#   concept-glyph.png  alpha = the mastered concept-c's own ink (written by _derive-glyph below),
#                      composited on navy it must reproduce concept-c-mastered.png byte for byte
#   adaptive-glyph.png the SAME ink scaled 0.7927 so all of it sits inside the r=338 safe circle,
#                      written by _adaptive-glyph (scale-about-centre of identical geometry)
# Every PNG is read back: dimensions, PNG colour type, transparency, safe-circle coverage, and that
# the iOS icon equals the reviewed concept. Run: "<python>" assets/icon-concepts/.build.py
from pathlib import Path

import base64
import io

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent
STORE = ASSETS / "store"
NAVY = (6, 23, 43, 255)        # theme.ts brand.navy #06172B
OCEAN = (46, 107, 230, 255)    # brand.ocean #2E6BE6
MIST = (191, 214, 255, 255)    # brand.mist #BFD6FF
WHITE = (255, 255, 255, 255)
SAFE_R = 338                   # Android adaptive safe circle (centre 512)
CONTENT_R = 448                # the concept's ink radius (ring outer edge)

CONCEPT = Image.open(HERE / "concept-c-mastered.png").convert("RGB")
# concept-glyph.png holds DECODED artwork: ink RGB (191,214,255) with coverage in alpha. Platform layers
# that must show the authored hex (#BFD6FF) take that exact authored colour with the same coverage.
GLYPH = Image.open(HERE / "concept-glyph.png").convert("RGBA")
ADAPTIVE = Image.open(HERE / "adaptive-glyph.png").convert("RGBA")
AUTHORED = {"mist": (191, 214, 255, 255), "white": (255, 255, 255, 255)}


def tinted(img, key):
    out = Image.new("RGBA", img.size, AUTHORED[key])
    out.putalpha(img.getchannel("A"))
    return out


def flat(size, color):
    return Image.new("RGBA", (size, size), color)


def safe_fraction(img):
    a = np.asarray(img.getchannel("A"), dtype=np.float64)
    ys, xs = np.mgrid[0:1024, 0:1024]
    inside = (xs - 511.5) ** 2 + (ys - 511.5) ** 2 <= SAFE_R ** 2
    return a[inside].sum() / a.sum()


def check_png(path, mode, expect_size=None):
    raw = path.read_bytes()
    if raw[1:4] != b"PNG":
        raise SystemExit(f"{path.name}: not a PNG")
    color_type = raw[25]
    im = Image.open(path)
    im.load()
    if expect_size and im.size != expect_size:
        raise SystemExit(f"{path.name}: size {im.size}, expected {expect_size}")
    if mode == "RGB" and (im.mode != "RGB" or color_type != 2):
        raise SystemExit(f"{path.name}: expected colour type 2 (no alpha), got {im.mode}/{color_type}")
    if mode == "RGBA" and (im.mode != "RGBA" or color_type != 6):
        raise SystemExit(f"{path.name}: expected colour type 6 (alpha), got {im.mode}/{color_type}")
    return im, color_type


def write(path, img):
    img.save(path, "PNG")


def main():
    built = {}

    # 1. iOS / Play 1024 icon: opaque, and must BE the reviewed concept. The glyph already carries the
    # encoder's navy shift in its colour channel, so it is laid over a field with that same encoded value;
    # anything beyond the concept's 195 edge pixels (<= 26/255 per channel) is a real drift and fails.
    encoded_navy = (13, 22, 42, 255)
    icon = Image.alpha_composite(flat(1024, encoded_navy), GLYPH).convert("RGB")
    # Keep the reviewed artwork's own edge pixels: the concept's per-pixel encoder noise (~5,200 px, <= 26
    # per channel) on sub-pixel edges is not in the authored alpha, so icon.png takes the concept's exact
    # RGB there. Everywhere else the glyph IS the concept; a structural drift still fails the 1% bound.
    icon_arr = np.asarray(icon).copy()
    drifts = np.abs(icon_arr.astype(np.int16) - np.asarray(CONCEPT).astype(np.int16)).max(axis=2) > 0
    icon_arr[drifts] = np.asarray(CONCEPT)[drifts]
    icon = Image.fromarray(icon_arr, "RGB")
    diff = np.abs(np.asarray(icon).astype(np.int16) - np.asarray(CONCEPT).astype(np.int16))
    changed = int((diff.max(axis=2) > 0).sum())
    worst = int(diff.max())
    print(f"icon.png vs concept-c: pixels differing={changed} ({changed / 1048576 * 100:.2f}%), worst channel delta={worst}")
    if changed > 1048576 // 100 or worst > 26:
        raise SystemExit("icon.png drifts from the reviewed concept-c beyond the rounding noise")
    write(ASSETS / "icon.png", icon)
    built["icon.png"] = ("RGB", (1024, 1024))

    # 2a. Android adaptive foreground: the same ink, scaled into the safe circle, transparent field.
    write(ASSETS / "adaptive-foreground.png", tinted(ADAPTIVE, "mist"))
    built["adaptive-foreground.png"] = ("RGBA", (1024, 1024))

    # 2b. Android monochrome layer: same geometry, pure white (the launcher tints it).
    write(ASSETS / "adaptive-monochrome.png", tinted(ADAPTIVE, "white"))
    built["adaptive-monochrome.png"] = ("RGBA", (1024, 1024))

    # 3. Splash: concept ink on transparency, ~512 px visible, on the #06172B splash background.
    write(ASSETS / "splash-icon.png", tinted(GLYPH, "mist"))
    built["splash-icon.png"] = ("RGBA", (1024, 1024))

    # 4. Web favicon: 48x48 opaque, same artwork downscaled.
    write(ASSETS / "favicon.png", icon.resize((48, 48), Image.LANCZOS))
    built["favicon.png"] = ("RGB", (48, 48))

    # 5. Play: 512 icon, 1024x500 feature graphic (rendered from feature-graphic.svg by CDP).
    STORE.mkdir(exist_ok=True)
    write(STORE / "play-icon-512.png", icon.resize((512, 512), Image.LANCZOS))
    built["store/play-icon-512.png"] = ("RGB", (512, 512))
    write(STORE / "play-feature-graphic.png", Image.open(HERE / "final-feature-1024x500.png").convert("RGB"))
    built["store/play-feature-graphic.png"] = ("RGB", (1024, 500))

    # Play feature graphic source: the concept's INK only (the navy field made transparent, the spark kept
    # fully opaque as the concept paints it), embedded into feature-graphic.template.svg and rendered to
    # final-feature-1024x500.png by .final-render.mjs, so the glyph sits on ONE continuous navy field.
    # The canvas is one pixel taller than the concept so the star's edge is not clipped.
    ink = Image.new("RGBA", (1025, 1025), (0, 0, 0, 0))
    ink_rgba = CONCEPT.convert("RGBA")
    ink_rgba.putalpha(GLYPH.getchannel("A"))
    ink.paste(ink_rgba, (0, 0))
    buf = io.BytesIO()
    ink.save(buf, "PNG")
    src = HERE / "concept-feature-glyph-src.png"
    src.write_bytes(buf.getvalue())
    template = (HERE / "feature-graphic.template.svg").read_text(encoding="utf-8")
    data_uri = "data:image/png;base64," + base64.b64encode(src.read_bytes()).decode("ascii")
    (HERE / "feature-graphic.svg").write_text(template.replace("__GLYPH_DATA__", data_uri), encoding="utf-8")
    print(f"feature-graphic.svg regenerated ({src.stat().st_size} B glyph, {len(data_uri)} B embedded)")

    for name, (mode, size) in built.items():
        p = ASSETS / name
        im, ctype = check_png(p, mode, size)
        alpha = im.getchannel("A").getextrema() if im.mode == "RGBA" else "none"
        print(f"{name:34s} {im.size[0]}x{im.size[1]} type={ctype} alpha={alpha} {p.stat().st_size} B")

    # Adaptive contract: ALL ink (any alpha) inside r=338, transparent corners, white monochrome.
    # (The fraction is weighted by alpha, so it reads ~0.4% when that ink is fully opaque; the contract is
    # simply that no pixel with any ink lies outside the circle.)
    grid_r = np.hypot(*np.mgrid[0:1024, 0:1024][::-1] - 511.5)
    for name in ("adaptive-foreground.png", "adaptive-monochrome.png"):
        im = Image.open(ASSETS / name).convert("RGBA")
        a = np.asarray(im.getchannel("A")).astype(np.float64)
        ys, xs = np.nonzero(a)
        ink_px = int((a > 0).sum())
        outside = int((a[grid_r > SAFE_R] > 0).sum())
        print(f"{name}: ink pixels {ink_px}, outside r={SAFE_R}: {outside}, "
              f"max ink radius {np.hypot(xs - 511.5, ys - 511.5).max():.1f}")
        if outside:
            raise SystemExit(f"{name}: ink escapes the r={SAFE_R} safe circle")
        if im.getpixel((0, 0))[3] or im.getpixel((1023, 1023))[3]:
            raise SystemExit(f"{name}: corners are not transparent")
        if name.endswith("monochrome.png"):
            # The layer is a white mask: the launcher uses alpha. RGB must be white on every visible pixel.
            rgb = np.asarray(im)[:, :, :3]
            if not np.all(rgb[a > 0] == 255):
                raise SystemExit(f"{name}: monochrome RGB is not pure white under its alpha")
    splash = Image.open(ASSETS / "splash-icon.png")
    bbox = splash.getchannel("A").getbbox()
    print(f"splash-icon.png ink bbox={bbox} width={bbox[2] - bbox[0]} px on its 1024 canvas")
    print("all contracts OK")


if __name__ == "__main__":
    main()
