import json
import os
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    from .draw_app import AUTO_SELECT_ID, DEFAULT_FRUIT, JUDGE_MODE_COMPONENTS, build_result
except ImportError:
    from draw_app import AUTO_SELECT_ID, DEFAULT_FRUIT, JUDGE_MODE_COMPONENTS, build_result  # type: ignore


HOST = "127.0.0.1"
PORT = 8010
AUTO_OPEN_BROWSER = os.environ.get("DRAW_APP_API_AUTO_OPEN", "1") != "0"
DEFAULT_REALTIME_INTERVAL = 0.5
DEFAULT_FRAME_SIZE = 640
DEFAULT_FRAME_WIDTH = DEFAULT_FRAME_SIZE
DEFAULT_FRAME_HEIGHT = DEFAULT_FRAME_SIZE
DEFAULT_PROCESSING_LONG_SIDE = 280
MIN_FRAME_SIZE = 280
MAX_FRAME_SIZE = 1400
MIN_PROCESSING_SIZE = 64
MAX_PROCESSING_SIZE = 1024


def clamp_float(value: str | None, default: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value) if value is not None else default
    except ValueError:
        parsed = default
    return max(minimum, min(maximum, parsed))


def clamp_int(value: str | None, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value) if value is not None else default
    except ValueError:
        parsed = default
    return max(minimum, min(maximum, parsed))


def default_processing_dimensions(frame_width: int, frame_height: int) -> tuple[int, int]:
    if frame_width <= 0 or frame_height <= 0:
        return DEFAULT_PROCESSING_LONG_SIDE, DEFAULT_PROCESSING_LONG_SIDE
    if frame_width >= frame_height:
        processing_width = DEFAULT_PROCESSING_LONG_SIDE
        processing_height = max(
            MIN_PROCESSING_SIZE,
            int(round(DEFAULT_PROCESSING_LONG_SIDE * frame_height / frame_width)),
        )
    else:
        processing_height = DEFAULT_PROCESSING_LONG_SIDE
        processing_width = max(
            MIN_PROCESSING_SIZE,
            int(round(DEFAULT_PROCESSING_LONG_SIDE * frame_width / frame_height)),
        )
    return (
        min(MAX_PROCESSING_SIZE, processing_width),
        min(MAX_PROCESSING_SIZE, processing_height),
    )


def widget_config_from_query(query: str) -> dict:
    params = parse_qs(query)
    image_id = params.get("image_id", [AUTO_SELECT_ID])[0] or AUTO_SELECT_ID
    fruit_name = params.get("fruit_name", [DEFAULT_FRUIT])[0] or DEFAULT_FRUIT
    judge_mode = params.get("judge_mode", [JUDGE_MODE_COMPONENTS])[0] or JUDGE_MODE_COMPONENTS
    realtime_interval = clamp_float(
        params.get("realtime_interval", [str(DEFAULT_REALTIME_INTERVAL)])[0],
        default=DEFAULT_REALTIME_INTERVAL,
        minimum=0.1,
        maximum=10.0,
    )
    frame_size = clamp_int(
        params.get("frame_size", [str(DEFAULT_FRAME_SIZE)])[0],
        default=DEFAULT_FRAME_SIZE,
        minimum=MIN_FRAME_SIZE,
        maximum=MAX_FRAME_SIZE,
    )
    frame_width = clamp_int(
        params.get("frame_width", [str(frame_size)])[0],
        default=DEFAULT_FRAME_WIDTH,
        minimum=MIN_FRAME_SIZE,
        maximum=MAX_FRAME_SIZE,
    )
    frame_height = clamp_int(
        params.get("frame_height", [str(frame_size)])[0],
        default=DEFAULT_FRAME_HEIGHT,
        minimum=MIN_FRAME_SIZE,
        maximum=MAX_FRAME_SIZE,
    )
    default_processing_width, default_processing_height = default_processing_dimensions(frame_width, frame_height)
    processing_width = clamp_int(
        params.get("processing_width", [str(default_processing_width)])[0],
        default=default_processing_width,
        minimum=MIN_PROCESSING_SIZE,
        maximum=MAX_PROCESSING_SIZE,
    )
    processing_height = clamp_int(
        params.get("processing_height", [str(default_processing_height)])[0],
        default=default_processing_height,
        minimum=MIN_PROCESSING_SIZE,
        maximum=MAX_PROCESSING_SIZE,
    )
    return {
        "image_id": image_id,
        "fruit_name": fruit_name,
        "judge_mode": judge_mode,
        "realtime_interval": realtime_interval,
        "frame_size": frame_size,
        "frame_width": frame_width,
        "frame_height": frame_height,
        "processing_width": processing_width,
        "processing_height": processing_height,
    }


