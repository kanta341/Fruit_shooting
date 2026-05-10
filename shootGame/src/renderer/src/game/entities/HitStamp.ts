import { Entity } from './Entity'

export class HitStamp extends Entity {
    private readonly image: HTMLImageElement
    private readonly rotation: number
    private readonly opacity: number

    constructor(
        centerX: number,
        centerY: number,
        width: number,
        height: number,
        image: HTMLImageElement,
        rotation: number,
        opacity: number,
    ) {
        super(centerX - width / 2, centerY - height / 2, width, height)
        this.image = image
        this.rotation = rotation
        this.opacity = opacity
    }

    update(_dt: number): void {
    }

    render(ctx: CanvasRenderingContext2D): void {
        if (!this.image.complete || this.image.naturalWidth <= 0 || this.image.naturalHeight <= 0) {
            return
        }

        const centerX = this.x + this.width / 2
        const centerY = this.y + this.height / 2

        ctx.save()
        ctx.globalAlpha = this.opacity
        ctx.translate(centerX, centerY)
        ctx.rotate(this.rotation)
        ctx.drawImage(this.image, -this.width / 2, -this.height / 2, this.width, this.height)
        ctx.restore()
    }
}
