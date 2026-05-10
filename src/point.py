import json
import math
import os
import struct
import zlib
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

try:
    from .fruit_catalog import AUTO_FRUIT, fruit_line_dir, fruit_point_dir, normalize_fruit_name
except ImportError:
    from fruit_catalog import AUTO_FRUIT, fruit_line_dir, fruit_point_dir, normalize_fruit_name  # type: ignore

LINE_IMAGE_DIR = fruit_line_dir(AUTO_FRUIT)
POINT_DATA_DIR = fruit_point_dir(AUTO_FRUIT)
LINE_THRESHOLD = 220
RESAMPLED_POINT_COUNT = 256
REPRESENTATIVE_POINT_COUNT = 10


@dataclass(frozen=True)
class ContourPoint:
    x: float
    y: float


@dataclass(frozen=True)
class RepresentativePoint:
    point_index: int
    x: float
    y: float


@dataclass(frozen=True)
class ContourData:
    image_id: str
    image_width: int
    image_height: int
    bbox_left: int
    bbox_top: int
    bbox_right: int
    bbox_bottom: int
    bbox_width: int
    bbox_height: int
    contour_points: tuple[ContourPoint, ...]
    representative_points: tuple[RepresentativePoint, ...]

    def to_dict(self) -> dict:
        return {
            "image_id": self.image_id,
            "image_width": self.image_width,
            "image_height": self.image_height,
            "bbox": {
                "left": self.bbox_left,
                "top": self.bbox_top,
                "right": self.bbox_right,
                "bottom": self.bbox_bottom,
                "width": self.bbox_width,
                "height": self.bbox_height,
            },
            "contour_points": [{"x": point.x, "y": point.y} for point in self.contour_points],
            "representative_points": [
                {"point_index": point.point_index, "x": point.x, "y": point.y}
                for point in self.representative_points
            ],
        }


def paeth_predictor(left: int, up: int, up_left: int) -> int:
    predictor = left + up - up_left
    left_distance = abs(predictor - left)
    up_distance = abs(predictor - up)
    up_left_distance = abs(predictor - up_left)
    if left_distance <= up_distance and left_distance <= up_left_distance:
        return left
    if up_distance <= up_left_distance:
        return up
    return up_left


