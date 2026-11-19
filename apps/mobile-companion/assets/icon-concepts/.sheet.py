# Builds apps/mobile-companion/assets/icon-concepts/concepts-sheet.png with Pillow.
# Each concept is shown at 1024, 180 and 60 px on light (#F2F2F7) and dark (#000) grounds, then
# masked as an iOS rounded square (22.37% corner radius) and as an Android circle.
# The resampled previews are the real test: 60 px is the launcher grid, 180 px is search / settings.
# Run: "<python>" apps/mobile-companion/assets/icon-concepts/.sheet.py
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
CONCEPTS = ["concept-a", "concept-b", "concept-c"]
LIGHT = (0xF2, 0xF2, 0xF7, 255)
DARK = (0, 0, 0, 255)
ROW_BG = (0x1A, 0x1A, 0x1E, 255)  # sheet chrome: neither test ground


def resize_icon(icon, size):
    # Launchers downscale with a good filter; LANCZOS is the fair worst case for thin strokes.
    return icon.resize((size, size), Image.LANCZOS)


def rounded_alpha(size, radius_ratio=0.2237):
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size * 4 - 1, size * 4 - 1), radius=int(size * 4 * radius_ratio), fill=255
    )
    return mask.resize((size, size), Image.LANCZOS)


def circle_alpha(size):
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def paste_on_ground(sheet, icon, x, y, ground, shape=None):
    # shape: None (full 1024 artwork, which carries its own navy field), 'ios', or 'android'.
    tile = icon
    if shape == "ios":
        tile = icon.copy()
        tile.putalpha(rounded_alpha(icon.size[0]))
    elif shape == "android":
        tile = icon.copy()
        tile.putalpha(circle_alpha(icon.size[0]))
    ground_tile = Image.new("RGBA", (icon.size[0], icon.size[1]), ground)
    ground_tile.alpha_composite(tile)
    # a faint drop shadow on the light ground so a navy icon's edge is visible at 60 px
    if ground == LIGHT:
        shadow = Image.new("RGBA", (icon.size[0] + 8, icon.size[1] + 8), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle((4, 5, shadow.size[0] - 5, shadow.size[1] - 4),
                                                 radius=max(4, icon.size[0] // 8), fill=(0, 0, 0, 28))
        sheet.alpha_composite(shadow, (x - 4, y - 4))
    sheet.alpha_composite(ground_tile, (x, y))


def main():
    icons = {name: Image.open(HERE / f"{name}.png").convert("RGBA") for name in CONCEPTS}
    for name, icon in icons.items():
        if icon.size != (1024, 1024):
            raise SystemExit(f"{name}.png is {icon.size}, expected 1024x1024")

    big = 1024
    pad = 36
    # Per strip: one 1024 tile, then 180 and 60, then the same two sizes as iOS rounded square and
    # Android circle. Row label is a colour chip (no fonts on this machine to trust).
    sizes = [1024, 180, 60, 180, 60, 180, 60]
    strip_w = sum(s + pad for s in sizes)
    row_w = pad + strip_w + pad + strip_w + pad + big + pad + big + pad
    row_h = big + 2 * pad
    sheet = Image.new("RGBA", (row_w, row_h * len(CONCEPTS) + 56), ROW_BG)
    draw = ImageDraw.Draw(sheet)
    for i, name in enumerate(CONCEPTS):
        y = i * row_h + 56
        if i:
            draw.line((0, y - 28, row_w, y - 28), fill=(0x33, 0x33, 0x3A, 255), width=2)
        for j in range(i + 1):
            draw.rectangle((24 + j * 20, y + 24, 24 + j * 20 + 14, y + 38), fill=(0xE8, 0xE8, 0xF0, 255))
        x = pad
        for ground, shapes in ((LIGHT, (None, None, "ios", "android", "ios", "android")),
                               (DARK, (None, None, "ios", "android", "ios", "android"))):
            for size, shape in zip(sizes, shapes):
                icon = resize_icon(icons[name], size)
                paste_on_ground(sheet, icon, x, y + (big - size) // 2, ground, shape)
                x += size + pad
        icon = icons[name]
        paste_on_ground(sheet, icon, x, y, ROW_BG, "ios")
        x += big + pad
        paste_on_ground(sheet, icon, x, y, ROW_BG, "android")
    out = HERE / "concepts-sheet.png"
    sheet.convert("RGB").save(out, "PNG", optimize=True)
    print(f"{out.name} {sheet.size[0]}x{sheet.size[1]} rows A,B,C")


if __name__ == "__main__":
    main()
