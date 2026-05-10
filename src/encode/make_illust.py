import os, glob
from pathlib import Path
import cv2
import numpy as np

def ensure_dir(p: str | Path) -> None:
    Path(p).mkdir(parents=True, exist_ok=True)

def largest_component(mask: np.ndarray) -> np.ndarray:
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if num_labels <= 1:
        return mask

    largest_label = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
    out = np.zeros_like(mask)
    out[labels == largest_label] = 255
    return out

def quantize_kmeans(bgr: np.ndarray, k: int = 8, attempts: int = 3) -> np.ndarray:
    data = bgr.reshape((-1, 3)).astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _compactness, labels, centers = cv2.kmeans(
        data, k, None, criteria, attempts, cv2.KMEANS_PP_CENTERS
    )
    centers = np.clip(centers, 0, 255).astype(np.uint8)
    return centers[labels.flatten()].reshape(bgr.shape)

def foreground_mask(bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    white_dist = np.linalg.norm(255 - bgr.astype(np.float32), axis=2)

    mask = np.where(
        (white_dist > 90) |
        ((sat > 55) & (val < 250)) |
        (gray < 190),
        255,
        0,
    ).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    mask = largest_component(mask)
    if not np.any(mask):
        return mask

    mask = cv2.dilate(mask, kernel, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.GaussianBlur(mask, (5, 5), 0)
    return cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)[1]


def soft_outline_mask(bgr: np.ndarray) -> np.ndarray:
    mask = foreground_mask(bgr)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    gradient = cv2.morphologyEx(mask, cv2.MORPH_GRADIENT, kernel)
    return cv2.threshold(gradient, 0, 255, cv2.THRESH_BINARY)[1]

def smooth_color(bgr: np.ndarray, mode: str = "strong") -> np.ndarray:
    if mode == "strong":
        out = cv2.bilateralFilter(bgr, d=9, sigmaColor=75, sigmaSpace=75)
        out = cv2.bilateralFilter(out, d=9, sigmaColor=75, sigmaSpace=75)
        return out
    else:
        out = cv2.bilateralFilter(bgr, d=11, sigmaColor=55, sigmaSpace=55)
        out = cv2.bilateralFilter(out, d=11, sigmaColor=45, sigmaSpace=45)
        return cv2.GaussianBlur(out, (0, 0), sigmaX=0.8, sigmaY=0.8)

def cartoonize_bgr(bgr: np.ndarray, mode: str = "strong", k: int = 8) -> np.ndarray:
    smooth = smooth_color(bgr, mode=mode)
    quant = quantize_kmeans(smooth, k=k)
    out = quant.copy()
    if mode == "strong":
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        edges = cv2.adaptiveThreshold(
            cv2.medianBlur(gray, 5), 255,
            adaptiveMethod=cv2.ADAPTIVE_THRESH_MEAN_C,
            thresholdType=cv2.THRESH_BINARY,
            blockSize=9, C=2
        )
        edges = 255 - edges
        edges_3 = cv2.cvtColor(edges, cv2.COLOR_GRAY2BGR)
        out[edges_3 > 0] = 0
        return out

    outline = soft_outline_mask(bgr) > 0
    out[outline] = (out[outline].astype(np.float32) * 0.82).astype(np.uint8)
    return out

def resize_keep_aspect(img: np.ndarray, target: int) -> np.ndarray:
    h, w = img.shape[:2]
    if max(h, w) == target:
        return img
    scale = target / float(max(h, w))
    nh, nw = int(round(h * scale)), int(round(w * scale))
    return cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)

def cartoonize_dir(in_dir: str, out_dir: str, mode="strong", k=8, size=256):
    ensure_dir(out_dir)
    patterns = ["*.jpg","*.jpeg","*.png","*.webp","*.bmp"]
    files = []
    for pat in patterns:
        files += glob.glob(os.path.join(in_dir, pat))
    files = sorted(set(files))
    if not files:
        raise RuntimeError(f"No images found in {in_dir}")

    for fp in files:
        img = cv2.imread(fp, cv2.IMREAD_UNCHANGED)
        if img is None:
            print("skip:", fp)
            continue

        alpha = None
        if img.ndim == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        if img.shape[2] == 4:
            bgr = img[:, :, :3]
            alpha = img[:, :, 3]
        else:
            bgr = img

        if size is not None:
            bgr = resize_keep_aspect(bgr, size)
            if alpha is not None:
                alpha = resize_keep_aspect(alpha, size)

        fg_mask = foreground_mask(bgr)
        out_bgr = cartoonize_bgr(bgr, mode=mode, k=k)
        out_bgr[fg_mask == 0] = 255

        if alpha is not None:
            alpha = cv2.bitwise_and(alpha, fg_mask)
            out = np.dstack([out_bgr, alpha])
        else:
            out = out_bgr

        out_path = os.path.join(out_dir, Path(fp).stem + ".png")
        cv2.imwrite(out_path, out)
        print("OK:", Path(fp).name, "->", Path(out_path).name)

    print("Done. Output:", out_dir)

cartoonize_dir(
    in_dir="data/fruit_data_illust_encoded/fruit_raw_data/apple fruit",
    out_dir="data/fruit_data_illust_encoded/fruit_data_illust/apple",
    mode="soft",
    k=6,
    size=256
)
