import { Entity } from './Entity'
import { EnemyConfig } from '../GameConfig'

export type EnemyGrowAnimation = {
    image: HTMLImageElement
    frameWidth: number
    frameHeight: number
    frames: number
    duration: number
}

export class Enemy extends Entity {
    private static nextId = 1
    private static readonly ALPHA_COLLISION_THRESHOLD = 24
    id: number
    gameHeight: number
    onEscaped: () => void
    speed: number
    color: string
    private image?: HTMLImageElement
    private maskCanvas?: HTMLCanvasElement
    private maskCtx?: CanvasRenderingContext2D
    private maskReady = false
    private age = 0
    private growAnimation?: EnemyGrowAnimation

    constructor(
        x: number,
        y: number,
        gameHeight: number,
        config: EnemyConfig,
        onEscaped: () => void,
        image?: HTMLImageElement,
        growAnimation?: EnemyGrowAnimation,
    ) {
        const size = config.size * 3.4
        super(x, y, size, size)
        this.id = Enemy.nextId++
        this.gameHeight = gameHeight
        this.onEscaped = onEscaped
        this.speed = config.speed
        this.color = config.color
        this.image = image
        this.growAnimation = growAnimation
    }

    update(dt: number): void {
        this.age += dt
    }

    render(ctx: CanvasRenderingContext2D): void {
        if (this.renderGrowAnimation(ctx)) {
            return
        }

        if (this.image?.complete && this.image.naturalWidth > 0 && this.image.naturalHeight > 0) {
            ctx.drawImage(this.image, this.x, this.y, this.width, this.height)
        } else {
            ctx.fillStyle = this.color
            ctx.fillRect(this.x, this.y, this.width, this.height)
        }

    }

    private renderGrowAnimation(ctx: CanvasRenderingContext2D) {
        const animation = this.growAnimation
        if (!animation) {
            return false
        }
        if (!animation.image.complete || animation.image.naturalWidth <= 0 || animation.image.naturalHeight <= 0) {
            return false
        }

        const progress = Math.max(0, Math.min(1, this.age / animation.duration))
        const frame = Math.min(animation.frames - 1, Math.floor(progress * animation.frames))
        ctx.drawImage(
            animation.image,
            frame * animation.frameWidth,
            0,
            animation.frameWidth,
            animation.frameHeight,
            this.x,
            this.y,
            this.width,
            this.height,
        )
        return true
    }

    takeDamage(_amount: number) {
        this.markedForDeletion = true
    }

    collidesWithOpaqueArea(other: Entity) {
        if (!this.isCollidingWith(other)) {
            return false
        }

        if (!this.image?.complete || this.image.naturalWidth <= 0 || this.image.naturalHeight <= 0) {
            return true
        }

        this.ensureMask()
        if (!this.maskCtx) {
            return true
        }

        const left = Math.max(this.x, other.x)
        const right = Math.min(this.x + this.width, other.x + other.width)
        const top = Math.max(this.y, other.y)
        const bottom = Math.min(this.y + this.height, other.y + other.height)
        if (right <= left || bottom <= top) {
            return false
        }

        const sampleCount = 6
        for (let yIndex = 0; yIndex <= sampleCount; yIndex++) {
            const sampleY = top + ((bottom - top) * yIndex) / sampleCount
            for (let xIndex = 0; xIndex <= sampleCount; xIndex++) {
                const sampleX = left + ((right - left) * xIndex) / sampleCount
                if (this.isOpaqueAt(sampleX, sampleY)) {
                    return true
                }
            }
        }

        return false
    }

    private isOpaqueAt(worldX: number, worldY: number) {
        if (!this.maskCtx || !this.image) {
            return true
        }

        const localX = Math.floor(((worldX - this.x) / this.width) * this.image.naturalWidth)
        const localY = Math.floor(((worldY - this.y) / this.height) * this.image.naturalHeight)
        if (localX < 0 || localY < 0 || localX >= this.image.naturalWidth || localY >= this.image.naturalHeight) {
            return false
        }

        return this.maskCtx.getImageData(localX, localY, 1, 1).data[3] > Enemy.ALPHA_COLLISION_THRESHOLD
    }

    private ensureMask() {
        if (this.maskReady || !this.image || this.image.naturalWidth <= 0 || this.image.naturalHeight <= 0) {
            return
        }

        this.maskCanvas = document.createElement('canvas')
        this.maskCanvas.width = this.image.naturalWidth
        this.maskCanvas.height = this.image.naturalHeight
        this.maskCtx = this.maskCanvas.getContext('2d') ?? undefined
        this.maskCtx?.drawImage(this.image, 0, 0)
        this.maskReady = true
    }
}
