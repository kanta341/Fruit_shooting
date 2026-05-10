const STORAGE_KEY = 'remote-control-origin'
const GENERATED_VARIANT_STORAGE_KEY = 'remote-draw-generated-variant'
const BANANA_POSTPROCESS_STORAGE_KEY = 'remote-draw-banana-postprocess'

type FruitType = 'banana' | 'apple' | 'grape'
type GeneratedVariant = 'banana_400' | 'apple_512' | 'grape_400'
type CropRect = { left: number; top: number; right: number; bottom: number; size?: number }
type FruitCounts = Record<FruitType, number>
type RankingEntry = {
    id: string
    playedAt: string
    counts: FruitCounts
    total: number
    name?: string
}
type GameResultsPayload = {
    status: 'playing' | 'ended'
    currentEntryId: string | null
    counts: FruitCounts | null
    rankings: RankingEntry[]
}

export class RemoteDrawClient {
    private static readonly FRAME_WIDTH = 800
    private static readonly FRAME_HEIGHT = 450
    private static readonly PROCESSING_WIDTH = 280
    private static readonly PROCESSING_HEIGHT = Math.max(
        1,
        Math.round((RemoteDrawClient.FRAME_HEIGHT / RemoteDrawClient.FRAME_WIDTH) * RemoteDrawClient.PROCESSING_WIDTH),
    )
    private static readonly GRAPH_WHITE_THRESHOLD = 245
    private static readonly GRAPH_MAX_HISTORY = 30

    private root: HTMLDivElement | null = null
    private canvas: HTMLCanvasElement | null = null
    private ctx: CanvasRenderingContext2D | null = null
    private preview: HTMLImageElement | null = null
    private statusPanel: HTMLDivElement | null = null
    private resultOverlay: HTMLDivElement | null = null
    private variantToggleButton: HTMLButtonElement | null = null
    private bananaPostprocessToggleButton: HTMLButtonElement | null = null
    private cropOverlay: HTMLDivElement | null = null
    private drawing = false
    private canvasDirty = false
    private predictInFlight = false
    private activePointerId: number | null = null
    private pendingCommitAfterPrediction = false
    private latestPredictionId: number | null = null
    private canvasRevision = 0
    private submittedCanvasRevision = 0
    private latestRequestSerial = 0
    private latestAppliedSerial = 0
    private activeStrokeSerial = 0
    private sessionId = this.getOrCreateSessionId()
    private serverOrigin = this.getStoredOrigin()
    private drawMode: 'generated' = 'generated'
    private generatedVariant = this.getStoredGeneratedVariant()
    private bananaPostprocessEnabled = this.getStoredBananaPostprocessEnabled()
    private realtimeIntervalMs = 50
    private lastRealtimePredictAt = 0
    private pixelCountHistory: Array<{ processing: number; ui: number }> = []
    private pendingPixelCountsPromise: Promise<{ processing: number; ui: number }> | null = null
    private graphCanvasProcessing: HTMLCanvasElement | null = null
    private graphCanvasUI: HTMLCanvasElement | null = null

    mount(container: HTMLElement) {
        container.innerHTML = ''
        if (!this.serverOrigin) {
            this.renderSetup(container)
            return
        }
        void this.syncRemoteConfig()
        this.renderDrawSurface(container)
    }

    private renderSetup(container: HTMLElement) {
        const wrapper = document.createElement('div')
        wrapper.style.position = 'fixed'
        wrapper.style.inset = '0'
        wrapper.style.display = 'grid'
        wrapper.style.placeItems = 'center'
        wrapper.style.background = '#f3ecdf'
        wrapper.style.fontFamily = '"Hiragino Sans", "Yu Gothic", sans-serif'

        const panel = document.createElement('div')
        panel.style.width = 'min(88vw, 420px)'
        panel.style.padding = '20px'
        panel.style.borderRadius = '20px'
        panel.style.background = '#fffaf3'
        panel.style.border = '1px solid #d8cab3'
        panel.style.boxShadow = '0 18px 44px rgba(70, 54, 35, 0.12)'

        const title = document.createElement('div')
        title.textContent = 'Connect To PC'
        title.style.fontSize = '24px'
        title.style.fontWeight = '800'
        title.style.marginBottom = '8px'

        const description = document.createElement('div')
        description.textContent = 'PC の control server URL を入力してください。例: http://10.100.138.194:8030'
        description.style.fontSize = '14px'
        description.style.lineHeight = '1.6'
        description.style.color = '#675b4b'
        description.style.marginBottom = '14px'

        const input = document.createElement('input')
        input.type = 'url'
        input.placeholder = 'http://<PC-IP>:8030'
        input.value = 'http://'
        input.style.width = '100%'
        input.style.padding = '14px 16px'
        input.style.borderRadius = '14px'
        input.style.border = '1px solid #cdbda3'
        input.style.font = 'inherit'
        input.style.fontSize = '16px'
        input.style.marginBottom = '12px'
        input.autocapitalize = 'off'
        input.autocorrect = false

        const button = document.createElement('button')
        button.textContent = 'Start'
        button.style.width = '100%'
        button.style.padding = '14px 18px'
        button.style.border = 'none'
        button.style.borderRadius = '999px'
        button.style.background = 'linear-gradient(180deg, #2b6a50, #204c3a)'
        button.style.color = '#fff'
        button.style.font = 'inherit'
        button.style.fontSize = '16px'
        button.style.fontWeight = '800'

        button.onclick = async () => {
            const normalized = input.value.trim().replace(/\/+$/, '')
            if (!normalized) {
                return
            }

            try {
                const response = await fetch(`${normalized}/api/status`)
                if (!response.ok) {
                    throw new Error(`Status ${response.status}`)
                }
                window.localStorage.setItem(STORAGE_KEY, normalized)
                this.serverOrigin = normalized
                await this.syncRemoteConfig()
                this.mount(container)
            } catch (error) {
                alert(`PC に接続できません: ${String(error)}`)
            }
        }

        panel.appendChild(title)
        panel.appendChild(description)
        panel.appendChild(input)
        panel.appendChild(button)
        wrapper.appendChild(panel)
        container.appendChild(wrapper)
    }

