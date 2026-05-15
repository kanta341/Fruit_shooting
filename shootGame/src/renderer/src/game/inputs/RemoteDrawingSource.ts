import { BulletSource, FruitType, ShotBatch, ShotPayload } from '../interfaces/BulletSource'

type RemoteShotResponse = {
    shot?: {
        id: number
        image_id?: string
        processing_width: number
        processing_height: number
        frame_width: number
        frame_height: number
        launch_x?: number
        launch_y?: number
        launch_vx?: number
        launch_vy?: number
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
    } | null
}

export class RemoteDrawingSource implements BulletSource {
    private static readonly WHITE_BG_THRESHOLD = 245
    private static readonly POLL_INTERVAL_SECONDS = 0.08

    private onShootCallback: ((data?: ShotBatch) => void) | null = null
    private pollingTimer = 0
    private requestInFlight = false

    constructor(private readonly getTargetWidth: () => number = () => window.innerWidth) {
    }

    onShoot(callback: (data?: ShotBatch) => void): void {
        this.onShootCallback = callback
    }

    update(dt: number): void {
        this.pollingTimer += dt
        if (this.requestInFlight || this.pollingTimer < RemoteDrawingSource.POLL_INTERVAL_SECONDS) {
            return
        }

        this.pollingTimer = 0
        void this.pollShotQueue()
    }

    private async pollShotQueue() {
        this.requestInFlight = true
        try {
            const response = await fetch('http://127.0.0.1:8030/api/remote-shot')
            if (!response.ok) {
                return
            }

            const payload = await response.json() as RemoteShotResponse
            if (!payload.shot?.bullet_assets?.length) {
                return
            }

            const shots = await this.buildShotPayloads(payload.shot)
            if (shots.length > 0) {
                console.log(`[remote-drawing] received shot id=${payload.shot.id} count=${shots.length}`)
                this.onShootCallback?.(shots)
            }
        } catch (error) {
            console.warn('[remote-drawing] poll failed', error)
        } finally {
            this.requestInFlight = false
        }
    }

    private async buildShotPayloads(shot: NonNullable<RemoteShotResponse['shot']>): Promise<ShotBatch> {
        const scaleX = shot.processing_width / shot.frame_width
        const scaleY = shot.processing_height / shot.frame_height
        const targetScaleX = Math.max(0.001, this.getTargetWidth() / shot.frame_width)
        const targetScaleY = Math.max(0.001, window.innerHeight / shot.frame_height)
        const payloads = await Promise.all(
            (shot.bullet_assets ?? []).map((asset) => this.buildBulletAssetPayload(asset, scaleX, scaleY, targetScaleX, targetScaleY, shot.image_id ?? 'AUTO', shot)),
        )
        return payloads.filter((payload): payload is ShotPayload => Boolean(payload))
    }

    private async buildBulletAssetPayload(
        asset: NonNullable<NonNullable<RemoteShotResponse['shot']>['bullet_assets']>[number],
        scaleX: number,
        scaleY: number,
        targetScaleX: number,
        targetScaleY: number,
        defaultImageId: string,
        shot: NonNullable<RemoteShotResponse['shot']>,
	    ): Promise<ShotPayload | null> {
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
            throw new Error('Could not get remote bullet asset drawing context')
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
            throw new Error('Could not get remote bullet sprite context')
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

	        const logicalBoundsLeft = bounds.left * assetScaleX
	        const logicalBoundsTop = bounds.top * assetScaleY
	        const logicalBoundsWidth = bounds.width * assetScaleX
	        const logicalBoundsHeight = bounds.height * assetScaleY
	        const frameOriginX = (asset.origin_x + logicalBoundsLeft) / scaleX
	        const frameWidth = logicalBoundsWidth / scaleX
	        const targetCenterX = (frameOriginX + frameWidth / 2) * targetScaleX

	        return {
	            sprite,
	            originX: targetCenterX - frameWidth / 2,
	            originY: (asset.origin_y + logicalBoundsTop) / scaleY,
	            width: frameWidth,
	            height: logicalBoundsHeight / scaleY,
	            fruitType: asset.fruit_name ?? 'banana',
            imageId: asset.image_id ?? defaultImageId,
            launchX: shot.launch_x == null ? undefined : (shot.launch_x / shot.processing_width) * this.getTargetWidth(),
            launchY: shot.launch_y == null ? undefined : (shot.launch_y / shot.processing_height) * window.innerHeight,
            velocityX: shot.launch_vx,
            velocityY: shot.launch_vy,
        }
    }

    private findVisibleBounds(imageData: ImageData) {
        const { data, width, height } = imageData
        let left = width
        let top = height
        let right = -1
        let bottom = -1

        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
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

    private transparentizeWhiteBackground(imageData: ImageData) {
        const pixels = imageData.data
        for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i]
            const g = pixels[i + 1]
            const b = pixels[i + 2]
            if (
                r >= RemoteDrawingSource.WHITE_BG_THRESHOLD &&
                g >= RemoteDrawingSource.WHITE_BG_THRESHOLD &&
                b >= RemoteDrawingSource.WHITE_BG_THRESHOLD
            ) {
                pixels[i + 3] = 0
            }
        }
    }

    private loadImage(src: string) {
        return new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image()
            if (!src.startsWith('data:')) {
                image.crossOrigin = 'anonymous'
            }
            image.onload = () => resolve(image)
            image.onerror = () => reject(new Error('Could not load remote generated image'))
            image.src = src
        })
    }
}