def html_page(config: dict) -> str:
    config_json = json.dumps(config, ensure_ascii=False)
    return f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Draw Fruit API</title>
  <style>
    :root {{
      color-scheme: light;
      --panel: rgba(255, 251, 246, 0.98);
      --border: #d7ccb9;
      --accent: #254d3a;
      --text: #2d241b;
      --subtle: #7a6d5b;
      --frame-width: {config["frame_width"]}px;
      --frame-height: {config["frame_height"]}px;
    }}
    * {{ box-sizing: border-box; }}
    html, body {{
      margin: 0;
      padding: 0;
      background: transparent;
      font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
      color: var(--text);
    }}
    .widget {{
      width: min(calc(var(--frame-width) * 1.36 + 60px), 100vw);
      padding: 20px;
      border: 1px solid var(--border);
      border-radius: 24px;
      background: var(--panel);
      box-shadow: 0 18px 44px rgba(70, 54, 35, 0.12);
    }}
    .workspace {{
      display: flex;
      align-items: stretch;
      gap: 14px;
    }}
    .stage {{
      position: relative;
      width: min(var(--frame-width), calc(100vw - 40px));
      height: min(var(--frame-height), calc(100vh - 120px));
      border-radius: 18px;
      overflow: hidden;
      border: 2px solid var(--border);
      background: white;
    }}
    .stage img,
    .stage canvas,
    .stage .empty {{
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }}
    .stage img {{
      object-fit: fill;
      pointer-events: none;
    }}
    .stage canvas {{
      background: transparent;
      touch-action: none;
      cursor: crosshair;
      opacity: 0;
    }}
    .structure-preview {{
      width: min(calc(var(--frame-width) * 0.34), 220px);
      min-width: 140px;
      border: 2px solid var(--border);
      border-radius: 18px;
      background: white;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }}
    .structure-preview__label {{
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      color: var(--subtle);
      font-size: 0.78rem;
      font-weight: 700;
      text-align: center;
    }}
    .structure-preview__frame {{
      position: relative;
      flex: 1;
      min-height: 140px;
    }}
    .structure-preview img,
    .structure-preview .empty {{
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }}
    .structure-preview img {{
      object-fit: fill;
    }}
    .structure-preview .empty {{
      display: grid;
      place-items: center;
      padding: 14px;
      color: var(--subtle);
      text-align: center;
      line-height: 1.45;
      font-size: 0.82rem;
    }}
    .stage .empty {{
      display: grid;
      place-items: center;
      color: var(--subtle);
      text-align: center;
      line-height: 1.6;
      padding: 24px;
      background: rgba(255, 255, 255, 0.82);
      pointer-events: none;
    }}
    .toolbar {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 14px;
    }}
    .status {{
      font-size: 0.92rem;
      color: var(--subtle);
      min-height: 1.4em;
    }}
    button {{
      appearance: none;
      border: none;
      border-radius: 999px;
      padding: 11px 16px;
      background: #eadfcd;
      color: var(--text);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }}
    @media (max-width: 860px) {{
      .widget {{
        width: 100vw;
        border-radius: 0;
        border-left: none;
        border-right: none;
      }}
      .workspace {{
        flex-direction: column;
      }}
      .structure-preview {{
        width: 100%;
        min-height: 160px;
      }}
    }}
  </style>
