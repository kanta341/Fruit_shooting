import math
from dataclasses import dataclass
from pathlib import Path

try:
    from .point import (
        ContourData,
        ContourPoint,
        data_url_to_png_bytes,
        ensure_contour_data,
        extract_contour_data_from_png_bytes,
        load_contour_data,
    )
    from .fruit_catalog import AUTO_FRUIT
except ImportError:
    from point import (  # type: ignore
        ContourData,
        ContourPoint,
        data_url_to_png_bytes,
        ensure_contour_data,
        extract_contour_data_from_png_bytes,
        load_contour_data,
    )
    from fruit_catalog import AUTO_FRUIT  # type: ignore


FIXED_IMAGE_ID = "Image_1"


@dataclass(frozen=True)
class FitResult:
    image_id: str
    image_width: int
    image_height: int
    scale: float
    translation_x: float
    translation_y: float
    representative_index: int
    input_start_index: int
    reversed: bool
    similarity: float


def rotate_points(points: tuple[ContourPoint, ...], start_index: int, reverse: bool) -> list[ContourPoint]:
    count = len(points)
    if reverse:
        return [points[(start_index - offset) % count] for offset in range(count)]
    return [points[(start_index + offset) % count] for offset in range(count)]


def major_axis_scale(input_contour: ContourData, reference_contour: ContourData) -> float:
    input_major = max(input_contour.bbox_width, input_contour.bbox_height)
    reference_major = max(reference_contour.bbox_width, reference_contour.bbox_height)
    if reference_major <= 0:
        return 1.0
    return input_major / reference_major


def point_distance(left: ContourPoint, right: ContourPoint) -> float:
    return math.hypot(left.x - right.x, left.y - right.y)


def polyline_length(points: list[ContourPoint]) -> float:
    if len(points) < 2:
        return 0.0
    total = 0.0
    for index in range(1, len(points)):
        total += point_distance(points[index - 1], points[index])
    return total


def similarity_for_same_length(
    input_points: list[ContourPoint],
    reference_points: list[ContourPoint],
) -> float:
    total = 0.0
    count = min(len(input_points), len(reference_points))
    for index in range(count):
        total += point_distance(input_points[index], reference_points[index])
    mean_distance = total / max(count, 1)
    return 1.0 / (1.0 + mean_distance)


def cut_reference_segment(points: list[ContourPoint], target_length: float) -> list[ContourPoint]:
    if not points:
        return []
    if len(points) == 1 or target_length <= 0:
        return [points[0]]

    segment = [points[0]]
    traveled = 0.0
    for index in range(1, len(points)):
        start = points[index - 1]
        end = points[index]
        edge_length = point_distance(start, end)
        if traveled + edge_length >= target_length and edge_length > 0:
            remain = target_length - traveled
            ratio = remain / edge_length
            segment.append(
                ContourPoint(
                    x=start.x * (1.0 - ratio) + end.x * ratio,
                    y=start.y * (1.0 - ratio) + end.y * ratio,
                )
            )
            return segment
        segment.append(end)
        traveled += edge_length
    return segment


def resample_open_points(points: list[ContourPoint], sample_count: int) -> list[ContourPoint]:
    if not points:
        return []
    if len(points) == 1:
        return [points[0] for _ in range(sample_count)]

    lengths = [0.0]
    for index in range(1, len(points)):
        lengths.append(lengths[-1] + point_distance(points[index - 1], points[index]))
    total_length = lengths[-1]
    if total_length <= 0:
        return [points[0] for _ in range(sample_count)]

    sampled: list[ContourPoint] = []
    segment_index = 0
    denominator = max(sample_count - 1, 1)
    for sample_index in range(sample_count):
        target = total_length * sample_index / denominator
        while segment_index + 1 < len(lengths) and lengths[segment_index + 1] < target:
            segment_index += 1
        start = points[segment_index]
        end = points[min(segment_index + 1, len(points) - 1)]
        start_length = lengths[segment_index]
        end_length = lengths[min(segment_index + 1, len(lengths) - 1)]
        ratio = 0.0 if end_length == start_length else (target - start_length) / (end_length - start_length)
        sampled.append(
            ContourPoint(
                x=start.x * (1.0 - ratio) + end.x * ratio,
                y=start.y * (1.0 - ratio) + end.y * ratio,
            )
        )
    return sampled


