import base64
import io
import json
import os
import tempfile
import threading
import webbrowser
from dataclasses import dataclass
from functools import lru_cache
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from .fit import FIXED_IMAGE_ID, fit_input_data_url, load_reference_contour
    from .fruit_catalog import AUTO_FRUIT, SUPPORTED_FRUITS, all_available_image_ids, available_image_ids, fruit_illust_dir
    from .judge import DEVICE, load_model, predict_topk
except ImportError:
    from fit import FIXED_IMAGE_ID, fit_input_data_url, load_reference_contour  # type: ignore
    from fruit_catalog import AUTO_FRUIT, SUPPORTED_FRUITS, all_available_image_ids, available_image_ids, fruit_illust_dir  # type: ignore
    from judge import DEVICE, load_model, predict_topk  # type: ignore

import cv2
import numpy as np
from PIL import Image


HOST = "127.0.0.1"
PORT = 8000
CANVAS_SIZE = 280
DEFAULT_FRUIT = AUTO_FRUIT


def image_sort_key(image_id: str) -> tuple[int, str]:
    try:
        return int(image_id.split("_", 1)[1]), image_id
    except (IndexError, ValueError):
        return 10**9, image_id


AVAILABLE_IMAGE_IDS = sorted(all_available_image_ids(), key=image_sort_key)
AUTO_SELECT_ID = "AUTO"
JUDGE_MODE_COMPONENTS = "components"
JUDGE_MODE_WHOLE = "whole"
JUDGE_MODE_GRID = "grid"
JUDGE_MODE_GRID2 = "grid2"
DRAW_TARGET_LEFT = "left"
DRAW_TARGET_RIGHT = "right"
QUICK_SELECT_IDS = [AUTO_SELECT_ID] + list(sorted(available_image_ids(DEFAULT_FRUIT), key=image_sort_key)[:7])
QUICK_SELECT_BUTTONS = "\n".join(
    f'<button type="button" class="image-chip{" active" if image_id == AUTO_SELECT_ID else ""}" data-image-id="{image_id}">{image_id}</button>'
    for image_id in QUICK_SELECT_IDS
)
FRUIT_SELECT_OPTIONS = "\n".join(
    f'<option value="{fruit}"{" selected" if fruit == DEFAULT_FRUIT else ""}>{fruit}</option>'
    for fruit in SUPPORTED_FRUITS
)
JUDGE_MODE_BUTTONS = """
<button type="button" class="image-chip active" data-judge-mode="components">成分ごとに判定</button>
<button type="button" class="image-chip" data-judge-mode="whole">全体をそのまま判定</button>
<button type="button" class="image-chip" data-judge-mode="grid">区間ごとに生成</button>
<button type="button" class="image-chip" data-judge-mode="grid2">横4分割で生成</button>
""".strip()
DRAW_TARGET_BUTTONS = """
<button type="button" class="image-chip active" data-draw-target="left">左で描く</button>
<button type="button" class="image-chip" data-draw-target="right">右で描く</button>
""".strip()
GRID_DIVISIONS = 2
GRID2_DIVISIONS = 4


@dataclass(frozen=True)
class ComponentSketch:
    index: int
    area: int
    bbox: tuple[int, int, int, int]
    data_url: str
    label: str = ""


