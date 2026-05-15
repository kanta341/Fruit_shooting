import json
import os
import sys
import tempfile
import time
import zipfile

try:
    from .generate_fruit_pipeline import get_banana_generator_pipeline
except ImportError:
    from generate_fruit_pipeline import get_banana_generator_pipeline  # type: ignore


PREDICT_MODE_GENERATED = "generated"
PREDICT_MODE_JUDGE = "judge"
PREDICT_MODE_SHAPE_MATCH = "shape_match"

_judge_model = None
_judge_model_loaded = False


def strip_quantization_config(value):
    if isinstance(value, dict):
        return {
            key: strip_quantization_config(item)
            for key, item in value.items()
            if key != "quantization_config"
        }
    if isinstance(value, list):
        return [strip_quantization_config(item) for item in value]
    return value


def build_keras_compat_copy(model_path: str) -> str:
    fd, patched_path = tempfile.mkstemp(suffix=".keras")
    os.close(fd)
    with zipfile.ZipFile(model_path, "r") as src_zip:
        with zipfile.ZipFile(patched_path, "w", compression=zipfile.ZIP_DEFLATED) as dst_zip:
            for info in src_zip.infolist():
                data = src_zip.read(info.filename)
                if info.filename == "config.json":
                    config = strip_quantization_config(json.loads(data.decode("utf-8")))
                    data = json.dumps(config, ensure_ascii=False).encode("utf-8")
                dst_zip.writestr(info, data)
    return patched_path


def load_judge_model():
    global _judge_model, _judge_model_loaded
    if _judge_model_loaded:
        return _judge_model
    _judge_model_loaded = True
    try:
        import tensorflow as tf  # type: ignore
        model_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "generate_fruit", "model", "judge_model", "quickdraw_fruit_128_sigmoid.keras",
        )
        try:
            _judge_model = tf.keras.models.load_model(model_path, compile=False)
        except Exception as load_exc:
            if "quantization_config" not in str(load_exc):
                raise
            patched_path = build_keras_compat_copy(model_path)
            try:
                _judge_model = tf.keras.models.load_model(patched_path, compile=False)
            finally:
                try:
                    os.unlink(patched_path)
                except OSError:
                    pass
        sys.stderr.write(f"[judge] Model loaded from {model_path}\n")
        sys.stderr.flush()
    except Exception as exc:
        sys.stderr.write(f"[judge] Failed to load model: {exc}\n")
        sys.stderr.flush()
        _judge_model = None
    return _judge_model


def run_judge(image_b64: str, bbox: dict, canvas_width: int, canvas_height: int) -> dict:
    import base64
    import io
    import numpy as np
    from PIL import Image  # type: ignore

    # Decode canvas image
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]
    img_bytes = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(img_bytes)).convert("L")
    img_arr = np.array(img, dtype=np.float32)  # 0-255, white=255

    # Crop to ink bounding box with 10% padding, clamped to canvas
    left = int(bbox.get("left", 0))
    top = int(bbox.get("top", 0))
    right = int(bbox.get("right", canvas_width))
    bottom = int(bbox.get("bottom", canvas_height))
    w = max(1, right - left)
    h = max(1, bottom - top)
    pad = max(1, round(max(w, h) * 0.1))
    left = max(0, left - pad)
    top = max(0, top - pad)
    right = min(img_arr.shape[1], right + pad)
    bottom = min(img_arr.shape[0], bottom + pad)
    cropped = img_arr[top:bottom, left:right]

    # Pad cropped region to square with white background
    ch, cw = cropped.shape[:2]
    size = max(ch, cw, 1)
    square = np.full((size, size), 255.0, dtype=np.float32)
    y_off = (size - ch) // 2
    x_off = (size - cw) // 2
    square[y_off:y_off + ch, x_off:x_off + cw] = cropped

    # Resize to 128x128
    pil_sq = Image.fromarray(square.astype(np.uint8))
    pil_sq = pil_sq.resize((128, 128), Image.LANCZOS)
    arr = np.array(pil_sq, dtype=np.float32)

    # Binarize to match training: background=0, stroke=1, float32.
    arr = np.where(arr < 245.0, 1.0, 0.0).astype(np.float32)

    # Shape: (1, 128, 128, 1)
    arr = arr.reshape(1, 128, 128, 1)

    model = load_judge_model()
    if model is None:
        return {"apple": 0.0, "banana": 0.0, "grape": 0.0, "error": "model not loaded"}

    scores = model.predict(arr, verbose=0)[0].tolist()
    # class_names in model config: ["apple", "banana", "grapes"]
    return {
        "apple": float(scores[0]),
        "banana": float(scores[1]),
        "grape": float(scores[2]),
    }


