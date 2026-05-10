from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "data2" / "fruit_data_encoded2"
OUTPUT_ROOT = ROOT / "data2" / "fruit_data_encoded3"
DEFAULT_FRUIT_DIRS = ("apple", "banana", "grape")
VISIBLE_ALPHA = 16
SATURATION_MULTIPLIER = 1.8
MIN_VALUE_TO_ADJUST = 55
MAX_VALUE_TO_ADJUST = 235
MIN_SATURATION_TO_ADJUST = 22
WHITE_SATURATION_MAX = 42
WHITE_VALUE_MIN = 210


def saturate_image(source_path: Path, output_path: Path) -> int:
    image = Image.open(source_path).convert("RGBA")
    rgba = np.array(image)
    rgb = rgba[:, :, :3]
    alpha = rgba[:, :, 3]
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
    saturation = hsv[:, :, 1]
    value = hsv[:, :, 2]

    visible = alpha > VISIBLE_ALPHA
    near_black = value < MIN_VALUE_TO_ADJUST
    near_white = (value > WHITE_VALUE_MIN) & (saturation < WHITE_SATURATION_MAX)
    low_saturation = saturation < MIN_SATURATION_TO_ADJUST
    over_bright = value > MAX_VALUE_TO_ADJUST
    adjustable = visible & ~near_black & ~near_white & ~low_saturation & ~over_bright

    hsv[:, :, 1][adjustable] = np.minimum(255, hsv[:, :, 1][adjustable] * SATURATION_MULTIPLIER)
    rgba[:, :, :3] = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(output_path)
    return int(np.count_nonzero(adjustable))


def main() -> None:
    total_files = 0
    total_adjusted_pixels = 0
    for fruit_name in DEFAULT_FRUIT_DIRS:
        for source_path in sorted((SOURCE_ROOT / fruit_name).glob("*.png")):
            output_path = OUTPUT_ROOT / fruit_name / source_path.name
            total_adjusted_pixels += saturate_image(source_path, output_path)
            total_files += 1

    print(f"Processed {total_files} PNG files into {OUTPUT_ROOT}")
    print(f"Adjusted {total_adjusted_pixels} colored pixels")


if __name__ == "__main__":
    main()