HTML_PAGE = f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Draw To Fruit</title>
  <style>
    :root {{
      color-scheme: light;
      --panel: rgba(255, 250, 243, 0.96);
      --border: #d8cbb7;
      --text: #2f261c;
      --accent: #274c3a;
      --subtle: #7a6d5b;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      color: var(--text);
      font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
      background:
        radial-gradient(circle at top left, #fff9ef 0, #f4efe6 35%, #ece4d6 100%);
    }}
    .app {{
      width: min(1100px, 96vw);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 24px;
      box-shadow: 0 20px 60px rgba(65, 49, 30, 0.1);
    }}
    h1 {{
      margin: 0 0 8px;
      font-size: 1.5rem;
    }}
    p {{
      margin: 0 0 18px;
      color: var(--subtle);
      line-height: 1.5;
    }}
    .layout {{
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      gap: 24px;
      align-items: start;
    }}
    .app.right-draw-mode {{
      width: min(1500px, 98vw);
    }}
    .app.right-draw-mode .layout {{
      grid-template-columns: 260px minmax(0, 1fr);
    }}
    .left-panel, .right-panel {{
      background: rgba(255, 255, 255, 0.62);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px;
    }}
    .panel-title {{
      font-size: 0.95rem;
      font-weight: 700;
      margin: 0 0 14px;
    }}
    canvas, .preview-box {{
      width: {CANVAS_SIZE}px;
      height: {CANVAS_SIZE}px;
      border-radius: 14px;
      background: white;
      border: 2px solid var(--border);
    }}
    canvas {{
      touch-action: none;
      cursor: crosshair;
      display: block;
    }}
    .drawing-canvas.hidden {{
      display: none;
    }}
    .controls {{
      display: flex;
      gap: 10px;
      margin-top: 14px;
      flex-wrap: wrap;
    }}
    .selector {{
      margin-top: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }}
    .chip-row {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }}
    button {{
      appearance: none;
      border: none;
      border-radius: 999px;
      padding: 12px 18px;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
      background: #e8dfcf;
      color: var(--text);
    }}
    button.primary {{
      background: var(--accent);
      color: white;
    }}
    .image-chip {{
      background: #f1e6d4;
      padding: 8px 12px;
      font-size: 0.85rem;
      font-weight: 700;
    }}
    .image-chip.active {{
      background: #1f5b43;
      color: white;
    }}
    .selector-input {{
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      font: inherit;
      color: var(--text);
      background: white;
    }}
    .interval-row {{
      display: flex;
      align-items: center;
      gap: 10px;
    }}
    .interval-input {{
      width: 88px;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      font: inherit;
      color: var(--text);
      background: white;
    }}
    .right-grid {{
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }}
    .app.right-draw-mode .right-grid {{
      grid-template-columns: minmax(0, 1fr);
    }}
    .app.right-draw-mode .preview-box,
    .app.right-draw-mode .preview-label.secondary-preview {{
      display: none;
    }}
    .preview-card {{
      display: flex;
      flex-direction: column;
      gap: 10px;
    }}
    .preview-label {{
      font-size: 0.9rem;
      font-weight: 700;
    }}
    .preview-box {{
      display: grid;
      place-items: center;
      overflow: hidden;
    }}
    .preview-box img {{
      width: 100%;
      height: 100%;
      object-fit: contain;
    }}
    .right-stage {{
      position: relative;
      width: min(72vw, 640px);
      height: min(72vw, 640px);
      max-width: 100%;
      border-radius: 18px;
      border: 2px solid var(--border);
      background: white;
      overflow: hidden;
      display: none;
    }}
    .app.right-draw-mode .right-stage {{
      display: block;
    }}
    .right-stage img,
    .right-stage canvas {{
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: none;
      border-radius: 0;
      background: transparent;
    }}
    .right-stage img {{
      object-fit: contain;
      pointer-events: none;
    }}
    .right-stage .empty {{
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      background: rgba(255, 255, 255, 0.84);
      z-index: 2;
      pointer-events: none;
    }}
    .right-stage img,
    .right-stage canvas {{
      z-index: 1;
    }}
    .app.right-draw-mode .left-panel .drawing-panel {{
      display: none;
    }}
    .app.right-draw-mode .preview-box {{
      width: min(32vw, {CANVAS_SIZE}px);
      height: min(32vw, {CANVAS_SIZE}px);
    }}
    .empty {{
      color: var(--subtle);
      text-align: center;
      line-height: 1.6;
      padding: 24px;
    }}
    .status {{
      margin-top: 16px;
      font-size: 0.95rem;
      color: var(--subtle);
    }}
    .result {{
      margin-top: 12px;
      padding: 14px 16px;
      min-height: 104px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: white;
      white-space: pre-wrap;
      line-height: 1.6;
    }}
    @media (max-width: 860px) {{
      .layout {{
        grid-template-columns: 1fr;
      }}
      .right-grid {{
        grid-template-columns: 1fr;
      }}
      canvas, .preview-box {{
        width: min(80vw, {CANVAS_SIZE}px);
        height: min(80vw, {CANVAS_SIZE}px);
      }}
      .right-stage {{
        width: min(88vw, 640px);
        height: min(88vw, 640px);
      }}
    }}
  </style>
