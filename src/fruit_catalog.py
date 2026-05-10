from functools import lru_cache
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DATASET_ROOT = REPO_ROOT / "data2"
SUPPORTED_FRUITS = ("banana", "apple", "grape")
AUTO_FRUIT = "banana"


def normalize_fruit_name(fruit_name: str) -> str:
    normalized = fruit_name.strip().lower()
    if normalized not in SUPPORTED_FRUITS:
        raise ValueError(f"Unsupported fruit: {fruit_name}")
    return normalized


def fruit_line_dir(fruit_name: str) -> Path:
    return DATASET_ROOT / "fruit_data_line" / normalize_fruit_name(fruit_name)


def fruit_illust_dir(fruit_name: str) -> Path:
    return DATASET_ROOT / "fruit_data_encoded3" / normalize_fruit_name(fruit_name)


def fruit_point_dir(fruit_name: str) -> Path:
    return DATASET_ROOT / "point_data" / normalize_fruit_name(fruit_name)


@lru_cache(maxsize=None)
def available_image_ids(fruit_name: str) -> tuple[str, ...]:
    normalized = normalize_fruit_name(fruit_name)
    line_ids = {path.stem for path in fruit_line_dir(normalized).glob("*.png")}
    illust_ids = {path.stem for path in fruit_illust_dir(normalized).glob("*.png")}
    return tuple(sorted(line_ids & illust_ids))


@lru_cache(maxsize=1)
def all_available_image_ids() -> tuple[str, ...]:
    merged: set[str] = set()
    for fruit_name in SUPPORTED_FRUITS:
        merged.update(available_image_ids(fruit_name))
    return tuple(sorted(merged))
