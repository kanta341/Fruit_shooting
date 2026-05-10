from __future__ import annotations

import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "back" / "me2"
OUTPUT_DIR = ROOT / "shootGame" / "src" / "renderer" / "public" / "grown-plant-layouts"
ALPHA_THRESHOLD = 24


def opaque_points(path: Path) -> tuple[int, int, list[tuple[int, int]]]:
    image = Image.open(path).convert("RGBA")
    alpha = image.getchannel("A")
    width, height = image.size
    points: list[tuple[int, int]] = []
    for y in range(height):
        for x in range(width):
            if alpha.getpixel((x, y)) > ALPHA_THRESHOLD:
                points.append((x, y))
    return width, height, points


def median(values: list[int]) -> float:
    if not values:
        return 0
    sorted_values = sorted(values)
    middle = len(sorted_values) // 2
    if len(sorted_values) % 2:
        return float(sorted_values[middle])
    return (sorted_values[middle - 1] + sorted_values[middle]) / 2


def plant_anchor(path: Path) -> dict[str, float | str | int]:
    width, height, points = opaque_points(path)
    if not points:
        return {"name": path.name, "width": width, "height": height, "anchorX": width / 2, "anchorY": height / 2}

    center_x = width / 2
    # Use the farthest visible side tip as the branch endpoint. This handles right- or left-growing stems.
    rightmost_x = max(x for x, _ in points)
    leftmost_x = min(x for x, _ in points)
    use_right = abs(rightmost_x - center_x) >= abs(leftmost_x - center_x)
    tip_x = rightmost_x if use_right else leftmost_x
    band_width = max(3, round(width * 0.015))
    if use_right:
        band = [(x, y) for x, y in points if x >= tip_x - band_width]
    else:
        band = [(x, y) for x, y in points if x <= tip_x + band_width]

    return {
        "name": path.name,
        "width": width,
        "height": height,
        "anchorX": tip_x,
        "anchorY": median([y for _, y in band]),
    }


def fruit_anchor(path: Path) -> dict[str, float | str | int]:
    width, height, points = opaque_points(path)
    if not points:
        return {"name": path.name, "width": width, "height": height, "anchorX": width / 2, "anchorY": 0}

    top_y = min(y for _, y in points)
    band_height = max(4, round(height * 0.05))
    top_band = [(x, y) for x, y in points if y <= top_y + band_height]
    return {
        "name": path.name,
        "width": width,
        "height": height,
        "anchorX": median([x for x, _ in top_band]),
        "anchorY": median([y for _, y in top_band]),
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    fruit_dirs = {
        "banana": SOURCE_DIR / "banana",
        "apple": SOURCE_DIR / "apple",
        "grape": SOURCE_DIR / "grape",
    }
    manifest = {
        "plants": [plant_anchor(path) for path in sorted((SOURCE_DIR / "plant").glob("*.png"))],
        "fruits": {
            fruit_type: [fruit_anchor(path) for path in sorted(directory.glob("*.png"))]
            for fruit_type, directory in fruit_dirs.items()
        },
    }
    (OUTPUT_DIR / "index.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
