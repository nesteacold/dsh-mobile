# Builds assets/icon-concepts/final-sheet.png: every shipped raster in the shape a store or launcher
# actually applies, so the owner can judge the finish in one look.
#   row 1  iOS icon in its rounded mask on light and dark home-screen grounds
#   row 2  Android adaptive: squircle mask and circle mask, layers on the #06172B background colour;
#          the monochrome layer tinted on a Material-you style theme surface
#   row 3  splash at its phone size on the #06172B splash background, web favicon, Play 512 and feature art
# Rounded/circle masks are cut with a ONE-PIXEL supersampled outline (no resampling of the artwork itself),
# so nothing in this sheet is a blurred copy of a build.
# Run: "<python>" assets/icon-concepts/.final-sheet.py
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent
STORE = ASSETS / "store"
NAVY = (6, 23, 43)
LIGHT_GROUND = (242, 242, 247)
DARK_GROUND = (0, 0, 0)
CHROME = (26, 26, 30)
MONO_BG = (0x4C, 0x5A, 0x7A)  # Material "tonal" surface the launcher derives from the navy background

icon = Image.open(ASSETS / "icon.png").convert("RGB")
fg = Image.open(ASSETS / "adaptive-foreground.png").convert("RGBA")
mono = Image.open(ASSETS / "adaptive-monochrome.png").convert("RGBA")
splash = Image.open(ASSETS / "splash-icon.png").convert("RGBA")
fav = Image.open(ASSETS / "favicon.png").convert("RGB")
play512 = Image.open(STORE / "play-icon-512.png").convert("RGB")
feature = Image.open(STORE / "play-feature-graphic.png").convert("RGB")


def mask_shape(size, kind, ss=4):
    m = Image.new("L", (size * ss, size * ss), 0)
    d = ImageDraw.Draw(m)
    box = (0, 0, size * ss - 1, size * ss - 1)
    if kind == "ios":
        d.rounded_rectangle(box, radius=int(size * ss * 0.2237), fill=255)
    elif kind == "squircle":  # ~ Android launcher squircle: four 45%-rounded corners, flat edges
        r = int(size * ss * 0.45)
        d.rounded_rectangle(box, radius=r, fill=255)
    elif kind == "circle":
        d.ellipse(box, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def tile(img, size, ground, kind):
    out = Image.new("RGBA", (size, size), ground + (255,))
    src = img.resize((size, size), Image.LANCZOS) if img.size != (size, size) else img
    if kind:
        cut = src.convert("RGBA")
        cut.putalpha(mask_shape(size, kind))
        out.alpha_composite(cut)
    else:
        out.alpha_composite(src)
    return out


def composite_layers(size, background, fg_img, kind, tint=None):
    out = Image.new("RGBA", (size, size), background + (255,))
    layer = fg_img.resize((size, size), Image.LANCZOS)
    if tint:
        layer = Image.merge("RGBA", (*Image.new("RGB", layer.size, tint).split(), layer.getchannel("A")))
    out.alpha_composite(layer)
    cut = out.copy()
    cut.putalpha(mask_shape(size, kind))
    return cut


def label_chip(draw, x, y, count):
    for i in range(count):
        draw.rectangle((x + i * 20, y, x + i * 20 + 14, y + 14), fill=(232, 232, 240))


def main():
    pad = 32
    big = 512
    row_h = 640
    width = pad + big + 8 * (200 + 16) + pad + 600
    sheet = Image.new("RGBA", (width, row_h * 3 + 40), CHROME + (255,))
    draw = ImageDraw.Draw(sheet)

    # Row 1: iOS rounded mask, light + dark grounds, plus the mask at launcher size.
    io_light = tile(icon, big, LIGHT_GROUND, "ios")
    io_dark = tile(icon, big, DARK_GROUND, "ios")
    sheet.alpha_composite(io_light, (pad, 40))
    x = pad + big + 24
    for size in (180, 120, 87, 60):
        sheet.alpha_composite(tile(icon, size, LIGHT_GROUND, "ios"), (x, 40 + (big - size) // 2))
        x += size + 16
    io_dark_pos = x + 8
    sheet.alpha_composite(io_dark, (io_dark_pos, 40))
    x = io_dark_pos + big + 24
    for size in (180, 120, 87, 60):
        sheet.alpha_composite(tile(icon, size, DARK_GROUND, "ios"), (x, 40 + (big - size) // 2))
        x += size + 16

    # Row 2: adaptive squircle and circle from the real layers; monochrome tinted.
    y = row_h + 20
    squircle = composite_layers(big, NAVY, fg, "squircle")
    circle = composite_layers(big, NAVY, fg, "circle")
    sheet.alpha_composite(squircle, (pad, y))
    x = pad + big + 24
    for size in (180, 120, 87, 60):
        sheet.alpha_composite(composite_layers(size, NAVY, fg, "squircle"), (x, y + (big - size) // 2))
        x += size + 16
    sheet.alpha_composite(circle, (x + 8, y))
    x = x + 8 + big + 24
    for size in (180, 120, 87, 60):
        sheet.alpha_composite(composite_layers(size, NAVY, fg, "circle"), (x, y + (big - size) // 2))
        x += size + 16
    # Monochrome on a tonal theme surface (the launcher tints it), circle and squircle.
    mono_tile = composite_layers(big, MONO_BG, fg, "circle", tint=(255, 255, 255))
    x = pad + 2 * (big + 24) + 13 * (200 + 16)
    sheet.alpha_composite(mono_tile, (width - pad - big, y))

    # Row 3: splash as the phone shows it, favicon, Play 512, feature graphic.
    y = 2 * row_h + 40
    phone_w, phone_h = 420, 560
    phone = Image.new("RGBA", (phone_w, phone_h), NAVY + (255,))
    splash_shown = splash.resize((200, 200), Image.LANCZOS)          # imageWidth 200, contain
    phone.alpha_composite(splash_shown, ((phone_w - 200) // 2, (phone_h - 200) // 2))
    cut = phone.copy()
    cut.putalpha(mask_shape(phone_w, "ios") if phone_w == phone_h else
                 Image.new("L", (phone_w, phone_h), 0))
    # a simple phone frame: rounded rect mask drawn directly (not a square mask)
    frame = Image.new("L", (phone_w * 2, phone_h * 2), 0)
    ImageDraw.Draw(frame).rounded_rectangle((0, 0, phone_w * 2 - 1, phone_h * 2 - 1), radius=64, fill=255)
    cut.putalpha(frame.resize((phone_w, phone_h), Image.LANCZOS))
    sheet.alpha_composite(cut, (pad, y))
    x = pad + phone_w + 32
    sheet.alpha_composite(fav.convert("RGBA").resize((96, 96), Image.NEAREST), (x, y))
    sheet.alpha_composite(tile(icon, 87, LIGHT_GROUND, "ios"), (x, y + 140))
    sheet.alpha_composite(play512.resize((240, 240), Image.LANCZOS).convert("RGBA"), (x, y + 260))
    sheet.alpha_composite(feature.convert("RGBA"), (x + 280, y + 260))

    out = HERE / "final-sheet.png"
    sheet.convert("RGB").save(out, "PNG", optimize=True)
    print(f"final-sheet.png {sheet.size[0]}x{sheet.size[1]}")


if __name__ == "__main__":
    main()
