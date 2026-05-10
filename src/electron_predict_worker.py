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
