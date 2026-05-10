import { Entity } from './Entity'
import { FruitType } from '../interfaces/BulletSource'

type Point = {
    x: number
    y: number
}

type Bounds = Point & {
    width: number
    height: number
}

export class HarvestedFruit extends Entity {
    private age = 0
    private readonly harvestDuration = 0.42
    private readonly flightDuration = 0.9
    private readonly delay = 0.45
    private startedHarvest = false
    private completed = false
    private readonly controlPoint: Point

    constructor(
        private readonly image: HTMLImageElement,
        private readonly fruitType: FruitType,
        private readonly startCenter: Point,
        private readonly startWidth: number,
        private readonly startHeight: number,
        private readonly getTargetBounds: () => Bounds,
        private readonly onHarvestStart: () => void,
        private readonly onCollected: (fruitType: FruitType) => void,
    ) {
        super(startCenter.x - startWidth / 2, startCenter.y - startHeight / 2, startWidth, startHeight)
        this.controlPoint = this.createControlPoint(startCenter, this.getTargetCenter())
    }

    update(dt: number): void {
        this.age += dt

        if (!this.startedHarvest && this.age >= this.delay) {
            this.startedHarvest = true
            this.onHarvestStart()
        }

        if (!this.completed && this.age >= this.delay + this.harvestDuration + this.flightDuration) {
            this.completed = true
            this.markedForDeletion = true
            this.onCollected(this.fruitType)
        }
    }

    render(ctx: CanvasRenderingContext2D): void {
        if (!this.isReady()) {
            return
        }

        const localAge = Math.max(0, this.age - this.delay)
        const targetCenter = this.getTargetCenter()
        let center = this.startCenter
        let scale = 1
        let rotation = 0
        let alpha = 1

        if (localAge <= 0) {
            rotation = Math.sin(this.age * 3.2) * (Math.PI / 36)
        } else if (localAge < this.harvestDuration) {
            const t = this.easeOutBack(localAge / this.harvestDuration)
            center = {
                x: this.startCenter.x,
                y: this.startCenter.y + 34 * t,
            }
            scale = this.harvestScale(localAge / this.harvestDuration)
            rotation = Math.sin(t * Math.PI * 1.6) * 0.14
        } else {
            const t = Math.min(1, (localAge - this.harvestDuration) / this.flightDuration)
            const eased = this.easeInOut(t)
            const flightStart = {
                x: this.startCenter.x,
                y: this.startCenter.y + 34,
            }
            center = this.quadraticBezier(flightStart, this.controlPoint, targetCenter, eased)
            scale = 1.08 * (1 - eased) + 0.18 * eased
            rotation = eased * Math.PI * 1.25
            alpha = Math.max(0, 1 - Math.max(0, eased - 0.78) / 0.22)
        }

        this.drawCentered(ctx, center, scale, rotation, alpha)
    }

    private drawCentered(ctx: CanvasRenderingContext2D, center: Point, scale: number, rotation: number, alpha: number): void {
        const width = this.startWidth * scale
        const height = this.startHeight * scale

        ctx.save()
        ctx.globalAlpha = alpha
        ctx.translate(center.x, center.y)
        ctx.rotate(rotation)
        ctx.drawImage(this.image, -width / 2, -height / 2, width, height)
        ctx.restore()
    }

    private getTargetCenter(): Point {
        const target = this.getTargetBounds()
        return {
            x: target.x + target.width / 2,
            y: target.y + target.height / 2,
        }
    }

    private createControlPoint(start: Point, target: Point): Point {
        const midX = (start.x + target.x) / 2
        const midY = (start.y + target.y) / 2
        const dx = target.x - start.x
        const dy = target.y - start.y
        const distance = Math.max(1, Math.hypot(dx, dy))
        const curve = Math.min(240, Math.max(90, distance * 0.32))
        return {
            x: midX - (dy / distance) * curve,
            y: midY + (dx / distance) * curve - 80,
        }
    }

    private quadraticBezier(start: Point, control: Point, end: Point, t: number): Point {
        const inv = 1 - t
        return {
            x: inv * inv * start.x + 2 * inv * t * control.x + t * t * end.x,
            y: inv * inv * start.y + 2 * inv * t * control.y + t * t * end.y,
        }
    }

    private harvestScale(t: number): number {
        if (t < 0.45) {
            return 1 - 0.18 * this.easeInOut(t / 0.45)
        }
        return 0.82 + 0.32 * this.easeOutBack((t - 0.45) / 0.55)
    }

    private easeInOut(t: number): number {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    }

    private easeOutBack(t: number): number {
        const c1 = 1.70158
        const c3 = c1 + 1
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
    }

    private isReady(): boolean {
        return this.image.complete && this.image.naturalWidth > 0 && this.image.naturalHeight > 0
    }
}