def _decode_canvas_line_mask(image_b64: str, bbox: dict, canvas_width: int, canvas_height: int):
    import base64
    import io
    import cv2  # type: ignore
    import numpy as np
    from PIL import Image  # type: ignore

    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]
    img_bytes = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(img_bytes)).convert("L")
    img_arr = np.array(img, dtype=np.uint8)

    left = int(bbox.get("left", 0))
    top = int(bbox.get("top", 0))
    right = int(bbox.get("right", canvas_width))
    bottom = int(bbox.get("bottom", canvas_height))
    w = max(1, right - left)
    h = max(1, bottom - top)
    pad = max(2, round(max(w, h) * 0.12))
    left = max(0, left - pad)
    top = max(0, top - pad)
    right = min(img_arr.shape[1], right + pad)
    bottom = min(img_arr.shape[0], bottom + pad)
    cropped = img_arr[top:bottom, left:right]
    line = np.where(cropped < 245, 255, 0).astype(np.uint8)
    return _normalize_mask_to_square(line)


def _normalize_mask_to_square(mask, size: int = 128):
    import cv2  # type: ignore
    import numpy as np

    ys, xs = np.where(mask > 0)
    if len(xs) == 0 or len(ys) == 0:
        return np.zeros((size, size), dtype=np.uint8)
    left, right = int(xs.min()), int(xs.max()) + 1
    top, bottom = int(ys.min()), int(ys.max()) + 1
    cropped = mask[top:bottom, left:right]
    h, w = cropped.shape[:2]
    side = max(h, w, 1)
    pad = max(2, round(side * 0.08))
    square_side = side + pad * 2
    square = np.zeros((square_side, square_side), dtype=np.uint8)
    y = pad + (side - h) // 2
    x = pad + (side - w) // 2
    square[y:y + h, x:x + w] = cropped
    return cv2.resize(square, (size, size), interpolation=cv2.INTER_NEAREST)


def _sample_mask_from_file(path: str):
    import cv2  # type: ignore
    import numpy as np

    image = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if image is None:
        return None
    if image.ndim == 2:
        mask = np.where(image < 245, 255, 0).astype(np.uint8)
    elif image.shape[2] == 4:
        alpha = image[:, :, 3]
        gray = cv2.cvtColor(image[:, :, :3], cv2.COLOR_BGR2GRAY)
        mask = np.where((alpha > 8) & (gray < 250), 255, 0).astype(np.uint8)
        if int(mask.sum()) == 0:
            mask = np.where(alpha > 8, 255, 0).astype(np.uint8)
    else:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        mask = np.where(gray < 245, 255, 0).astype(np.uint8)
    return _normalize_mask_to_square(mask)


def _largest_contour(mask):
    import cv2  # type: ignore

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    return max(contours, key=cv2.contourArea)


def _shape_score_from_distance(distance: float) -> float:
    return max(0.0, min(1.0, 1.0 / (1.0 + max(0.0, distance))))


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _score_band(value: float, low: float, high: float, soft: float = 0.25) -> float:
    if low <= value <= high:
        return 1.0
    if value < low:
        return _clamp01(1.0 - ((low - value) / max(soft, 1e-6)))
    return _clamp01(1.0 - ((value - high) / max(soft, 1e-6)))


