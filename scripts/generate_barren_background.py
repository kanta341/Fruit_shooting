from __future__ import annotations

from pathlib import Path
import math
import random
from collections import Counter

from PIL import Image, ImageColor, ImageDraw, ImageEnhance, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "back" / "img_data"
OUTPUT_PATH = ROOT / "shootGame" / "src" / "renderer" / "src" / "assets" / "barren-background.png"
WIDTH = 1600
HEIGHT = 900
SEED = 260214


def load_rgba(name: str) -> Image.Image:
    return Image.open(SOURCE_DIR / name).convert("RGBA")


def sample_background_color(image: Image.Image) -> tuple[int, int, int]:
    rgba = image.convert("RGBA")
    w, h = rgba.size
    points = [
        (24, 24),
        (w - 25, 24),
        (24, h - 25),
        (w - 25, h - 25),
        (w // 2, 24),
        (w // 2, h - 25),
    ]
    rs, gs, bs = [], [], []
    for x, y in points:
        r, g, b, _ = rgba.getpixel((max(0, x), max(0, y)))
        rs.append(r)
        gs.append(g)
        bs.append(b)
    return (
        int(sum(rs) / len(rs)),
        int(sum(gs) / len(gs)),
        int(sum(bs) / len(bs)),
    )


def cut_from_flat_background(image: Image.Image, distance_gain: float = 3.3) -> Image.Image:
    rgba = image.convert("RGBA")
    bg = sample_background_color(rgba)
    pixels = rgba.load()
    alpha = Image.new("L", rgba.size, 0)
    alpha_pixels = alpha.load()

    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, _ = pixels[x, y]
            dist = math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2)
            value = max(0, min(255, int((dist - 11) * distance_gain)))
            alpha_pixels[x, y] = value

    alpha = alpha.filter(ImageFilter.GaussianBlur(1.8))
    alpha = ImageEnhance.Contrast(alpha).enhance(1.35)
    rgba.putalpha(alpha)
    return rgba


def cut_from_edge_palette(image: Image.Image, tolerance: float = 34.0) -> Image.Image:
    rgba = image.convert("RGBA")
    w, h = rgba.size
    samples: Counter[tuple[int, int, int]] = Counter()

    for x in range(0, w, max(1, w // 120)):
        for y in (0, h - 1):
            r, g, b, _ = rgba.getpixel((x, y))
            samples[(round(r / 16) * 16, round(g / 16) * 16, round(b / 16) * 16)] += 1
    for y in range(0, h, max(1, h // 80)):
        for x in (0, w - 1):
            r, g, b, _ = rgba.getpixel((x, y))
            samples[(round(r / 16) * 16, round(g / 16) * 16, round(b / 16) * 16)] += 1

    palette = [(min(255, r), min(255, g), min(255, b)) for (r, g, b), _ in samples.most_common(6)]
    pixels = rgba.load()
    alpha = Image.new("L", rgba.size, 0)
    alpha_pixels = alpha.load()

    for y in range(h):
        for x in range(w):
            r, g, b, _ = pixels[x, y]
            nearest = min(
                math.sqrt((r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2)
                for pr, pg, pb in palette
            )
            value = int(max(0, min(255, (nearest - tolerance) * 5.8)))
            alpha_pixels[x, y] = value

    alpha = alpha.filter(ImageFilter.GaussianBlur(1.2))
    alpha = ImageEnhance.Contrast(alpha).enhance(1.5)
    rgba.putalpha(alpha)
    return rgba


def make_base_ground(width: int, height: int) -> Image.Image:
    base = Image.new("RGBA", (width, height), "#43352b")
    draw = ImageDraw.Draw(base)

    for y in range(height):
        t = y / max(1, height - 1)
        r = int(65 + (116 - 65) * t)
        g = int(53 + (95 - 53) * t)
        b = int(43 + (63 - 43) * t)
        draw.line((0, y, width, y), fill=(r, g, b, 255))

    haze = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    haze_draw = ImageDraw.Draw(haze)
    haze_draw.ellipse((-180, -160, width * 0.9, height * 0.6), fill=(170, 148, 112, 42))
    haze_draw.ellipse((width * 0.2, height * 0.1, width + 220, height + 120), fill=(93, 73, 50, 88))
    haze = haze.filter(ImageFilter.GaussianBlur(90))
    base.alpha_composite(haze)

    dust = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    dust_draw = ImageDraw.Draw(dust)
    rng = random.Random(SEED)
    for _ in range(260):
        x = rng.randint(0, width)
        y = rng.randint(0, height)
        rx = rng.randint(30, 140)
        ry = rng.randint(14, 90)
        color = rng.choice(
            [
                (91, 72, 48, 18),
                (138, 114, 82, 12),
                (50, 38, 29, 22),
            ]
        )
        dust_draw.ellipse((x - rx, y - ry, x + rx, y + ry), fill=color)
    dust = dust.filter(ImageFilter.GaussianBlur(22))
    base.alpha_composite(dust)
    return base


def transform_asset(
    image: Image.Image,
    scale: float,
    rotation: float,
    *,
    opacity: float = 1.0,
    mirror: bool = False,
    color: str | None = None,
) -> Image.Image:
    asset = image.copy()
    if mirror:
        asset = ImageOps.mirror(asset)

    new_size = (
        max(1, int(asset.width * scale)),
        max(1, int(asset.height * scale)),
    )
    asset = asset.resize(new_size, Image.Resampling.LANCZOS)
    asset = asset.rotate(rotation, expand=True, resample=Image.Resampling.BICUBIC)

    if color is not None:
        tint = Image.new("RGBA", asset.size, ImageColor.getrgb(color) + (0,))
        tint.putalpha(asset.getchannel("A"))
        asset = Image.blend(asset, tint, 0.15)

    if opacity < 1:
        alpha = asset.getchannel("A")
        alpha = alpha.point(lambda value: int(value * opacity))
        asset.putalpha(alpha)
    return asset


def paste_center(canvas: Image.Image, asset: Image.Image, center: tuple[int, int]) -> None:
    x = int(center[0] - asset.width / 2)
    y = int(center[1] - asset.height / 2)
    canvas.alpha_composite(asset, (x, y))


def add_tiled_field(
    canvas: Image.Image,
    image: Image.Image,
    *,
    scale_range: tuple[float, float],
    opacity_range: tuple[float, float],
    rotation_range: tuple[float, float],
    y_band: tuple[float, float],
    x_step: int,
    y_step: int,
    jitter: int,
    tint: str | None,
    seed_offset: int,
) -> None:
    rng = random.Random(SEED + seed_offset)
    y_start = int(canvas.height * y_band[0])
    y_end = int(canvas.height * y_band[1])

    row_index = 0
    for y in range(y_start, y_end + y_step, y_step):
        x_offset = (x_step // 2) if row_index % 2 else 0
        for x in range(-140, canvas.width + 140, x_step):
            scale = rng.uniform(*scale_range)
            rotation = rng.uniform(*rotation_range)
            opacity = rng.uniform(*opacity_range)
            asset = transform_asset(
                image,
                scale,
                rotation,
                opacity=opacity,
                mirror=rng.random() < 0.5,
                color=tint,
            )
            center = (
                x + x_offset + rng.randint(-jitter, jitter),
                y + rng.randint(-jitter, jitter),
            )
            paste_center(canvas, asset, center)
        row_index += 1


def add_cracks(canvas: Image.Image) -> None:
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    rng = random.Random(SEED + 7)

    for _ in range(18):
        start_x = rng.randint(30, canvas.width - 30)
        start_y = rng.randint(int(canvas.height * 0.38), canvas.height - 20)
        points = [(start_x, start_y)]
        x, y = start_x, start_y
        for _ in range(rng.randint(4, 7)):
            x += rng.randint(-120, 120)
            y += rng.randint(18, 56)
            points.append((max(0, min(canvas.width, x)), max(0, min(canvas.height, y))))
        draw.line(points, fill=(30, 21, 16, 85), width=rng.randint(3, 7), joint="curve")
        draw.line(points, fill=(118, 94, 67, 28), width=1)

    overlay = overlay.filter(ImageFilter.GaussianBlur(0.5))
    canvas.alpha_composite(overlay)


def add_vignette(canvas: Image.Image) -> None:
    vignette = Image.new("L", canvas.size, 0)
    draw = ImageDraw.Draw(vignette)
    draw.ellipse((-220, -140, canvas.width + 220, canvas.height + 240), fill=235)
    vignette = ImageOps.invert(vignette).filter(ImageFilter.GaussianBlur(70))
    layer = Image.new("RGBA", canvas.size, (28, 20, 15, 0))
    layer.putalpha(vignette.point(lambda value: min(170, int(value * 0.72))))
    canvas.alpha_composite(layer)


def build_background() -> Image.Image:
    rng = random.Random(SEED)
    base = make_base_ground(WIDTH, HEIGHT)

    wreck_a = cut_from_edge_palette(load_rgba("1.png"))
    branch_a = cut_from_flat_background(load_rgba("2.png"))
    branch_b = cut_from_flat_background(load_rgba("3.png"))
    crater = cut_from_edge_palette(load_rgba("４.png"))

    add_tiled_field(
        base,
        crater,
        scale_range=(0.10, 0.16),
        opacity_range=(0.18, 0.34),
        rotation_range=(-18, 18),
        y_band=(0.42, 0.90),
        x_step=220,
        y_step=155,
        jitter=28,
        tint="#81684f",
        seed_offset=11,
    )
    add_tiled_field(
        base,
        wreck_a,
        scale_range=(0.08, 0.12),
        opacity_range=(0.16, 0.30),
        rotation_range=(-28, 28),
        y_band=(0.10, 0.78),
        x_step=210,
        y_step=145,
        jitter=36,
        tint="#715a43",
        seed_offset=21,
    )
    add_tiled_field(
        base,
        branch_a,
        scale_range=(0.09, 0.14),
        opacity_range=(0.12, 0.22),
        rotation_range=(-24, 24),
        y_band=(0.08, 0.88),
        x_step=170,
        y_step=120,
        jitter=24,
        tint="#7d6852",
        seed_offset=31,
    )
    add_tiled_field(
        base,
        branch_b,
        scale_range=(0.09, 0.14),
        opacity_range=(0.10, 0.20),
        rotation_range=(-24, 24),
        y_band=(0.12, 0.92),
        x_step=175,
        y_step=125,
        jitter=24,
        tint="#6f5b47",
        seed_offset=41,
    )

    for _ in range(28):
        x = rng.randint(0, WIDTH)
        y = rng.randint(int(HEIGHT * 0.35), HEIGHT - 10)
        asset = transform_asset(
            crater,
            rng.uniform(0.14, 0.19),
            rng.uniform(-20, 20),
            opacity=rng.uniform(0.18, 0.28),
            mirror=rng.random() < 0.5,
            color="#876d54",
        )
        paste_center(base, asset, (x, y))

    ember_haze = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    ember_draw = ImageDraw.Draw(ember_haze)
    for _ in range(36):
        x = rng.randint(0, WIDTH)
        y = rng.randint(int(HEIGHT * 0.2), int(HEIGHT * 0.86))
        rx = rng.randint(35, 120)
        ry = rng.randint(10, 45)
        ember_draw.ellipse((x - rx, y - ry, x + rx, y + ry), fill=(196, 131, 62, rng.randint(8, 18)))
    ember_haze = ember_haze.filter(ImageFilter.GaussianBlur(18))
    base.alpha_composite(ember_haze)

    add_cracks(base)
    add_vignette(base)

    sharpened = ImageEnhance.Sharpness(base).enhance(1.15)
    contrast = ImageEnhance.Contrast(sharpened).enhance(1.06)
    return contrast.convert("RGBA")


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    background = build_background()
    background.save(OUTPUT_PATH)
    print(f"saved {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