    private renderDrawSurface(container: HTMLElement) {
        document.documentElement.style.margin = '0'
        document.documentElement.style.width = '100%'
        document.documentElement.style.height = '100%'
        document.body.style.margin = '0'
        document.body.style.width = '100%'
        document.body.style.height = '100%'
        document.body.style.overflow = 'hidden'
        document.body.style.background = '#fff'

        const root = document.createElement('div')
        root.style.position = 'fixed'
        root.style.inset = '0'
        root.style.background = '#fff'
        root.style.overflow = 'hidden'
        root.style.touchAction = 'none'

        const preview = document.createElement('img')
        preview.hidden = true
        preview.style.position = 'absolute'
        preview.style.inset = '0'
        preview.style.width = '100%'
        preview.style.height = '100%'
        preview.style.objectFit = 'fill'
        preview.style.pointerEvents = 'none'

        const canvas = document.createElement('canvas')
        canvas.width = RemoteDrawClient.PROCESSING_WIDTH
        canvas.height = RemoteDrawClient.PROCESSING_HEIGHT
        canvas.style.position = 'absolute'
        canvas.style.inset = '0'
        canvas.style.width = '100%'
        canvas.style.height = '100%'
        canvas.style.touchAction = 'none'

        root.appendChild(preview)
        root.appendChild(canvas)
        root.appendChild(this.createCropOverlay())
        root.appendChild(this.createStatusPanel())
        root.appendChild(this.createVariantToggleButton())
        root.appendChild(this.createBananaPostprocessToggleButton())
        root.appendChild(this.createResultOverlay())
        root.appendChild(this.createPixelCountGraphPanel())
        container.appendChild(root)

        this.root = root
        this.preview = preview
        this.canvas = canvas
        const ctx = canvas.getContext('2d')
        if (!ctx) {
            throw new Error('Could not get draw context')
        }
        this.ctx = ctx

        this.resetCanvasVisuals()
        this.clearPreview()

        canvas.addEventListener('pointerdown', this.startDraw)
        canvas.addEventListener('pointermove', this.draw)
        canvas.addEventListener('pointerup', this.endDraw)
        canvas.addEventListener('pointercancel', this.endDraw)
        canvas.addEventListener('pointerleave', (event) => {
            if (!this.drawing) return
            if (event.buttons === 0) {
                this.endDraw(event)
            }
        })

        window.addEventListener('resize', this.updateLineWidth)
        document.body.addEventListener('dblclick', (event) => {
            event.preventDefault()
            void this.clearRemoteSession()
        })

        window.setInterval(() => {
            const now = Date.now()
            if (
                this.drawing &&
                this.canvasDirty &&
                !this.predictInFlight &&
                now - this.lastRealtimePredictAt >= this.realtimeIntervalMs
            ) {
                this.lastRealtimePredictAt = now
                void this.runPrediction(false)
            }
        }, 50)
        window.setInterval(() => {
            void this.syncRemoteConfig()
        }, 1500)
        window.setInterval(() => {
            void this.syncGameResults()
        }, 1000)
        void this.syncGameResults()
    }

    private startDraw = (event: PointerEvent) => {
        if (this.drawing || !this.ctx || !this.canvas) return
        this.drawing = true
        this.activeStrokeSerial += 1
        this.activePointerId = event.pointerId
        this.pendingCommitAfterPrediction = false
        this.latestPredictionId = null
        this.canvasRevision = 0
        this.submittedCanvasRevision = 0
        this.latestRequestSerial = 0
        this.latestAppliedSerial = 0
        this.canvasDirty = false
        this.resetCanvasVisuals()
        this.clearPreview()

        const point = this.pointFromEvent(event)
        this.ctx.beginPath()
        this.ctx.moveTo(point.x, point.y)
        this.ctx.lineTo(point.x, point.y)
        this.ctx.stroke()
        this.canvasDirty = true
        this.canvasRevision += 1
        this.updateGeneratedModeCropGuide({
            left: point.x,
            top: point.y,
            right: point.x + 1,
            bottom: point.y + 1,
            width: 1,
            height: 1,
        })
        this.canvas.setPointerCapture?.(event.pointerId)
        event.preventDefault()
    }

    private draw = (event: PointerEvent) => {
        if (!this.drawing || this.activePointerId !== event.pointerId || !this.ctx) return
        const point = this.pointFromEvent(event)
        this.ctx.lineTo(point.x, point.y)
        this.ctx.stroke()
        this.canvasDirty = true
        this.canvasRevision += 1
        this.updateGeneratedModeCropGuide()
        event.preventDefault()
    }

    private endDraw = (event: PointerEvent) => {
        if (!this.drawing || (event && this.activePointerId !== event.pointerId) || !this.ctx) return
        this.drawing = false
        this.activePointerId = null
        this.ctx.beginPath()
        if (this.canvasDirty) {
            if (this.predictInFlight) {
                this.pendingCommitAfterPrediction = true
            } else {
                void this.runPrediction(true)
            }
        }
    }