</head>
<body>
  <div class="app" id="appRoot">
    <h1>線画から近いサイズの画像を出す</h1>
    <p>左で描く通常モードと、右側の大きい生成エリアへ直接描くモードを切り替えられます。</p>
    <div class="layout">
      <section class="left-panel">
        <div class="drawing-panel">
          <div class="panel-title">入力線画</div>
          <canvas id="leftCanvas" class="drawing-canvas" width="{CANVAS_SIZE}" height="{CANVAS_SIZE}"></canvas>
        </div>
        <div class="selector">
          <div class="panel-title">フルーツ種別</div>
          <select id="fruitInput" class="selector-input">
            {FRUIT_SELECT_OPTIONS}
          </select>
        </div>
        <div class="selector">
          <div class="panel-title">描画モード</div>
          <div class="chip-row" id="drawTargetButtons">
            {DRAW_TARGET_BUTTONS}
          </div>
        </div>
        <div class="selector">
          <div class="panel-title">表示画像</div>
          <div class="chip-row" id="imageButtons">
            {QUICK_SELECT_BUTTONS}
          </div>
          <input id="imageIdInput" class="selector-input" list="imageIdList" value="{AUTO_SELECT_ID}" placeholder="AUTO or Image_1">
          <datalist id="imageIdList">
            <option value="{AUTO_SELECT_ID}"></option>
            {"".join(f'<option value="{image_id}"></option>' for image_id in AVAILABLE_IMAGE_IDS)}
          </datalist>
        </div>
        <div class="selector">
          <div class="panel-title">判定モード</div>
          <div class="chip-row" id="judgeModeButtons">
            {JUDGE_MODE_BUTTONS}
          </div>
        </div>
        <div class="controls">
          <button id="ok" class="primary">OK</button>
          <button id="clear">Clear</button>
          <button id="realtimeToggle" type="button">Realtime: OFF</button>
        </div>
        <div class="selector">
          <div class="interval-row">
            <label for="realtimeIntervalInput">Realtime interval (s)</label>
            <input id="realtimeIntervalInput" class="interval-input" type="number" min="0.1" step="0.1" value="0.5">
          </div>
        </div>
      </section>
      <section class="right-panel">
        <div class="panel-title">右側プレビュー</div>
        <div class="right-grid">
          <div class="preview-card">
            <div class="preview-label">生成エリア</div>
            <div class="right-stage" id="rightStage">
              <img id="rightStagePreview" alt="generated preview" hidden>
              <canvas id="rightCanvas" class="drawing-canvas" width="{CANVAS_SIZE}" height="{CANVAS_SIZE}"></canvas>
              <div id="rightStageEmpty" class="empty">右描画モードではここへ直接線を描いてください。</div>
            </div>
            <div class="preview-label secondary-preview">合成プレビュー</div>
            <div class="preview-box">
              <img id="compositePreview" alt="composite preview" hidden>
              <div id="compositeEmpty" class="empty">左に線を描いて<br>OK を押してください。</div>
            </div>
          </div>
        </div>
        <div class="status" id="status">待機中</div>
        <div class="result" id="result">まだ生成していません。</div>
      </section>
    </div>
  </div>
  <script>
    const appRoot = document.getElementById("appRoot");
    const leftCanvas = document.getElementById("leftCanvas");
    const rightCanvas = document.getElementById("rightCanvas");
    const leftCtx = leftCanvas.getContext("2d");
    const rightCtx = rightCanvas.getContext("2d");
    const okButton = document.getElementById("ok");
    const clearButton = document.getElementById("clear");
    const realtimeToggle = document.getElementById("realtimeToggle");
    const realtimeIntervalInput = document.getElementById("realtimeIntervalInput");
    const imageButtons = document.getElementById("imageButtons");
    const judgeModeButtons = document.getElementById("judgeModeButtons");
    const drawTargetButtons = document.getElementById("drawTargetButtons");
    const imageIdInput = document.getElementById("imageIdInput");
    const fruitInput = document.getElementById("fruitInput");
    const compositePreview = document.getElementById("compositePreview");
    const compositeEmpty = document.getElementById("compositeEmpty");
    const rightStagePreview = document.getElementById("rightStagePreview");
    const rightStageEmpty = document.getElementById("rightStageEmpty");
    const status = document.getElementById("status");
    const result = document.getElementById("result");

    function setupCanvas(targetCanvas, targetCtx, fillWhite = true) {{
      targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
      if (fillWhite) {{
        targetCtx.fillStyle = "white";
        targetCtx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
      }}
      targetCtx.lineCap = "round";
      targetCtx.lineJoin = "round";
      targetCtx.strokeStyle = "black";
      targetCtx.lineWidth = 6;
    }}

    setupCanvas(leftCanvas, leftCtx, true);
    setupCanvas(rightCanvas, rightCtx, false);

    let drawing = false;
    let canvasDirty = false;
    let predictInFlight = false;
    let realtimeEnabled = false;
    let realtimeIntervalId = null;
    let selectedImageId = imageIdInput.value.trim() || "{AUTO_SELECT_ID}";
    let selectedFruit = fruitInput.value.trim() || "{DEFAULT_FRUIT}";
    let selectedJudgeMode = "{JUDGE_MODE_COMPONENTS}";
    let selectedDrawTarget = "{DRAW_TARGET_LEFT}";

    function activeCanvas() {{
      return selectedDrawTarget === "{DRAW_TARGET_RIGHT}" ? rightCanvas : leftCanvas;
    }}

    function activeContext() {{
      return selectedDrawTarget === "{DRAW_TARGET_RIGHT}" ? rightCtx : leftCtx;
    }}

    function updateRealtimeButton() {{
      realtimeToggle.textContent = `Realtime: ${{realtimeEnabled ? "ON" : "OFF"}}`;
      realtimeToggle.classList.toggle("primary", realtimeEnabled);
    }}

    function getRealtimeIntervalMs() {{
      const seconds = Number.parseFloat(realtimeIntervalInput.value);
      if (!Number.isFinite(seconds)) {{
        return 500;
      }}
      return Math.max(100, Math.round(seconds * 1000));
    }}

    function stopRealtimeLoop() {{
      if (realtimeIntervalId) {{
        clearInterval(realtimeIntervalId);
        realtimeIntervalId = null;
      }}
    }}

    function startRealtimeLoop() {{
      stopRealtimeLoop();
      realtimeIntervalId = setInterval(() => {{
        if (!realtimeEnabled || !drawing || !canvasDirty) {{
          return;
        }}
        runPrediction(true);
      }}, getRealtimeIntervalMs());
    }}

    function syncImageButtons() {{
      const buttons = imageButtons.querySelectorAll("[data-image-id]");
      buttons.forEach((button) => {{
        button.classList.toggle("active", button.dataset.imageId === selectedImageId);
      }});
    }}

    function syncJudgeModeButtons() {{
      const buttons = judgeModeButtons.querySelectorAll("[data-judge-mode]");
      buttons.forEach((button) => {{
        button.classList.toggle("active", button.dataset.judgeMode === selectedJudgeMode);
      }});
    }}

    function syncDrawTargetButtons() {{
      const buttons = drawTargetButtons.querySelectorAll("[data-draw-target]");
      buttons.forEach((button) => {{
        button.classList.toggle("active", button.dataset.drawTarget === selectedDrawTarget);
      }});
      appRoot.classList.toggle("right-draw-mode", selectedDrawTarget === "{DRAW_TARGET_RIGHT}");
      compositeEmpty.innerHTML = "左に線を描いて<br>OK を押してください。";
      rightStageEmpty.hidden = !rightCanvasIsBlank();
    }}

    imageButtons.addEventListener("click", (event) => {{
      const button = event.target.closest("[data-image-id]");
      if (!button) return;
      selectedImageId = button.dataset.imageId;
      imageIdInput.value = selectedImageId;
      syncImageButtons();
    }});

    judgeModeButtons.addEventListener("click", (event) => {{
      const button = event.target.closest("[data-judge-mode]");
      if (!button) return;
      selectedJudgeMode = button.dataset.judgeMode;
      syncJudgeModeButtons();
    }});

    drawTargetButtons.addEventListener("click", (event) => {{
      const button = event.target.closest("[data-draw-target]");
      if (!button) return;
      selectedDrawTarget = button.dataset.drawTarget;
      syncDrawTargetButtons();
    }});

    imageIdInput.addEventListener("change", () => {{
      selectedImageId = imageIdInput.value.trim() || "{AUTO_SELECT_ID}";
      syncImageButtons();
    }});

    fruitInput.addEventListener("change", () => {{
      selectedFruit = fruitInput.value.trim() || "{DEFAULT_FRUIT}";
    }});

    function pointFromEvent(targetCanvas, event) {{
      const rect = targetCanvas.getBoundingClientRect();
      const scaleX = targetCanvas.width / rect.width;
      const scaleY = targetCanvas.height / rect.height;
      return {{
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
      }};
    }}

    function startDraw(event) {{
      drawing = true;
      const targetCanvas = event.currentTarget;
      const targetCtx = targetCanvas === rightCanvas ? rightCtx : leftCtx;
      const point = pointFromEvent(targetCanvas, event);
      targetCtx.beginPath();
      targetCtx.moveTo(point.x, point.y);
      targetCtx.lineTo(point.x, point.y);
      targetCtx.stroke();
      canvasDirty = true;
      if (targetCanvas === rightCanvas) {{
        rightStageEmpty.hidden = true;
      }}
      event.preventDefault();
    }}

    function draw(event) {{
      if (!drawing) return;
      const targetCanvas = event.currentTarget;
      const targetCtx = targetCanvas === rightCanvas ? rightCtx : leftCtx;
      const point = pointFromEvent(targetCanvas, event);
      targetCtx.lineTo(point.x, point.y);
      targetCtx.stroke();
      canvasDirty = true;
      event.preventDefault();
    }}

    function endDraw() {{
      drawing = false;
      leftCtx.beginPath();
      rightCtx.beginPath();
      if (realtimeEnabled && canvasDirty) {{
        runPrediction(true);
      }}
    }}

    function getInkBounds() {{
      const targetCanvas = activeCanvas();
      const targetCtx = activeContext();
      const imageData = targetCtx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
      const pixels = imageData.data;
      let minX = targetCanvas.width;
      let minY = targetCanvas.height;
      let maxX = -1;
      let maxY = -1;

      for (let y = 0; y < targetCanvas.height; y += 1) {{
        for (let x = 0; x < targetCanvas.width; x += 1) {{
          const index = (y * targetCanvas.width + x) * 4;
          const r = pixels[index];
          const g = pixels[index + 1];
          const b = pixels[index + 2];
          const a = pixels[index + 3];
          const isInk = selectedDrawTarget === "{DRAW_TARGET_RIGHT}"
            ? (a > 0 && (r < 220 || g < 220 || b < 220))
            : (r < 220 || g < 220 || b < 220);
          if (isInk) {{
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }}
        }}
      }}

      if (maxX < 0 || maxY < 0) {{
        return null;
      }}
      return {{
        left: minX,
        top: minY,
        right: maxX + 1,
        bottom: maxY + 1,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      }};
    }}

    function buildSketchOverlayDataUrl() {{
      const targetCanvas = activeCanvas();
      const targetCtx = activeContext();
      const imageData = targetCtx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
      const pixels = imageData.data;
      for (let index = 0; index < pixels.length; index += 4) {{
        const r = pixels[index];
        const g = pixels[index + 1];
        const b = pixels[index + 2];
        const a = pixels[index + 3];
        const isInk = selectedDrawTarget === "{DRAW_TARGET_RIGHT}"
          ? (a > 0 && (r < 220 || g < 220 || b < 220))
          : (r < 220 || g < 220 || b < 220);
        pixels[index] = 0;
        pixels[index + 1] = 0;
        pixels[index + 2] = 0;
        pixels[index + 3] = isInk ? 255 : 0;
      }}
      const overlayCanvas = document.createElement("canvas");
      overlayCanvas.width = targetCanvas.width;
      overlayCanvas.height = targetCanvas.height;
      overlayCanvas.getContext("2d").putImageData(imageData, 0, 0);
      return overlayCanvas.toDataURL("image/png");
    }}

    function rightCanvasIsBlank() {{
      const pixels = rightCtx.getImageData(0, 0, rightCanvas.width, rightCanvas.height).data;
      for (let index = 0; index < pixels.length; index += 4) {{
        if (pixels[index + 3] > 0 && (pixels[index] < 220 || pixels[index + 1] < 220 || pixels[index + 2] < 220)) {{
          return false;
        }}
      }}
      return true;
    }}

    function buildInputDataUrl() {{
      if (selectedDrawTarget !== "{DRAW_TARGET_RIGHT}") {{
        return activeCanvas().toDataURL("image/png");
      }}
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = rightCanvas.width;
      exportCanvas.height = rightCanvas.height;
      const exportCtx = exportCanvas.getContext("2d");
      exportCtx.fillStyle = "white";
      exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
      exportCtx.drawImage(rightCanvas, 0, 0);
      return exportCanvas.toDataURL("image/png");
    }}

    async function runPrediction(isRealtime = false) {{
      if (predictInFlight) {{
        return;
      }}
      if (!canvasDirty) {{
        if (isRealtime) {{
          return;
        }}
        status.textContent = "未入力";
        result.textContent = selectedDrawTarget === "{DRAW_TARGET_RIGHT}"
          ? "先に右側の生成エリアへ線を描いてください。"
          : "先に左側へ線を描いてください。";
        return;
      }}

      const bbox = getInkBounds();
      if (!bbox) {{
        if (isRealtime) {{
          return;
        }}
        status.textContent = "未入力";
        result.textContent = "線が見つかりませんでした。";
        return;
      }}

      predictInFlight = true;
        status.textContent = isRealtime ? "リアルタイム生成中..." : "生成中...";
      try {{
        const dataUrl = buildInputDataUrl();
        const sketchOverlay = buildSketchOverlayDataUrl();
        const response = await fetch("/predict", {{
          method: "POST",
          headers: {{ "Content-Type": "application/json" }},
          body: JSON.stringify({{ image: dataUrl, sketch_overlay: sketchOverlay, bbox, image_id: selectedImageId, fruit_name: selectedFruit, judge_mode: selectedJudgeMode }}),
        }});
        const payload = await response.json();
        if (!response.ok) {{
          throw new Error(payload.error || "生成に失敗しました");
        }}

        compositePreview.src = payload.composite_image;
        compositePreview.hidden = false;
        compositeEmpty.hidden = true;
        rightStagePreview.src = payload.stage_image;
        rightStagePreview.hidden = false;
        rightStageEmpty.hidden = true;

        status.textContent = isRealtime ? "リアルタイム更新中" : "生成完了";
        result.textContent = payload.lines.join("\\n");
      }} catch (error) {{
        if (!isRealtime) {{
          status.textContent = "エラー";
          result.textContent = String(error);
        }}
      }}
      predictInFlight = false;
    }}

    leftCanvas.addEventListener("pointerdown", startDraw);
    leftCanvas.addEventListener("pointermove", draw);
    leftCanvas.addEventListener("pointerup", endDraw);
    leftCanvas.addEventListener("pointerleave", endDraw);
    leftCanvas.addEventListener("pointercancel", endDraw);
    rightCanvas.addEventListener("pointerdown", startDraw);
    rightCanvas.addEventListener("pointermove", draw);
    rightCanvas.addEventListener("pointerup", endDraw);
    rightCanvas.addEventListener("pointerleave", endDraw);
    rightCanvas.addEventListener("pointercancel", endDraw);
    okButton.addEventListener("click", runPrediction);
    realtimeToggle.addEventListener("click", () => {{
      realtimeEnabled = !realtimeEnabled;
      updateRealtimeButton();
      if (realtimeEnabled) {{
        startRealtimeLoop();
        if (canvasDirty) {{
          runPrediction(true);
        }}
      }} else {{
        stopRealtimeLoop();
      }}
    }});

    realtimeIntervalInput.addEventListener("change", () => {{
      if (realtimeEnabled) {{
        startRealtimeLoop();
      }}
    }});

    clearButton.addEventListener("click", () => {{
      canvasDirty = false;
      predictInFlight = false;
      stopRealtimeLoop();
      leftCtx.clearRect(0, 0, leftCanvas.width, leftCanvas.height);
      rightCtx.clearRect(0, 0, rightCanvas.width, rightCanvas.height);
      setupCanvas(leftCanvas, leftCtx, true);
      setupCanvas(rightCanvas, rightCtx, false);

      compositePreview.hidden = true;
      compositePreview.removeAttribute("src");
      compositeEmpty.hidden = false;
      rightStagePreview.hidden = true;
      rightStagePreview.removeAttribute("src");
      rightStageEmpty.hidden = false;

      status.textContent = "待機中";
      result.textContent = "まだ生成していません。";
      if (realtimeEnabled) {{
        startRealtimeLoop();
      }}
    }});

    syncImageButtons();
    syncJudgeModeButtons();
    syncDrawTargetButtons();
    updateRealtimeButton();
  </script>
