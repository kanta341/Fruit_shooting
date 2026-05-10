from __future__ import annotations

from collections import Counter
from pathlib import Path
import json
import math

from PIL import Image, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "back" / "img2"
OUTPUT_DIR = ROOT / "shootGame" / "src" / "renderer" / "public" / "hit-foliage-generated"


def cut_from_edge_palette(image: Image.Image, tolerance: float = 34.0) -> Image.Image:
    rgba = image.convert("RGBA")
    width, height = rgba.size
    samples: Counter[tuple[int, int, int]] = Counter()

    for x in range(0, width, max(1, width // 120)):
        for y in (0, height - 1):
            r, g, b, _ = rgba.getpixel((x, y))
            samples[(round(r / 16) * 16, round(g / 16) * 16, round(b / 16) * 16)] += 1
    for y in range(0, height, max(1, height // 80)):
        for x in (0, width - 1):
            r, g, b, _ = rgba.getpixel((x, y))
            samples[(round(r / 16) * 16, round(g / 16) * 16, round(b / 16) * 16)] += 1

    palette = [(min(255, r), min(255, g), min(255, b)) for (r, g, b), _ in samples.most_common(6)]
    alpha = Image.new("L", rgba.size, 0)

    for y in range(height):
        for x in range(width):
            r, g, b, _ = rgba.getpixel((x, y))
            nearest = min(
                math.sqrt((r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2)
                for pr, pg, pb in palette
            )
            value = int(max(0, min(255, (nearest - tolerance) * 6.4)))
            alpha.putpixel((x, y), value)

    alpha = alpha.filter(ImageFilter.GaussianBlur(1.4))
    alpha = ImageEnhance.Contrast(alpha).enhance(1.65)
    rgba.putalpha(alpha)
    return rgba


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest: list[str] = []
    for source_path in sorted(SOURCE_DIR.glob("*.png"), key=lambda path: path.name):
        source = Image.open(source_path)
        cleaned = cut_from_edge_palette(source)
        output_path = OUTPUT_DIR / source_path.name
        cleaned.save(output_path)
        manifest.append(source_path.name)
        print(f"saved {output_path}")

    (OUTPUT_DIR / "index.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"saved {OUTPUT_DIR / 'index.json'}")


if __name__ == "__main__":
    main()