def decode_png_bytes(png_bytes: bytes) -> tuple[int, int, int, bytearray]:
    if png_bytes[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Unsupported image format: expected PNG")

    cursor = 8
    width = height = bit_depth = color_type = None
    idat_parts: list[bytes] = []
    while cursor < len(png_bytes):
        chunk_length = struct.unpack(">I", png_bytes[cursor : cursor + 4])[0]
        cursor += 4
        chunk_type = png_bytes[cursor : cursor + 4]
        cursor += 4
        chunk_data = png_bytes[cursor : cursor + chunk_length]
        cursor += chunk_length + 4
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(
                ">IIBBBBB", chunk_data
            )
            if bit_depth != 8:
                raise ValueError(f"Unsupported bit depth: {bit_depth}")
            if compression != 0 or filter_method != 0 or interlace != 0:
                raise ValueError("Unsupported PNG encoding")
        elif chunk_type == b"IDAT":
            idat_parts.append(chunk_data)
        elif chunk_type == b"IEND":
            break

    if width is None or height is None or color_type is None:
        raise ValueError("PNG header is incomplete")

    channels_by_color_type = {0: 1, 2: 3, 6: 4}
    if color_type not in channels_by_color_type:
        raise ValueError(f"Unsupported PNG color type: {color_type}")

    channels = channels_by_color_type[color_type]
    bytes_per_pixel = channels
    stride = width * channels
    decompressed = zlib.decompress(b"".join(idat_parts))

    pixels = bytearray(width * height * channels)
    src_offset = 0
    dst_offset = 0
    previous_row = bytearray(stride)
    for _ in range(height):
        filter_type = decompressed[src_offset]
        src_offset += 1
        raw_row = decompressed[src_offset : src_offset + stride]
        src_offset += stride

        row = bytearray(stride)
        for index in range(stride):
            left = row[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
            up = previous_row[index]
            up_left = previous_row[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
            value = raw_row[index]
            if filter_type == 1:
                value = (value + left) & 0xFF
            elif filter_type == 2:
                value = (value + up) & 0xFF
            elif filter_type == 3:
                value = (value + ((left + up) // 2)) & 0xFF
            elif filter_type == 4:
                value = (value + paeth_predictor(left, up, up_left)) & 0xFF
            row[index] = value

        pixels[dst_offset : dst_offset + stride] = row
        dst_offset += stride
        previous_row = row
    return width, height, color_type, pixels


def data_url_to_png_bytes(data_url: str) -> bytes:
    if "," not in data_url:
        raise ValueError("Invalid image payload")
    return _data_url_to_png_bytes_impl(data_url)


def _data_url_to_png_bytes_impl(data_url: str) -> bytes:
    import base64

    _, encoded = data_url.split(",", 1)
    return base64.b64decode(encoded)


def rgba_to_ink(pixel: bytes) -> bool:
    red, green, blue, alpha = pixel
    return alpha > 0 and (red < LINE_THRESHOLD or green < LINE_THRESHOLD or blue < LINE_THRESHOLD)


def pixel_to_ink(color_type: int, pixels: bytearray, offset: int) -> bool:
    if color_type == 0:
        return pixels[offset] < LINE_THRESHOLD
    if color_type == 2:
        red, green, blue = pixels[offset : offset + 3]
        return red < LINE_THRESHOLD or green < LINE_THRESHOLD or blue < LINE_THRESHOLD
    if color_type == 6:
        return rgba_to_ink(pixels[offset : offset + 4])
    raise ValueError(f"Unsupported PNG color type: {color_type}")


def extract_ink_points(width: int, height: int, color_type: int, pixels: bytearray) -> set[tuple[int, int]]:
    channels = {0: 1, 2: 3, 6: 4}[color_type]
    points: set[tuple[int, int]] = set()
    offset = 0
    for y in range(height):
        for x in range(width):
            if pixel_to_ink(color_type, pixels, offset):
                points.add((x, y))
            offset += channels
    if not points:
        raise ValueError("No visible line pixels found")
    return points


def crop_points(points: set[tuple[int, int]]) -> tuple[set[tuple[int, int]], tuple[int, int, int, int]]:
    left = min(x for x, _ in points)
    top = min(y for _, y in points)
    right = max(x for x, _ in points) + 1
    bottom = max(y for _, y in points) + 1
    cropped = {(x - left, y - top) for x, y in points}
    return cropped, (left, top, right, bottom)


def neighbors8(point: tuple[int, int]) -> tuple[tuple[int, int], ...]:
    x, y = point
    return (
        (x, y - 1),
        (x + 1, y - 1),
        (x + 1, y),
        (x + 1, y + 1),
        (x, y + 1),
        (x - 1, y + 1),
        (x - 1, y),
        (x - 1, y - 1),
    )


def zhang_suen_thinning(points: set[tuple[int, int]]) -> set[tuple[int, int]]:
    active = set(points)
    changed = True
    while changed:
        changed = False
        for step in (0, 1):
            to_remove: list[tuple[int, int]] = []
            for point in active:
                ordered_neighbors = neighbors8(point)
                present = [neighbor in active for neighbor in ordered_neighbors]
                count = sum(present)
                if count < 2 or count > 6:
                    continue
                transitions = sum(1 for index in range(8) if not present[index] and present[(index + 1) % 8])
                if transitions != 1:
                    continue
                north, north_east, east, south_east, south, south_west, west, north_west = present
                if step == 0:
                    if north and east and south:
                        continue
                    if east and south and west:
                        continue
                else:
                    if north and east and west:
                        continue
                    if north and south and west:
                        continue
                to_remove.append(point)
            if to_remove:
                active.difference_update(to_remove)
                changed = True
    return active


def prune_spurs(points: set[tuple[int, int]], rounds: int = 24) -> set[tuple[int, int]]:
    active = set(points)
    for _ in range(rounds):
        endpoints = []
        for point in active:
            degree = sum(1 for neighbor in neighbors8(point) if neighbor in active)
            if degree <= 1:
                endpoints.append(point)
        if not endpoints:
            break
        active.difference_update(endpoints)
    return active


def choose_next_point(
    previous_point: tuple[int, int],
    current_point: tuple[int, int],
    candidates: list[tuple[int, int]],
) -> tuple[int, int]:
    current_dx = current_point[0] - previous_point[0]
    current_dy = current_point[1] - previous_point[1]
    best_candidate = candidates[0]
    best_score = -10.0
    for candidate in candidates:
        next_dx = candidate[0] - current_point[0]
        next_dy = candidate[1] - current_point[1]
        current_norm = math.hypot(current_dx, current_dy) or 1.0
        next_norm = math.hypot(next_dx, next_dy) or 1.0
        score = (current_dx * next_dx + current_dy * next_dy) / (current_norm * next_norm)
        score -= 0.01 * math.hypot(next_dx, next_dy)
        if score > best_score:
            best_score = score
            best_candidate = candidate
    return best_candidate


def order_closed_curve(points: set[tuple[int, int]]) -> list[tuple[int, int]]:
    if not points:
        raise ValueError("Empty contour")

    adjacency = {point: [neighbor for neighbor in neighbors8(point) if neighbor in points] for point in points}
    start = min(points, key=lambda item: (item[1], item[0]))
    start_neighbors = adjacency[start]
    if not start_neighbors:
        return [start]

    first = min(start_neighbors, key=lambda item: (item[1], item[0]))
    ordered = [start]
    previous = start
    current = first
    used_edges = {(start, first), (first, start)}

    for _ in range(len(points) * 2):
        if current == start:
            break
        ordered.append(current)
        candidates = [neighbor for neighbor in adjacency[current] if (current, neighbor) not in used_edges]
        if not candidates:
            if start in adjacency[current]:
                current = start
                continue
            break
        next_point = choose_next_point(previous, current, candidates)
        used_edges.add((current, next_point))
        used_edges.add((next_point, current))
        previous, current = current, next_point

    if len(ordered) < 8:
        raise ValueError("Failed to build an ordered contour")
    return ordered


def find_endpoints(points: set[tuple[int, int]]) -> list[tuple[int, int]]:
    endpoints = []
    for point in points:
        degree = sum(1 for neighbor in neighbors8(point) if neighbor in points)
        if degree <= 1:
            endpoints.append(point)
    return sorted(endpoints, key=lambda item: (item[1], item[0]))


def order_open_curve(points: set[tuple[int, int]]) -> list[tuple[int, int]]:
    if not points:
        raise ValueError("Empty contour")

    adjacency = {point: [neighbor for neighbor in neighbors8(point) if neighbor in points] for point in points}
    endpoints = find_endpoints(points)
    start = endpoints[0] if endpoints else min(points, key=lambda item: (item[1], item[0]))

    ordered = [start]
    previous = start
    current = start
    visited = {start}

    while True:
        candidates = [neighbor for neighbor in adjacency[current] if neighbor not in visited]
        if not candidates:
            break
        if len(ordered) == 1:
            next_point = min(candidates, key=lambda item: (item[1], item[0]))
        else:
            next_point = choose_next_point(previous, current, candidates)
        ordered.append(next_point)
        visited.add(next_point)
        previous, current = current, next_point

    if len(ordered) < 2:
        raise ValueError("Failed to build an ordered open curve")
    return ordered


def cumulative_lengths(points: list[tuple[float, float]], closed: bool) -> list[float]:
    total = [0.0]
    for index in range(1, len(points)):
        dx = points[index][0] - points[index - 1][0]
        dy = points[index][1] - points[index - 1][1]
        total.append(total[-1] + math.hypot(dx, dy))
    if closed:
        dx = points[0][0] - points[-1][0]
        dy = points[0][1] - points[-1][1]
        total.append(total[-1] + math.hypot(dx, dy))
    return total


def resample_curve(points: list[tuple[int, int]], sample_count: int, closed: bool) -> list[ContourPoint]:
    float_points = [(float(x), float(y)) for x, y in points]
    lengths = cumulative_lengths(float_points, closed=closed)
    perimeter = lengths[-1]
    if perimeter <= 0:
        return [ContourPoint(x=float_points[0][0], y=float_points[0][1]) for _ in range(sample_count)]

    sampled: list[ContourPoint] = []
    segment_index = 0
    for sample_index in range(sample_count):
        denominator = sample_count if closed else max(sample_count - 1, 1)
        target = perimeter * sample_index / denominator
        while segment_index + 1 < len(lengths) and lengths[segment_index + 1] < target:
            segment_index += 1
        start_point = float_points[segment_index % len(float_points)]
        if closed:
            end_point = float_points[(segment_index + 1) % len(float_points)]
        else:
            end_point = float_points[min(segment_index + 1, len(float_points) - 1)]
        start_length = lengths[segment_index]
        end_length = lengths[segment_index + 1]
        ratio = 0.0 if end_length == start_length else (target - start_length) / (end_length - start_length)
        sampled.append(
            ContourPoint(
                x=start_point[0] * (1.0 - ratio) + end_point[0] * ratio,
                y=start_point[1] * (1.0 - ratio) + end_point[1] * ratio,
            )
        )
    return sampled


def representative_points(points: list[ContourPoint], count: int) -> tuple[RepresentativePoint, ...]:
    total = len(points)
    selected = []
    for index in range(count):
        point_index = (index * total) // count
        point = points[point_index]
        selected.append(RepresentativePoint(point_index=point_index, x=point.x, y=point.y))
    return tuple(selected)


def extract_contour_data_from_png_bytes(png_bytes: bytes, image_id: str = "input", closed: bool = True) -> ContourData:
    image_width, image_height, color_type, pixels = decode_png_bytes(png_bytes)
    ink_points = extract_ink_points(image_width, image_height, color_type, pixels)
    cropped_points, (left, top, right, bottom) = crop_points(ink_points)
    skeleton = zhang_suen_thinning(cropped_points)
    if closed:
        skeleton = prune_spurs(skeleton)
        ordered_points = order_closed_curve(skeleton)
    else:
        ordered_points = order_open_curve(skeleton)
    contour_points = resample_curve(
        [(x + left, y + top) for x, y in ordered_points],
        RESAMPLED_POINT_COUNT,
        closed=closed,
    )
    return ContourData(
        image_id=image_id,
        image_width=image_width,
        image_height=image_height,
        bbox_left=left,
        bbox_top=top,
        bbox_right=right,
        bbox_bottom=bottom,
        bbox_width=right - left,
        bbox_height=bottom - top,
        contour_points=tuple(contour_points),
        representative_points=representative_points(contour_points, REPRESENTATIVE_POINT_COUNT),
    )


def save_contour_data(png_path: Path, output_dir: Path) -> Path:
    contour_data = extract_contour_data_from_png_bytes(png_path.read_bytes(), image_id=png_path.stem)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{png_path.stem}.json"
    output_path.write_text(json.dumps(contour_data.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    return output_path


def ensure_contour_data(image_id: str, fruit_name: str = AUTO_FRUIT) -> Path:
    normalized_fruit = normalize_fruit_name(fruit_name)
    output_path = fruit_point_dir(normalized_fruit) / f"{image_id}.json"
    if output_path.exists():
        return output_path

    png_path = fruit_line_dir(normalized_fruit) / f"{image_id}.png"
    if not png_path.exists():
        raise FileNotFoundError(f"Reference line image not found: {png_path}")
    return save_contour_data(png_path, fruit_point_dir(normalized_fruit))


def build_point_dataset(line_image_dir: Path = LINE_IMAGE_DIR, output_dir: Path = POINT_DATA_DIR) -> list[Path]:
    png_paths = sorted(line_image_dir.glob("*.png"))
    output_dir.mkdir(parents=True, exist_ok=True)
    tasks = [(path, output_dir) for path in png_paths]
    if os.environ.get("POINT_FORCE_SEQUENTIAL") == "1":
        return [_save_contour_data_worker(task) for task in tasks]
    try:
        with ProcessPoolExecutor() as executor:
            return list(executor.map(_save_contour_data_worker, tasks))
    except PermissionError:
        return [_save_contour_data_worker(task) for task in tasks]


def _save_contour_data_worker(args: tuple[Path, Path]) -> Path:
    png_path, output_dir = args
    return save_contour_data(png_path, output_dir)


def load_contour_data(path: Path) -> ContourData:
    payload = json.loads(path.read_text(encoding="utf-8"))
    bbox = payload["bbox"]
    contour_points = tuple(ContourPoint(x=item["x"], y=item["y"]) for item in payload["contour_points"])
    representative = tuple(
        RepresentativePoint(point_index=item["point_index"], x=item["x"], y=item["y"])
        for item in payload["representative_points"]
    )
    return ContourData(
        image_id=payload["image_id"],
        image_width=payload["image_width"],
        image_height=payload["image_height"],
        bbox_left=bbox["left"],
        bbox_top=bbox["top"],
        bbox_right=bbox["right"],
        bbox_bottom=bbox["bottom"],
        bbox_width=bbox["width"],
        bbox_height=bbox["height"],
        contour_points=contour_points,
        representative_points=representative,
    )


def main() -> None:
    build_point_dataset()


if __name__ == "__main__":
    main()
