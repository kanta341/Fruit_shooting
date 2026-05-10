from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "data2" / "fruit_data_encoded"
OUTPUT_ROOT = ROOT / "data2" / "fruit_data_encoded2"
FRUIT_DIRS = ("apple", "banana", "grape")
TRANSPARENT_ALPHA = 20
VISIBLE_ALPHA = 16
WHITE_LUMA_THRESHOLD = 205
WHITE_CHANNEL_MIN = 185
WHITE_CHANNEL_SPREAD_MAX = 70


def is_exterior_removable(red: int, green: int, blue: int, alpha: int) -> bool:
    if alpha <= TRANSPARENT_ALPHA:
        return True

    luma = (red + green + blue) / 3
    channel_spread = max(red, green, blue) - min(red, green, blue)
    return (
        luma >= WHITE_LUMA_THRESHOLD
        and min(red, green, blue) >= WHITE_CHANNEL_MIN
        and channel_spread <= WHITE_CHANNEL_SPREAD_MAX
    )


def transparentize_exterior_white(image: Image.Image) -> Image.Image:
    rgba = np.array(image.convert("RGBA"))
    rgb = rgba[:, :, :3].astype(np.int16)
    alpha = rgba[:, :, 3]
    luma = rgb.mean(axis=2)
    channel_spread = rgb.max(axis=2) - rgb.min(axis=2)
    removable = (
        (alpha <= TRANSPARENT_ALPHA)
        | (
            (luma >= WHITE_LUMA_THRESHOLD)
            & (rgb.min(axis=2) >= WHITE_CHANNEL_MIN)
            & (channel_spread <= WHITE_CHANNEL_SPREAD_MAX)
        )
    ).astype(np.uint8)

    label_count, labels = cv2.connectedComponents(removable, connectivity=8)
    if label_count <= 1:
        return Image.fromarray(rgba, "RGBA")

    border_labels = set(np.unique(labels[0, :]))
    border_labels.update(np.unique(labels[-1, :]))
    border_labels.update(np.unique(labels[:, 0]))
    border_labels.update(np.unique(labels[:, -1]))
    border_labels.discard(0)

    if border_labels:
        exterior = np.isin(labels, list(border_labels))
        rgba[exterior, 3] = 0

    return Image.fromarray(rgba, "RGBA")


def keep_largest_visible_component(image: Image.Image) -> Image.Image:
    rgba = np.array(image.convert("RGBA"))
    visible = (rgba[:, :, 3] > VISIBLE_ALPHA).astype(np.uint8)
    label_count, labels, stats, _centroids = cv2.connectedComponentsWithStats(visible, connectivity=8)
    if label_count <= 2:
        return Image.fromarray(rgba, "RGBA")

    areas = stats[1:, cv2.CC_STAT_AREA]
    keep_label = int(np.argmax(areas) + 1)
    rgba[(labels != 0) & (labels != keep_label), 3] = 0
    return Image.fromarray(rgba, "RGBA")


def process_image(source_path: Path, output_path: Path) -> tuple[int, int]:
    original = Image.open(source_path).convert("RGBA")
    original_alpha_pixels = int(np.count_nonzero(np.array(original)[:, :, 3] > VISIBLE_ALPHA))
    processed = transparentize_exterior_white(original)
    processed = keep_largest_visible_component(processed)
    processed_alpha_pixels = int(np.count_nonzero(np.array(processed)[:, :, 3] > VISIBLE_ALPHA))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    processed.save(output_path)
    return original_alpha_pixels, processed_alpha_pixels


def main() -> None:
    total_files = 0
    total_removed_pixels = 0
    for fruit_name in FRUIT_DIRS:
        source_dir = SOURCE_ROOT / fruit_name
        output_dir = OUTPUT_ROOT / fruit_name
        for source_path in sorted(source_dir.glob("*.png")):
            output_path = output_dir / source_path.name
            before, after = process_image(source_path, output_path)
            total_files += 1
            total_removed_pixels += max(0, before - after)

    print(f"Processed {total_files} PNG files into {OUTPUT_ROOT}")
    print(f"Removed {total_removed_pixels} visible pixels")


if __name__ == "__main__":
    main()
