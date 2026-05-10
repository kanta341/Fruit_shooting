import { BulletSource, FruitType, ShotBatch, ShotPayload } from '../interfaces/BulletSource'

type Point = { x: number; y: number }

type PredictResponse = {
    stage_image?: string
    composite_image?: string
    structure_preview_image?: string
    border_preview_image?: string
    cleaned_border_preview_image?: string
    image_id?: string
    bullet_assets?: Array<{
        image: string
        origin_x: number
        origin_y: number
        width: number
        height: number
        source_width?: number
        source_height?: number
        fruit_name?: FruitType
        image_id?: string
    }>
    components?: Array<{
        fruit_name?: FruitType
        image_id?: string
    }>
    profiling?: Record<string, number>
}

export class DrawingPad implements BulletSource {
    private static readonly FRUIT_NAME: FruitType = 'banana'
    private static readonly IMAGE_ID = 'AUTO'
    private static readonly JUDGE_MODE = 'components'
    private static readonly STROKE_WIDTH = 2
    private static readonly PROCESSING_LONG_SIDE = 280
    private static readonly REALTIME_INTERVAL_SECONDS = 0.1
    private static readonly WHITE_BG_THRESHOLD = 245

    private canvas: HTMLCanvasElement
    private ctx: CanvasRenderingContext2D
    private resultCanvas: HTMLCanvasElement
    private resultCtx: CanvasRenderingContext2D
    private isDrawing: boolean = false
    private currentPath: Point[] = []
    private onShootCallback: ((data?: ShotBatch) => void) | null = null
    private predictionTimer: number = 0
    private requestSequence: number = 0
    private latestAppliedSequence: number = 0
    private activeStrokeId: number = 0
    private latestShotForActiveStroke: ShotBatch | null = null
    private latestProfileLabel: string | null = null
    private processingWidth: number
    private processingHeight: number
    private scaleX: number
    private scaleY: number

    constructor(width: number, height: number) {
        const { processingWidth, processingHeight } = DrawingPad.computeProcessingSize(width, height)
        this.processingWidth = processingWidth
        this.processingHeight = processingHeight
        this.scaleX = this.processingWidth / width
        this.scaleY = this.processingHeight / height

        this.canvas = document.createElement('canvas')
        this.canvas.width = width
        this.canvas.height = height
        this.canvas.style.position = 'absolute'
        this.canvas.style.bottom = '0'
        this.canvas.style.left = '0'
        this.canvas.style.borderTop = '2px solid white'
        this.canvas.style.cursor = 'crosshair'
        this.canvas.style.backgroundColor = 'transparent'
        this.canvas.style.zIndex = '1'

        document.body.appendChild(this.canvas)

        this.resultCanvas = document.createElement('canvas')
        this.resultCanvas.width = width
        this.resultCanvas.height = height
        this.resultCanvas.style.position = 'absolute'
        this.resultCanvas.style.bottom = '0'
        this.resultCanvas.style.left = '0'
        this.resultCanvas.style.width = `${width}px`
        this.resultCanvas.style.height = `${height}px`
        this.resultCanvas.style.pointerEvents = 'none'
        this.resultCanvas.style.zIndex = '2'
        document.body.appendChild(this.resultCanvas)

        const ctx = this.canvas.getContext('2d')
        if (!ctx) throw new Error('Could not get drawing context')
        this.ctx = ctx

        const resultCtx = this.resultCanvas.getContext('2d')
        if (!resultCtx) throw new Error('Could not get result drawing context')
        this.resultCtx = resultCtx

        this.bindEvents()
    }

    private bindEvents() {
        this.canvas.addEventListener('mousedown', (e) => this.startDrawing(e))
        this.canvas.addEventListener('mousemove', (e) => this.draw(e))
        this.canvas.addEventListener('mouseup', () => this.stopDrawing())
        this.canvas.addEventListener('mouseleave', () => this.stopDrawing())
    }

