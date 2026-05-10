import { Entity } from './Entity'

export type GrownPlantLayout = {
    plant: {
        width: number
        height: number
        anchorX: number
        anchorY: number
    }
    fruit: {
        width: number
        height: number
        anchorX: number
        anchorY: number
    }
}

export class GrownPlant extends Entity {
    private age = 0
    private fruitVisible = true
    private fadeStartAge: number | null = null
    private fadeDuration = 3

    constructor(
        centerX: number,
        centerY: number,
        width: number,
        height: number,
        private readonly plantImage: HTMLImageElement,
        private readonly fruitImage: HTMLImageElement,
        private readonly layout: GrownPlantLayout,
    ) {
        super(centerX - width / 2, centerY - height / 2, width, height)
    }

    update(dt: number): void {
        this.age += dt
        if (this.fadeStartAge !== null && this.age >= this.fadeStartAge + this.fadeDuration) {
            this.markedForDeletion = true
        }
    }

    hideFruit(): void {
        this.fruitVisible = false
    }

    fadeOutAfter(delay: number, duration: number): void {
        this.fadeStartAge = this.age + delay
        this.fadeDuration = duration
    }

    render(ctx: CanvasRenderingContext2D): void {
        if (!this.isReady(this.plantImage)) {
            return
        }

        const alpha = this.getAlpha()
        if (alpha <= 0) {
            return
        }

        const scaleX = this.width / this.layout.plant.width
        const scaleY = this.height / this.layout.plant.height
        const scale = (scaleX + scaleY) / 2
        const plantAnchorX = this.x + this.layout.plant.anchorX * scaleX
        const plantAnchorY = this.y + this.layout.plant.anchorY * scaleY

        ctx.save()
        ctx.globalAlpha = alpha
        ctx.drawImage(this.plantImage, this.x, this.y, this.width, this.height)
        if (!this.fruitVisible || !this.isReady(this.fruitImage)) {
            ctx.restore()
            return
        }

        const fruitWidth = this.layout.fruit.width * scale
        const fruitHeight = this.layout.fruit.height * scale
        const fruitAnchorX = this.layout.fruit.anchorX * scale
        const fruitAnchorY = this.layout.fruit.anchorY * scale
        const swing = Math.sin(this.age * 3.2) * (Math.PI / 36)
        ctx.translate(plantAnchorX, plantAnchorY)
        ctx.rotate(swing)
        ctx.drawImage(this.fruitImage, -fruitAnchorX, -fruitAnchorY, fruitWidth, fruitHeight)
        ctx.restore()
    }

    private getAlpha(): number {
        if (this.fadeStartAge === null || this.age < this.fadeStartAge) {
            return 1
        }

        return Math.max(0, 1 - (this.age - this.fadeStartAge) / this.fadeDuration)
    }

    private isReady(image: HTMLImageElement) {
        return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
    }
}