</body>
</html>
"""

def file_to_data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def data_url_to_bytes(data_url: str) -> bytes:
    if "," not in data_url:
        raise ValueError("Invalid image payload")
    _, encoded = data_url.split(",", 1)
    return base64.b64decode(encoded)


def svg_to_data_url(svg: str) -> str:
    encoded = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


@lru_cache(maxsize=1)
def load_judge_bundle():
    model, idx_to_class, cfg = load_model(
        model_path=Path("data/model/3fruit/best_model.pt"),
        meta_path=Path("data/model/3fruit/meta.json"),
        device=DEVICE,
    )
    return model, idx_to_class, cfg


def parse_auto_class_name(class_name: str) -> tuple[str, str]:
    for fruit_name in SUPPORTED_FRUITS:
        prefix = f"{fruit_name}_"
        if class_name.startswith(prefix):
            image_id = class_name[len(prefix):]
            return fruit_name, image_id
    raise ValueError(f"Unsupported AUTO class name: {class_name}")


def normalize_sketch_for_judge(data_url: str) -> bytes:
    source = Image.open(io.BytesIO(data_url_to_bytes(data_url))).convert("L")
    binary = source.point(lambda value: 0 if value < 200 else 255, mode="L")
    bbox = binary.point(lambda value: 255 if value == 0 else 0, mode="L").getbbox()
    if bbox is None:
        raise ValueError("線が見つかりませんでした")

    cropped = binary.crop(bbox)
    canvas = Image.new("L", source.size, 255)
    max_side = max(cropped.width, cropped.height, 1)
    target_side = int(min(source.size) * 0.78)
    scale = target_side / max_side
    resized = cropped.resize(
        (max(1, int(round(cropped.width * scale))), max(1, int(round(cropped.height * scale)))),
        Image.Resampling.NEAREST,
    )
    offset_x = (canvas.width - resized.width) // 2
    offset_y = (canvas.height - resized.height) // 2
    canvas.paste(resized, (offset_x, offset_y))
    buffer = io.BytesIO()
    canvas.save(buffer, format="PNG")
    return buffer.getvalue()


def component_image_to_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def data_url_to_mask(data_url: str) -> np.ndarray:
    image = Image.open(io.BytesIO(data_url_to_bytes(data_url))).convert("L")
    gray = np.array(image, dtype=np.uint8)
    return np.where(gray < 200, 255, 0).astype(np.uint8)


def extract_components(data_url: str) -> list[ComponentSketch]:
    mask = data_url_to_mask(data_url)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)

    components: list[ComponentSketch] = []
    for label in range(1, num_labels):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area <= 0:
            continue
        left = int(stats[label, cv2.CC_STAT_LEFT])
        top = int(stats[label, cv2.CC_STAT_TOP])
        width = int(stats[label, cv2.CC_STAT_WIDTH])
        height = int(stats[label, cv2.CC_STAT_HEIGHT])

        component_mask = np.where(labels == label, 0, 255).astype(np.uint8)
        component_image = Image.fromarray(component_mask, mode="L")
        components.append(
            ComponentSketch(
                index=label - 1,
                area=area,
                bbox=(left, top, left + width, top + height),
                data_url=component_image_to_data_url(component_image),
                label=f"component-{label - 1}",
            )
        )

    components.sort(key=lambda item: (-item.area, item.bbox[1], item.bbox[0]))
    return components


def cell_bounds(row: int, col: int, canvas_width: int, canvas_height: int) -> tuple[int, int, int, int]:
    x0 = round(canvas_width * col / GRID_DIVISIONS)
    x1 = round(canvas_width * (col + 1) / GRID_DIVISIONS)
    y0 = round(canvas_height * row / GRID_DIVISIONS)
    y1 = round(canvas_height * (row + 1) / GRID_DIVISIONS)
    return x0, y0, x1, y1


def build_grid_mode_components(data_url: str, canvas_width: int, canvas_height: int) -> list[ComponentSketch]:
    mask = data_url_to_mask(data_url)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    generated: list[ComponentSketch] = []
    seen_keys: set[tuple[int, tuple[tuple[int, int], ...]]] = set()

    for label in range(1, num_labels):
        component_mask = np.where(labels == label, 255, 0).astype(np.uint8)
        occupied_cells: list[tuple[int, int]] = []
        for row in range(GRID_DIVISIONS):
            for col in range(GRID_DIVISIONS):
                x0, y0, x1, y1 = cell_bounds(row, col, canvas_width, canvas_height)
                if np.any(component_mask[y0:y1, x0:x1] > 0):
                    occupied_cells.append((row, col))

        for row, col in occupied_cells:
            cells = ((row, col),)
            key = (label, cells)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            x0, y0, x1, y1 = cell_bounds(row, col, canvas_width, canvas_height)
            region_mask = np.zeros_like(component_mask)
            region_mask[y0:y1, x0:x1] = component_mask[y0:y1, x0:x1]
            area = int(np.count_nonzero(region_mask))
            if area == 0:
                continue
            region_image = Image.fromarray(np.where(region_mask > 0, 0, 255).astype(np.uint8), mode="L")
            generated.append(
                ComponentSketch(
                    index=label - 1,
                    area=area,
                    bbox=(x0, y0, x1, y1),
                    data_url=component_image_to_data_url(region_image),
                    label=f"cell r{row + 1}c{col + 1}",
                )
            )

        if len(occupied_cells) == 2:
            for index, first_cell in enumerate(occupied_cells):
                for second_cell in occupied_cells[index + 1 :]:
                    cells = tuple(sorted((first_cell, second_cell)))
                    key = (label, cells)
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                    region_mask = np.zeros_like(component_mask)
                    for row, col in cells:
                        x0, y0, x1, y1 = cell_bounds(row, col, canvas_width, canvas_height)
                        region_mask[y0:y1, x0:x1] = component_mask[y0:y1, x0:x1]
                    area = int(np.count_nonzero(region_mask))
                    if area == 0:
                        continue
                    xs = []
                    ys = []
                    for row, col in cells:
                        x0, y0, x1, y1 = cell_bounds(row, col, canvas_width, canvas_height)
                        xs.extend([x0, x1])
                        ys.extend([y0, y1])
                    region_image = Image.fromarray(np.where(region_mask > 0, 0, 255).astype(np.uint8), mode="L")
                    cell_label = " + ".join(f"r{row + 1}c{col + 1}" for row, col in cells)
                    generated.append(
                        ComponentSketch(
                            index=label - 1,
                            area=area,
                            bbox=(min(xs), min(ys), max(xs), max(ys)),
                            data_url=component_image_to_data_url(region_image),
                            label=f"cells {cell_label}",
                        )
                    )

    generated.sort(key=lambda item: (item.index, item.label))
    return generated


def build_grid2_mode_components(data_url: str, canvas_width: int, canvas_height: int) -> list[ComponentSketch]:
    mask = data_url_to_mask(data_url)
    generated: list[ComponentSketch] = []

    for col in range(GRID2_DIVISIONS):
        x0 = round(canvas_width * col / GRID2_DIVISIONS)
        x1 = round(canvas_width * (col + 1) / GRID2_DIVISIONS)
        region_mask = np.zeros_like(mask)
        region_mask[:, x0:x1] = mask[:, x0:x1]
        area = int(np.count_nonzero(region_mask))
        if area == 0:
            continue
        region_image = Image.fromarray(np.where(region_mask > 0, 0, 255).astype(np.uint8), mode="L")
        generated.append(
            ComponentSketch(
                index=col,
                area=area,
                bbox=(x0, 0, x1, canvas_height),
                data_url=component_image_to_data_url(region_image),
                label=f"strip c{col + 1}",
            )
        )

    return generated


def select_image_with_judge(data_url: str) -> tuple[str, str, float]:
    model, idx_to_class, cfg = load_judge_bundle()
    normalized_png = normalize_sketch_for_judge(data_url)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp_file:
        temp_file.write(normalized_png)
        temp_path = Path(temp_file.name)
    try:
        predictions = predict_topk(
            image_path=temp_path,
            model=model,
            idx_to_class=idx_to_class,
            image_size=cfg["image_size"],
            input_black_threshold=cfg["input_black_threshold"],
            device=DEVICE,
            k=1,
        )
    finally:
        temp_path.unlink(missing_ok=True)

    prediction = predictions[0]
    resolved_fruit_name, image_id = parse_auto_class_name(prediction["class_name"])
    if image_id not in available_image_ids(resolved_fruit_name):
        raise ValueError(f"Judge selected unknown image id for {resolved_fruit_name}: {image_id}")
    return resolved_fruit_name, image_id, float(prediction["probability"])


def render_composite_image(
    sketch_overlay_data_url: str | None,
    placements: list[dict],
    canvas_width: int,
    canvas_height: int,
) -> str:
    image_tags = []
    for placement in placements:
        image_href = file_to_data_url(fruit_illust_dir(placement["fruit_name"]) / f"{placement['image_id']}.png")
        rendered_width = placement["image_width"] * placement["scale"]
        rendered_height = placement["image_height"] * placement["scale"]
        image_tags.append(
            f'<image href="{image_href}" x="{placement["translation_x"]:.3f}" y="{placement["translation_y"]:.3f}" '
            f'width="{rendered_width:.3f}" height="{rendered_height:.3f}" preserveAspectRatio="none" opacity="0.72" />'
        )
    svg = f"""
