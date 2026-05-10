import { Entity } from './Entity'
import { InputHandler } from '../inputs/InputHandler'

export class Player extends Entity {
    speed: number = 300
    input: InputHandler
    gameWidth: number

    constructor(gameWidth: number, gameHeight: number, input: InputHandler) {
        const width = 30
        const height = 30
        // Start at bottom center
        const x = gameWidth / 2 - width / 2
        const y = gameHeight - height - 10
        super(x, y, width, height)
        this.input = input
        this.gameWidth = gameWidth
    }

    update(dt: number): void {
        if (this.input.isDown('ArrowLeft')) {
            this.x -= this.speed * dt
        }
        if (this.input.isDown('ArrowRight')) {
            this.x += this.speed * dt
        }

        // Clamp to screen
        this.x = Math.max(0, Math.min(this.x, this.gameWidth - this.width))
    }

    render(ctx: CanvasRenderingContext2D): void {
        ctx.fillStyle = '#0f0'
        // Triangle shape for player
        ctx.beginPath()
        ctx.moveTo(this.x + this.width / 2, this.y)
        ctx.lineTo(this.x + this.width, this.y + this.height)
        ctx.lineTo(this.x, this.y + this.height)
        ctx.closePath()
        ctx.fill()
    }
}
