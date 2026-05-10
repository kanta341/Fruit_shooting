export type CoreFruitType = 'banana' | 'apple' | 'grape'
export type SmallStaticFruitType = 'berry' | 'lemon' | 'orange' | 'peach'
export type FruitType = CoreFruitType | SmallStaticFruitType | 'suika'

export type ShotPayload = {
    sprite: HTMLCanvasElement
    originX: number
    originY: number
    width: number
    height: number
    fruitType: FruitType
    imageId: string
}

export type ShotBatch = ShotPayload[]

export interface BulletSource {
    /**
     * Register a callback to be fired when a shot is requested.
   * @param callback Function to call when shooting
   */
    onShoot(callback: (data?: ShotBatch) => void): void

    /**
     * Update the source state (e.g. timers, cooldowns).
     * @param dt Delta time in seconds
     */
    update(dt: number): void
}