<svg xmlns="http://www.w3.org/2000/svg" width="{canvas_width}" height="{canvas_height}" viewBox="0 0 {canvas_width} {canvas_height}">
  <rect width="100%" height="100%" fill="white" />
  {' '.join(image_tags)}
  {f'<image href="{sketch_overlay_data_url}" x="0" y="0" width="{canvas_width}" height="{canvas_height}" preserveAspectRatio="none" />' if sketch_overlay_data_url else ''}
</svg>
""".strip()
    return svg_to_data_url(svg)


def render_bullet_assets(placements: list[dict]) -> list[dict]:
    assets: list[dict] = []
    for placement in placements:
        image_href = file_to_data_url(fruit_illust_dir(placement["fruit_name"]) / f"{placement['image_id']}.png")
        rendered_width = placement["image_width"] * placement["scale"]
        rendered_height = placement["image_height"] * placement["scale"]
        width = max(1, int(np.ceil(rendered_width)))
        height = max(1, int(np.ceil(rendered_height)))
        svg = f"""
<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <rect width="100%" height="100%" fill="white" />
  <image href="{image_href}" x="0" y="0" width="{rendered_width:.3f}" height="{rendered_height:.3f}" preserveAspectRatio="none" opacity="0.72" />
</svg>
""".strip()
        assets.append(
            {
                "image": svg_to_data_url(svg),
                "origin_x": float(placement["translation_x"]),
                "origin_y": float(placement["translation_y"]),
                "width": float(rendered_width),
                "height": float(rendered_height),
                "fruit_name": placement["fruit_name"],
                "image_id": placement["image_id"],
            }
        )
    return assets


def resolve_image_id(component_data_url: str, image_id: str, fruit_name: str) -> tuple[str, float | None, str, str]:
    if image_id == AUTO_SELECT_ID:
        resolved_fruit_name, resolved_image_id, judge_probability = select_image_with_judge(component_data_url)
        return resolved_image_id, judge_probability, "judge", resolved_fruit_name
    if image_id not in available_image_ids(fruit_name):
        raise ValueError(f"Unknown image id for {fruit_name}: {image_id}")
    return image_id, None, "manual", fruit_name


def build_result(
    data_url: str,
    sketch_overlay_data_url: str,
    bbox: dict,
    image_id: str,
    fruit_name: str,
    judge_mode: str,
    canvas_width: int = CANVAS_SIZE,
    canvas_height: int = CANVAS_SIZE,
) -> dict:
    if judge_mode == JUDGE_MODE_WHOLE:
        components = [
            ComponentSketch(
                index=0,
                area=0,
                bbox=(bbox["left"], bbox["top"], bbox["right"], bbox["bottom"]),
                data_url=data_url,
                label="whole image",
            )
        ]
    elif judge_mode == JUDGE_MODE_GRID:
        components = build_grid_mode_components(data_url, canvas_width=canvas_width, canvas_height=canvas_height)
        if not components:
            raise ValueError("区間内に線が見つかりませんでした")
    elif judge_mode == JUDGE_MODE_GRID2:
        components = build_grid2_mode_components(data_url, canvas_width=canvas_width, canvas_height=canvas_height)
        if not components:
            raise ValueError("区間内に線が見つかりませんでした")
    else:
        components = extract_components(data_url)
        if not components:
            raise ValueError("線が見つかりませんでした")

    placements = []
    lines = [
        f"judge mode: {judge_mode}",
        f"selected fruit: {fruit_name}",
        f"component count: {len(components)}",
        f"input bbox size: {bbox['width']} x {bbox['height']}",
    ]

    first_image_id = None
    for component_index, component in enumerate(components, start=1):
        resolved_image_id, judge_probability, selection_mode, resolved_fruit_name = resolve_image_id(
            component.data_url,
            image_id,
            fruit_name,
        )

        fit_result = fit_input_data_url(
            component.data_url,
            image_id=resolved_image_id,
            whole_mode=(judge_mode != JUDGE_MODE_COMPONENTS),
            fruit_name=resolved_fruit_name,
        )
        reference_contour = load_reference_contour(resolved_image_id, fruit_name=resolved_fruit_name)
        placements.append(
            {
                "fruit_name": resolved_fruit_name,
                "image_id": fit_result.image_id,
                "image_width": fit_result.image_width,
                "image_height": fit_result.image_height,
                "scale": fit_result.scale,
                "translation_x": fit_result.translation_x,
                "translation_y": fit_result.translation_y,
            }
        )
        if first_image_id is None:
            first_image_id = fit_result.image_id

        left, top, right, bottom = component.bbox
        component_lines = [
            f"[component {component_index}] segment: {component.label or f'component-{component.index}'}",
            f"[component {component_index}] fruit: {resolved_fruit_name}",
            f"[component {component_index}] image: {resolved_image_id}",
            f"[component {component_index}] selection mode: {selection_mode}",
            f"[component {component_index}] bbox: ({left}, {top}) - ({right}, {bottom})",
            f"[component {component_index}] reference bbox size: {reference_contour.bbox_width} x {reference_contour.bbox_height}",
            f"[component {component_index}] scale: {fit_result.scale:.6f}",
            f"[component {component_index}] translation: ({fit_result.translation_x:.3f}, {fit_result.translation_y:.3f})",
            f"[component {component_index}] representative index: {fit_result.representative_index}",
            f"[component {component_index}] reversed: {fit_result.reversed}",
            f"[component {component_index}] similarity: {fit_result.similarity:.6f}",
        ]
        if judge_probability is not None:
            component_lines.insert(2, f"[component {component_index}] judge probability: {judge_probability:.6f}")
        lines.extend(component_lines)

    composite_image = render_composite_image(
        sketch_overlay_data_url,
        placements,
        canvas_width=canvas_width,
        canvas_height=canvas_height,
    )
    stage_image = render_composite_image(
        None,
        placements,
        canvas_width=canvas_width,
        canvas_height=canvas_height,
    )
    bullet_assets = render_bullet_assets(placements)
    return {
        "lines": lines,
        "image_id": first_image_id,
        "components": placements,
        "composite_image": composite_image,
        "stage_image": stage_image,
        "bullet_assets": bullet_assets,
    }


class AppHandler(BaseHTTPRequestHandler):
    def _send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self) -> None:
        body = HTML_PAGE.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/":
            self._send_html()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        if self.path != "/predict":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            payload = json.loads(body.decode("utf-8"))
            self._send_json(
                build_result(
                    payload["image"],
                    payload["sketch_overlay"],
                    payload["bbox"],
                    payload["image_id"],
                    payload.get("fruit_name", DEFAULT_FRUIT),
                    payload.get("judge_mode", JUDGE_MODE_COMPONENTS),
                    int(payload.get("canvas_width", CANVAS_SIZE)),
                    int(payload.get("canvas_height", CANVAS_SIZE)),
                )
            )
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def log_message(self, format: str, *args) -> None:
        return


def open_browser() -> None:
    webbrowser.open(f"http://{HOST}:{PORT}/", new=1)


def main() -> None:
    os.environ.setdefault("TK_SILENCE_DEPRECATION", "1")
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"Open http://{HOST}:{PORT}/ in your browser")
    threading.Timer(0.8, open_browser).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