def _closed_region_components(line_mask):
    import cv2  # type: ignore
    import numpy as np

    if line_mask is None or int(np.count_nonzero(line_mask)) == 0:
        return [], np.zeros((128, 128), dtype=np.uint8)

    # Treat the sketch line as a wall. A small dilation makes hand-drawn gaps less
    # likely to break closed regions, while still preserving separate lobes.
    kernel = np.ones((3, 3), dtype=np.uint8)
    wall = cv2.dilate(np.where(line_mask > 0, 255, 0).astype(np.uint8), kernel, iterations=1)
    free = np.where(wall > 0, 0, 255).astype(np.uint8)

    flood = free.copy()
    h, w = flood.shape[:2]
    mask = np.zeros((h + 2, w + 2), dtype=np.uint8)
    for x in range(w):
        if flood[0, x] == 255:
            cv2.floodFill(flood, mask, (x, 0), 128)
        if flood[h - 1, x] == 255:
            cv2.floodFill(flood, mask, (x, h - 1), 128)
    for y in range(h):
        if flood[y, 0] == 255:
            cv2.floodFill(flood, mask, (0, y), 128)
        if flood[y, w - 1] == 255:
            cv2.floodFill(flood, mask, (w - 1, y), 128)

    enclosed = np.where(flood == 255, 255, 0).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(enclosed, 8)
    components = []
    min_area = max(18, int(enclosed.size * 0.0012))

    def lemon_point_features(approx, x, y, bw, bh):
        points = approx.reshape(-1, 2).astype(np.float32)
        if len(points) < 3:
            return 0, 0.0, [], []
        center = np.array([x + bw / 2.0, y + bh / 2.0], dtype=np.float32)
        major = max(float(bw), float(bh), 1.0)
        point_count = 0
        candidates = []
        selected_points = []
        for index, point in enumerate(points):
            prev_point = points[(index - 1) % len(points)]
            next_point = points[(index + 1) % len(points)]
            v1 = prev_point - point
            v2 = next_point - point
            norm = float(np.linalg.norm(v1) * np.linalg.norm(v2))
            if norm <= 1e-6:
                continue
            angle = float(np.degrees(np.arccos(np.clip(float(np.dot(v1, v2)) / norm, -1.0, 1.0))))
            candidate = {
                "x": float(point[0]),
                "y": float(point[1]),
                "angle": angle,
            }
            candidates.append(candidate)
            if angle > 80.0:
                continue
            from_center = float(np.linalg.norm(point - center)) / major
            if from_center < 0.30:
                continue
            px, py = float(point[0]), float(point[1])
            edge_margin_x = max(3.0, bw * 0.18)
            edge_margin_y = max(3.0, bh * 0.18)
            near_outer_edge = (
                px <= x + edge_margin_x
                or px >= x + bw - edge_margin_x
                or py <= y + edge_margin_y
                or py >= y + bh - edge_margin_y
            )
            if near_outer_edge:
                point_count += 1
                selected_points.append(candidate)
        if point_count == 0:
            score = 0.0
        elif point_count <= 2:
            score = 1.0
        else:
            score = max(0.35, 1.0 - (point_count - 2) * 0.22)
        return int(point_count), float(_clamp01(score)), candidates, selected_points

    for label in range(1, n):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        comp_mask = np.where(labels == label, 255, 0).astype(np.uint8)
        contours, _ = cv2.findContours(comp_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        contour_area = float(cv2.contourArea(contour))
        perimeter = float(cv2.arcLength(contour, True))
        x, y, bw, bh = cv2.boundingRect(contour)
        hull = cv2.convexHull(contour)
        hull_area = float(cv2.contourArea(hull))
        aspect = max(bw / max(bh, 1), bh / max(bw, 1))
        circularity = (4.0 * np.pi * contour_area / (perimeter * perimeter)) if perimeter > 0 else 0.0
        solidity = contour_area / hull_area if hull_area > 0 else 0.0
        extent = contour_area / max(float(bw * bh), 1.0)

        points = contour.reshape(-1, 2)
        top_cut = y + bh * 0.38
        mid_cut = y + bh * 0.62
        low_cut = y + bh * 0.72
        top_points = points[points[:, 1] <= top_cut]
        mid_points = points[(points[:, 1] >= top_cut) & (points[:, 1] <= mid_cut)]
        low_points = points[points[:, 1] >= low_cut]

        def span_x(arr):
            if len(arr) == 0:
                return 0.0
            return float(arr[:, 0].max() - arr[:, 0].min() + 1)

        top_span = span_x(top_points)
        mid_span = span_x(mid_points)
        low_span = span_x(low_points)
        taper = 1.0 - (low_span / max(mid_span, 1.0))
        lower_jaggedness = 0.0
        if len(low_points) >= 4 and low_span > 0:
            lower_contour = low_points[np.argsort(low_points[:, 0])]
            diffs = np.diff(lower_contour[:, 1].astype(np.float32))
            sign_changes = int(np.sum(np.diff(np.sign(diffs)) != 0)) if len(diffs) > 1 else 0
            lower_jaggedness = _clamp01(sign_changes / max(low_span * 0.35, 1.0))
        approx = cv2.approxPolyDP(contour, 0.025 * perimeter, True) if perimeter > 0 else contour
        lemon_point_count, lemon_point_score, lemon_point_candidates, lemon_selected_points = lemon_point_features(approx, x, y, bw, bh)

        components.append({
            "area": float(area),
            "contour_area": contour_area,
            "perimeter": perimeter,
            "bbox": [int(x), int(y), int(bw), int(bh)],
            "aspect": float(aspect),
            "circularity": float(circularity),
            "solidity": float(solidity),
            "extent": float(extent),
            "top_span_ratio": float(top_span / max(bw, 1)),
            "mid_span_ratio": float(mid_span / max(bw, 1)),
            "low_span_ratio": float(low_span / max(bw, 1)),
            "taper": float(taper),
            "lower_jaggedness": float(lower_jaggedness),
            "lemon_point_count": lemon_point_count,
            "lemon_point_score": lemon_point_score,
            "lemon_point_candidates": lemon_point_candidates,
            "lemon_selected_points": lemon_selected_points,
            "vertices": int(len(approx)),
        })

    if not components:
        # Fallback for imperfectly closed sketches or filled transparent sample
        # images: use the outer contour as the candidate region.
        contours, _ = cv2.findContours(wall, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        fallback_contours = sorted(contours, key=cv2.contourArea, reverse=True)[:6]
        for contour in fallback_contours:
            contour_area = float(cv2.contourArea(contour))
            if contour_area < min_area:
                continue
            perimeter = float(cv2.arcLength(contour, True))
            x, y, bw, bh = cv2.boundingRect(contour)
            hull = cv2.convexHull(contour)
            hull_area = float(cv2.contourArea(hull))
            aspect = max(bw / max(bh, 1), bh / max(bw, 1))
            circularity = (4.0 * np.pi * contour_area / (perimeter * perimeter)) if perimeter > 0 else 0.0
            solidity = contour_area / hull_area if hull_area > 0 else 0.0
            extent = contour_area / max(float(bw * bh), 1.0)
            points = contour.reshape(-1, 2)
            top_cut = y + bh * 0.38
            mid_cut = y + bh * 0.62
            low_cut = y + bh * 0.72
            top_points = points[points[:, 1] <= top_cut]
            mid_points = points[(points[:, 1] >= top_cut) & (points[:, 1] <= mid_cut)]
            low_points = points[points[:, 1] >= low_cut]

            def span_x(arr):
                if len(arr) == 0:
                    return 0.0
                return float(arr[:, 0].max() - arr[:, 0].min() + 1)

            top_span = span_x(top_points)
            mid_span = span_x(mid_points)
            low_span = span_x(low_points)
            taper = 1.0 - (low_span / max(mid_span, 1.0))
            lower_jaggedness = 0.0
            if len(low_points) >= 4 and low_span > 0:
                lower_contour = low_points[np.argsort(low_points[:, 0])]
                diffs = np.diff(lower_contour[:, 1].astype(np.float32))
                sign_changes = int(np.sum(np.diff(np.sign(diffs)) != 0)) if len(diffs) > 1 else 0
                lower_jaggedness = _clamp01(sign_changes / max(low_span * 0.35, 1.0))
            approx = cv2.approxPolyDP(contour, 0.025 * perimeter, True) if perimeter > 0 else contour
            lemon_point_count, lemon_point_score, lemon_point_candidates, lemon_selected_points = lemon_point_features(approx, x, y, bw, bh)
            components.append({
                "area": contour_area,
                "contour_area": contour_area,
                "perimeter": perimeter,
                "bbox": [int(x), int(y), int(bw), int(bh)],
                "aspect": float(aspect),
                "circularity": float(circularity),
                "solidity": float(solidity),
                "extent": float(extent),
                "top_span_ratio": float(top_span / max(bw, 1)),
                "mid_span_ratio": float(mid_span / max(bw, 1)),
                "low_span_ratio": float(low_span / max(bw, 1)),
                "taper": float(taper),
                "lower_jaggedness": float(lower_jaggedness),
                "lemon_point_count": lemon_point_count,
                "lemon_point_score": lemon_point_score,
                "lemon_point_candidates": lemon_point_candidates,
                "lemon_selected_points": lemon_selected_points,
                "vertices": int(len(approx)),
            })

    components.sort(key=lambda item: item["area"], reverse=True)
    return components, enclosed


def _rule_scores_from_closed_regions(line_mask):
    import cv2  # type: ignore
    import numpy as np

    components, enclosed = _closed_region_components(line_mask)
    if not components:
        return {
            "best": None,
            "scores": {
                "berry": {"score": 0.0, "reason": "closed region not found"},
                "lemon": {"score": 0.0, "reason": "closed region not found"},
                "peach": {"score": 0.0, "reason": "closed region not found"},
            },
            "components": [],
            "closed_region_count": 0,
        }

    top = components[0]
    second = components[1] if len(components) > 1 else None
    total_area = float(sum(item["area"] for item in components))
    top_share = top["area"] / max(total_area, 1.0)
    second_ratio = (second["area"] / max(top["area"], 1.0)) if second else 0.0
    third_ratio = (components[2]["area"] / max(top["area"], 1.0)) if len(components) > 2 else 0.0
    tx, ty, tw, th = top["bbox"]
    ink = np.where(line_mask > 0, 255, 0).astype(np.uint8)
    n_ink, ink_labels, ink_stats, ink_centroids = cv2.connectedComponentsWithStats(ink, 8)
    inner_dot_count = 0
    inner_dot_area = 0.0
    for label in range(1, n_ink):
        area = int(ink_stats[label, cv2.CC_STAT_AREA])
        if area < 3 or area > max(90, int(top["area"] * 0.045)):
            continue
        x = int(ink_stats[label, cv2.CC_STAT_LEFT])
        y = int(ink_stats[label, cv2.CC_STAT_TOP])
        w = int(ink_stats[label, cv2.CC_STAT_WIDTH])
        h = int(ink_stats[label, cv2.CC_STAT_HEIGHT])
        cx, cy = ink_centroids[label]
        if w <= 0 or h <= 0:
            continue
        if max(w / max(h, 1), h / max(w, 1)) > 2.4:
            continue
        margin_x = max(4, tw * 0.08)
        margin_y = max(4, th * 0.08)
        if not (tx + margin_x <= cx <= tx + tw - margin_x and ty + margin_y <= cy <= ty + th - margin_y):
            continue
        inner_dot_count += 1
        inner_dot_area += area
    inner_dot_score = _clamp01(inner_dot_count / 5.0)

    peach_pair = _clamp01((second_ratio - 0.45) / 0.35) if second else 0.0
    peach_side_lobe = _clamp01((second_ratio - 0.14) / 0.18) if second else 0.0
    peach_round_body = _score_band(top["aspect"], 1.0, 1.38, 0.34) * _score_band(top["circularity"], 0.74, 0.98, 0.22)
    peach_dominance = _clamp01(1.0 - (third_ratio / 0.38))
    peach_score = _clamp01(
        (peach_pair * 0.44)
        + (peach_side_lobe * peach_round_body * 0.34)
        + (peach_dominance * 0.12)
        + (_score_band(top["aspect"], 1.0, 1.9, 0.8) * 0.10)
    )

    lemon_aspect = _score_band(top["aspect"], 1.55, 3.25, 0.55)
    lemon_smooth = _score_band(top["circularity"], 0.42, 0.88, 0.32)
    lemon_solid = _score_band(top["solidity"], 0.84, 1.02, 0.18)
    lemon_single = _clamp01((top_share - 0.55) / 0.32)
    lemon_not_pair = 1.0 - _clamp01((second_ratio - 0.32) / 0.28)
    lemon_pair_penalty = 1.0 - _clamp01((second_ratio - 0.12) / 0.16)
    lemon_point_score = float(top.get("lemon_point_score", 0.0))
    lemon_point_gate = 0.28 + lemon_point_score * 0.72
    lemon_score = _clamp01(
        lemon_aspect * 0.30
        + lemon_smooth * 0.16
        + lemon_solid * 0.10
        + lemon_single * 0.10
        + lemon_not_pair * 0.10
        + lemon_point_score * 0.24
    ) * lemon_pair_penalty * lemon_point_gate
    if int(top.get("lemon_point_count", 0)) < 2:
        lemon_score *= 0.5

    berry_taper = _clamp01((top["taper"] - 0.20) / 0.30)
    berry_body = _score_band(top["aspect"], 1.0, 1.75, 0.65)
    berry_not_lemon = 1.0 - _clamp01((top["aspect"] - 1.65) / 0.95)
    berry_jagged = _clamp01(max(top["lower_jaggedness"], (top["vertices"] - 8) / 14.0)) * berry_taper
    berry_single = _clamp01((top_share - 0.48) / 0.35)
    berry_multi_region = _clamp01((len(components) - 1) / 3.0)
    second_jagged = 0.0
    second_stem_score = 0.0
    if second:
        second_jagged = _clamp01(max(
            second["lower_jaggedness"],
            (second["vertices"] - 6) / 10.0,
            (0.72 - second["solidity"]) / 0.38,
        ))
        second_size_for_stem = _score_band(second_ratio, 0.08, 0.36, 0.10)
        second_stem_score = second_jagged * second_size_for_stem
    berry_score = _clamp01(
        berry_taper * 0.34
        + (berry_body * berry_taper) * 0.15
        + berry_not_lemon * 0.05
        + berry_jagged * 0.18
        + berry_single * 0.08
        + inner_dot_score * 0.16
        + berry_multi_region * 0.04
        + second_stem_score * berry_taper * 0.18
    )
    if len(components) <= 1 and inner_dot_count < 3:
        berry_score = 0.0
    if len(components) >= 4 and top["taper"] >= 0.30:
        berry_score = max(berry_score, 0.76 + min(0.14, (len(components) - 4) * 0.035))
        lemon_score *= 0.76
    if second_stem_score >= 0.45 and top["aspect"] <= 1.85 and top["taper"] >= 0.25:
        berry_score = max(berry_score, 0.70 + second_stem_score * 0.18)
        lemon_score *= 0.80
    if inner_dot_count >= 3 and top["aspect"] <= 1.85:
        berry_score = max(berry_score, 0.72 + min(0.18, (inner_dot_count - 3) * 0.035))
        lemon_score *= 0.72
        peach_score *= 0.82

    scores = {
        "berry": {
            "score": berry_score,
            "taper": top["taper"],
            "lower_jaggedness": top["lower_jaggedness"],
            "vertices": top["vertices"],
            "inner_dot_count": inner_dot_count,
            "inner_dot_score": inner_dot_score,
            "inner_dot_area": inner_dot_area,
            "second_stem_score": second_stem_score,
            "second_jaggedness": second_jagged,
        },
        "lemon": {
            "score": lemon_score,
            "aspect": top["aspect"],
            "circularity": top["circularity"],
            "solidity": top["solidity"],
            "point_count": top.get("lemon_point_count", 0),
            "point_score": lemon_point_score,
        },
        "peach": {
            "score": peach_score,
            "top2_area_ratio": second_ratio,
            "third_area_ratio": third_ratio,
        },
    }
    best = max(scores.keys(), key=lambda fruit: float(scores[fruit]["score"]))
    return {
        "best": best,
        "scores": scores,
        "components": components[:6],
        "closed_region_count": len(components),
        "closed_region_pixels": int(enclosed.sum() // 255),
    }


def run_shape_match(image_b64: str, bbox: dict, canvas_width: int, canvas_height: int) -> dict:
    input_mask = _decode_canvas_line_mask(image_b64, bbox, canvas_width, canvas_height)
    rule_result = _rule_scores_from_closed_regions(input_mask)
    rule_best = rule_result.get("best")
    return {
        "best": rule_best,
        "rule_best": rule_best,
        "scores": rule_result.get("scores", {}),
        "rule_scores": rule_result.get("scores", {}),
        "rule": rule_result,
    }


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    emit({"type": "ready"})
    for raw_line in sys.stdin:
        request_started_at = time.perf_counter()
        line = raw_line.strip()
        if not line:
            continue

        request_id = None
        try:
            decode_started_at = time.perf_counter()
            payload = json.loads(line)
            decode_finished_at = time.perf_counter()
            request_id = payload.get("id")
            params = payload.get("payload", {})
            predict_started_at = time.perf_counter()
            predict_mode = params.get("predict_mode", PREDICT_MODE_GENERATED)

            if predict_mode == PREDICT_MODE_JUDGE:
                result = run_judge(
                    params["image"],
                    params["bbox"],
                    int(params.get("canvas_width", 280)),
                    int(params.get("canvas_height", 280)),
                )
            elif predict_mode == PREDICT_MODE_SHAPE_MATCH:
                result = run_shape_match(
                    params["image"],
                    params["bbox"],
                    int(params.get("canvas_width", 280)),
                    int(params.get("canvas_height", 280)),
                )
            elif predict_mode == PREDICT_MODE_GENERATED:
                result = get_banana_generator_pipeline().generate(
                    params["image"],
                    params.get("sketch_overlay", ""),
                    params["bbox"],
                    int(params.get("canvas_width", 280)),
                    int(params.get("canvas_height", 280)),
                    params.get("generated_variant", "banana_400"),
                    bool(params.get("banana_postprocess", False)),
                    params.get("border_threshold"),
                    params.get("alpha_threshold"),
                    bool(params.get("keep_largest", True)),
                    bool(params.get("alpha_keep_largest", False)),
                    bool(params.get("apple_skip_inner_alpha", False)),
                    bool(params.get("apple_skip_radial_variance", False)),
                    int(params.get("apple_radial_variance_threshold", 50)),
                    bool(params.get("non_alpha_mode", False)),
                    bool(params.get("apple_align_input_fill", False)),
                )
            else:
                raise ValueError(f"Unsupported predict_mode: {predict_mode}")

            predict_finished_at = time.perf_counter()
            result["profiling"] = {
                "worker_json_decode_ms": round((decode_finished_at - decode_started_at) * 1000, 3),
                "worker_build_result_ms": round((predict_finished_at - predict_started_at) * 1000, 3),
                "worker_total_ms": round((predict_finished_at - request_started_at) * 1000, 3),
            }
            emit({"id": request_id, "ok": True, "result": result})
        except Exception as exc:  # noqa: BLE001
            failed_at = time.perf_counter()
            emit(
                {
                    "id": request_id,
                    "ok": False,
                    "error": str(exc),
                    "profiling": {
                        "worker_total_ms": round((failed_at - request_started_at) * 1000, 3),
                    },
                }
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
