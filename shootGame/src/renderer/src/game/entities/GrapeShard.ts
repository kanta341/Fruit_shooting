import { Entity } from './Entity'

export class GrapeShard extends Entity {
    power: number
    speed: number
    vx: number
    vy: number
    private life: number
    private readonly maxLife: number
    private readonly radius: number
    private activationDelay: number
    private hitEnemyIds = new Set<number>()
    private reflected = false
    private homing:
        | {
            startX: number
            startY: number
            targetX: number
            targetY: number
            controlX: number
            controlY: number
            age: number
            duration: number
        }
        | null = null

    constructor(
        x: number,
        y: number,
        angle: number,
        speed: number,
        power: number,
        radius: number,
        life: number = 2.8,
        homingTarget?: { x: number; y: number; curveOffset?: number; duration?: number },
        activationDelay: number = 0,
    ) {
        super(x - radius, y - radius, radius * 2, radius * 2)
        this.vx = Math.cos(angle) * speed
        this.vy = Math.sin(angle) * speed
        this.speed = speed
        this.power = power
        this.radius = radius
        this.life = life
        this.maxLife = life
        this.activationDelay = activationDelay
        if (homingTarget) {
            const duration = homingTarget.duration ?? Math.max(0.18, Math.min(0.42, Math.hypot(homingTarget.x - x, homingTarget.y - y) / Math.max(1, speed)))
            const midX = (x + homingTarget.x) / 2
            const midY = (y + homingTarget.y) / 2
            const angleToTarget = Math.atan2(homingTarget.y - y, homingTarget.x - x)
            const offset = homingTarget.curveOffset ?? radius * 5
            this.homing = {
                startX: x,
                startY: y,
                targetX: homingTarget.x,
                targetY: homingTarget.y,
                controlX: midX + Math.cos(angleToTarget + Math.PI / 2) * offset,
                controlY: midY + Math.sin(angleToTarget + Math.PI / 2) * offset,
                age: 0,
                duration,
            }
        }
    }

    update(dt: number): void {
        if (this.activationDelay > 0) {
            this.activationDelay = Math.max(0, this.activationDelay - dt)
            return
        }

        if (this.homing) {
            this.homing.age += dt
            const t = Math.min(1, this.homing.age / this.homing.duration)
            const inv = 1 - t
            const cx = inv * inv * this.homing.startX
                + 2 * inv * t * this.homing.controlX
                + t * t * this.homing.targetX
            const cy = inv * inv * this.homing.startY
                + 2 * inv * t * this.homing.controlY
                + t * t * this.homing.targetY
            this.x = cx - this.radius
            this.y = cy - this.radius
        } else {
            this.x += this.vx * dt
            this.y += this.vy * dt
        }
        this.life -= dt
        if (this.life <= 0) {
            this.markedForDeletion = true
        }
    }

    render(ctx: CanvasRenderingContext2D): void {
        if (this.activationDelay > 0) return

        const alpha = Math.max(0, this.life / this.maxLife)
        const centerX = this.x + this.radius
        const centerY = this.y + this.radius

        ctx.save()
        const gradient = ctx.createRadialGradient(
            centerX - this.radius * 0.35,
            centerY - this.radius * 0.45,
            this.radius * 0.15,
            centerX,
            centerY,
            this.radius * 2.4,
        )
        gradient.addColorStop(0, `rgba(255, 242, 255, ${alpha * 0.95})`)
        gradient.addColorStop(0.22, `rgba(180, 112, 225, ${alpha * 0.92})`)
        gradient.addColorStop(0.62, `rgba(112, 46, 150, ${alpha * 0.9})`)
        gradient.addColorStop(1, `rgba(58, 14, 84, ${alpha * 0.85})`)
        ctx.fillStyle = gradient
        ctx.beginPath()
        ctx.arc(centerX, centerY, this.radius, 0, Math.PI * 2)
        ctx.fill()

        ctx.strokeStyle = `rgba(236, 205, 255, ${alpha * 0.55})`
        ctx.lineWidth = Math.max(1, this.radius * 0.16)
        ctx.beginPath()
        ctx.arc(centerX, centerY, this.radius, 0, Math.PI * 2)
        ctx.stroke()

        ctx.fillStyle = `rgba(255, 248, 255, ${alpha * 0.65})`
        ctx.beginPath()
        ctx.ellipse(
            centerX - this.radius * 0.22,
            centerY - this.radius * 0.28,
            this.radius * 0.26,
            this.radius * 0.16,
            -0.5,
            0,
            Math.PI * 2,
        )
        ctx.fill()
        ctx.restore()
    }

    hasHitEnemy(enemyId: number) {
        return this.hitEnemyIds.has(enemyId)
    }

    recordHitEnemy(enemyId: number) {
        this.hitEnemyIds.add(enemyId)
    }

    get isHoming() {
        return this.homing !== null
    }

    get canImpact() {
        if (this.activationDelay > 0) return false
        return !this.homing || this.homing.age >= this.homing.duration * 0.92
    }

    reflectOnce(): boolean {
        if (this.reflected) {
            return false
        }

        this.reflected = true
        const currentAngle = Math.atan2(this.vy, this.vx)
        const jitter = (Math.random() - 0.5) * (Math.PI / 3)
        const reflectedAngle = currentAngle + Math.PI + jitter
        this.vx = Math.cos(reflectedAngle) * this.speed
        this.vy = Math.sin(reflectedAngle) * this.speed
        this.life = Math.max(this.life, this.maxLife * 0.35)
        return true
    }
}
