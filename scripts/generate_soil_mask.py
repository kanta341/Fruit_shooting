from __future__ import annotations

from collections import deque
from pathlib import Path
from colorsys import rgb_to_hsv

from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = ROOT / "back" / "backImag" / "hiroba2.png"
OUTPUT_DIR = ROOT / "shootGame" / "src" / "renderer" / "public" / "background-masks"
OUTPUT_PATH = OUTPUT_DIR / "hiroba2-soil-mask.png"


def is_soil(red: int, green: int, blue: int) -> bool:
    hue, saturation, value = rgb_to_hsv(red / 255, green / 255, blue / 255)
    hue_degrees = hue * 360

    # Soil in hiroba2 is warm brown. Grass is green/yellow-green, and stones are low saturation.
    return (
        12 <= hue_degrees <= 42
        and saturation >= 0.22
        and 0.18 <= value <= 0.78
        and red >= green >= blue
    )


def largest_black_component(mask: Image.Image) -> Image.Image:
    width, height = mask.size
    pixels = mask.load()
    visited = bytearray(width * height)
    best_component: list[tuple[int, int]] = []

    for start_y in range(height):
        for start_x in range(width):
            index = start_y * width + start_x
            if visited[index] or pixels[start_x, start_y] != 0:
                continue

            component: list[tuple[int, int]] = []
            queue: deque[tuple[int, int]] = deque([(start_x, start_y)])
            visited[index] = 1

            while queue:
                x, y = queue.popleft()
                component.append((x, y))

                for next_x, next_y in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if next_x < 0 or next_y < 0 or next_x >= width or next_y >= height:
                        continue

                    next_index = next_y * width + next_x
                    if visited[next_index] or pixels[next_x, next_y] != 0:
                        continue

                    visited[next_index] = 1
                    queue.append((next_x, next_y))

            if len(component) > len(best_component):
                best_component = component

    cleaned = Image.new("L", mask.size, 255)
    cleaned_pixels = cleaned.load()
    for x, y in best_component:
        cleaned_pixels[x, y] = 0
    return cleaned


def main() -> None:
    image = Image.open(SOURCE_PATH).convert("RGB")
    mask = Image.new("L", image.size, 255)
    mask_pixels = mask.load()

    for y in range(image.height):
        for x in range(image.width):
            if is_soil(*image.getpixel((x, y))):
                mask_pixels[x, y] = 0

    # Smooth tiny speckles, then keep the main central soil patch only.
    mask = mask.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))
    mask = largest_black_component(mask)
    mask = mask.filter(ImageFilter.MinFilter(7)).filter(ImageFilter.MaxFilter(7))

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    mask.save(OUTPUT_PATH)
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
