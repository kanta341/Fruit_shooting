import { Entity } from './Entity'

export class FloatingText extends Entity {
    text: string
    color: string
    life: number = 1.0 // Seconds to live
    opacity: number = 1.0

    constructor(x: number, y: number, text: string, color: string = '#fff') {
        super(x, y, 0, 0)
        this.text = text
        this.color = color
    }

    update(dt: number): void {
        this.life -= dt
        this.y -= 50 * dt // Float up
        this.opacity = Math.max(0, this.life) // Fade out

        if (this.life <= 0) {
            this.markedForDeletion = true
        }
    }

    render(ctx: CanvasRenderingContext2D): void {
        ctx.save()
        ctx.globalAlpha = this.opacity
        ctx.fillStyle = this.color
        ctx.font = 'bold 20px monospace'
        ctx.fillText(this.text, this.x, this.y)
        ctx.restore()
    }
}
