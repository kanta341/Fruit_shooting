import { Entity } from './Entity'
import { FruitType, ShotPayload } from '../interfaces/BulletSource'

export class DrawnBullet extends Entity {
    private static readonly FRUIT_POWER_MULTIPLIER: Record<FruitType, number> = {
        banana: 1.0,
        apple: 1.15,
        grape: 0.85,
        berry: 0.7,
        lemon: 0.7,
        peach: 0.7,
        dorian: 1.3,
    }

    speed: number = 400
    power: number
    fruitType: FruitType
    imageId: string
    rotation: number
    rotationSpeed: number
    hasTriggeredPrimaryEffect = false
    private velocityX: number
    private velocityY: number
    private sprite: HTMLCanvasElement
    private hitEnemyIds = new Set<number>()

    constructor(startX: number, startY: number, shot: ShotPayload) {
        const initialX = shot.launchX == null ? startX + shot.originX : shot.launchX - shot.width / 2
        const initialY = shot.launchY == null ? startY + shot.originY : shot.launchY - shot.height / 2
        super(initialX, initialY, shot.width, shot.height)
        this.sprite = shot.sprite
        this.fruitType = shot.fruitType
        this.imageId = shot.imageId
        this.power = this.computePower(shot.width, shot.height, shot.fruitType)
        this.rotation = 0
        this.rotationSpeed = shot.fruitType === 'banana' ? Math.PI * 5.5 : 0
        const vx = shot.velocityX ?? 0
        const vy = shot.velocityY ?? -1
        const len = Math.hypot(vx, vy) || 1
        this.velocityX = vx / len
        this.velocityY = vy / len
    }

    update(dt: number): void {
        this.x += this.velocityX * this.speed * dt
        this.y += this.velocityY * this.speed * dt
        this.rotation += this.rotationSpeed * dt
        if (this.y + this.height < 0 || this.x + this.width < 0 || this.x > window.innerWidth) {
            this.markedForDeletion = true
        }
    }

    render(ctx: CanvasRenderingContext2D): void {
        const centerX = this.x + this.width / 2
        const centerY = this.y + this.height / 2
        this.renderAt(ctx, centerX, centerY, this.width, this.height, this.rotation)
    }

    renderAt(ctx: CanvasRenderingContext2D, centerX: number, centerY: number, width: number, height: number, rotation: number = 0): void {
        ctx.save()
        ctx.translate(centerX, centerY)
        if (rotation !== 0) {
            ctx.rotate(rotation)
        }
        ctx.drawImage(this.sprite, -width / 2, -height / 2, width, height)
        ctx.restore()
    }

    get isPiercing() {
        return this.fruitType === 'banana'
    }

    get centerX() {
        return this.x + this.width / 2
    }

    get centerY() {
        return this.y + this.height / 2
    }

    get directionX() {
        return this.velocityX
    }

    get directionY() {
        return this.velocityY
    }

    hasHitEnemy(enemyId: number) {
        return this.hitEnemyIds.has(enemyId)
    }

    recordHitEnemy(enemyId: number) {
        this.hitEnemyIds.add(enemyId)
    }

    markConsumed() {
        this.markedForDeletion = true
        this.hasTriggeredPrimaryEffect = true
    }

    private computePower(width: number, height: number, fruitType: FruitType) {
        const sizeScore = Math.sqrt(Math.max(1, width * height))
        const basePower = Math.max(10, sizeScore * 0.62)
        return basePower * DrawnBullet.FRUIT_POWER_MULTIPLIER[fruitType]
    }
}