    private async runPrediction(commitAfter: boolean) {
        if (!this.serverOrigin || !this.ctx || !this.canvas) {
            return
        }
        if (this.predictInFlight || !this.canvasDirty) {
            if (commitAfter) this.pendingCommitAfterPrediction = true
            return
        }
        if (this.canvasRevision === this.submittedCanvasRevision) {
            if (commitAfter && this.latestPredictionId != null && !this.drawing) {
                this.pendingCommitAfterPrediction = false
                await this.commitLatestPrediction()
            }
            return
        }

        const bbox = this.getInkBounds()
        if (!bbox) return
        this.updateGeneratedModeCropGuide(bbox)
        const requestSerial = ++this.latestRequestSerial
        const requestRevision = this.canvasRevision
        this.submittedCanvasRevision = requestRevision
        const strokeSerial = this.activeStrokeSerial
        this.predictInFlight = true
        try {
            const response = await fetch(`${this.serverOrigin}/api/remote-draw/predict`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session_id: this.sessionId,
                    image: this.buildInputDataUrl(),
                    sketch_overlay: this.buildSketchOverlayDataUrl(),
                    bbox,
                    image_id: 'AUTO',
                    fruit_name: 'banana',
                    judge_mode: 'components',
                    predict_mode: this.drawMode,
                    generated_variant: this.generatedVariant,
                    banana_postprocess: this.bananaPostprocessEnabled,
                    canvas_width: this.canvas.width,
                    canvas_height: this.canvas.height,
                    frame_width: RemoteDrawClient.FRAME_WIDTH,
                    frame_height: RemoteDrawClient.FRAME_HEIGHT,
                }),
            })
            const payload = await response.json() as {
                stage_image?: string
                prediction_id?: number
                error?: string
                generated_crop?: CropRect
                border_preview_image?: string
                cleaned_border_preview_image?: string
            }
            if (!response.ok) throw new Error(payload.error ?? 'Prediction failed')
            if (strokeSerial !== this.activeStrokeSerial) return
            if (requestSerial >= this.latestAppliedSerial) {
                this.latestAppliedSerial = requestSerial
                this.latestPredictionId = payload.prediction_id ?? null
                this.updateCropOverlay(payload.generated_crop ?? this.computeGeneratedCropRect(bbox))
                if (payload.stage_image && this.preview) {
                    this.preview.src = payload.stage_image
                    this.preview.hidden = false
                    this.pendingPixelCountsPromise = this.measurePixelCounts(payload.stage_image)
                }
            }
            if (
                requestRevision === this.canvasRevision &&
                (commitAfter || this.pendingCommitAfterPrediction) &&
                !this.drawing
            ) {
                this.pendingCommitAfterPrediction = false
                await this.commitLatestPrediction()
            }
        } catch (error) {
            this.showConnectionError('predict failed', error)
            console.error('[remote-draw-client] predict failed', {
                serverOrigin: this.serverOrigin,
                error: this.formatError(error),
            })
        } finally {
            this.predictInFlight = false
            if (this.canvasDirty && this.canvasRevision > this.submittedCanvasRevision) {
                const shouldCommitAfterLatest = this.pendingCommitAfterPrediction && !this.drawing
                void this.runPrediction(shouldCommitAfterLatest)
            }
        }
    }

    private async syncRemoteConfig() {
        if (!this.serverOrigin) return
        try {
            const response = await fetch(`${this.serverOrigin}/api/remote-draw/config`)
            if (!response.ok) return
            const payload = await response.json() as { realtime_interval_ms?: number }
            if (typeof payload.realtime_interval_ms === 'number' && Number.isFinite(payload.realtime_interval_ms)) {
                this.realtimeIntervalMs = payload.realtime_interval_ms
            }
            this.hideConnectionError()
        } catch (error) {
            this.showConnectionError('config sync failed', error)
            console.warn('[remote-draw-client] config sync failed', {
                serverOrigin: this.serverOrigin,
                error: this.formatError(error),
            })
        }
    }

    private async commitLatestPrediction() {
        if (!this.serverOrigin || !this.latestPredictionId) return
        const response = await fetch(`${this.serverOrigin}/api/remote-draw/commit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: this.sessionId,
                prediction_id: this.latestPredictionId,
            }),
        })
        const payload = await response.json() as { error?: string }
        if (!response.ok) {
            throw new Error(payload.error ?? 'Commit failed')
        }
        this.hideConnectionError()

        if (this.pendingPixelCountsPromise) {
            const counts = await this.pendingPixelCountsPromise
            this.pendingPixelCountsPromise = null
            this.pixelCountHistory.push(counts)
            if (this.pixelCountHistory.length > RemoteDrawClient.GRAPH_MAX_HISTORY) {
                this.pixelCountHistory.shift()
            }
            this.updateGraphs()
        }
    }

    private async clearRemoteSession() {
        if (!this.serverOrigin) return
        this.drawing = false
        this.activeStrokeSerial += 1
        this.canvasDirty = false
        this.predictInFlight = false
        this.pendingCommitAfterPrediction = false
        this.latestPredictionId = null
        this.pendingPixelCountsPromise = null
        this.canvasRevision = 0
        this.submittedCanvasRevision = 0
        this.resetCanvasVisuals()
        this.clearPreview()
        this.updateCropOverlay(null)
        await fetch(`${this.serverOrigin}/api/remote-draw/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: this.sessionId }),
        })
    }

    private createStatusPanel() {
        const panel = document.createElement('div')
        panel.hidden = true
        panel.style.position = 'absolute'
        panel.style.left = '12px'
        panel.style.bottom = '12px'
        panel.style.maxWidth = 'min(720px, calc(100vw - 24px))'
        panel.style.padding = '12px 14px'
        panel.style.borderRadius = '14px'
        panel.style.background = 'rgba(26, 20, 15, 0.86)'
        panel.style.color = '#fff'
        panel.style.fontFamily = '"Hiragino Sans", "Yu Gothic", sans-serif'
        panel.style.fontSize = '13px'
        panel.style.lineHeight = '1.45'
        panel.style.zIndex = '10'
        panel.style.pointerEvents = 'auto'

        this.statusPanel = panel
        return panel
    }

    private createCropOverlay() {
        const overlay = document.createElement('div')
        overlay.hidden = true
        overlay.style.position = 'absolute'
        overlay.style.border = '2px dashed rgba(34, 148, 99, 0.95)'
        overlay.style.borderRadius = '10px'
        overlay.style.boxShadow = '0 0 0 1px rgba(255, 255, 255, 0.55) inset'
        overlay.style.pointerEvents = 'none'
        overlay.style.zIndex = '11'
        this.cropOverlay = overlay
        return overlay
    }

    private createVariantToggleButton() {
        const button = document.createElement('button')
        button.style.position = 'absolute'
        button.style.right = '16px'
        button.style.bottom = '16px'
        button.style.zIndex = '12'
        button.style.border = '0'
        button.style.borderRadius = '999px'
        button.style.padding = '12px 18px'
        button.style.background = 'rgba(35, 31, 26, 0.86)'
        button.style.color = '#fff8d7'
        button.style.fontFamily = '"Hiragino Sans", "Yu Gothic", sans-serif'
        button.style.fontSize = '14px'
        button.style.fontWeight = '800'
        button.style.letterSpacing = '0.02em'
        button.style.boxShadow = '0 12px 28px rgba(0, 0, 0, 0.16)'
        button.style.pointerEvents = 'auto'
        button.addEventListener('click', () => {
            void this.toggleGeneratedVariant()
        })
        this.variantToggleButton = button
        this.updateVariantToggleButton()
        return button
    }

    private createBananaPostprocessToggleButton() {
        const button = document.createElement('button')
        button.style.position = 'absolute'
        button.style.right = '16px'
        button.style.bottom = '68px'
        button.style.zIndex = '12'
        button.style.border = '0'
        button.style.borderRadius = '999px'
        button.style.padding = '12px 18px'
        button.style.background = 'rgba(35, 31, 26, 0.86)'
        button.style.color = '#fff8d7'
        button.style.fontFamily = '"Hiragino Sans", "Yu Gothic", sans-serif'
        button.style.fontSize = '14px'
        button.style.fontWeight = '800'
        button.style.letterSpacing = '0.02em'
        button.style.boxShadow = '0 12px 28px rgba(0, 0, 0, 0.16)'
        button.style.pointerEvents = 'auto'
        button.addEventListener('click', () => {
            void this.toggleBananaPostprocess()
        })
        this.bananaPostprocessToggleButton = button
        this.updateBananaPostprocessToggleButton()
        return button
    }

    private updateVariantToggleButton() {
        if (!this.variantToggleButton) return
        this.variantToggleButton.textContent = `生成モデル: ${this.getGeneratedVariantLabel()}`
    }

    private updateBananaPostprocessToggleButton() {
        if (!this.bananaPostprocessToggleButton) return
        const visible = this.generatedVariant === 'banana_400'
        this.bananaPostprocessToggleButton.hidden = !visible
        this.bananaPostprocessToggleButton.textContent = this.bananaPostprocessEnabled
            ? 'バナナ補正: ON'
            : 'バナナ補正: OFF'
    }

    private async toggleGeneratedVariant() {
        const variants: GeneratedVariant[] = ['banana_400', 'apple_512', 'grape_400']
        const currentIndex = variants.indexOf(this.generatedVariant)
        this.generatedVariant = variants[(currentIndex + 1) % variants.length] ?? 'banana_400'
        window.localStorage.setItem(GENERATED_VARIANT_STORAGE_KEY, this.generatedVariant)
        this.updateVariantToggleButton()
        this.updateBananaPostprocessToggleButton()
        await this.clearRemoteSession()
    }

    private async toggleBananaPostprocess() {
        this.bananaPostprocessEnabled = !this.bananaPostprocessEnabled
        window.localStorage.setItem(BANANA_POSTPROCESS_STORAGE_KEY, this.bananaPostprocessEnabled ? '1' : '0')
        this.updateBananaPostprocessToggleButton()
        await this.clearRemoteSession()
    }

    private getGeneratedVariantLabel() {
        switch (this.generatedVariant) {
            case 'banana_400':
                return 'バナナ400'
            case 'apple_512':
                return 'りんご512'
            case 'grape_400':
                return 'ブドウ400'
            default:
                return 'バナナ400'
        }
    }

    private showConnectionError(label: string, error: unknown) {
        if (!this.statusPanel) return
        const message = this.formatError(error)
        this.statusPanel.hidden = false
        this.statusPanel.innerHTML = ''

        const text = document.createElement('div')
        text.textContent = `${label}: ${message} / URL: ${this.serverOrigin}`
        text.style.marginBottom = '8px'

        const button = document.createElement('button')
        button.textContent = '接続先URLを変更'
        button.style.border = '0'
        button.style.borderRadius = '999px'
        button.style.padding = '8px 12px'
        button.style.background = '#fff'
        button.style.color = '#2a221a'
        button.style.font = 'inherit'
        button.style.fontWeight = '800'
        button.onclick = () => {
            window.localStorage.removeItem(STORAGE_KEY)
            window.location.reload()
        }

        this.statusPanel.appendChild(text)
        this.statusPanel.appendChild(button)
    }

    private hideConnectionError() {
        if (!this.statusPanel) return
        this.statusPanel.hidden = true
        this.statusPanel.innerHTML = ''
    }

    private updateGeneratedModeCropGuide(bbox?: ReturnType<RemoteDrawClient['getInkBounds']>) {
        const resolvedBbox = bbox ?? this.getInkBounds()
        this.updateCropOverlay(resolvedBbox ? this.computeGeneratedCropRect(resolvedBbox) : null)
    }

    private computeGeneratedCropRect(bbox: NonNullable<ReturnType<RemoteDrawClient['getInkBounds']>>): CropRect {
        if (!this.canvas) {
            return bbox
        }
        const width = Math.max(1, Math.round(bbox.width))
        const height = Math.max(1, Math.round(bbox.height))
        const centerX = (bbox.left + bbox.right) / 2
        const centerY = (bbox.top + bbox.bottom) / 2
        const padding = Math.max(4, Math.round(Math.max(width, height) * 0.08))
        let size = (Math.max(width, height) + padding * 2) * 2
        size = Math.max(8, Math.min(size, Math.max(this.canvas.width, this.canvas.height)))
        let left = Math.round(centerX - size / 2)
        let top = Math.round(centerY - size / 2)
        return {
            left,
            top,
            right: left + size,
            bottom: top + size,
            size,
        }
    }

    private updateCropOverlay(crop: CropRect | null) {
        if (!this.cropOverlay || !this.canvas) return
        if (!crop) {
            this.cropOverlay.hidden = true
            return
        }
        const rect = this.canvas.getBoundingClientRect()
        const scaleX = rect.width / this.canvas.width
        const scaleY = rect.height / this.canvas.height
        this.cropOverlay.hidden = false
        this.cropOverlay.style.left = `${crop.left * scaleX}px`
        this.cropOverlay.style.top = `${crop.top * scaleY}px`
        this.cropOverlay.style.width = `${Math.max(1, (crop.right - crop.left) * scaleX)}px`
        this.cropOverlay.style.height = `${Math.max(1, (crop.bottom - crop.top) * scaleY)}px`
    }

    private createPixelCountGraphPanel(): HTMLDivElement {
        const panel = document.createElement('div')
        panel.style.position = 'absolute'
        panel.style.top = '12px'
        panel.style.right = '12px'
        panel.style.width = '172px'
        panel.style.zIndex = '8'
        panel.style.pointerEvents = 'none'
        panel.style.display = 'flex'
        panel.style.flexDirection = 'column'
        panel.style.gap = '6px'

        const makeSection = (label: string, isProcessing: boolean) => {
            const sec = document.createElement('div')
            sec.style.background = 'rgba(12, 9, 5, 0.80)'
            sec.style.borderRadius = '8px'
            sec.style.padding = '5px 7px 4px'
            sec.style.border = '1px solid rgba(255,255,255,0.09)'

            const hdr = document.createElement('div')
            hdr.style.color = isProcessing ? '#7ec8ff' : '#ffb86c'
            hdr.style.fontSize = '10px'
            hdr.style.fontFamily = 'monospace'
            hdr.style.fontWeight = '700'
            hdr.style.marginBottom = '3px'
            hdr.textContent = label

            const graphCanvas = document.createElement('canvas')
            graphCanvas.width = 158
            graphCanvas.height = 68
            graphCanvas.style.width = '100%'
            graphCanvas.style.display = 'block'
            graphCanvas.style.borderRadius = '3px'

            sec.appendChild(hdr)
            sec.appendChild(graphCanvas)

            if (isProcessing) {
                this.graphCanvasProcessing = graphCanvas
            } else {
                this.graphCanvasUI = graphCanvas
            }
            return sec
        }

        panel.appendChild(makeSection(
            `処理空間 ${RemoteDrawClient.PROCESSING_WIDTH}×${RemoteDrawClient.PROCESSING_HEIGHT}px`,
            true,
        ))
        panel.appendChild(makeSection('UI表示空間 (画面サイズ)', false))

        this.updateGraphs()
        return panel
    }

    private measurePixelCounts(stageSrc: string): Promise<{ processing: number; ui: number }> {
        return new Promise((resolve) => {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
                try {
                    const processing = this.countNonWhitePixels(
                        img,
                        RemoteDrawClient.PROCESSING_WIDTH,
                        RemoteDrawClient.PROCESSING_HEIGHT,
                    )
                    const ui = this.countNonWhitePixels(img, window.innerWidth, window.innerHeight)
                    resolve({ processing, ui })
                } catch {
                    resolve({ processing: 0, ui: 0 })
                }
            }
            img.onerror = () => resolve({ processing: 0, ui: 0 })
            img.src = stageSrc
        })
    }

    private countNonWhitePixels(img: HTMLImageElement, width: number, height: number): number {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) return 0
        ctx.drawImage(img, 0, 0, width, height)
        const data = ctx.getImageData(0, 0, width, height).data
        const threshold = RemoteDrawClient.GRAPH_WHITE_THRESHOLD
        let count = 0
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] < threshold || data[i + 1] < threshold || data[i + 2] < threshold) {
                count++
            }
        }
        return count
    }

    private updateGraphs() {
        const procValues = this.pixelCountHistory.map((h) => h.processing)
        const uiValues = this.pixelCountHistory.map((h) => h.ui)
        const procTotal = RemoteDrawClient.PROCESSING_WIDTH * RemoteDrawClient.PROCESSING_HEIGHT
        const uiTotal = window.innerWidth * window.innerHeight
        this.drawSingleGraph(this.graphCanvasProcessing, procValues, '#7ec8ff', 'rgba(126,200,255,0.14)', procTotal)
        this.drawSingleGraph(this.graphCanvasUI, uiValues, '#ffb86c', 'rgba(255,184,108,0.14)', uiTotal)
    }

    private drawSingleGraph(
        graphCanvas: HTMLCanvasElement | null,
        values: number[],
        lineColor: string,
        fillColor: string,
        totalPixels: number,
    ) {
        if (!graphCanvas) return
        const ctx = graphCanvas.getContext('2d')
        if (!ctx) return

        const w = graphCanvas.width
        const h = graphCanvas.height
        ctx.clearRect(0, 0, w, h)

        const padL = 3
        const padR = 3
        const padT = 3
        const padB = 15
        const cw = w - padL - padR
        const ch = h - padT - padB

        ctx.fillStyle = 'rgba(0,0,0,0.22)'
        ctx.beginPath()
        ctx.roundRect(0, 0, w, h, 3)
        ctx.fill()

        if (values.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.22)'
            ctx.font = '9px monospace'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText('no data', w / 2, (h - padB) / 2 + padT)
            return
        }

        const maxVal = Math.max(...values, 1)

        const getX = (i: number) =>
            padL + (values.length === 1 ? cw / 2 : (i / (values.length - 1)) * cw)
        const getY = (v: number) => padT + ch * (1 - v / maxVal)

        // Midline grid
        ctx.strokeStyle = 'rgba(255,255,255,0.07)'
        ctx.lineWidth = 0.5
        ctx.beginPath()
        ctx.moveTo(padL, padT + ch / 2)
        ctx.lineTo(padL + cw, padT + ch / 2)
        ctx.stroke()

        // Fill under line
        if (values.length > 1) {
            ctx.beginPath()
            values.forEach((v, i) => {
                const x = getX(i)
                const y = getY(v)
                if (i === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
            })
            ctx.lineTo(getX(values.length - 1), padT + ch)
            ctx.lineTo(padL, padT + ch)
            ctx.closePath()
            ctx.fillStyle = fillColor
            ctx.fill()
        }

        // Line
        ctx.strokeStyle = lineColor
        ctx.lineWidth = 1.5
        ctx.lineJoin = 'round'
        ctx.beginPath()
        values.forEach((v, i) => {
            const x = getX(i)
            const y = getY(v)
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
        })
        ctx.stroke()

        // Dots (latest larger)
        ctx.fillStyle = lineColor
        values.forEach((v, i) => {
            const isLatest = i === values.length - 1
            ctx.beginPath()
            ctx.arc(getX(i), getY(v), isLatest ? 2.5 : 1.5, 0, Math.PI * 2)
            ctx.fill()
        })

        // Bottom labels: pixel count (left) and percentage (right)
        const latest = values[values.length - 1]
        const pct = totalPixels > 0 ? ((latest / totalPixels) * 100).toFixed(1) : '?'
        ctx.font = 'bold 9px monospace'
        ctx.textBaseline = 'bottom'
        ctx.fillStyle = lineColor
        ctx.textAlign = 'left'
        ctx.fillText(latest.toLocaleString(), padL, h - 1)
        ctx.fillStyle = 'rgba(255,255,255,0.45)'
        ctx.textAlign = 'right'
        ctx.fillText(`${pct}%`, w - padR, h - 1)
    }

    private createResultOverlay() {
        const overlay = document.createElement('div')
        overlay.style.position = 'absolute'
        overlay.style.inset = '0'
        overlay.style.zIndex = '20'
        overlay.style.display = 'none'
        overlay.style.background = 'rgba(27, 18, 11, 0.92)'
        overlay.style.color = '#fff8d7'
        overlay.style.fontFamily = '"Hiragino Sans", "Yu Gothic", sans-serif'
        overlay.style.overflowX = 'auto'
        overlay.style.overflowY = 'hidden'
        overlay.style.scrollSnapType = 'x mandatory'
        overlay.style.touchAction = 'pan-x'
        this.resultOverlay = overlay
        return overlay
    }

    private async syncGameResults() {
        if (!this.serverOrigin) return
        try {
            const payload = await this.fetchGameResults()
            if (payload.status !== 'ended' || !payload.counts) {
                this.hideResultOverlay()
                return
            }
            this.renderResultOverlay(payload)
        } catch (error) {
            console.warn('[remote-draw-client] game results sync failed', {
                serverOrigin: this.serverOrigin,
                error: this.formatError(error),
            })
        }
    }

    private async fetchGameResults(): Promise<GameResultsPayload> {
        try {
            const response = await fetch(`${this.serverOrigin}/api/game-results?t=${Date.now()}`, {
                cache: 'no-store',
            })
            if (response.ok) {
                return await response.json() as GameResultsPayload
            }
            console.warn('[remote-draw-client] game-results returned non-ok status', response.status)
        } catch (error) {
            console.warn('[remote-draw-client] game-results endpoint failed; falling back to status', {
                serverOrigin: this.serverOrigin,
                error: this.formatError(error),
            })
        }

        const statusResponse = await fetch(`${this.serverOrigin}/api/status?t=${Date.now()}`, {
            cache: 'no-store',
        })
        if (!statusResponse.ok) {
            throw new Error(`status fallback failed: ${statusResponse.status}`)
        }
        const statusPayload = await statusResponse.json() as {
            gameResult?: {
                status?: 'playing' | 'ended'
                currentEntryId?: string | null
                counts?: FruitCounts | null
                rankings?: RankingEntry[]
            }
        }
        const gameResult = statusPayload.gameResult
        return {
            status: gameResult?.status ?? 'playing',
            currentEntryId: gameResult?.currentEntryId ?? null,
            counts: gameResult?.counts ?? null,
            rankings: gameResult?.rankings ?? [],
        }
    }

    private hideResultOverlay() {
        if (!this.resultOverlay) return
        this.resultOverlay.style.display = 'none'
        this.resultOverlay.innerHTML = ''
    }

    private renderResultOverlay(payload: GameResultsPayload) {
        if (!this.resultOverlay || !payload.counts) return
        if (
            document.activeElement instanceof HTMLInputElement
            && document.activeElement.dataset.resultNameInput === 'true'
        ) {
            return
        }
        this.resultOverlay.style.display = 'flex'
        this.resultOverlay.innerHTML = ''
        this.resultOverlay.appendChild(this.createResultPage(payload.counts))
        this.resultOverlay.appendChild(this.createTotalRankingPage(payload))
        this.resultOverlay.appendChild(this.createFruitRankingPage(payload.rankings, payload.currentEntryId, payload.counts))
    }

    private createResultPage(counts: FruitCounts) {
        const page = this.createSlidePage('結果発表')
        page.style.padding = 'min(10vh, 86px) min(8vw, 86px)'
        const total = counts.apple + counts.banana + counts.grape
        const rows = [
            ['apple', counts.apple],
            ['grape', counts.grape],
            ['banana', counts.banana],
        ] as const

        const rowsContainer = document.createElement('div')
        rowsContainer.style.position = 'relative'
        rowsContainer.style.width = 'min(760px, 88vw)'
        rowsContainer.style.height = 'clamp(560px, 68vh, 740px)'
        rowsContainer.style.margin = '-4px 0 10px'

        rows.forEach(([fruitType, count], index) => {
            const row = document.createElement('div')
            row.style.position = 'absolute'
            row.style.left = '50%'
            row.style.top = `${8 + index * 42}%`
            row.style.transform = 'translate(-50%, -50%)'
            row.style.width = '100%'
            row.style.display = 'flex'
            row.style.alignItems = 'center'
            row.style.justifyContent = 'center'
            row.style.gap = 'clamp(20px, 4vw, 42px)'
            const icon = this.createFruitIcon(fruitType, 'clamp(142px, 24vw, 248px)')
            const countNode = document.createElement('div')
            countNode.textContent = `×${count}`
            countNode.style.fontSize = 'clamp(42px, 8vw, 82px)'
            countNode.style.fontWeight = '900'
            countNode.style.lineHeight = '1'
            row.appendChild(icon)
            row.appendChild(countNode)
            row.style.fontWeight = '900'
            rowsContainer.appendChild(row)
        })
        page.appendChild(rowsContainer)

        const totalNode = document.createElement('div')
        totalNode.textContent = `合計　×${total}`
        totalNode.style.fontSize = 'clamp(54px, 11vw, 104px)'
        totalNode.style.fontWeight = '900'
        totalNode.style.color = '#fff27a'
        totalNode.style.marginTop = '18px'
        page.appendChild(totalNode)
        page.appendChild(this.createSwipeHint())
        return page
    }

    private createTotalRankingPage(payload: GameResultsPayload) {
        const page = this.createSlidePage('合計ランキング')
        const title = page.firstElementChild as HTMLElement | null
        if (title) {
            title.style.fontSize = 'clamp(42px, 8vw, 82px)'
        }
        const rankings = this.getTopRankings(payload.rankings, 'total', 3)
        if (rankings.length === 0) {
            page.appendChild(this.createRankingRow('まだ記録がありません', false))
        } else {
            rankings.forEach((entry, index) => {
                page.appendChild(this.createRankingRow(`${index + 1}位　${this.getRankingDisplayName(entry, entry.id === payload.currentEntryId)}　${entry.total}個`, entry.id === payload.currentEntryId))
            })
        }

        const currentRank = this.getCurrentRank(payload.rankings, 'total', payload.currentEntryId)
        const current = document.createElement('div')
        const total = payload.counts ? payload.counts.apple + payload.counts.banana + payload.counts.grape : 0
        current.textContent = currentRank ? `あなた　${currentRank}位　${total}個` : `あなた　${total}個`
        current.style.width = 'min(780px, 88vw)'
        current.style.boxSizing = 'border-box'
        current.style.marginTop = '50px'
        current.style.padding = '14px 24px'
        current.style.borderRadius = '28px'
        current.style.fontSize = 'clamp(34px, 6.8vw, 64px)'
        current.style.fontWeight = '900'
        current.style.background = 'rgba(255, 230, 107, 0.28)'
        current.style.color = '#fff27a'
        page.appendChild(current)
        if (currentRank && currentRank <= 3 && payload.currentEntryId) {
            page.appendChild(this.createNameEntryForm(payload.currentEntryId))
        }
        page.appendChild(this.createSwipeHint())
        return page
    }

    private createFruitRankingPage(rankings: RankingEntry[], currentEntryId: string | null, counts?: FruitCounts) {
        const page = this.createSlidePage('フルーツ別ランキング')
        const title = page.firstElementChild as HTMLElement | null
        if (title) {
            title.style.fontSize = 'clamp(28px, 5.2vw, 54px)'
            title.style.marginBottom = '14px'
            title.style.whiteSpace = 'nowrap'
        }
        const columns = document.createElement('div')
        columns.style.display = 'flex'
        columns.style.alignItems = 'stretch'
        columns.style.justifyContent = 'center'
        columns.style.gap = 'clamp(6px, 1.4vw, 18px)'
        columns.style.width = 'min(1040px, 94vw)'
        ;([
            'apple',
            'banana',
            'grape',
        ] as const).forEach((metric) => {
            const section = document.createElement('section')
            section.style.flex = '1'
            section.style.minWidth = '0'
            section.style.display = 'flex'
            section.style.flexDirection = 'column'
            section.style.alignItems = 'center'
            section.style.gap = '8px'

            section.appendChild(this.createFruitIcon(metric, 'clamp(74px, 11vw, 124px)'))

            const fruitRankings = this.getTopRankings(rankings, metric, 3)
            if (fruitRankings.length === 0) {
                section.appendChild(this.createCompactRankingRow('記録なし', false))
            } else {
                fruitRankings.forEach((entry, index) => {
                    section.appendChild(this.createCompactRankingRow(`${index + 1}位 ${entry.counts[metric]}個`, entry.id === currentEntryId))
                })
            }
            if (counts) {
                section.appendChild(this.createCompactRankingRow(`あなた ${counts[metric]}個`, true))
            }
            columns.appendChild(section)
        })
        page.appendChild(columns)
        return page
    }

    private createSlidePage(titleText: string) {
        const page = document.createElement('div')
        page.style.position = 'relative'
        page.style.flex = '0 0 100%'
        page.style.minWidth = '100%'
        page.style.height = '100%'
        page.style.boxSizing = 'border-box'
        page.style.padding = 'min(8vh, 68px) min(7vw, 72px)'
        page.style.display = 'flex'
        page.style.flexDirection = 'column'
        page.style.alignItems = 'center'
        page.style.justifyContent = 'center'
        page.style.textAlign = 'center'
        page.style.scrollSnapAlign = 'start'

        const title = document.createElement('div')
        title.textContent = titleText
        title.style.fontSize = 'clamp(48px, 10vw, 104px)'
        title.style.fontWeight = '900'
        title.style.color = '#fff0a8'
        title.style.marginBottom = '28px'
        page.appendChild(title)
        return page
    }

    private createFruitIcon(fruitType: FruitType, size: string) {
        const image = document.createElement('img')
        image.src = `${this.serverOrigin}/api/fruit-icon/${fruitType}`
        image.alt = fruitType
        image.style.width = size
        image.style.height = size
        image.style.objectFit = 'contain'
        image.style.flex = '0 0 auto'
        return image
    }

    private createSwipeHint() {
        const hint = document.createElement('div')
        hint.textContent = '›'
        hint.setAttribute('aria-label', '右にスライド')
        hint.style.position = 'absolute'
        hint.style.right = 'clamp(12px, 3vw, 34px)'
        hint.style.top = '50%'
        hint.style.transform = 'translateY(-50%)'
        hint.style.width = 'clamp(44px, 8vw, 72px)'
        hint.style.height = 'clamp(44px, 8vw, 72px)'
        hint.style.borderRadius = '999px'
        hint.style.display = 'flex'
        hint.style.alignItems = 'center'
        hint.style.justifyContent = 'center'
        hint.style.background = 'rgba(255, 242, 122, 0.24)'
        hint.style.color = '#fff27a'
        hint.style.fontSize = 'clamp(54px, 10vw, 92px)'
        hint.style.fontWeight = '900'
        hint.style.lineHeight = '0.8'
        hint.style.pointerEvents = 'none'
        return hint
    }

    private createNameEntryForm(entryId: string) {
        const form = document.createElement('form')
        form.style.display = 'flex'
        form.style.alignItems = 'center'
        form.style.justifyContent = 'center'
        form.style.gap = '10px'
        form.style.marginTop = '18px'
        form.style.width = 'min(780px, 88vw)'

        const input = document.createElement('input')
        input.dataset.resultNameInput = 'true'
        input.type = 'text'
        input.maxLength = 12
        input.placeholder = '名前を入力'
        input.autocomplete = 'off'
        input.style.minWidth = '0'
        input.style.flex = '1'
        input.style.border = '0'
        input.style.borderRadius = '999px'
        input.style.padding = '14px 18px'
        input.style.fontSize = 'clamp(24px, 5vw, 44px)'
        input.style.fontWeight = '900'
        input.style.textAlign = 'center'
        input.style.background = 'rgba(255, 248, 215, 0.96)'
        input.style.color = '#3f2a18'

        const button = document.createElement('button')
        button.type = 'submit'
        button.textContent = '保存'
        button.style.border = '0'
        button.style.borderRadius = '999px'
        button.style.padding = '14px 22px'
        button.style.fontSize = 'clamp(22px, 4.5vw, 38px)'
        button.style.fontWeight = '900'
        button.style.background = '#fff27a'
        button.style.color = '#3f2a18'

        form.onsubmit = async (event) => {
            event.preventDefault()
            const name = input.value.trim()
            if (!name) return
            button.textContent = '保存中'
            button.disabled = true
            try {
                await this.updateRankingName(entryId, name)
                input.blur()
                await this.syncGameResults()
            } catch (error) {
                console.warn('[remote-draw-client] ranking name update failed', {
                    serverOrigin: this.serverOrigin,
                    error: this.formatError(error),
                })
                button.textContent = '再試行'
                button.disabled = false
            }
        }

        form.appendChild(input)
        form.appendChild(button)
        return form
    }

    private async updateRankingName(entryId: string, name: string) {
        if (!this.serverOrigin) return
        const response = await fetch(`${this.serverOrigin}/api/ranking-name`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entryId, name }),
        })
        if (!response.ok) {
            throw new Error(`ranking name update failed: ${response.status}`)
        }
    }

    private getRankingDisplayName(entry: RankingEntry, isCurrent: boolean) {
        return entry.name?.trim() || (isCurrent ? 'あなた' : 'なまえなし')
    }

    private createRankingRow(text: string, highlighted: boolean, fontSize = 'clamp(34px, 6.8vw, 64px)') {
        const row = document.createElement('div')
        row.textContent = text
        row.style.width = 'min(780px, 88vw)'
        row.style.padding = '12px 22px'
        row.style.margin = '12px 0'
        row.style.borderRadius = '28px'
        row.style.fontSize = fontSize
        row.style.fontWeight = '900'
        row.style.background = highlighted ? 'rgba(255, 230, 107, 0.35)' : 'rgba(255, 248, 215, 0.12)'
        row.style.color = highlighted ? '#fff27a' : '#fff8d7'
        return row
    }

    private createCompactRankingRow(text: string, highlighted: boolean) {
        const row = document.createElement('div')
        row.textContent = text
        row.style.width = '100%'
        row.style.boxSizing = 'border-box'
        row.style.padding = '8px 4px'
        row.style.margin = '3px 0'
        row.style.borderRadius = '16px'
        row.style.fontSize = 'clamp(16px, 2.7vw, 28px)'
        row.style.fontWeight = '900'
        row.style.lineHeight = '1.1'
        row.style.whiteSpace = 'nowrap'
        row.style.background = highlighted ? 'rgba(255, 230, 107, 0.35)' : 'rgba(255, 248, 215, 0.12)'
        row.style.color = highlighted ? '#fff27a' : '#fff8d7'
        return row
    }

    private getTopRankings(rankings: RankingEntry[], metric: FruitType | 'total', limit: number) {
        return this.getSortedRankings(rankings, metric).slice(0, limit)
    }

    private getCurrentRank(rankings: RankingEntry[], metric: FruitType | 'total', currentEntryId: string | null) {
        if (!currentEntryId) return null
        const index = this.getSortedRankings(rankings, metric).findIndex((entry) => entry.id === currentEntryId)
        return index >= 0 ? index + 1 : null
    }

    private getSortedRankings(rankings: RankingEntry[], metric: FruitType | 'total') {
        return [...rankings].sort((left, right) => {
            const leftValue = metric === 'total' ? left.total : left.counts[metric]
            const rightValue = metric === 'total' ? right.total : right.counts[metric]
            if (rightValue !== leftValue) {
                return rightValue - leftValue
            }
            return left.playedAt.localeCompare(right.playedAt)
        })
    }

    private formatError(error: unknown) {
        if (error instanceof Error) {
            return `${error.name}: ${error.message}`
        }
        try {
            return JSON.stringify(error)
        } catch {
            return String(error)
        }
    }

    private updateLineWidth = () => {
        if (!this.canvas || !this.ctx) return
        const rect = this.canvas.getBoundingClientRect()
        const scaleX = rect.width / this.canvas.width
        const scaleY = rect.height / this.canvas.height
        const scale = Math.max((scaleX + scaleY) / 2, 0.001)
        this.ctx.lineWidth = Math.max(1, 5.7 / scale)
        this.updateGeneratedModeCropGuide()
    }

    private resetCanvasVisuals() {
        if (!this.canvas || !this.ctx) return
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        this.ctx.lineCap = 'round'
        this.ctx.lineJoin = 'round'
        this.ctx.strokeStyle = '#000'
        this.updateLineWidth()
    }

    private clearPreview() {
        if (!this.preview) return
        this.preview.hidden = true
        this.preview.removeAttribute('src')
    }

    private pointFromEvent(event: PointerEvent) {
        if (!this.canvas) return { x: 0, y: 0 }
        const rect = this.canvas.getBoundingClientRect()
        return {
            x: (event.clientX - rect.left) * (this.canvas.width / rect.width),
            y: (event.clientY - rect.top) * (this.canvas.height / rect.height),
        }
    }

    private getInkBounds() {
        if (!this.canvas || !this.ctx) return null
        const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
        const pixels = imageData.data
        let minX = this.canvas.width
        let minY = this.canvas.height
        let maxX = -1
        let maxY = -1
        for (let y = 0; y < this.canvas.height; y += 1) {
            for (let x = 0; x < this.canvas.width; x += 1) {
                const index = (y * this.canvas.width + x) * 4
                if (!this.isInkAt(index, pixels)) continue
                minX = Math.min(minX, x)
                minY = Math.min(minY, y)
                maxX = Math.max(maxX, x)
                maxY = Math.max(maxY, y)
            }
        }
        if (maxX < 0 || maxY < 0) return null
        return {
            left: minX,
            top: minY,
            right: maxX + 1,
            bottom: maxY + 1,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
        }
    }

    private buildSketchOverlayDataUrl() {
        if (!this.canvas || !this.ctx) return ''
        const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
        const pixels = imageData.data
        for (let index = 0; index < pixels.length; index += 4) {
            const isInk = this.isInkAt(index, pixels)
            pixels[index] = 0
            pixels[index + 1] = 0
            pixels[index + 2] = 0
            pixels[index + 3] = isInk ? 255 : 0
        }
        const overlayCanvas = document.createElement('canvas')
        overlayCanvas.width = this.canvas.width
        overlayCanvas.height = this.canvas.height
        overlayCanvas.getContext('2d')?.putImageData(imageData, 0, 0)
        return overlayCanvas.toDataURL('image/png')
    }

    private buildInputDataUrl() {
        if (!this.canvas) return ''
        const exportCanvas = document.createElement('canvas')
        exportCanvas.width = this.canvas.width
        exportCanvas.height = this.canvas.height
        const exportCtx = exportCanvas.getContext('2d')
        if (!exportCtx) return ''
        exportCtx.fillStyle = '#fff'
        exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height)
        exportCtx.drawImage(this.canvas, 0, 0)
        return exportCanvas.toDataURL('image/png')
    }

    private isInkAt(index: number, pixels: Uint8ClampedArray) {
        return pixels[index + 3] > 0 && (pixels[index] < 220 || pixels[index + 1] < 220 || pixels[index + 2] < 220)
    }

    private getStoredOrigin() {
        return window.localStorage.getItem(STORAGE_KEY)?.replace(/\/+$/, '') ?? ''
    }

    private getStoredGeneratedVariant(): GeneratedVariant {
        const stored = window.localStorage.getItem(GENERATED_VARIANT_STORAGE_KEY)
        if (stored === 'banana_400' || stored === 'apple_512' || stored === 'grape_400') {
            return stored
        }
        return 'banana_400'
    }

    private getStoredBananaPostprocessEnabled() {
        return window.localStorage.getItem(BANANA_POSTPROCESS_STORAGE_KEY) === '1'
    }

    private getOrCreateSessionId() {
        const key = 'remote-draw-session-id'
        const existing = window.localStorage.getItem(key)
        if (existing) return existing
        const created = globalThis.crypto?.randomUUID?.() ?? `session-${Math.random().toString(36).slice(2)}`
        window.localStorage.setItem(key, created)
        return created
    }
}
