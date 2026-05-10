from __future__ import annotations

import base64
import io
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter
from skimage.morphology import skeletonize as skimage_skeletonize
import torch
import torch.nn as nn
import torch.nn.functional as F


MODEL_ROOT = Path(__file__).resolve().parent / "generate_fruit" / "model"
BANANA_BORDER_MODEL_PATH = MODEL_ROOT / "border_model" / "banana_border.pt"
APPLE_BORDER_MODEL_PATH = MODEL_ROOT / "border_model" / "apple" / "apple_border.pt"
BANANA_COLOR_400_MODEL_PATH = MODEL_ROOT / "400color" / "best_model_banana_color400_2.pt"
APPLE_COLOR_512_MODEL_PATH = MODEL_ROOT / "400color" / "apple_512.pt"
GRAPE_COLOR_400_MODEL_PATH = MODEL_ROOT / "400color" / "best_model_grape_new.pt"
APPLE_NON_ALPHA_MODEL_PATH = MODEL_ROOT / "nonAlpha" / "apple_nonAlpha.pt"
GRAPE_NON_ALPHA_MODEL_PATH = MODEL_ROOT / "nonAlpha" / "grape_nonAlpha.pt"
def resolve_torch_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


DEVICE = resolve_torch_device()
DEFAULT_BORDER_THRESHOLD = 0.35
DEFAULT_ALPHA_THRESHOLD = 0.5
MODEL_IMAGE_SIZE = 128
TARGET_MODEL_STROKE_WIDTH = 2.0
COLOR_IMAGE_SIZE_BY_VARIANT = {
    "banana_400": 400,
    "apple_512": 512,
    "grape_400": 400,
}
GENERATED_VARIANT_BANANA_400 = "banana_400"
GENERATED_VARIANT_APPLE_512 = "apple_512"
GENERATED_VARIANT_GRAPE_400 = "grape_400"


def data_url_to_bytes(data_url: str) -> bytes:
    if "," not in data_url:
        raise ValueError("Invalid data URL")
    _, encoded = data_url.split(",", 1)
    return base64.b64decode(encoded)


def image_to_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


