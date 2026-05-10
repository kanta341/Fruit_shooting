from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "back" / "me"
OUTPUT_DIR = ROOT / "shootGame" / "src" / "renderer" / "public" / "enemy-grow-animations"
FRAME_COUNT = 18
DURATION_SECONDS = 0.72
MAX_FRAME_SIZE = 640
FRAME_PADDING_RATIO = 1.15


def ease_out_cubic(value: float) -> float:
    return 1 - (1 - value) ** 3


def build_frame(source: Image.Image, frame_size: int, index: int) -> Image.Image:
    t = index / max(1, FRAME_COUNT - 1)
    eased = ease_out_cubic(t)
    mask_ratio = (1 - eased) * 0.52
    scale = 0.86 + math.sin(eased * math.pi * 0.5) * 0.14
    angle = math.sin(t * math.pi * 2.0) * (1 - t) * 5.5

    masked = source.copy()
    alpha = masked.getchannel("A")
    cover_start = int(masked.height * (1 - mask_ratio))
    if cover_start < masked.height:
        alpha.paste(0, (0, cover_start, masked.width, masked.height))
        masked.putalpha(alpha)

    scaled_width = max(1, round(masked.width * scale))
    scaled_height = max(1, round(masked.height * scale))
    scaled = masked.resize((scaled_width, scaled_height), Image.Resampling.LANCZOS)
    rotated = scaled.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)

    frame = Image.new("RGBA", (frame_size, frame_size), (0, 0, 0, 0))
    pivot_x = frame_size // 2
    pivot_y = int(frame_size * 0.86)
    paste_x = round(pivot_x - rotated.width / 2)
    paste_y = round(pivot_y - rotated.height)
    frame.alpha_composite(rotated, (paste_x, paste_y))
    return frame


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for old_file in OUTPUT_DIR.glob("*.png"):
        old_file.unlink()

    entries: list[dict[str, object]] = []
    for source_path in sorted(SOURCE_DIR.glob("*.png")):
        source = Image.open(source_path).convert("RGBA")
        max_source_size = math.floor(MAX_FRAME_SIZE / FRAME_PADDING_RATIO)
        if max(source.width, source.height) > max_source_size:
            source.thumbnail((max_source_size, max_source_size), Image.Resampling.LANCZOS)

        frame_size = min(MAX_FRAME_SIZE, math.ceil(max(source.width, source.height) * FRAME_PADDING_RATIO))
        frames = [build_frame(source, frame_size, index) for index in range(FRAME_COUNT)]
        sheet = Image.new("RGBA", (frame_size * FRAME_COUNT, frame_size), (0, 0, 0, 0))
        for index, frame in enumerate(frames):
            sheet.alpha_composite(frame, (frame_size * index, 0))

        sheet_name = f"{source_path.stem}-grow.png"
        sheet.save(OUTPUT_DIR / sheet_name)
        entries.append(
            {
                "source": source_path.name,
                "sheet": sheet_name,
                "frameWidth": frame_size,
                "frameHeight": frame_size,
                "frames": FRAME_COUNT,
                "duration": DURATION_SECONDS,
            }
        )

    (OUTPUT_DIR / "index.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