def estimate_translation(
    input_anchor: ContourPoint,
    reference_anchor: ContourPoint,
    scale: float,
) -> tuple[float, float]:
    return (
        input_anchor.x - reference_anchor.x * scale,
        input_anchor.y - reference_anchor.y * scale,
    )


def translate_reference(points: list[ContourPoint], scale: float, translation_x: float, translation_y: float) -> list[ContourPoint]:
    return [
        ContourPoint(x=point.x * scale + translation_x, y=point.y * scale + translation_y)
        for point in points
    ]


def load_reference_contour(image_id: str = FIXED_IMAGE_ID, fruit_name: str = AUTO_FRUIT) -> ContourData:
    return load_contour_data(ensure_contour_data(image_id, fruit_name=fruit_name))


def fit_input_data_url(
    data_url: str,
    image_id: str = FIXED_IMAGE_ID,
    whole_mode: bool = False,
    fruit_name: str = AUTO_FRUIT,
) -> FitResult:
    input_contour = extract_contour_data_from_png_bytes(
        data_url_to_png_bytes(data_url),
        image_id="input",
        closed=False,
    )
    if whole_mode:
        return fit_input_whole_contour(input_contour, image_id=image_id, fruit_name=fruit_name)
    return fit_input_contour(input_contour, image_id=image_id, fruit_name=fruit_name)


def bbox_center(contour: ContourData) -> tuple[float, float]:
    return (
        (contour.bbox_left + contour.bbox_right) / 2.0,
        (contour.bbox_top + contour.bbox_bottom) / 2.0,
    )


def fit_input_whole_contour(
    input_contour: ContourData,
    image_id: str = FIXED_IMAGE_ID,
    fruit_name: str = AUTO_FRUIT,
) -> FitResult:
    reference_contour = load_reference_contour(image_id, fruit_name=fruit_name)
    scale = major_axis_scale(input_contour, reference_contour)
    input_center_x, input_center_y = bbox_center(input_contour)
    reference_center_x, reference_center_y = bbox_center(reference_contour)
    translation_x = input_center_x - reference_center_x * scale
    translation_y = input_center_y - reference_center_y * scale

    scaled_reference_width = reference_contour.bbox_width * scale
    scaled_reference_height = reference_contour.bbox_height * scale
    width_error = abs(scaled_reference_width - input_contour.bbox_width)
    height_error = abs(scaled_reference_height - input_contour.bbox_height)
    similarity = 1.0 / (1.0 + (width_error + height_error) / 2.0)

    return FitResult(
        image_id=reference_contour.image_id,
        image_width=reference_contour.image_width,
        image_height=reference_contour.image_height,
        scale=scale,
        translation_x=translation_x,
        translation_y=translation_y,
        representative_index=-1,
        input_start_index=-1,
        reversed=False,
        similarity=similarity,
    )


def fit_input_contour(
    input_contour: ContourData,
    image_id: str = FIXED_IMAGE_ID,
    fruit_name: str = AUTO_FRUIT,
) -> FitResult:
    reference_contour = load_reference_contour(image_id, fruit_name=fruit_name)
    scale = major_axis_scale(input_contour, reference_contour)
    input_points = list(input_contour.contour_points)
    input_length = polyline_length(input_points)

    best_result: FitResult | None = None
    for representative_index, representative in enumerate(reference_contour.representative_points):
        for reversed_direction in (False, True):
            reference_points = rotate_points(reference_contour.contour_points, representative.point_index, reversed_direction)
            raw_reference_length = input_length / max(scale, 1e-8)
            reference_segment = cut_reference_segment(reference_points, raw_reference_length)
            transformed_reference = translate_reference(reference_segment, scale, 0.0, 0.0)
            transformed_reference = resample_open_points(transformed_reference, len(input_points))
            translation_x, translation_y = estimate_translation(input_points[0], transformed_reference[0], 1.0)
            transformed_reference = translate_reference(transformed_reference, 1.0, translation_x, translation_y)
            similarity = similarity_for_same_length(input_points, transformed_reference)
            candidate = FitResult(
                image_id=reference_contour.image_id,
                image_width=reference_contour.image_width,
                image_height=reference_contour.image_height,
                scale=scale,
                translation_x=translation_x,
                translation_y=translation_y,
                representative_index=representative_index,
                input_start_index=0,
                reversed=reversed_direction,
                similarity=similarity,
            )
            if best_result is None or candidate.similarity > best_result.similarity:
                best_result = candidate

    if best_result is None:
        raise ValueError("Failed to fit contour")
    return best_result