</head>
<body>
  <div class="widget">
    <div class="workspace">
      <div class="stage">
        <img id="stagePreview" alt="generated fruit" hidden>
        <canvas id="stageCanvas" width="{config["processing_width"]}" height="{config["processing_height"]}"></canvas>
        <div id="stageEmpty" class="empty">ここに直接線を描くと、同じ場所にフルーツをリアルタイム生成します。</div>
      </div>
      <div class="structure-preview">
        <div class="structure-preview__label">線の確認</div>
        <div class="structure-preview__frame">
          <img id="structurePreview" alt="generated fruit with sketch lines" hidden>
          <div id="structureEmpty" class="empty">生成後に線入り画像を表示します。</div>
        </div>
      </div>
    </div>
    <div class="toolbar">
      <div id="status" class="status">待機中</div>
      <button id="clearButton" type="button">Clear</button>
    </div>
  </div>
  <script id="widgetConfig" type="application/json">{config_json}</script>
  <script>
    const CONFIG = JSON.parse(document.getElementById("widgetConfig").textContent);
    const DESIRED_DISPLAY_LINE_WIDTH = 6;
    const canvas = document.getElementById("stageCanvas");
    const ctx = canvas.getContext("2d");
    const stagePreview = document.getElementById("stagePreview");
    const structurePreview = document.getElementById("structurePreview");
    const stageEmpty = document.getElementById("stageEmpty");
    const structureEmpty = document.getElementById("structureEmpty");
    const status = document.getElementById("status");
    const clearButton = document.getElementById("clearButton");

    let drawing = false;
    let canvasDirty = false;
    let predictInFlight = false;
    let realtimeIntervalId = null;

    function updateLineWidth() {{
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width / canvas.width;
      const scaleY = rect.height / canvas.height;
      const scale = Math.max((scaleX + scaleY) / 2, 0.001);
      ctx.lineWidth = Math.max(1, DESIRED_DISPLAY_LINE_WIDTH / scale);
    }}

    function setupCanvas() {{
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "black";
      updateLineWidth();
    }}

    function pointFromEvent(event) {{
      const rect = canvas.getBoundingClientRect();
      return {{
        x: (event.clientX - rect.left) * (canvas.width / rect.width),
        y: (event.clientY - rect.top) * (canvas.height / rect.height),
      }};
    }}

    function isInkAt(index, pixels) {{
      return pixels[index + 3] > 0 && (pixels[index] < 220 || pixels[index + 1] < 220 || pixels[index + 2] < 220);
    }}

    function getInkBounds() {{
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = imageData.data;
      let minX = canvas.width;
      let minY = canvas.height;
      let maxX = -1;
      let maxY = -1;

      for (let y = 0; y < canvas.height; y += 1) {{
        for (let x = 0; x < canvas.width; x += 1) {{
          const index = (y * canvas.width + x) * 4;
          if (!isInkAt(index, pixels)) {{
            continue;
          }}
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
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
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = imageData.data;
      for (let index = 0; index < pixels.length; index += 4) {{
        const isInk = isInkAt(index, pixels);
        pixels[index] = 0;
        pixels[index + 1] = 0;
        pixels[index + 2] = 0;
        pixels[index + 3] = isInk ? 255 : 0;
      }}
      const overlayCanvas = document.createElement("canvas");
      overlayCanvas.width = canvas.width;
      overlayCanvas.height = canvas.height;
      overlayCanvas.getContext("2d").putImageData(imageData, 0, 0);
      return overlayCanvas.toDataURL("image/png");
    }}

    function buildInputDataUrl() {{
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = canvas.width;
      exportCanvas.height = canvas.height;
      const exportCtx = exportCanvas.getContext("2d");
      exportCtx.fillStyle = "white";
      exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
      exportCtx.drawImage(canvas, 0, 0);
      return exportCanvas.toDataURL("image/png");
    }}

    async function runPrediction() {{
      if (predictInFlight || !canvasDirty) {{
        return;
      }}
      const bbox = getInkBounds();
      if (!bbox) {{
        status.textContent = "線が見つかりませんでした。";
        return;
      }}

      predictInFlight = true;
      status.textContent = "リアルタイム生成中...";
      try {{
        const response = await fetch("/api/predict", {{
          method: "POST",
          headers: {{ "Content-Type": "application/json" }},
          body: JSON.stringify({{
            image: buildInputDataUrl(),
            sketch_overlay: buildSketchOverlayDataUrl(),
            bbox,
            image_id: CONFIG.image_id,
            fruit_name: CONFIG.fruit_name,
            judge_mode: CONFIG.judge_mode,
            canvas_width: canvas.width,
            canvas_height: canvas.height,
          }}),
        }});
        const payload = await response.json();
        if (!response.ok) {{
          throw new Error(payload.error || "生成に失敗しました");
        }}
        stagePreview.src = payload.stage_image;
        stagePreview.hidden = false;
        structurePreview.src = payload.structure_preview_image || payload.composite_image || payload.stage_image;
        structurePreview.hidden = false;
        stageEmpty.hidden = true;
        structureEmpty.hidden = true;
        status.textContent = "リアルタイム更新中";
      }} catch (error) {{
        status.textContent = String(error);
      }}
      predictInFlight = false;
    }}

    function startRealtimeLoop() {{
      if (realtimeIntervalId) {{
        clearInterval(realtimeIntervalId);
      }}
      realtimeIntervalId = setInterval(() => {{
        if (!drawing || !canvasDirty) {{
          return;
        }}
        runPrediction();
      }}, Math.max(100, Math.round(Number(CONFIG.realtime_interval) * 1000)));
    }}

    function startDraw(event) {{
      drawing = true;
      const point = pointFromEvent(event);
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      canvasDirty = true;
      stageEmpty.hidden = true;
      event.preventDefault();
    }}

    function draw(event) {{
      if (!drawing) {{
        return;
      }}
      const point = pointFromEvent(event);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      canvasDirty = true;
      event.preventDefault();
    }}

    function endDraw() {{
      drawing = false;
      ctx.beginPath();
      if (canvasDirty) {{
        runPrediction();
      }}
    }}

    clearButton.addEventListener("click", () => {{
      canvasDirty = false;
      predictInFlight = false;
      setupCanvas();
      stagePreview.hidden = true;
      stagePreview.removeAttribute("src");
      structurePreview.hidden = true;
      structurePreview.removeAttribute("src");
      stageEmpty.hidden = false;
      structureEmpty.hidden = false;
      status.textContent = "待機中";
    }});

    canvas.addEventListener("pointerdown", startDraw);
    canvas.addEventListener("pointermove", draw);
    canvas.addEventListener("pointerup", endDraw);
    canvas.addEventListener("pointerleave", endDraw);
    canvas.addEventListener("pointercancel", endDraw);
    window.addEventListener("resize", updateLineWidth);

    setupCanvas();
    startRealtimeLoop();
  </script>
</body>
</html>
"""


class DrawApiHandler(BaseHTTPRequestHandler):
    def _send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, body: str) -> None:
        encoded = body.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(encoded)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/widget"):
            self._send_html(html_page(widget_config_from_query(parsed.query)))
            return
        if parsed.path == "/health":
            self._send_json({"ok": True})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        if self.path != "/api/predict":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            result = build_result(
                payload["image"],
                payload["sketch_overlay"],
                payload["bbox"],
                payload.get("image_id", AUTO_SELECT_ID),
                payload.get("fruit_name", DEFAULT_FRUIT),
                payload.get("judge_mode", JUDGE_MODE_COMPONENTS),
                int(payload.get("canvas_width", DEFAULT_PROCESSING_LONG_SIDE)),
                int(payload.get("canvas_height", DEFAULT_PROCESSING_LONG_SIDE)),
            )
            self._send_json(result)
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def log_message(self, format: str, *args) -> None:
        return


def open_browser() -> None:
    sample_url = (
        f"http://{HOST}:{PORT}/widget"
        f"?image_id={AUTO_SELECT_ID}"
        f"&fruit_name={DEFAULT_FRUIT}"
        f"&judge_mode={JUDGE_MODE_COMPONENTS}"
        f"&realtime_interval={DEFAULT_REALTIME_INTERVAL}"
        f"&frame_width={DEFAULT_FRAME_WIDTH}"
        f"&frame_height={DEFAULT_FRAME_HEIGHT}"
    )
    webbrowser.open(sample_url, new=1)


def main() -> None:
    os.environ.setdefault("TK_SILENCE_DEPRECATION", "1")
    server = ThreadingHTTPServer((HOST, PORT), DrawApiHandler)
    print(f"Open http://{HOST}:{PORT}/widget in your browser")
    if AUTO_OPEN_BROWSER:
        threading.Timer(0.8, open_browser).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
