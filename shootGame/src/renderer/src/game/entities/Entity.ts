export abstract class Entity {
    x: number
    y: number
    width: number
    height: number
    markedForDeletion: boolean = false

    constructor(x: number, y: number, width: number, height: number) {
        this.x = x
        this.y = y
        this.width = width
        this.height = height
    }

    abstract update(dt: number): void
    abstract render(ctx: CanvasRenderingContext2D): void

    get bounds() {
        return {
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
        }
    }

    isCollidingWith(other: Entity): boolean {
        return (
            this.x < other.x + other.width &&
            this.x + this.width > other.x &&
            this.y < other.y + other.height &&
            this.y + this.height > other.y
        )
    }
}
