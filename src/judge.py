from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
import torch
import torch.nn as nn

# ============================================================
# 1. 設定
# ============================================================
MODEL_PATH = "data/model/banana/best_model.pt"
META_PATH = "data/model/banana/meta.json"
INPUT_IMAGE_PATH = "data/fruit_data_illust_encoded/2.png"   # 推論したい画像
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


# ============================================================
# 2. モデル定義
# ============================================================
class ConvBNAct(nn.Module):
    def __init__(self, in_ch, out_ch, kernel_size=3, stride=1, groups=1):
        super().__init__()
        padding = kernel_size // 2
        self.block = nn.Sequential(
            nn.Conv2d(
                in_ch,
                out_ch,
                kernel_size,
                stride=stride,
                padding=padding,
                groups=groups,
                bias=False,
            ),
            nn.BatchNorm2d(out_ch),
            nn.ReLU(inplace=True),
        )

    def forward(self, x):
        return self.block(x)


class DepthwiseSeparableBlock(nn.Module):
    def __init__(self, in_ch, out_ch, stride=1):
        super().__init__()
        self.block = nn.Sequential(
            ConvBNAct(in_ch, in_ch, kernel_size=3, stride=stride, groups=in_ch),
            ConvBNAct(in_ch, out_ch, kernel_size=1, stride=1, groups=1),
        )

    def forward(self, x):
        return self.block(x)


class FastLineClassifier(nn.Module):
    def __init__(self, num_classes: int, base_channels: int = 24, dropout: float = 0.1):
        super().__init__()
        c1 = base_channels
        c2 = base_channels * 2
        c3 = base_channels * 4
        c4 = base_channels * 6

        self.stem = nn.Sequential(
            ConvBNAct(1, c1, kernel_size=3, stride=2),
            DepthwiseSeparableBlock(c1, c1, stride=1),
        )

        self.stage2 = nn.Sequential(
            DepthwiseSeparableBlock(c1, c2, stride=2),
            DepthwiseSeparableBlock(c2, c2, stride=1),
        )

        self.stage3 = nn.Sequential(
            DepthwiseSeparableBlock(c2, c3, stride=2),
            DepthwiseSeparableBlock(c3, c3, stride=1),
        )

        self.stage4 = nn.Sequential(
            DepthwiseSeparableBlock(c3, c4, stride=2),
            DepthwiseSeparableBlock(c4, c4, stride=1),
        )

        self.pool = nn.AdaptiveAvgPool2d(1)
        self.dropout = nn.Dropout(dropout)
        self.fc = nn.Linear(c4, num_classes)

    def forward(self, x):
        x = self.stem(x)
        x = self.stage2(x)
        x = self.stage3(x)
        x = self.stage4(x)
        x = self.pool(x).flatten(1)
        x = self.dropout(x)
        x = self.fc(x)
        return x


# ============================================================
# 3. 前処理
# ============================================================
def load_grayscale(image_path: str | Path) -> np.ndarray:
    with Image.open(image_path) as img:
        return np.array(img.convert("L"))


def threshold_black(gray: np.ndarray, threshold: int = 200) -> np.ndarray:
    # 黒線 -> 255, 背景 -> 0
    return np.where(gray < threshold, 255, 0).astype(np.uint8)


def keep_largest_component(mask: np.ndarray) -> np.ndarray:
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if num_labels <= 1:
        return mask

    component_areas = stats[1:, cv2.CC_STAT_AREA]
    largest_label = int(np.argmax(component_areas)) + 1
    return np.where(labels == largest_label, 255, 0).astype(np.uint8)


def image_to_tensor(img: np.ndarray) -> torch.Tensor:
    # uint8 [0,255] -> float32 [0,1]
    x = img.astype(np.float32) / 255.0
    x = np.expand_dims(x, axis=0)  # [1, H, W]
    return torch.from_numpy(x)


def preprocess_input_image_for_inference(
    image_path: str | Path,
    image_size: int = 96,
    input_black_threshold: int = 200,
) -> torch.Tensor:
    gray = load_grayscale(image_path)

    # 二値化して黒線成分を抽出
    mask = threshold_black(gray, threshold=input_black_threshold)

    # 最大連結成分だけ残す
    mask = keep_largest_component(mask)

    # 学習時と同じく白背景黒線に戻す
    # mask: 黒線255 / 背景0
    # img : 白背景255 / 黒線0
    img = 255 - mask

    # 学習時入力サイズへリサイズ
    img = cv2.resize(img, (image_size, image_size), interpolation=cv2.INTER_NEAREST)

    # テンソル化して batch 次元追加
    x = image_to_tensor(img).unsqueeze(0)  # [1, 1, H, W]
    return x


# ============================================================
# 4. モデル読み込み
# ============================================================
def load_model(model_path: str | Path, meta_path: str | Path, device: str = DEVICE):
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    cfg = meta["config"]
    num_classes = meta["num_classes"]

    # idx_to_class は JSON だと key が文字列になるので int に戻す
    idx_to_class = {int(k): v for k, v in meta["idx_to_class"].items()}

    model = FastLineClassifier(
        num_classes=num_classes,
        base_channels=cfg["base_channels"],
        dropout=cfg["dropout"],
    ).to(device)

    checkpoint = torch.load(model_path, map_location=device)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()

    return model, idx_to_class, cfg


# ============================================================
# 5. 推論本体
# ============================================================
@torch.no_grad()
def predict_topk(
    image_path: str | Path,
    model: nn.Module,
    idx_to_class: dict[int, str],
    image_size: int = 96,
    input_black_threshold: int = 200,
    device: str = DEVICE,
    k: int = 5,
):
    x = preprocess_input_image_for_inference(
        image_path=image_path,
        image_size=image_size,
        input_black_threshold=input_black_threshold,
    ).to(device)

    logits = model(x)
    probs = torch.softmax(logits, dim=1)

    top_probs, top_idx = probs.topk(k, dim=1)

    results = []
    for prob, idx in zip(top_probs[0].tolist(), top_idx[0].tolist()):
        results.append({
            "class_index": idx,
            "class_name": idx_to_class[idx],
            "probability": prob,
        })

    return results


# ============================================================
# 6. 実行例
# ============================================================
def main():
    model, idx_to_class, cfg = load_model(
        model_path=MODEL_PATH,
        meta_path=META_PATH,
        device=DEVICE,
    )

    results = predict_topk(
        image_path=INPUT_IMAGE_PATH,
        model=model,
        idx_to_class=idx_to_class,
        image_size=cfg["image_size"],
        input_black_threshold=cfg["input_black_threshold"],
        device=DEVICE,
        k=5,
    )

    print(f"Input: {INPUT_IMAGE_PATH}")
    print("Top-5 predictions:")
    for rank, item in enumerate(results, start=1):
        print(
            f"{rank}: {item['class_name']} "
            f"(index={item['class_index']}, prob={item['probability']:.6f})"
        )


if __name__ == "__main__":
    main()