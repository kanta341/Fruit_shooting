import { Entity } from './Entity'

export class Bullet extends Entity {
    speed: number = 400 // pixels per second

    constructor(x: number, y: number) {
        super(x, y, 5, 10) // Small rect
    }

    update(dt: number): void {
        this.y -= this.speed * dt
        if (this.y + this.height < 0) {
            this.markedForDeletion = true
        }
    }

    render(ctx: CanvasRenderingContext2D): void {
        ctx.fillStyle = '#ff0'
        ctx.fillRect(this.x, this.y, this.width, this.height)
    }
}
