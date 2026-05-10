import { Entity } from './Entity'

type Particle = {
    angle: number
    distance: number
    radius: number
    speed: number
    hue: number
}

type ExplosionStyle = 'apple' | 'grape'

export class ExplosionEffect extends Entity {
    private life: number
    private readonly maxLife: number
    private readonly maxRadius: number
    private readonly particles: Particle[]
    private readonly style: ExplosionStyle

    constructor(centerX: number, centerY: number, radius: number, style: ExplosionStyle = 'apple') {
        super(centerX - radius, centerY - radius, radius * 2, radius * 2)
        this.maxRadius = radius
        this.style = style
        this.maxLife = style === 'apple' ? 0.7 : 0.45
        this.life = this.maxLife
        const particleCount = style === 'apple' ? 24 : 14
        this.particles = Array.from({ length: particleCount }, (_, index) => ({
            angle: (Math.PI * 2 * index) / particleCount,
            distance: radius * (0.22 + (index % 6) * 0.08),
            radius: style === 'apple' ? 5 + (index % 4) * 2 : 4 + (index % 3) * 2,
            speed: radius * (style === 'apple' ? 1.3 + (index % 5) * 0.22 : 0.9 + (index % 4) * 0.25),
            hue: style === 'apple' ? 6 + (index % 5) * 10 : 270 + (index % 4) * 8,
        }))
    }

    update(dt: number): void {
        this.life -= dt
        if (this.life <= 0) {
            this.markedForDeletion = true
        }
    }

    render(ctx: CanvasRenderingContext2D): void {
        const progress = 1 - this.life / this.maxLife
        const alpha = Math.max(0, this.life / this.maxLife)
        const centerX = this.x + this.width / 2
        const centerY = this.y + this.height / 2

        ctx.save()
        ctx.globalCompositeOperation = 'lighter'

        const outerRadius = this.maxRadius * (this.style === 'apple' ? 0.55 + progress * 1.2 : 0.35 + progress * 0.9)
        const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, outerRadius)
        if (this.style === 'apple') {
            glow.addColorStop(0, `rgba(255, 249, 225, ${alpha * 0.98})`)
            glow.addColorStop(0.18, `rgba(255, 213, 120, ${alpha * 0.95})`)
            glow.addColorStop(0.42, `rgba(255, 104, 72, ${alpha * 0.82})`)
            glow.addColorStop(0.72, `rgba(212, 36, 32, ${alpha * 0.5})`)
            glow.addColorStop(1, 'rgba(255, 0, 0, 0)')
        } else {
            glow.addColorStop(0, `rgba(245, 228, 255, ${alpha * 0.95})`)
            glow.addColorStop(0.35, `rgba(178, 92, 255, ${alpha * 0.8})`)
            glow.addColorStop(0.7, `rgba(103, 24, 180, ${alpha * 0.45})`)
            glow.addColorStop(1, 'rgba(64, 0, 120, 0)')
        }
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(centerX, centerY, outerRadius, 0, Math.PI * 2)
        ctx.fill()

        ctx.lineWidth = this.style === 'apple' ? 5 : 3
        ctx.strokeStyle = this.style === 'apple'
            ? `rgba(255, 236, 180, ${alpha * 0.82})`
            : `rgba(215, 184, 255, ${alpha * 0.75})`
        ctx.beginPath()
        ctx.arc(centerX, centerY, outerRadius * 0.75, 0, Math.PI * 2)
        ctx.stroke()

        if (this.style === 'apple') {
            for (let i = 0; i < 8; i++) {
                const angle = progress * 0.25 + (Math.PI * 2 * i) / 8
                const sliceDistance = outerRadius * (0.32 + progress * 0.42)
                const px = centerX + Math.cos(angle) * sliceDistance
                const py = centerY + Math.sin(angle) * sliceDistance
                ctx.save()
                ctx.translate(px, py)
                ctx.rotate(angle + progress * 1.2)
                ctx.fillStyle = `rgba(255, 86, 72, ${alpha * 0.7})`
                ctx.beginPath()
                ctx.ellipse(0, 0, this.maxRadius * 0.12, this.maxRadius * 0.06, 0, 0, Math.PI * 2)
                ctx.fill()
                ctx.restore()
            }

            for (let i = 0; i < 3; i++) {
                const angle = -Math.PI * 0.9 + progress * 0.18 + i * 0.78
                const streamLength = this.maxRadius * (0.55 + progress * 0.95)
                const startX = centerX + Math.cos(angle) * this.maxRadius * 0.18
                const startY = centerY + Math.sin(angle) * this.maxRadius * 0.18
                const endX = startX + Math.cos(angle) * streamLength
                const endY = startY + Math.sin(angle) * streamLength
                ctx.strokeStyle = `rgba(255, 241, 173, ${alpha * 0.55})`
                ctx.lineWidth = this.maxRadius * 0.06 * (1 - progress * 0.3)
                ctx.lineCap = 'round'
                ctx.beginPath()
                ctx.moveTo(startX, startY)
                ctx.quadraticCurveTo(
                    (startX + endX) / 2 + Math.cos(angle + Math.PI / 2) * this.maxRadius * 0.12,
                    (startY + endY) / 2 + Math.sin(angle + Math.PI / 2) * this.maxRadius * 0.12,
                    endX,
                    endY,
                )
                ctx.stroke()
            }
        }

        for (const particle of this.particles) {
            const travel = particle.distance + particle.speed * progress * (this.style === 'apple' ? 0.38 : 0.25)
            const px = centerX + Math.cos(particle.angle) * travel
            const py = centerY + Math.sin(particle.angle) * travel
            const saturation = this.style === 'apple' ? 100 : 88
            const lightness = this.style === 'apple' ? 64 : 66
            ctx.fillStyle = `hsla(${particle.hue}, ${saturation}%, ${lightness}%, ${alpha * 0.85})`
            ctx.beginPath()
            ctx.arc(px, py, particle.radius * (1 - progress * 0.4), 0, Math.PI * 2)
            ctx.fill()
        }

        ctx.restore()
    }
}