class ConvBlock(nn.Module):
    def __init__(self, in_channels: int, out_channels: int):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(in_channels, out_channels, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(out_channels),
            nn.ReLU(inplace=True),
            nn.Conv2d(out_channels, out_channels, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(out_channels),
            nn.ReLU(inplace=True),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class UNetSmall(nn.Module):
    def __init__(self, input_channels: int, output_channels: int, base_channels: int):
        super().__init__()
        self.enc1 = ConvBlock(input_channels, base_channels)
        self.enc2 = ConvBlock(base_channels, base_channels * 2)
        self.enc3 = ConvBlock(base_channels * 2, base_channels * 4)
        self.pool = nn.MaxPool2d(kernel_size=2, stride=2)
        self.bottleneck = ConvBlock(base_channels * 4, base_channels * 8)
        self.up3 = nn.ConvTranspose2d(base_channels * 8, base_channels * 4, kernel_size=2, stride=2)
        self.dec3 = ConvBlock(base_channels * 8, base_channels * 4)
        self.up2 = nn.ConvTranspose2d(base_channels * 4, base_channels * 2, kernel_size=2, stride=2)
        self.dec2 = ConvBlock(base_channels * 4, base_channels * 2)
        self.up1 = nn.ConvTranspose2d(base_channels * 2, base_channels, kernel_size=2, stride=2)
        self.dec1 = ConvBlock(base_channels * 2, base_channels)
        self.out_conv = nn.Conv2d(base_channels, output_channels, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        enc1 = self.enc1(x)
        enc2 = self.enc2(self.pool(enc1))
        enc3 = self.enc3(self.pool(enc2))
        bottleneck = self.bottleneck(self.pool(enc3))
        dec3 = self.dec3(torch.cat([self.up3(bottleneck), enc3], dim=1))
        dec2 = self.dec2(torch.cat([self.up2(dec3), enc2], dim=1))
        dec1 = self.dec1(torch.cat([self.up1(dec2), enc1], dim=1))
        return self.out_conv(dec1)


class UNetLarge(nn.Module):
    def __init__(self, input_channels: int, output_channels: int, base_channels: int):
        super().__init__()
        self.enc1 = ConvBlock(input_channels, base_channels)
        self.enc2 = ConvBlock(base_channels, base_channels * 2)
        self.enc3 = ConvBlock(base_channels * 2, base_channels * 4)
        self.enc4 = ConvBlock(base_channels * 4, base_channels * 8)
        self.pool = nn.MaxPool2d(kernel_size=2, stride=2)
        self.bottleneck = ConvBlock(base_channels * 8, base_channels * 16)
        self.up4 = nn.ConvTranspose2d(base_channels * 16, base_channels * 8, kernel_size=2, stride=2)
        self.dec4 = ConvBlock(base_channels * 16, base_channels * 8)
        self.up3 = nn.ConvTranspose2d(base_channels * 8, base_channels * 4, kernel_size=2, stride=2)
        self.dec3 = ConvBlock(base_channels * 8, base_channels * 4)
        self.up2 = nn.ConvTranspose2d(base_channels * 4, base_channels * 2, kernel_size=2, stride=2)
        self.dec2 = ConvBlock(base_channels * 4, base_channels * 2)
        self.up1 = nn.ConvTranspose2d(base_channels * 2, base_channels, kernel_size=2, stride=2)
        self.dec1 = ConvBlock(base_channels * 2, base_channels)
        self.out_conv = nn.Conv2d(base_channels, output_channels, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        enc1 = self.enc1(x)
        enc2 = self.enc2(self.pool(enc1))
        enc3 = self.enc3(self.pool(enc2))
        enc4 = self.enc4(self.pool(enc3))
        bottleneck = self.bottleneck(self.pool(enc4))
        dec4 = self.dec4(torch.cat([self.up4(bottleneck), enc4], dim=1))
        dec3 = self.dec3(torch.cat([self.up3(dec4), enc3], dim=1))
        dec2 = self.dec2(torch.cat([self.up2(dec3), enc2], dim=1))
        dec1 = self.dec1(torch.cat([self.up1(dec2), enc1], dim=1))
        return self.out_conv(dec1)


class UpscaleBlock(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.up = nn.ConvTranspose2d(channels, channels, kernel_size=2, stride=2)
        self.conv = ConvBlock(channels, channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.conv(self.up(x))


class ResizeConvBlock(nn.Module):
    def __init__(self, channels: int, size: int):
        super().__init__()
        self.size = size
        self.conv = ConvBlock(channels, channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = F.interpolate(x, size=(self.size, self.size), mode="bilinear", align_corners=False)
        return self.conv(x)


class UNetColor400(nn.Module):
    def __init__(self, input_channels: int, output_channels: int, base_channels: int):
        super().__init__()
        self.enc1 = ConvBlock(input_channels, base_channels)
        self.enc2 = ConvBlock(base_channels, base_channels * 2)
        self.enc3 = ConvBlock(base_channels * 2, base_channels * 4)
        self.pool = nn.MaxPool2d(kernel_size=2, stride=2)
        self.bottleneck = ConvBlock(base_channels * 4, base_channels * 8)
        self.up3 = nn.ConvTranspose2d(base_channels * 8, base_channels * 4, kernel_size=2, stride=2)
        self.dec3 = ConvBlock(base_channels * 8, base_channels * 4)
        self.up2 = nn.ConvTranspose2d(base_channels * 4, base_channels * 2, kernel_size=2, stride=2)
        self.dec2 = ConvBlock(base_channels * 4, base_channels * 2)
        self.up1 = nn.ConvTranspose2d(base_channels * 2, base_channels, kernel_size=2, stride=2)
        self.dec1 = ConvBlock(base_channels * 2, base_channels)
        self.up0 = UpscaleBlock(base_channels)
        self.up_to_400 = ResizeConvBlock(base_channels, COLOR_IMAGE_SIZE_BY_VARIANT[GENERATED_VARIANT_BANANA_400])
        self.out_conv = nn.Conv2d(base_channels, output_channels, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        enc1 = self.enc1(x)
        enc2 = self.enc2(self.pool(enc1))
        enc3 = self.enc3(self.pool(enc2))
        bottleneck = self.bottleneck(self.pool(enc3))
        dec3 = self.dec3(torch.cat([self.up3(bottleneck), enc3], dim=1))
        dec2 = self.dec2(torch.cat([self.up2(dec3), enc2], dim=1))
        dec1 = self.dec1(torch.cat([self.up1(dec2), enc1], dim=1))
        up0 = self.up0(dec1)
        up400 = self.up_to_400(up0)
        return self.out_conv(up400)


class UNetColor512(nn.Module):
    def __init__(self, input_channels: int, output_channels: int, base_channels: int):
        super().__init__()
        self.enc1 = ConvBlock(input_channels, base_channels)
        self.enc2 = ConvBlock(base_channels, base_channels * 2)
        self.enc3 = ConvBlock(base_channels * 2, base_channels * 4)
        self.pool = nn.MaxPool2d(kernel_size=2, stride=2)
        self.bottleneck = ConvBlock(base_channels * 4, base_channels * 8)
        self.up3 = nn.ConvTranspose2d(base_channels * 8, base_channels * 4, kernel_size=2, stride=2)
        self.dec3 = ConvBlock(base_channels * 8, base_channels * 4)
        self.up2 = nn.ConvTranspose2d(base_channels * 4, base_channels * 2, kernel_size=2, stride=2)
        self.dec2 = ConvBlock(base_channels * 4, base_channels * 2)
        self.up1 = nn.ConvTranspose2d(base_channels * 2, base_channels, kernel_size=2, stride=2)
        self.dec1 = ConvBlock(base_channels * 2, base_channels)
        self.up0 = UpscaleBlock(base_channels)
        self.up_minus1 = UpscaleBlock(base_channels)
        self.out_conv = nn.Conv2d(base_channels, output_channels, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        enc1 = self.enc1(x)
        enc2 = self.enc2(self.pool(enc1))
        enc3 = self.enc3(self.pool(enc2))
        bottleneck = self.bottleneck(self.pool(enc3))
        dec3 = self.dec3(torch.cat([self.up3(bottleneck), enc3], dim=1))
        dec2 = self.dec2(torch.cat([self.up2(dec3), enc2], dim=1))
        dec1 = self.dec1(torch.cat([self.up1(dec2), enc1], dim=1))
        up0 = self.up0(dec1)
        up512 = self.up_minus1(up0)
        return self.out_conv(up512)


@dataclass(frozen=True)
class SquareCrop:
    left: int
    top: int
    right: int
    bottom: int
    size: int


class BananaGeneratorPipeline:
    def __init__(self) -> None:
        border_checkpoint = torch.load(BANANA_BORDER_MODEL_PATH, map_location="cpu")
        apple_border_checkpoint = torch.load(APPLE_BORDER_MODEL_PATH, map_location="cpu")
        banana_color_400_checkpoint = torch.load(BANANA_COLOR_400_MODEL_PATH, map_location="cpu")
        apple_checkpoint = torch.load(APPLE_COLOR_512_MODEL_PATH, map_location="cpu")
        grape_checkpoint = torch.load(GRAPE_COLOR_400_MODEL_PATH, map_location="cpu")
        apple_non_alpha_checkpoint = torch.load(APPLE_NON_ALPHA_MODEL_PATH, map_location="cpu")
        grape_non_alpha_checkpoint = torch.load(GRAPE_NON_ALPHA_MODEL_PATH, map_location="cpu")

        self.border_threshold = float(border_checkpoint.get("config", {}).get("threshold", DEFAULT_BORDER_THRESHOLD))
        self.apple_border_threshold = float(apple_border_checkpoint.get("config", {}).get("threshold", DEFAULT_BORDER_THRESHOLD))
        self.alpha_threshold = float(
            banana_color_400_checkpoint.get("config", {}).get("alpha_threshold", DEFAULT_ALPHA_THRESHOLD)
        )
        self.apple_threshold = float(apple_checkpoint.get("config", {}).get("alpha_threshold", DEFAULT_ALPHA_THRESHOLD))
        self.grape_threshold = float(grape_checkpoint.get("config", {}).get("alpha_threshold", DEFAULT_ALPHA_THRESHOLD))

        self.border_model = UNetSmall(input_channels=1, output_channels=1, base_channels=16)
        self.border_model.load_state_dict(border_checkpoint["model_state_dict"])
        self.border_model.to(DEVICE)
        self.border_model.eval()

        self.apple_border_model = UNetSmall(input_channels=1, output_channels=1, base_channels=16)
        self.apple_border_model.load_state_dict(apple_border_checkpoint["model_state_dict"])
        self.apple_border_model.to(DEVICE)
        self.apple_border_model.eval()

        self.banana_color_400_model = UNetColor400(input_channels=1, output_channels=4, base_channels=24)
        self.banana_color_400_model.load_state_dict(banana_color_400_checkpoint["model_state_dict"])
        self.banana_color_400_model.to(DEVICE)
        self.banana_color_400_model.eval()

        self.apple_model = UNetColor512(input_channels=1, output_channels=4, base_channels=24)
        self.apple_model.load_state_dict(apple_checkpoint["model_state_dict"])
        self.apple_model.to(DEVICE)
        self.apple_model.eval()

        self.grape_model = UNetColor400(input_channels=1, output_channels=4, base_channels=24)
        self.grape_model.load_state_dict(grape_checkpoint["model_state_dict"])
        self.grape_model.to(DEVICE)
        self.grape_model.eval()

        self.apple_non_alpha_model = UNetColor400(input_channels=3, output_channels=3, base_channels=24)
        self.apple_non_alpha_model.load_state_dict(apple_non_alpha_checkpoint["model_state_dict"])
        self.apple_non_alpha_model.to(DEVICE)
        self.apple_non_alpha_model.eval()

        self.grape_non_alpha_model = UNetColor400(input_channels=3, output_channels=3, base_channels=24)
        self.grape_non_alpha_model.load_state_dict(grape_non_alpha_checkpoint["model_state_dict"])
        self.grape_non_alpha_model.to(DEVICE)
        self.grape_non_alpha_model.eval()

    @torch.inference_mode()
    def generate(
        self,
        data_url: str,
        sketch_overlay_data_url: str,
        bbox: dict,
        canvas_width: int,
        canvas_height: int,
        variant: str = GENERATED_VARIANT_BANANA_400,
        banana_postprocess: bool = False,
        border_threshold: float | None = None,
        alpha_threshold: float | None = None,
        keep_largest: bool = True,
        alpha_keep_largest: bool = False,
        apple_skip_inner_alpha: bool = False,
        apple_skip_radial_variance: bool = False,
        apple_radial_variance_threshold: int = 50,
        non_alpha_mode: bool = False,
        apple_align_input_fill: bool = False,
    ) -> dict:
        t_start = time.perf_counter()
        source = Image.open(io.BytesIO(data_url_to_bytes(data_url))).convert("L")
        crop = self.compute_square_crop(bbox, canvas_width, canvas_height)
        cropped = self.extract_square_crop(source, crop)
        resized = cropped.resize((MODEL_IMAGE_SIZE, MODEL_IMAGE_SIZE), Image.Resampling.NEAREST)
        border_input = self.mask_from_image(resized)
        border_input = self.normalize_stroke_width(border_input, crop.size)
        t_prep = time.perf_counter()

        if alpha_threshold is not None:
            resolved_alpha_threshold = float(alpha_threshold)
        elif variant == GENERATED_VARIANT_APPLE_512:
            resolved_alpha_threshold = self.apple_threshold
        elif variant == GENERATED_VARIANT_GRAPE_400:
            resolved_alpha_threshold = self.grape_threshold
        else:
            resolved_alpha_threshold = self.alpha_threshold

        if variant == GENERATED_VARIANT_BANANA_400:
            fruit_name = "banana"
            image_id = "generated_banana_400"
            resolved_border_threshold = float(self.border_threshold if border_threshold is None else border_threshold)
            rgba, border_preview_mask, cleaned_border_mask, step_timings = self.generate_banana_rgba(
                border_input,
                resolved_border_threshold,
                resolved_alpha_threshold,
                variant,
                keep_largest,
            )
        elif variant == GENERATED_VARIANT_APPLE_512:
            fruit_name = "apple"
            image_id = "generated_apple_512"
            resolved_border_threshold = float(self.apple_border_threshold if border_threshold is None else border_threshold)
            if non_alpha_mode:
                image_id = "generated_apple_non_alpha"
                rgba, border_preview_mask, cleaned_border_mask, step_timings = self.generate_non_alpha_rgba(
                    border_input,
                    fruit_name="apple",
                )
            else:
                rgba, border_preview_mask, cleaned_border_mask, step_timings = self.generate_apple_rgba(
                    border_input,
                    resolved_border_threshold,
                    resolved_alpha_threshold,
                    keep_largest,
                )
        elif variant == GENERATED_VARIANT_GRAPE_400:
            fruit_name = "grape"
            image_id = "generated_grape_400"
            resolved_border_threshold = DEFAULT_BORDER_THRESHOLD
            if non_alpha_mode:
                image_id = "generated_grape_non_alpha"
                rgba, border_preview_mask, cleaned_border_mask, step_timings = self.generate_non_alpha_rgba(
                    border_input,
                    fruit_name="grape",
                )
            else:
                rgba, border_preview_mask, cleaned_border_mask, step_timings = self.generate_grape_rgba(
                    border_input,
                    resolved_alpha_threshold,
                )
        else:
            raise ValueError(f"Unsupported generated variant: {variant}")

        t_rgba = time.perf_counter()

        if alpha_keep_largest:
            rgba = keep_largest_alpha_component(rgba)
        t_alpha_kl = time.perf_counter()

        if (
            apple_align_input_fill
            and variant == GENERATED_VARIANT_APPLE_512
            and not non_alpha_mode
        ):
            input_fill_mask = build_fill_mask_from_line(close_open_endpoints(border_input, mode="apple"))
            rgba = align_rgba_alpha_to_fill_mask(rgba, input_fill_mask)
        t_align = time.perf_counter()

        skipped = False
        skip_reason: str | None = None
        centroid_canvas: dict | None = None
        t_inner_alpha = t_align
        t_radial = t_align

        if variant == GENERATED_VARIANT_APPLE_512:
            variance, cx_rgba, cy_rgba = compute_radial_variance_at_400px(rgba)
            t_radial = time.perf_counter()
            cx_canvas = crop.left + cx_rgba * crop.size / MODEL_IMAGE_SIZE
            cy_canvas = crop.top + cy_rgba * crop.size / MODEL_IMAGE_SIZE
            centroid_canvas = {"x": float(cx_canvas), "y": float(cy_canvas)}

            if apple_skip_inner_alpha and not skipped:
                if has_inner_alpha_hole(rgba):
                    skipped = True
                    skip_reason = "inner_alpha"
            t_inner_alpha = time.perf_counter()

            if apple_skip_radial_variance and not skipped:
                if variance >= apple_radial_variance_threshold:
                    skipped = True
                    skip_reason = "radial_variance"

        model_crop_image = Image.fromarray(rgba, mode="RGBA")
        crop_image = model_crop_image.resize((crop.size, crop.size), Image.Resampling.LANCZOS)
        if banana_postprocess and fruit_name == "banana":
            crop_image = self.apply_banana_postprocess(crop_image)
            model_crop_image = crop_image
        t_postprocess = time.perf_counter()

        stage_image = self.build_stage_image(
            crop_image=crop_image,
            crop=crop,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
            sketch_overlay_data_url="",
        )
        composite_image = self.build_stage_image(
            crop_image=crop_image,
            crop=crop,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
            sketch_overlay_data_url=sketch_overlay_data_url,
        )
        structure_preview_image = self.build_structure_preview_image(
            crop_image=crop_image,
            crop=crop,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
            sketch_overlay_data_url=sketch_overlay_data_url,
        )
        border_preview_image = self.mask_to_preview_image(border_preview_mask)
        cleaned_border_preview_image = self.mask_to_preview_image(cleaned_border_mask)
        t_end = time.perf_counter()

        pipeline_timings: dict = {
            "prepare_input_ms": round((t_prep - t_start) * 1000, 1),
            **{k: v for k, v in step_timings.items() if v is not None},
            "keep_largest_alpha_ms": round((t_alpha_kl - t_rgba) * 1000, 1) if alpha_keep_largest else None,
            "apple_align_input_fill_ms": round((t_align - t_alpha_kl) * 1000, 1) if apple_align_input_fill and variant == GENERATED_VARIANT_APPLE_512 and not non_alpha_mode else None,
            "radial_variance_ms": round((t_radial - t_align) * 1000, 1) if variant == GENERATED_VARIANT_APPLE_512 else None,
            "inner_alpha_check_ms": round((t_inner_alpha - t_radial) * 1000, 1) if variant == GENERATED_VARIANT_APPLE_512 and apple_skip_inner_alpha else None,
            "postprocess_ms": round((t_postprocess - t_inner_alpha) * 1000, 1) if banana_postprocess and fruit_name == "banana" else None,
            "build_images_ms": round((t_end - t_postprocess) * 1000, 1),
            "total_ms": round((t_end - t_start) * 1000, 1),
        }
        pipeline_timings = {k: v for k, v in pipeline_timings.items() if v is not None}
        bullet_asset = {
            "image": image_to_data_url(model_crop_image if non_alpha_mode else crop_image),
            "origin_x": float(crop.left),
            "origin_y": float(crop.top),
            "width": float(crop.size),
            "height": float(crop.size),
            "source_width": float((model_crop_image if non_alpha_mode else crop_image).width),
            "source_height": float((model_crop_image if non_alpha_mode else crop_image).height),
            "fruit_name": fruit_name,
            "image_id": image_id,
        }

        return {
            "stage_image": image_to_data_url(stage_image),
            "composite_image": image_to_data_url(composite_image),
            "structure_preview_image": image_to_data_url(structure_preview_image),
            "border_preview_image": image_to_data_url(border_preview_image),
            "cleaned_border_preview_image": image_to_data_url(cleaned_border_preview_image),
            "image_id": image_id,
            "components": [
                {
                    "fruit_name": fruit_name,
                    "image_id": image_id,
                }
            ],
            "bullet_assets": [bullet_asset],
            "generated_crop": {
                "left": crop.left,
                "top": crop.top,
                "right": crop.right,
                "bottom": crop.bottom,
                "size": crop.size,
            },
            "generator_thresholds": {
                "border_threshold": resolved_border_threshold,
                "alpha_threshold": resolved_alpha_threshold,
            },
            "generated_variant": variant,
            "non_alpha_mode": non_alpha_mode,
            "banana_postprocess": banana_postprocess,
            "keep_largest": keep_largest,
            "skipped": skipped,
            "skip_reason": skip_reason,
            "centroid_canvas": centroid_canvas,
            "pipeline_timings": pipeline_timings,
        }

    def compute_square_crop(self, bbox: dict, canvas_width: int, canvas_height: int) -> SquareCrop:
        width = max(1, int(round(float(bbox["width"]))))
        height = max(1, int(round(float(bbox["height"]))))
        center_x = (float(bbox["left"]) + float(bbox["right"])) / 2.0
        center_y = (float(bbox["top"]) + float(bbox["bottom"])) / 2.0
        padding = max(4, int(round(max(width, height) * 0.08)))
        size = (max(width, height) + padding * 2) * 2
        size = max(8, min(size, max(canvas_width, canvas_height)))

        left = int(round(center_x - size / 2))
        top = int(round(center_y - size / 2))
        right = left + size
        bottom = top + size

        actual_size = size
        if actual_size <= 0:
            actual_size = min(canvas_width, canvas_height)
            left = max(0, (canvas_width - actual_size) // 2)
            top = max(0, (canvas_height - actual_size) // 2)
            right = left + actual_size
            bottom = top + actual_size

        return SquareCrop(left=left, top=top, right=right, bottom=bottom, size=actual_size)

    def extract_square_crop(self, source: Image.Image, crop: SquareCrop) -> Image.Image:
        padded = Image.new("L", (crop.size, crop.size), 255)
        intersect_left = max(0, crop.left)
        intersect_top = max(0, crop.top)
        intersect_right = min(source.width, crop.right)
        intersect_bottom = min(source.height, crop.bottom)
        if intersect_left >= intersect_right or intersect_top >= intersect_bottom:
            return padded

        cropped = source.crop((intersect_left, intersect_top, intersect_right, intersect_bottom))
        paste_left = intersect_left - crop.left
        paste_top = intersect_top - crop.top
        padded.paste(cropped, (paste_left, paste_top))
        return padded

    def mask_from_image(self, image: Image.Image) -> np.ndarray:
        arr = np.array(image.convert("L"))
        return (arr < 128).astype(np.uint8) * 255

    def mask_to_preview_image(self, mask: np.ndarray) -> Image.Image:
        preview = np.where(mask > 0, 0, 255).astype(np.uint8)
        return Image.fromarray(preview, mode="L").convert("RGBA")

    def normalize_stroke_width(self, mask: np.ndarray, crop_size: int) -> np.ndarray:
        if crop_size <= 0:
            return mask

        estimated_width = self.estimate_stroke_width(mask)
        if estimated_width <= 0:
            return mask

        delta = TARGET_MODEL_STROKE_WIDTH - estimated_width
        if delta <= 0.5:
            return mask

        radius = max(1, int(round(delta / 2.0)))
        kernel_size = radius * 2 + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
        adjusted = cv2.dilate(mask, kernel, iterations=1)
        return np.where(adjusted > 0, 255, 0).astype(np.uint8)

    def estimate_stroke_width(self, mask: np.ndarray) -> float:
        binary = np.where(mask > 0, 1, 0).astype(np.uint8)
        if not np.any(binary):
            return 0.0

        distance = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
        radii = distance[distance > 0.0]
        if radii.size == 0:
            return 0.0
        return float(np.median(radii) * 2.0)

    def generate_banana_rgba(
        self,
        border_input: np.ndarray,
        border_threshold: float,
        alpha_threshold: float,
        variant: str,
        keep_largest: bool = True,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
        t0 = time.perf_counter()
        border_logits = self.border_model(self.tensor_from_mask(border_input))
        border_prob = torch.sigmoid(border_logits)[0, 0].detach().cpu().numpy()
        border_binary = (border_prob >= border_threshold).astype(np.uint8) * 255
        t1 = time.perf_counter()
        normalized_border = normalize_to_2px(border_binary)
        t2 = time.perf_counter()
        cleaned_border = keep_largest_component(normalized_border) if keep_largest else normalized_border
        t3 = time.perf_counter()
        color_output = self.banana_color_400_model(self.tensor_from_mask(cleaned_border))
        rgba = self.rgba_from_output(color_output[0].detach().cpu(), alpha_threshold)
        t4 = time.perf_counter()
        timings = {
            "border_model_ms": round((t1 - t0) * 1000, 1),
            "normalize_to_2px_ms": round((t2 - t1) * 1000, 1),
            "keep_largest_border_ms": round((t3 - t2) * 1000, 1) if keep_largest else None,
            "color_model_ms": round((t4 - t3) * 1000, 1),
        }
        return rgba, border_binary, cleaned_border, timings

    def generate_apple_rgba(self, border_input: np.ndarray, border_threshold: float, alpha_threshold: float, keep_largest: bool = True) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
        t0 = time.perf_counter()
        border_logits = self.apple_border_model(self.tensor_from_mask(border_input))
        border_prob = torch.sigmoid(border_logits)[0, 0].detach().cpu().numpy()
        border_binary = (border_prob >= border_threshold).astype(np.uint8) * 255
        t1 = time.perf_counter()
        normalized_border = normalize_to_2px(border_binary)
        t2 = time.perf_counter()
        cleaned_border = keep_largest_component(normalized_border) if keep_largest else normalized_border
        t3 = time.perf_counter()
        color_output = self.apple_model(self.tensor_from_mask(cleaned_border))
        rgba = self.rgba_from_output(color_output[0].detach().cpu(), alpha_threshold)
        t4 = time.perf_counter()
        timings = {
            "border_model_ms": round((t1 - t0) * 1000, 1),
            "normalize_to_2px_ms": round((t2 - t1) * 1000, 1),
            "keep_largest_border_ms": round((t3 - t2) * 1000, 1) if keep_largest else None,
            "color_model_ms": round((t4 - t3) * 1000, 1),
        }
        return rgba, border_binary, cleaned_border, timings

    def generate_grape_rgba(self, border_input: np.ndarray, alpha_threshold: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
        t0 = time.perf_counter()
        cleaned_border = keep_largest_component(border_input)
        t1 = time.perf_counter()
        color_output = self.grape_model(self.tensor_from_mask(border_input))
        rgba = self.rgba_from_output(color_output[0].detach().cpu(), alpha_threshold)
        t2 = time.perf_counter()
        timings = {
            "keep_largest_border_ms": round((t1 - t0) * 1000, 1),
            "color_model_ms": round((t2 - t1) * 1000, 1),
        }
        return rgba, border_input, cleaned_border, timings

    def generate_non_alpha_rgba(self, border_input: np.ndarray, fruit_name: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
        t0 = time.perf_counter()
        closed_border = close_open_endpoints(border_input, mode=fruit_name)
        t1 = time.perf_counter()
        fill_mask = build_fill_mask_from_line(closed_border)
        t2 = time.perf_counter()
        distance_map = build_distance_map(fill_mask)
        model_input = self.tensor_from_non_alpha_inputs(closed_border, fill_mask, distance_map)
        model = self.apple_non_alpha_model if fruit_name == "apple" else self.grape_non_alpha_model
        color_output = model(model_input)
        rgba = self.rgba_from_rgb_output_and_fill_mask(color_output[0].detach().cpu(), fill_mask)
        t3 = time.perf_counter()
        timings = {
            "endpoint_close_ms": round((t1 - t0) * 1000, 1),
            "fill_mask_ms": round((t2 - t1) * 1000, 1),
            "color_model_ms": round((t3 - t2) * 1000, 1),
        }
        return rgba, closed_border, fill_mask, timings

    def apply_banana_postprocess(self, image: Image.Image) -> Image.Image:
        rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
        alpha = rgba[:, :, 3]
        visible = alpha > 0
        if not np.any(visible):
            return image

        rgb_uint8 = rgba[:, :, :3].copy()
        rgb_uint8[~visible] = 0

        smoothed_rgb = cv2.bilateralFilter(rgb_uint8, d=0, sigmaColor=28, sigmaSpace=5)
        smoothed_alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=0.9, sigmaY=0.9)
        smoothed_alpha = np.where(smoothed_alpha >= 8, smoothed_alpha, 0).astype(np.uint8)

        merged = np.dstack([smoothed_rgb, smoothed_alpha])
        merged_image = Image.fromarray(merged, mode="RGBA")
        merged_image = merged_image.resize((image.width * 2, image.height * 2), Image.Resampling.BICUBIC)
        merged_image = merged_image.resize((image.width, image.height), Image.Resampling.LANCZOS)
        return merged_image.filter(ImageFilter.SMOOTH_MORE)

    def tensor_from_mask(self, mask: np.ndarray) -> torch.Tensor:
        normalized = (mask > 0).astype(np.float32)
        return torch.from_numpy(normalized).unsqueeze(0).unsqueeze(0).to(DEVICE)

    def tensor_from_non_alpha_inputs(self, line_mask: np.ndarray, fill_mask: np.ndarray, distance_map: np.ndarray) -> torch.Tensor:
        line = (line_mask > 0).astype(np.float32)
        fill = (fill_mask > 0).astype(np.float32)
        dist = np.clip(distance_map.astype(np.float32), 0.0, 1.0)
        stacked = np.stack([line, fill, dist], axis=0)
        return torch.from_numpy(stacked).unsqueeze(0).to(DEVICE)

    def rgba_from_output(self, output: torch.Tensor, alpha_threshold: float) -> np.ndarray:
        rgb = torch.sigmoid(output[0:3]).permute(1, 2, 0).numpy()
        alpha_prob = torch.sigmoid(output[3]).numpy()
        alpha = (alpha_prob >= alpha_threshold).astype(np.uint8) * 255
        rgb_uint8 = np.clip(np.rint(rgb * 255.0), 0, 255).astype(np.uint8)
        rgb_uint8[alpha == 0] = 0
        return np.dstack([rgb_uint8, alpha])

    def rgba_from_rgb_output_and_fill_mask(self, output: torch.Tensor, fill_mask: np.ndarray) -> np.ndarray:
        rgb = torch.sigmoid(output[0:3]).permute(1, 2, 0).numpy()
        rgb_uint8 = np.clip(np.rint(rgb * 255.0), 0, 255).astype(np.uint8)
        alpha = cv2.resize(
            np.where(fill_mask > 0, 255, 0).astype(np.uint8),
            (rgb_uint8.shape[1], rgb_uint8.shape[0]),
            interpolation=cv2.INTER_NEAREST,
        )
        rgb_uint8[alpha == 0] = 0
        return np.dstack([rgb_uint8, alpha])

    def build_stage_image(
        self,
        crop_image: Image.Image,
        crop: SquareCrop,
        canvas_width: int,
        canvas_height: int,
        sketch_overlay_data_url: str,
    ) -> Image.Image:
        stage = Image.new("RGBA", (canvas_width, canvas_height), (255, 255, 255, 255))
        intersect_left = max(0, crop.left)
        intersect_top = max(0, crop.top)
        intersect_right = min(canvas_width, crop.right)
        intersect_bottom = min(canvas_height, crop.bottom)
        if intersect_left < intersect_right and intersect_top < intersect_bottom:
            visible_crop = crop_image.crop(
                (
                    intersect_left - crop.left,
                    intersect_top - crop.top,
                    intersect_right - crop.left,
                    intersect_bottom - crop.top,
                )
            )
            stage.alpha_composite(visible_crop, (intersect_left, intersect_top))
        if sketch_overlay_data_url:
            overlay = Image.open(io.BytesIO(data_url_to_bytes(sketch_overlay_data_url))).convert("RGBA")
            if overlay.size != (canvas_width, canvas_height):
                overlay = overlay.resize((canvas_width, canvas_height), Image.Resampling.NEAREST)
            stage.alpha_composite(overlay)
        return stage

    def build_structure_preview_image(
        self,
        crop_image: Image.Image,
        crop: SquareCrop,
        canvas_width: int,
        canvas_height: int,
        sketch_overlay_data_url: str,
    ) -> Image.Image:
        preview = Image.new("RGBA", (crop.size, crop.size), (255, 255, 255, 255))
        preview.alpha_composite(crop_image.convert("RGBA"), (0, 0))

        if sketch_overlay_data_url:
            overlay = Image.open(io.BytesIO(data_url_to_bytes(sketch_overlay_data_url))).convert("RGBA")
            if overlay.size != (canvas_width, canvas_height):
                overlay = overlay.resize((canvas_width, canvas_height), Image.Resampling.NEAREST)

            padded_overlay = Image.new("RGBA", (crop.size, crop.size), (0, 0, 0, 0))
            intersect_left = max(0, crop.left)
            intersect_top = max(0, crop.top)
            intersect_right = min(canvas_width, crop.right)
            intersect_bottom = min(canvas_height, crop.bottom)
            if intersect_left < intersect_right and intersect_top < intersect_bottom:
                cropped_overlay = overlay.crop((intersect_left, intersect_top, intersect_right, intersect_bottom))
                padded_overlay.alpha_composite(cropped_overlay, (intersect_left - crop.left, intersect_top - crop.top))
            preview.alpha_composite(padded_overlay)

        if preview.size != (MODEL_IMAGE_SIZE, MODEL_IMAGE_SIZE):
            preview = preview.resize((MODEL_IMAGE_SIZE, MODEL_IMAGE_SIZE), Image.Resampling.NEAREST)
        return preview


def keep_largest_component(mask: np.ndarray) -> np.ndarray:
    if mask.ndim != 2:
        raise ValueError("Expected 2D binary mask")
    binary = np.where(mask > 0, 255, 0).astype(np.uint8)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if num_labels <= 1:
        return binary

    component_areas = stats[1:, cv2.CC_STAT_AREA]
    total_area = int(np.sum(component_areas))
    threshold = total_area * 0.2
    cleaned = np.zeros_like(binary)
    for i, area in enumerate(component_areas):
        if area >= threshold:
            cleaned = np.where(labels == i + 1, 255, cleaned).astype(np.uint8)
    return cleaned


def keep_largest_alpha_component(rgba: np.ndarray) -> np.ndarray:
    alpha = rgba[:, :, 3]
    binary = np.where(alpha > 0, 255, 0).astype(np.uint8)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if num_labels <= 1:
        return rgba
    component_areas = stats[1:, cv2.CC_STAT_AREA]
    largest_label = int(np.argmax(component_areas)) + 1
    result = rgba.copy()
    result[labels != largest_label, 3] = 0
    return result


def find_line_endpoints(mask: np.ndarray) -> list[tuple[int, int]]:
    binary = mask > 0
    if not np.any(binary):
        return []
    skeleton = skimage_skeletonize(binary).astype(np.uint8)
    if not np.any(skeleton):
        return []
    padded = np.pad(skeleton, 1, mode="constant")
    endpoints: list[tuple[int, int]] = []
    ys, xs = np.where(skeleton > 0)
    for y, x in zip(ys, xs):
        window = padded[y:y + 3, x:x + 3]
        neighbor_count = int(np.sum(window)) - 1
        if neighbor_count <= 1:
            endpoints.append((int(x), int(y)))
    return endpoints


def close_open_endpoints(mask: np.ndarray, mode: str) -> np.ndarray:
    endpoints = find_line_endpoints(mask)
    if not endpoints:
        return np.where(mask > 0, 255, 0).astype(np.uint8)
    closed = np.where(mask > 0, 255, 0).astype(np.uint8)
    if mode == "apple":
        pair = choose_apple_endpoint_pair(closed, endpoints)
        if pair is not None:
            cv2.line(closed, pair[0], pair[1], 255, thickness=2, lineType=cv2.LINE_AA)
        return np.where(closed > 0, 255, 0).astype(np.uint8)

    remaining = endpoints[:]
    while len(remaining) >= 2:
        best_i = 0
        best_j = 1
        best_dist = float("inf")
        for i in range(len(remaining)):
            for j in range(i + 1, len(remaining)):
                dist = (remaining[i][0] - remaining[j][0]) ** 2 + (remaining[i][1] - remaining[j][1]) ** 2
                if dist < best_dist:
                    best_i, best_j, best_dist = i, j, dist
        p1 = remaining[best_i]
        p2 = remaining[best_j]
        cv2.line(closed, p1, p2, 255, thickness=2, lineType=cv2.LINE_AA)
        for index in sorted([best_i, best_j], reverse=True):
            remaining.pop(index)
    return np.where(closed > 0, 255, 0).astype(np.uint8)


def choose_apple_endpoint_pair(mask: np.ndarray, endpoints: list[tuple[int, int]]) -> tuple[tuple[int, int], tuple[int, int]] | None:
    if len(endpoints) == 1:
        ys, xs = np.where(mask > 0)
        if len(xs) == 0:
            return None
        p = endpoints[0]
        distances = (xs - p[0]) ** 2 + (ys - p[1]) ** 2
        idx = int(np.argmax(distances))
        return p, (int(xs[idx]), int(ys[idx]))
    best_pair = None
    best_area = -1
    for i in range(len(endpoints)):
        for j in range(i + 1, len(endpoints)):
            candidate = mask.copy()
            cv2.line(candidate, endpoints[i], endpoints[j], 255, thickness=2, lineType=cv2.LINE_AA)
            fill = build_fill_mask_from_line(candidate)
            area = int(np.sum(fill > 0))
            if area > best_area:
                best_pair = (endpoints[i], endpoints[j])
                best_area = area
    return best_pair


def build_fill_mask_from_line(mask: np.ndarray) -> np.ndarray:
    line = np.where(mask > 0, 255, 0).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    wall = cv2.dilate(line, kernel, iterations=1)
    background = np.where(wall > 0, 0, 255).astype(np.uint8)
    padded = cv2.copyMakeBorder(background, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=255)
    flood_mask = np.zeros((padded.shape[0] + 2, padded.shape[1] + 2), np.uint8)
    cv2.floodFill(padded, flood_mask, (0, 0), 128)
    outside = padded[1:-1, 1:-1] == 128
    fill = np.where(~outside | (line > 0), 255, 0).astype(np.uint8)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(fill, connectivity=8)
    if num_labels <= 1:
        return fill
    min_area = max(4, int(fill.size * 0.003))
    cleaned = np.zeros_like(fill)
    for label in range(1, num_labels):
        if stats[label, cv2.CC_STAT_AREA] >= min_area:
            cleaned[labels == label] = 255
    return cleaned


def build_distance_map(fill_mask: np.ndarray) -> np.ndarray:
    binary = np.where(fill_mask > 0, 1, 0).astype(np.uint8)
    if not np.any(binary):
        return np.zeros_like(fill_mask, dtype=np.float32)
    distance = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    max_value = float(np.max(distance))
    if max_value <= 0:
        return np.zeros_like(fill_mask, dtype=np.float32)
    return (distance / max_value).astype(np.float32)


def bbox_from_mask(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask > 0)
    if len(xs) == 0 or len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def align_rgba_alpha_to_fill_mask(rgba: np.ndarray, fill_mask: np.ndarray) -> np.ndarray:
    alpha = rgba[:, :, 3]
    source_bbox = bbox_from_mask(alpha)
    if source_bbox is None:
        return rgba

    h, w = alpha.shape
    target_mask = cv2.resize(
        np.where(fill_mask > 0, 255, 0).astype(np.uint8),
        (w, h),
        interpolation=cv2.INTER_NEAREST,
    )
    target_bbox = bbox_from_mask(target_mask)
    if target_bbox is None:
        return rgba

    sx1, sy1, sx2, sy2 = source_bbox
    tx1, ty1, tx2, ty2 = target_bbox
    source_w = max(1, sx2 - sx1)
    source_h = max(1, sy2 - sy1)
    target_w = max(1, tx2 - tx1)
    target_h = max(1, ty2 - ty1)
    scale = min(1.0, target_w / source_w, target_h / source_h)

    source = Image.fromarray(rgba, mode="RGBA")
    if scale < 0.995:
        resized_w = max(1, int(round(w * scale)))
        resized_h = max(1, int(round(h * scale)))
        resized = source.resize((resized_w, resized_h), Image.Resampling.LANCZOS)
        scaled_alpha = cv2.resize(alpha, (resized_w, resized_h), interpolation=cv2.INTER_NEAREST)
        scaled_bbox = bbox_from_mask(scaled_alpha)
    else:
        resized = source
        resized_w, resized_h = w, h
        scaled_bbox = source_bbox

    if scaled_bbox is None:
        return rgba

    rsx1, rsy1, rsx2, rsy2 = scaled_bbox
    source_cx = (rsx1 + rsx2) / 2.0
    source_cy = (rsy1 + rsy2) / 2.0
    target_cx = (tx1 + tx2) / 2.0
    target_cy = (ty1 + ty2) / 2.0
    paste_x = int(round(target_cx - source_cx))
    paste_y = int(round(target_cy - source_cy))

    aligned = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    aligned.alpha_composite(resized, (paste_x, paste_y))
    return np.array(aligned, dtype=np.uint8)


def has_inner_alpha_hole(rgba: np.ndarray) -> bool:
    alpha = rgba[:, :, 3]
    h, w = alpha.shape
    transparent = np.where(alpha == 0, 255, 0).astype(np.uint8)
    padded = cv2.copyMakeBorder(transparent, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=255)
    seed_mask = np.zeros((h + 4, w + 4), np.uint8)
    cv2.floodFill(padded, seed_mask, (0, 0), 128)
    inner = padded[1:-1, 1:-1]
    return bool(np.any(inner == 255))


def compute_radial_variance_at_400px(rgba: np.ndarray) -> tuple[float, float, float]:
    TARGET = 400
    h, w = rgba.shape[:2]
    resized = cv2.resize(rgba, (TARGET, TARGET), interpolation=cv2.INTER_NEAREST)
    alpha = resized[:, :, 3]
    mask = np.where(alpha > 0, 255, 0).astype(np.uint8)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0.0, w / 2.0, h / 2.0
    largest = max(contours, key=cv2.contourArea)
    M = cv2.moments(largest)
    if M["m00"] == 0:
        cx_400, cy_400 = TARGET / 2.0, TARGET / 2.0
    else:
        cx_400 = M["m10"] / M["m00"]
        cy_400 = M["m01"] / M["m00"]
    pts = largest[:, 0, :]
    dists = np.sqrt((pts[:, 0] - cx_400) ** 2 + (pts[:, 1] - cy_400) ** 2)
    variance = float(np.max(dists) - np.min(dists)) if len(dists) > 0 else 0.0
    cx_rgba = cx_400 * w / TARGET
    cy_rgba = cy_400 * h / TARGET
    return variance, cx_rgba, cy_rgba


def normalize_to_2px(mask: np.ndarray) -> np.ndarray:
    binary = mask > 0
    if not np.any(binary):
        return mask

    skeleton = skimage_skeletonize(binary)
    if not np.any(skeleton):
        return mask

    skeleton_uint8 = skeleton.astype(np.uint8) * 255
    kernel_size = int(TARGET_MODEL_STROKE_WIDTH) * 2 - 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    return cv2.dilate(skeleton_uint8, kernel)


_PIPELINE: BananaGeneratorPipeline | None = None


def get_banana_generator_pipeline() -> BananaGeneratorPipeline:
    global _PIPELINE
    if _PIPELINE is None:
        _PIPELINE = BananaGeneratorPipeline()
    return _PIPELINE