    private getPos(e: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect()
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        }
    }

    private startDrawing(e: MouseEvent) {
        this.isDrawing = true
        this.activeStrokeId += 1
        this.currentPath = []
        this.latestAppliedSequence = 0
        this.latestShotForActiveStroke = null
        this.clearGeneratedResult()
        const pos = this.getPos(e)
        this.currentPath.push(pos)

        this.ctx.beginPath()
        this.ctx.moveTo(pos.x, pos.y)
        this.ctx.strokeStyle = 'white'
        this.ctx.lineWidth = DrawingPad.STROKE_WIDTH
    }

    private draw(e: MouseEvent) {
        if (!this.isDrawing) return
        const pos = this.getPos(e)
        this.currentPath.push(pos)

        this.ctx.lineTo(pos.x, pos.y)
        this.ctx.stroke()
    }

    private stopDrawing() {
        if (!this.isDrawing) return
        this.isDrawing = false
        this.predictionTimer = 0
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

        if (this.latestShotForActiveStroke && this.onShootCallback) {
            this.onShootCallback(this.latestShotForActiveStroke)
        }

        this.latestShotForActiveStroke = null
        this.latestAppliedSequence = 0
        this.activeStrokeId += 1
    }

    onShoot(callback: (data?: ShotBatch) => void): void {
        this.onShootCallback = callback
    }

    update(dt: number): void {
        if (!this.isDrawing || this.currentPath.length <= 5) {
            return
        }

        this.predictionTimer += dt
        if (this.predictionTimer < DrawingPad.REALTIME_INTERVAL_SECONDS) {
            return
        }

        this.predictionTimer = 0
        void this.generateFruitFromCurrentPath(false)
    }

    private clearGeneratedResult() {
        this.resultCtx.clearRect(0, 0, this.resultCanvas.width, this.resultCanvas.height)
    }

    private async generateFruitFromCurrentPath(clearSketch: boolean) {
        const requestStartedAt = performance.now()
        const path = [...this.currentPath]
        const strokeId = this.activeStrokeId
        if (clearSketch) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        }
        if (path.length <= 5) return

        const payloadStartedAt = performance.now()
        const payload = this.buildPredictPayload(path)
        const payloadFinishedAt = performance.now()
        const requestId = ++this.requestSequence

        try {
            const invokeStartedAt = performance.now()
            const result = await this.requestPrediction(payload)
            const invokeFinishedAt = performance.now()
            if (
                result.stage_image &&
                strokeId === this.activeStrokeId &&
                requestId >= this.latestAppliedSequence
            ) {
                this.latestAppliedSequence = requestId
                const renderStartedAt = performance.now()
                const shot = await this.renderStageImage(result)
                const renderFinishedAt = performance.now()
                if (strokeId !== this.activeStrokeId) {
                    return
                }
                if (shot) {
                    this.latestShotForActiveStroke = shot
                }
                this.logProfiling({
                    requestId,
                    clearSketch,
                    payloadBuildMs: payloadFinishedAt - payloadStartedAt,
                    electronInvokeMs: invokeFinishedAt - invokeStartedAt,
                    renderStageMs: renderFinishedAt - renderStartedAt,
                    rendererTotalMs: renderFinishedAt - requestStartedAt,
                    profiling: result.profiling,
                })
            }
        } catch (error) {
            console.error('Fruit prediction failed in Electron main process.', error)
        }
    }

    private async requestPrediction(payload: Record<string, unknown>): Promise<PredictResponse> {
        if (typeof window !== 'undefined' && typeof window.electron?.predictFruit === 'function') {
            return await window.electron.predictFruit(payload as never) as PredictResponse
        }

        const response = await fetch('/api/predict', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        })

        const result = await response.json() as PredictResponse & { error?: string }
        if (!response.ok || result.error) {
            throw new Error(result.error ?? `Predict API returned ${response.status}`)
        }
        return result
    }

    private buildPredictPayload(path: Point[]) {
        const scaledPath = path.map((point) => this.toProcessingPoint(point))
        const bbox = this.computeBoundingBox(scaledPath)
        const image = this.renderDataUrl(scaledPath, true)
        const sketchOverlay = this.renderDataUrl(scaledPath, false)

        return {
            image,
            sketch_overlay: sketchOverlay,
            bbox,
            image_id: DrawingPad.IMAGE_ID,
            fruit_name: DrawingPad.FRUIT_NAME,
            judge_mode: DrawingPad.JUDGE_MODE,
            canvas_width: this.processingWidth,
            canvas_height: this.processingHeight,
        }
    }

    private renderDataUrl(path: Point[], withWhiteBackground: boolean) {
        const canvas = document.createElement('canvas')
        canvas.width = this.processingWidth
        canvas.height = this.processingHeight

        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Could not get offscreen drawing context')

        if (withWhiteBackground) {
            ctx.fillStyle = '#fff'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height)
        }

        this.drawPath(ctx, path)
        return canvas.toDataURL('image/png')
    }

    private drawPath(ctx: CanvasRenderingContext2D, path: Point[]) {
        if (path.length === 0) return

        ctx.beginPath()
        ctx.moveTo(path[0].x, path[0].y)
        for (let i = 1; i < path.length; i++) {
            ctx.lineTo(path[i].x, path[i].y)
        }
        ctx.strokeStyle = '#000'
        ctx.lineWidth = Math.max(1, DrawingPad.STROKE_WIDTH * ((this.scaleX + this.scaleY) / 2))
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.stroke()
    }

    private computeBoundingBox(path: Point[]) {
        let left = Infinity
        let top = Infinity
        let right = -Infinity
        let bottom = -Infinity

        path.forEach((point) => {
            left = Math.min(left, point.x)
            top = Math.min(top, point.y)
            right = Math.max(right, point.x)
            bottom = Math.max(bottom, point.y)
        })

        const padding = DrawingPad.STROKE_WIDTH
        const boundedLeft = Math.max(0, Math.floor(left - padding))
        const boundedTop = Math.max(0, Math.floor(top - padding))
        const boundedRight = Math.min(this.processingWidth, Math.ceil(right + padding))
        const boundedBottom = Math.min(this.processingHeight, Math.ceil(bottom + padding))

        return {
            left: boundedLeft,
            top: boundedTop,
            right: boundedRight,
            bottom: boundedBottom,
            width: Math.max(1, boundedRight - boundedLeft),
            height: Math.max(1, boundedBottom - boundedTop),
        }
    }

    private async renderStageImage(result: PredictResponse) {
        if (!result.stage_image) {
            return null
        }

        const image = await this.loadImage(result.stage_image)
        this.resultCtx.clearRect(0, 0, this.resultCanvas.width, this.resultCanvas.height)
        this.resultCtx.drawImage(image, 0, 0, this.resultCanvas.width, this.resultCanvas.height)

        const imageData = this.resultCtx.getImageData(0, 0, this.resultCanvas.width, this.resultCanvas.height)
        this.transparentizeWhiteBackground(imageData)
        this.resultCtx.putImageData(imageData, 0, 0)
        return await this.buildShotPayloads(imageData, result)
    }

    private async buildShotPayloads(imageData: ImageData, result: PredictResponse): Promise<ShotBatch | null> {
        if (result.bullet_assets && result.bullet_assets.length > 0) {
            const assets = await Promise.all(result.bullet_assets.map((asset) => this.buildBulletAssetPayload(asset)))
            return assets.filter((asset): asset is ShotPayload => Boolean(asset))
        }
        return this.buildFallbackShotPayload(imageData, result)
    }

    private buildFallbackShotPayload(imageData: ImageData, result: PredictResponse): ShotBatch | null {
        const bounds = this.findVisibleBounds(imageData)
        if (!bounds) {
            return null
        }

        const sprite = document.createElement('canvas')
        sprite.width = bounds.width
        sprite.height = bounds.height

        const spriteCtx = sprite.getContext('2d')
        if (!spriteCtx) {
            throw new Error('Could not get sprite drawing context')
        }

        spriteCtx.putImageData(
            imageData,
            -bounds.left,
            -bounds.top,
            bounds.left,
            bounds.top,
            bounds.width,
            bounds.height,
        )

        const component = result.components?.[0]
        return [{
            sprite,
            originX: bounds.left,
            originY: bounds.top,
            width: bounds.width,
            height: bounds.height,
            fruitType: component?.fruit_name ?? DrawingPad.FRUIT_NAME,
            imageId: component?.image_id ?? result.image_id ?? DrawingPad.IMAGE_ID,
        }]
    }

    private async buildBulletAssetPayload(asset: NonNullable<PredictResponse['bullet_assets']>[number]): Promise<ShotPayload | null> {
        const image = await this.loadImage(asset.image)
        const logicalWidth = Math.max(1, Number(asset.width))
        const logicalHeight = Math.max(1, Number(asset.height))
        const rawWidth = Math.max(1, Math.round(asset.source_width ?? (image.naturalWidth || logicalWidth)))
        const rawHeight = Math.max(1, Math.round(asset.source_height ?? (image.naturalHeight || logicalHeight)))
        const assetScaleX = logicalWidth / rawWidth
        const assetScaleY = logicalHeight / rawHeight
        const rawCanvas = document.createElement('canvas')
        rawCanvas.width = rawWidth
        rawCanvas.height = rawHeight

        const rawCtx = rawCanvas.getContext('2d')
        if (!rawCtx) {
            throw new Error('Could not get bullet asset drawing context')
        }
        rawCtx.drawImage(image, 0, 0, rawWidth, rawHeight)

        const rawImageData = rawCtx.getImageData(0, 0, rawWidth, rawHeight)
        this.transparentizeWhiteBackground(rawImageData)
        const bounds = this.findVisibleBounds(rawImageData)
        if (!bounds) {
            return null
        }

        const sprite = document.createElement('canvas')
        sprite.width = bounds.width
        sprite.height = bounds.height
        const spriteCtx = sprite.getContext('2d')
        if (!spriteCtx) {
            throw new Error('Could not get bullet sprite context')
        }
        spriteCtx.putImageData(
            rawImageData,
            -bounds.left,
            -bounds.top,
            bounds.left,
            bounds.top,
            bounds.width,
            bounds.height,
        )

        return {
            sprite,
            originX: (asset.origin_x + bounds.left * assetScaleX) / this.scaleX,
            originY: (asset.origin_y + bounds.top * assetScaleY) / this.scaleY,
            width: (bounds.width * assetScaleX) / this.scaleX,
            height: (bounds.height * assetScaleY) / this.scaleY,
            fruitType: asset.fruit_name ?? DrawingPad.FRUIT_NAME,
            imageId: asset.image_id ?? DrawingPad.IMAGE_ID,
        }
    }

    private findVisibleBounds(imageData: ImageData) {
        const { data, width, height } = imageData
        let left = width
        let top = height
        let right = -1
        let bottom = -1

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const alpha = data[(y * width + x) * 4 + 3]
                if (alpha === 0) {
                    continue
                }
                left = Math.min(left, x)
                top = Math.min(top, y)
                right = Math.max(right, x)
                bottom = Math.max(bottom, y)
            }
        }

        if (right < left || bottom < top) {
            return null
        }

        return {
            left,
            top,
            width: right - left + 1,
            height: bottom - top + 1,
        }
    }

    private loadImage(src: string) {
        return new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image()
            image.onload = () => resolve(image)
            image.onerror = () => reject(new Error('Could not load generated stage image'))
            image.src = src
        })
    }

    private transparentizeWhiteBackground(imageData: ImageData) {
        const pixels = imageData.data
        for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i]
            const g = pixels[i + 1]
            const b = pixels[i + 2]
            if (r >= DrawingPad.WHITE_BG_THRESHOLD && g >= DrawingPad.WHITE_BG_THRESHOLD && b >= DrawingPad.WHITE_BG_THRESHOLD) {
                pixels[i + 3] = 0
            }
        }
    }

    private toProcessingPoint(point: Point): Point {
        return {
            x: point.x * this.scaleX,
            y: point.y * this.scaleY,
        }
    }

    private static computeProcessingSize(width: number, height: number) {
        const longSide = DrawingPad.PROCESSING_LONG_SIDE
        if (width >= height) {
            return {
                processingWidth: longSide,
                processingHeight: Math.max(1, Math.round((height / width) * longSide)),
            }
        }
        return {
            processingWidth: Math.max(1, Math.round((width / height) * longSide)),
            processingHeight: longSide,
        }
    }

    private logProfiling({
        requestId,
        clearSketch,
        payloadBuildMs,
        electronInvokeMs,
        renderStageMs,
        rendererTotalMs,
        profiling,
    }: {
        requestId: number
        clearSketch: boolean
        payloadBuildMs: number
        electronInvokeMs: number
        renderStageMs: number
        rendererTotalMs: number
        profiling?: Record<string, number>
    }) {
        const summary = {
            request_id: requestId,
            mode: clearSketch ? 'finalize' : 'realtime',
            renderer_payload_build_ms: Number(payloadBuildMs.toFixed(3)),
            renderer_invoke_ms: Number(electronInvokeMs.toFixed(3)),
            renderer_stage_render_ms: Number(renderStageMs.toFixed(3)),
            renderer_total_ms: Number(rendererTotalMs.toFixed(3)),
            ...(profiling ?? {}),
        }
        const label = `[fruit-profile] request=${requestId}`
        if (this.latestProfileLabel === label) {
            console.log(label, summary)
            return
        }
        this.latestProfileLabel = label
        console.groupCollapsed(label)
        Object.entries(summary).forEach(([key, value]) => {
            console.log(`${key}:`, value)
        })
        console.groupEnd()
    }
}
