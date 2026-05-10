from __future__ import annotations

import argparse

try:
    from .fruit_catalog import SUPPORTED_FRUITS, fruit_line_dir, fruit_point_dir, normalize_fruit_name
    from .point import build_point_dataset
except ImportError:
    from fruit_catalog import SUPPORTED_FRUITS, fruit_line_dir, fruit_point_dir, normalize_fruit_name  # type: ignore
    from point import build_point_dataset  # type: ignore


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build point_data JSON files for fruit line datasets.")
    parser.add_argument(
        "--fruit",
        action="append",
        dest="fruits",
        help="Fruit name to build. Repeatable. Default: all supported fruits.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    fruits = args.fruits or list(SUPPORTED_FRUITS)
    for fruit_name in fruits:
        normalized = normalize_fruit_name(fruit_name)
        outputs = build_point_dataset(
            line_image_dir=fruit_line_dir(normalized),
            output_dir=fruit_point_dir(normalized),
        )
        print(f"{normalized}: {len(outputs)} files")


if __name__ == "__main__":
    main()
