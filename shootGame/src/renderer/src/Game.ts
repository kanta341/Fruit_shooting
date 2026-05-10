import { Player } from './game/entities/Player'
import { Enemy, EnemyGrowAnimation } from './game/entities/Enemy'
import { DrawnBullet } from './game/entities/DrawnBullet'
import { ExplosionEffect } from './game/entities/ExplosionEffect'
import { FloatingText } from './game/entities/FloatingText'
import { GrapeShard } from './game/entities/GrapeShard'
import { GrownPlant } from './game/entities/GrownPlant'
import { HarvestedFruit } from './game/entities/HarvestedFruit'
import { InputHandler } from './game/inputs/InputHandler'
import { RemoteDrawingSource } from './game/inputs/RemoteDrawingSource'
import { BulletSource, CoreFruitType, FruitType, ShotBatch, ShotPayload } from './game/interfaces/BulletSource'
import { GameConfig, EnemyConfig } from './game/GameConfig'

const PLAYFIELD_HEIGHT = 620
const DRAWING_PAD_HEIGHT = 0
const APPLE_EXPLOSION_BASE_RADIUS = 150
const APPLE_EXPLOSION_DAMAGE_FACTOR = 1.45
const GRAPE_SHARD_COUNT = 12
const GRAPE_SHARD_SPEED = 260
const GRAPE_SHARD_POWER_FACTOR = 0.35
const SPAWN_BASE_SPEED_MULTIPLIER = 0.5
const SPAWN_TIME_ACCELERATION_MAX = 1.5
const SPAWN_FRUIT_COUNT_ACCELERATION_MAX = 2.2
const SPAWN_FRUIT_COUNT_FOR_MAX_ACCELERATION = 500
const SPAWN_FRUIT_BALANCE_ACCELERATION_MAX = 5
export const GAME_CANVAS_WIDTH = 800
export const GAME_CANVAS_HEIGHT = PLAYFIELD_HEIGHT + DRAWING_PAD_HEIGHT

type EnemyImageAsset = {
    name: string
    image: HTMLImageElement
    growAnimation: EnemyGrowAnimation | undefined
}

type EnemyGrowAnimationManifest = {
    source: string
    sheet: string
    frameWidth: number
    frameHeight: number
    frames: number
    duration: number
}

type NamedImageAsset = {
    name: string
    image: HTMLImageElement
}

type GrownPlantManifestItem = {
    name: string
    width: number
    height: number
    anchorX: number
    anchorY: number
}

type GrownPlantManifest = {
    plants: GrownPlantManifestItem[]
    fruits: Record<CoreFruitType, GrownPlantManifestItem[]>
}

type BoxState = 'empty' | 'banana' | 'apple' | 'grape' | 'mixed' | 'full'
type EndScreenMode = 'result' | 'ranking'

type RankingEntry = {
    id: string
    playedAt: string
    counts: Record<CoreFruitType, number>
    total: number
    name?: string
}

type RankingSubmitResult = {
    entry: RankingEntry
    entries: RankingEntry[]
}

const RANKING_STORAGE_KEY = 'fruit-rankings'

type SpawnSpeedFactors = {
    timeAcceleration: number
    crowdingSlowdown: number
    crowdingThresholdMultiplier: number
    fruitCountAcceleration: number
    fruitBalanceAcceleration: number
    totalAcceleration: number
}

export class Game {
    private canvas: HTMLCanvasElement
    private ctx: CanvasRenderingContext2D
    private lastTime: number = 0
    private stopped = false
    private frameId = 0

    private player: Player
    private enemies: Enemy[] = []
    private bullets: DrawnBullet[] = []
    private grapeShards: GrapeShard[] = []
    private effects: ExplosionEffect[] = []
    private grownPlants: GrownPlant[] = []
    private harvestedFruits: HarvestedFruit[] = []
    private floatingTexts: FloatingText[] = []
    private input: InputHandler
    private bulletSource: BulletSource

    private gameTime: number = 0
    private totalElapsedTime: number = 0
    private gameDuration: number = GameConfig.gameDuration
    private gameOver: boolean = false
    private endScreenMode: EndScreenMode = 'result'
    private endScreenElapsed: number = 0
    private rankingSubmitted: boolean = false
    private rankingSubmitPromise: Promise<void> | null = null
    private restartingAfterRankingSubmit: boolean = false
    private rankingEntries: RankingEntry[] = []
    private currentRankingEntryId: string | null = null
    private paused: boolean = false
    private showSpawnDebug: boolean = window.localStorage.getItem('shoot-game-spawn-debug-visible') !== '0'

    private spawnTimers: Map<string, number> = new Map()
    private retryButton: HTMLButtonElement
    private pauseLabel: HTMLDivElement
    private playfieldBackground: HTMLImageElement
    private backgroundLoaded: boolean = false
    private soilMaskImage: HTMLImageElement
    private soilMaskCanvas: HTMLCanvasElement | null = null
    private soilMaskContext: CanvasRenderingContext2D | null = null
    private soilMaskLoaded: boolean = false
    private boxPopTimer: number = 0
    private boxImages: Record<BoxState, HTMLImageElement | null> = {
        empty: null,
        banana: null,
        apple: null,
        grape: null,
        mixed: null,
        full: null,
    }
    private fruitCounts: Record<CoreFruitType, number> = {
        banana: 0,
        apple: 0,
        grape: 0,
    }
    private enemyImages: EnemyImageAsset[] = []
    private plantImages: NamedImageAsset[] = []
    private fruitImages: Record<CoreFruitType, NamedImageAsset[]> = {
        banana: [],
        apple: [],
        grape: [],
    }
    private grownPlantManifest: GrownPlantManifest = {
        plants: [],
        fruits: {
            banana: [],
            apple: [],
            grape: [],
        },
    }

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Could not get 2d context')
        this.ctx = ctx

        this.input = new InputHandler()
        this.player = new Player(canvas.width, this.getPlayfieldBottom(), this.input)
        this.bulletSource = new RemoteDrawingSource(() => this.canvas.width)

        // Subscribe to shot events
        this.bulletSource.onShoot((data) => {
            if (!this.gameOver) {
                this.spawnBullet(data)
            }
        })

        // Initialize spawn timers
        GameConfig.enemyTypes.forEach(t => {
            this.spawnTimers.set(t.name, 0)
        })

        // Create Retry Button (Initial Hidden)
        this.retryButton = document.createElement('button')
        this.retryButton.innerText = 'RETRY'
        this.retryButton.style.position = 'absolute'
        this.retryButton.style.top = '60%'
        this.retryButton.style.left = '50%'
        this.retryButton.style.transform = 'translate(-50%, -50%)'
        this.retryButton.style.padding = '15px 30px'
        this.retryButton.style.fontSize = '24px'
        this.retryButton.style.cursor = 'pointer'
        this.retryButton.style.display = 'none'
        this.retryButton.onclick = () => this.restart()
        document.body.appendChild(this.retryButton)

        this.pauseLabel = document.createElement('div')
        this.pauseLabel.innerText = 'PAUSED'
        this.pauseLabel.style.position = 'absolute'
        this.pauseLabel.style.top = '24px'
        this.pauseLabel.style.left = '50%'
        this.pauseLabel.style.transform = 'translateX(-50%)'
        this.pauseLabel.style.padding = '10px 18px'
        this.pauseLabel.style.borderRadius = '999px'
        this.pauseLabel.style.background = 'rgba(0, 0, 0, 0.65)'
        this.pauseLabel.style.color = '#fff'
        this.pauseLabel.style.fontSize = '24px'
        this.pauseLabel.style.fontFamily = 'monospace'
        this.pauseLabel.style.fontWeight = '700'
        this.pauseLabel.style.letterSpacing = '0.08em'
        this.pauseLabel.style.display = 'none'
        document.body.appendChild(this.pauseLabel)

        this.playfieldBackground = new Image()
        this.playfieldBackground.onload = () => {
            this.backgroundLoaded = true
        }
        this.playfieldBackground.src = this.getBackgroundImageUrl()

        this.soilMaskImage = new Image()
        this.soilMaskImage.onload = () => {
            this.soilMaskCanvas = document.createElement('canvas')
            this.soilMaskCanvas.width = this.soilMaskImage.naturalWidth
            this.soilMaskCanvas.height = this.soilMaskImage.naturalHeight
            this.soilMaskContext = this.soilMaskCanvas.getContext('2d')
            this.soilMaskContext?.drawImage(this.soilMaskImage, 0, 0)
            this.soilMaskLoaded = Boolean(this.soilMaskContext)
        }
        this.soilMaskImage.src = 'background-masks/hiroba2-soil-mask.png'

        void this.loadBoxImages()
        void this.loadEnemyImages()
        void this.loadGrownPlantAssets()
        void this.loadRankings()
        if (typeof window !== 'undefined' && typeof window.electron?.onRankingsChanged === 'function') {
            window.electron.onRankingsChanged((entries) => {
                this.rankingEntries = entries
            })
        }
    }

    start() {
        this.gameTime = this.gameDuration
        this.totalElapsedTime = 0
        void this.setRemoteGameResultState('playing', null)
        this.lastTime = performance.now()
        this.frameId = requestAnimationFrame((time) => this.loop(time))
    }

    stop() {
        this.stopped = true
        cancelAnimationFrame(this.frameId)
        this.retryButton.remove()
        this.pauseLabel.remove()
    }

    private loop(time: number) {
        if (this.stopped) return
        const dt = (time - this.lastTime) / 1000
        this.lastTime = time

        this.update(dt)
        this.render()

        this.frameId = requestAnimationFrame((time) => this.loop(time))
    }

    private update(dt: number) {
        // Restart logic
        if (this.gameOver) {
            if (this.input.isDown('KeyR')) {
                this.restart()
            }
            if (this.endScreenMode === 'result') {
                this.endScreenElapsed += dt
                if (this.endScreenElapsed >= 4) {
                    this.endScreenMode = 'ranking'
                    void this.loadRankings()
                }
            }
            return
        }

        if (this.paused) {
            return
        }

        // Update Input Sources
        this.bulletSource.update(dt)

        // Player Update
        this.player.update(dt)

        // Enemy Spawning (Advanced Logic)
        this.totalElapsedTime += dt
        GameConfig.enemyTypes.forEach(type => {
            // Check Start Time
            if (this.totalElapsedTime < type.spawnStart) return

            // Check End Time (if set)
            if (type.spawnEnd > 0 && this.totalElapsedTime > type.spawnEnd) return

            const currentInterval = this.getCurrentSpawnInterval(type)

            let timer = this.spawnTimers.get(type.name) || 0
            timer += dt
            if (timer >= currentInterval) {
                timer = 0
                this.spawnEnemy(type)
            }
            this.spawnTimers.set(type.name, timer)
        })

        // Update Enemies
        this.enemies.forEach(e => e.update(dt))
        this.enemies = this.enemies.filter(e => !e.markedForDeletion)

        // Update Bullets
        this.bullets.forEach(b => b.update(dt))
        this.bullets = this.bullets.filter(b => !b.markedForDeletion)
        this.grapeShards.forEach((shard) => shard.update(dt))
        this.grapeShards = this.grapeShards.filter((shard) => !shard.markedForDeletion)
        this.effects.forEach((effect) => effect.update(dt))
        this.effects = this.effects.filter((effect) => !effect.markedForDeletion)
        this.grownPlants.forEach((plant) => plant.update(dt))
        this.grownPlants = this.grownPlants.filter((plant) => !plant.markedForDeletion)
        this.harvestedFruits.forEach((fruit) => fruit.update(dt))
        this.harvestedFruits = this.harvestedFruits.filter((fruit) => !fruit.markedForDeletion)
        this.boxPopTimer = Math.max(0, this.boxPopTimer - dt)

        // Update Floating Texts
        this.floatingTexts.forEach(ft => ft.update(dt))
        this.floatingTexts = this.floatingTexts.filter(ft => !ft.markedForDeletion)

        // Collision Detection
        this.checkCollisions()

        // Check Game Over
        this.gameTime -= dt
        if (this.gameTime <= 0) {
            this.gameTime = 0
            this.finishGame()
        }
    }

    private finishGame() {
        if (this.gameOver) {
            return
        }

        const counts = this.getFruitCountsSnapshot()
        this.gameOver = true
        this.endScreenMode = 'result'
        this.endScreenElapsed = 0
        this.retryButton.style.display = 'none'
        void this.setRemoteGameResultState('ended', counts)
        this.rankingSubmitPromise = this.submitRankingResult()
    }

    private spawnBullet(data?: ShotBatch) {
        if (!data || data.length === 0) return
        const startY = this.getPlayfieldBottom()
        data.forEach((shot) => {
            const b = new DrawnBullet(0, startY, shot)
            this.bullets.push(b)
        })
    }

    private spawnEnemy(type: EnemyConfig) {
        const enemySize = type.size * 3.4
        const centerAreaLeft = this.canvas.width / 6
        const centerAreaTop = this.canvas.height / 6
        const centerAreaWidth = (this.canvas.width * 2) / 3
        const centerAreaHeight = (this.canvas.height * 2) / 3
        const position = this.pickEnemySpawnPosition(
            centerAreaLeft,
            centerAreaTop,
            centerAreaWidth,
            centerAreaHeight,
            enemySize,
        )
        const enemyAsset = this.pickRandomEnemyImage()

        const e = new Enemy(position.x, position.y, this.getPlayfieldBottom(), type, () => {}, enemyAsset?.image, enemyAsset?.growAnimation)
        this.enemies.push(e)
    }

    private getCurrentSpawnInterval(type: EnemyConfig) {
        const factors = this.getSpawnSpeedFactors()
        return Math.max(0.1, type.spawnInterval / (factors.totalAcceleration * SPAWN_BASE_SPEED_MULTIPLIER))
    }

    private getSpawnSpeedFactors(): SpawnSpeedFactors {
        const timeProgress = Math.min(1, this.totalElapsedTime / this.gameDuration)
        const timeAcceleration = 1 + (SPAWN_TIME_ACCELERATION_MAX - 1) * timeProgress
        const fruitCountAcceleration = this.getFruitCountAcceleration()
        const fruitBalanceAcceleration = this.getFruitBalanceAcceleration()
        const crowdingThresholdMultiplier = timeAcceleration * fruitCountAcceleration * fruitBalanceAcceleration
        const crowdingSlowdown = this.getFieldCrowdingSlowdown(crowdingThresholdMultiplier)
        return {
            timeAcceleration,
            crowdingSlowdown,
            crowdingThresholdMultiplier,
            fruitCountAcceleration,
            fruitBalanceAcceleration,
            totalAcceleration: timeAcceleration * fruitCountAcceleration * fruitBalanceAcceleration * crowdingSlowdown,
        }
    }

    private getFieldCrowdingSlowdown(thresholdMultiplier: number) {
        const activeEnemyCount = this.enemies.filter((enemy) => !enemy.markedForDeletion).length
        if (activeEnemyCount >= 50 * thresholdMultiplier) {
            return 10 / 100
        }
        if (activeEnemyCount >= 20 * thresholdMultiplier) {
            return 30 / 100
        }
        if (activeEnemyCount >= 10 * thresholdMultiplier) {
            return 60 / 100
        }
        if (activeEnemyCount >= 5 * thresholdMultiplier) {
            return 80 / 100
        }
        return 1
    }

    private getFruitCountAcceleration() {
        const total = this.getTotalFruitCount()
        if (total <= 0) {
            return 1
        }

        const progress = Math.min(1, total / SPAWN_FRUIT_COUNT_FOR_MAX_ACCELERATION)
        return 1 + (SPAWN_FRUIT_COUNT_ACCELERATION_MAX - 1) * Math.sqrt(progress)
    }

    private getFruitBalanceAcceleration() {
        const total = this.getTotalFruitCount()
        if (total <= 0) {
            return 1
        }

        const ratios = [
            this.fruitCounts.apple / total,
            this.fruitCounts.banana / total,
            this.fruitCounts.grape / total,
        ]
        const ideal = 1 / 3
        const rootMeanSquareDeviation = Math.sqrt(
            ratios.reduce((sum, ratio) => sum + (ratio - ideal) ** 2, 0) / ratios.length,
        )
        const maxDeviation = Math.sqrt(2 / 9)
        const balanceScore = 1 - Math.min(1, rootMeanSquareDeviation / maxDeviation)
        return 1 + (SPAWN_FRUIT_BALANCE_ACCELERATION_MAX - 1) * balanceScore
    }

    private pickEnemySpawnPosition(areaX: number, areaY: number, areaWidth: number, areaHeight: number, enemySize: number) {
        const maxX = Math.max(0, areaWidth - enemySize)
        const maxY = Math.max(0, areaHeight - enemySize)
        let fallback = {
            x: areaX + Math.random() * maxX,
            y: areaY + Math.random() * maxY,
        }

        for (let attempt = 0; attempt < 90; attempt += 1) {
            const candidate = {
                x: areaX + Math.random() * maxX,
                y: areaY + Math.random() * maxY,
            }
            fallback = candidate
            if (this.isEnemyRectInsideSoil(candidate.x, candidate.y, enemySize, enemySize)) {
                return candidate
            }
        }

        const validCandidates: Array<{ x: number, y: number }> = []
        const columns = 18
        const rows = 14
        for (let row = 0; row < rows; row += 1) {
            for (let column = 0; column < columns; column += 1) {
                const candidate = {
                    x: areaX + maxX * (column / Math.max(1, columns - 1)),
                    y: areaY + maxY * (row / Math.max(1, rows - 1)),
                }
                if (this.isEnemyRectInsideSoil(candidate.x, candidate.y, enemySize, enemySize)) {
                    validCandidates.push(candidate)
                }
            }
        }

        if (validCandidates.length > 0) {
            return validCandidates[Math.floor(Math.random() * validCandidates.length)]
        }

        return fallback
    }

    private isEnemyRectInsideSoil(x: number, y: number, width: number, height: number): boolean {
        if (!this.soilMaskLoaded || !this.soilMaskContext || !this.soilMaskCanvas) {
            return true
        }

        const inset = Math.max(2, Math.min(width, height) * 0.08)
        const sampleCount = 5
        for (let row = 0; row < sampleCount; row += 1) {
            for (let column = 0; column < sampleCount; column += 1) {
                const xRatio = column / (sampleCount - 1)
                const yRatio = row / (sampleCount - 1)
                const sampleX = x + inset + (width - inset * 2) * xRatio
                const sampleY = y + inset + (height - inset * 2) * yRatio
                if (!this.isSoilAtCanvasPoint(sampleX, sampleY)) {
                    return false
                }
            }
        }

        return true
    }

    private isSoilAtCanvasPoint(canvasX: number, canvasY: number): boolean {
        if (!this.soilMaskContext || !this.soilMaskCanvas) {
            return true
        }

        const maskX = Math.floor((canvasX / this.canvas.width) * this.soilMaskCanvas.width)
        const maskY = Math.floor((canvasY / this.canvas.height) * this.soilMaskCanvas.height)
        if (maskX < 0 || maskY < 0 || maskX >= this.soilMaskCanvas.width || maskY >= this.soilMaskCanvas.height) {
            return false
        }

        const [red] = this.soilMaskContext.getImageData(maskX, maskY, 1, 1).data
        return red < 64
    }

    private checkCollisions() {
        for (const bullet of this.bullets) {
            for (const enemy of this.enemies) {
                if (bullet.markedForDeletion || enemy.markedForDeletion) continue
                if (!enemy.collidesWithOpaqueArea(bullet)) continue
                if (bullet.hasHitEnemy(enemy.id)) continue

                bullet.recordHitEnemy(enemy.id)

                if (bullet.fruitType === 'banana') {
                    this.applyDamage(enemy, bullet.power, '#ffe36c', 'banana')
                    continue
                }

                if (bullet.fruitType === 'apple') {
                    this.triggerAppleExplosion(bullet, enemy)
                    break
                }

                if (bullet.fruitType === 'grape') {
                    this.triggerGrapeBurst(bullet, enemy)
                    break
                }
            }
        }

        for (const shard of this.grapeShards) {
            for (const enemy of this.enemies) {
                if (shard.markedForDeletion || enemy.markedForDeletion) continue
                if (!enemy.collidesWithOpaqueArea(shard)) continue
                if (shard.hasHitEnemy(enemy.id)) continue
                shard.recordHitEnemy(enemy.id)
                this.applyDamage(enemy, shard.power, '#c88cff', 'grape')
                if (!shard.reflectOnce()) {
                    shard.markedForDeletion = true
                }
                break
            }
        }
    }

    restart() {
        if (this.gameOver) {
            void this.restartAfterRankingSubmit()
            return
        }

        this.resetGameState()
    }

    private async restartAfterRankingSubmit() {
        if (this.restartingAfterRankingSubmit) {
            return
        }

        this.restartingAfterRankingSubmit = true
        try {
            await this.ensureRankingSubmitted()
        } finally {
            this.restartingAfterRankingSubmit = false
        }

        this.resetGameState()
    }

    private async ensureRankingSubmitted() {
        if (!this.gameOver) {
            return
        }

        if (!this.rankingSubmitPromise) {
            this.rankingSubmitPromise = this.submitRankingResult()
        }

        await this.rankingSubmitPromise
    }

    private resetGameState() {
        this.gameTime = this.gameDuration
        this.totalElapsedTime = 0
        this.gameOver = false
        this.endScreenMode = 'result'
        this.endScreenElapsed = 0
        this.rankingSubmitted = false
        this.rankingSubmitPromise = null
        this.currentRankingEntryId = null
        this.fruitCounts = {
            banana: 0,
            apple: 0,
            grape: 0,
        }
        this.enemies = []
        this.bullets = []
        this.grapeShards = []
        this.effects = []
        this.grownPlants = []
        this.harvestedFruits = []
        this.floatingTexts = []

        // Reset timers
        GameConfig.enemyTypes.forEach(t => {
            this.spawnTimers.set(t.name, 0)
        })

        this.player = new Player(this.canvas.width, this.getPlayfieldBottom(), this.input) // Reset position
        this.retryButton.style.display = 'none'
        void this.setRemoteGameResultState('playing', null)
    }

    setGameDuration(seconds: number) {
        const nextDuration = Math.max(10, Math.min(600, Math.round(seconds)))
        this.gameDuration = nextDuration
        if (!this.gameOver) {
            this.gameTime = Math.max(0, nextDuration - this.totalElapsedTime)
            if (this.gameTime <= 0) {
                this.finishGame()
            }
        }
    }

    getGameDuration() {
        return this.gameDuration
    }

    getShowSpawnDebug() {
        return this.showSpawnDebug
    }

    setShowSpawnDebug(visible: boolean) {
        this.showSpawnDebug = visible
        window.localStorage.setItem('shoot-game-spawn-debug-visible', visible ? '1' : '0')
    }

    private getPlayfieldBottom() {
        return this.canvas.height
    }

    private render() {
        this.renderBackground()

        // Render Entities
        // this.player.render(this.ctx) // Player is hidden/removed in this mode
        this.grownPlants.forEach((plant) => plant.render(this.ctx))
        this.enemies.forEach(e => e.render(this.ctx))
        this.bullets.forEach(b => b.render(this.ctx))
        this.grapeShards.forEach((shard) => shard.render(this.ctx))
        this.effects.forEach((effect) => effect.render(this.ctx))
        this.floatingTexts.forEach(ft => ft.render(this.ctx))
        this.harvestedFruits.forEach((fruit) => fruit.render(this.ctx))
        this.renderBox()
        this.renderFruitCounter()
        if (this.showSpawnDebug) this.renderSpawnSpeedDebug()

        // UI
        this.ctx.fillStyle = '#fff'
        this.ctx.font = '20px monospace'
        this.ctx.fillText(`Time: ${Math.ceil(this.gameTime)}`, this.canvas.width - 120, 30)

        if (this.gameOver) {
            this.renderEndScreen()
        }

        if (this.paused && !this.gameOver) {
            this.ctx.fillStyle = 'rgba(0, 0, 0, 0.42)'
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
        }
    }

    setPaused(paused: boolean) {
        console.log(`[renderer] setPaused paused=${paused}`)
        this.paused = paused
        this.pauseLabel.style.display = paused ? 'block' : 'none'
    }

    resize(width: number, height: number) {
        this.canvas.width = width
        this.canvas.height = height
        this.player = new Player(this.canvas.width, this.getPlayfieldBottom(), this.input)
    }

    private renderBackground() {
        this.ctx.fillStyle = '#3d3027'
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)

        if (this.backgroundLoaded) {
            this.ctx.drawImage(this.playfieldBackground, 0, 0, this.canvas.width, this.canvas.height)
        } else {
            this.ctx.fillStyle = '#5a4736'
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
        }
    }

    private getBackgroundImageUrl() {
        if (typeof window !== 'undefined' && typeof window.electron?.getBackgroundImageUrl === 'function') {
            return window.electron.getBackgroundImageUrl()
        }

        return '/local-background/hiroba2.png'
    }

    private getBoxImageUrls(): Record<BoxState, string> {
        if (typeof window !== 'undefined' && typeof window.electron?.getBoxImageAssets === 'function') {
            return window.electron.getBoxImageAssets()
        }

        return {
            empty: '/local-box/box1.png',
            banana: '/local-box/2banana.png',
            apple: '/local-box/2apple.png',
            grape: '/local-box/2grape.png',
            mixed: '/local-box/box2.png',
            full: '/local-box/box3.png',
        }
    }

    private async loadBoxImages() {
        const urls = this.getBoxImageUrls()
        const entries = await Promise.all(
            (Object.entries(urls) as Array<[BoxState, string]>).map(async ([state, url]) => {
                const image = await this.loadImage(url)
                return [state, image] as const
            }),
        )

        for (const [state, image] of entries) {
            this.boxImages[state] = image
        }
    }

    private getCurrentBoxState(): BoxState {
        const collectedTypes = (Object.keys(this.fruitCounts) as CoreFruitType[])
            .filter((fruitType) => this.fruitCounts[fruitType] > 0)
        const total = this.getTotalFruitCount()

        if (collectedTypes.length >= 3 && total > 30) {
            return 'full'
        }

        if (collectedTypes.length >= 2) {
            return 'mixed'
        }

        if (collectedTypes.length === 1) {
            return collectedTypes[0]
        }

        return 'empty'
    }

    private getTotalFruitCount() {
        return this.fruitCounts.banana + this.fruitCounts.apple + this.fruitCounts.grape
    }

    private renderBox() {
        const boxImage = this.boxImages[this.getCurrentBoxState()]
        if (!boxImage || !boxImage.complete || boxImage.naturalWidth <= 0 || boxImage.naturalHeight <= 0) {
            return
        }

        const bounds = this.getBoxBounds(boxImage)
        this.ctx.drawImage(
            boxImage,
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
        )
    }

    private getBoxBounds(image?: HTMLImageElement | null) {
        const boxImage = image ?? this.boxImages[this.getCurrentBoxState()]
        const aspectRatio = boxImage && boxImage.naturalWidth > 0
            ? boxImage.naturalHeight / boxImage.naturalWidth
            : 1
        const baseWidth = Math.max(195, Math.min(390, this.canvas.width * 0.21))
        const baseHeight = baseWidth * aspectRatio
        const marginRight = 86
        const marginBottom = 72
        const baseX = this.canvas.width - baseWidth - marginRight
        const baseY = this.canvas.height - baseHeight - marginBottom
        const popProgress = this.boxPopTimer > 0 ? this.boxPopTimer / 0.22 : 0
        const popScale = 1 + Math.sin(popProgress * Math.PI) * 0.16
        const width = baseWidth * popScale
        const height = baseHeight * popScale

        return {
            x: baseX + (baseWidth - width) / 2,
            y: baseY + (baseHeight - height) / 2,
            width,
            height,
        }
    }

    private renderFruitCounter() {
        const rows: Array<{ fruitType: CoreFruitType, fallbackColor: string }> = [
            { fruitType: 'apple', fallbackColor: '#ff6372' },
            { fruitType: 'banana', fallbackColor: '#ffd74f' },
            { fruitType: 'grape', fallbackColor: '#a16bff' },
        ]
        const iconSlotSize = 114
        const iconDrawSize = iconSlotSize * 2
        const left = 22
        const top = 18
        const rowHeight = 122

        this.ctx.save()
        this.ctx.textBaseline = 'middle'
        this.ctx.textAlign = 'left'
        this.ctx.font = '700 54px "Comic Sans MS", "Chalkboard SE", "Marker Felt", sans-serif'
        this.ctx.lineWidth = 8
        this.ctx.strokeStyle = 'rgba(71, 46, 25, 0.9)'
        this.ctx.fillStyle = '#fff5b8'

        rows.forEach(({ fruitType, fallbackColor }, index) => {
            const y = top + index * rowHeight
            const image = this.fruitImages[fruitType][0]?.image
            if (image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
                const scale = Math.min(iconDrawSize / image.naturalWidth, iconDrawSize / image.naturalHeight)
                const width = image.naturalWidth * scale
                const height = image.naturalHeight * scale
                this.ctx.drawImage(image, left + (iconSlotSize - width) / 2, y + (iconSlotSize - height) / 2, width, height)
            } else {
                this.ctx.fillStyle = fallbackColor
                this.ctx.beginPath()
                this.ctx.arc(left + iconSlotSize / 2, y + iconSlotSize / 2, iconDrawSize * 0.36, 0, Math.PI * 2)
                this.ctx.fill()
                this.ctx.fillStyle = '#fff5b8'
            }

            const text = `×${this.fruitCounts[fruitType]}`
            const textX = left + iconSlotSize + 10
            const textY = y + iconSlotSize / 2
            this.ctx.strokeText(text, textX, textY)
            this.ctx.fillText(text, textX, textY)
        })

        this.ctx.restore()
    }

    private renderSpawnSpeedDebug() {
        const factors = this.getSpawnSpeedFactors()
        const total = this.getTotalFruitCount()
        const activeEnemyCount = this.enemies.filter((enemy) => !enemy.markedForDeletion).length
        const x = Math.max(320, this.canvas.width - 330)
        const y = 76
        const width = 300
        const lineHeight = 22
        const lines = [
            'Spawn speed debug',
            `base: x${SPAWN_BASE_SPEED_MULTIPLIER.toFixed(2)}`,
            `time: x${factors.timeAcceleration.toFixed(2)}`,
            `buds on field: x${factors.crowdingSlowdown.toFixed(2)} (${activeEnemyCount})`,
            `bud thresholds: ${Math.round(5 * factors.crowdingThresholdMultiplier)}/${Math.round(10 * factors.crowdingThresholdMultiplier)}/${Math.round(20 * factors.crowdingThresholdMultiplier)}/${Math.round(50 * factors.crowdingThresholdMultiplier)}`,
            `fruit total: x${factors.fruitCountAcceleration.toFixed(2)} (${total})`,
            `fruit balance: x${factors.fruitBalanceAcceleration.toFixed(2)}`,
            `total: x${factors.totalAcceleration.toFixed(2)}`,
        ]

        this.ctx.save()
        this.ctx.fillStyle = 'rgba(34, 24, 15, 0.62)'
        this.ctx.fillRect(x - 14, y - 24, width, lines.length * lineHeight + 22)
        this.ctx.strokeStyle = 'rgba(255, 239, 184, 0.65)'
        this.ctx.lineWidth = 2
        this.ctx.strokeRect(x - 14, y - 24, width, lines.length * lineHeight + 22)
        this.ctx.textAlign = 'left'
        this.ctx.textBaseline = 'top'
        this.ctx.font = '700 17px "Comic Sans MS", "Chalkboard SE", sans-serif'

        lines.forEach((line, index) => {
            this.ctx.fillStyle = index === 0 ? '#ffe9a6' : '#fff8d7'
            this.ctx.fillText(line, x, y + index * lineHeight)
        })
        this.ctx.restore()
    }

    private renderEndScreen() {
        this.ctx.save()
        this.ctx.fillStyle = 'rgba(20, 14, 8, 0.78)'
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)

        if (this.endScreenMode === 'result') {
            this.renderResultScreen()
        } else {
            this.renderRankingScreen()
        }

        this.ctx.restore()
    }

    private renderResultScreen() {
        const centerX = this.canvas.width / 2
        const panelWidth = Math.min(920, this.canvas.width * 0.88)
        const panelHeight = Math.min(650, this.canvas.height * 0.82)
        const panelX = centerX - panelWidth / 2
        const panelY = this.canvas.height / 2 - panelHeight / 2

        this.drawRoundedPanel(panelX, panelY, panelWidth, panelHeight)
        this.ctx.textAlign = 'center'
        this.ctx.textBaseline = 'middle'
        this.ctx.font = '800 82px "Comic Sans MS", "Chalkboard SE", "Marker Felt", sans-serif'
        this.ctx.fillStyle = '#fff0a8'
        this.ctx.strokeStyle = '#6b3f1d'
        this.ctx.lineWidth = 10
        this.ctx.strokeText('結果発表', centerX, panelY + 88)
        this.ctx.fillText('結果発表', centerX, panelY + 88)

        const rows: Array<{ fruitType: CoreFruitType, label: string, color: string }> = [
            { fruitType: 'apple', label: 'りんご', color: '#ff7a86' },
            { fruitType: 'grape', label: 'ぶどう', color: '#b88bff' },
            { fruitType: 'banana', label: 'バナナ', color: '#ffe06d' },
        ]
        const rowY = panelY + 205
        rows.forEach((row, index) => {
            this.renderResultFruitRow(panelX + 170, rowY + index * 105, row.fruitType, row.label, row.color)
        })

        this.ctx.textAlign = 'center'
        this.ctx.font = '800 68px "Comic Sans MS", "Chalkboard SE", "Marker Felt", sans-serif'
        this.ctx.fillStyle = '#ffffff'
        this.ctx.strokeStyle = '#5e351b'
        this.ctx.lineWidth = 9
        const totalText = `合計  ×${this.getTotalFruitCount()}`
        this.ctx.strokeText(totalText, centerX, panelY + panelHeight - 70)
        this.ctx.fillText(totalText, centerX, panelY + panelHeight - 70)
    }

    private renderResultFruitRow(x: number, y: number, fruitType: CoreFruitType, label: string, fallbackColor: string) {
        const image = this.fruitImages[fruitType][0]?.image
        const iconSize = 150
        if (image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
            const scale = Math.min(iconSize / image.naturalWidth, iconSize / image.naturalHeight)
            const width = image.naturalWidth * scale
            const height = image.naturalHeight * scale
            this.ctx.drawImage(image, x - width / 2, y - height / 2, width, height)
        } else {
            this.ctx.fillStyle = fallbackColor
            this.ctx.beginPath()
            this.ctx.arc(x, y, iconSize * 0.38, 0, Math.PI * 2)
            this.ctx.fill()
        }

        this.ctx.textAlign = 'left'
        this.ctx.textBaseline = 'middle'
        this.ctx.font = '800 58px "Comic Sans MS", "Chalkboard SE", "Marker Felt", sans-serif'
        this.ctx.fillStyle = '#fff8d7'
        this.ctx.strokeStyle = '#5e351b'
        this.ctx.lineWidth = 8
        const text = `${label}  ×${this.fruitCounts[fruitType]}`
        this.ctx.strokeText(text, x + 125, y)
        this.ctx.fillText(text, x + 125, y)
    }

    private renderRankingScreen() {
        const panelWidth = Math.min(860, this.canvas.width * 0.82)
        const panelHeight = Math.min(620, this.canvas.height * 0.82)
        const panelX = this.canvas.width / 2 - panelWidth / 2
        const panelY = this.canvas.height / 2 - panelHeight / 2
        this.drawRoundedPanel(panelX, panelY, panelWidth, panelHeight)

        this.ctx.textAlign = 'center'
        this.ctx.textBaseline = 'middle'
        this.ctx.font = '800 70px "Comic Sans MS", "Chalkboard SE", "Marker Felt", sans-serif'
        this.ctx.fillStyle = '#fff0a8'
        this.ctx.strokeStyle = '#6b3f1d'
        this.ctx.lineWidth = 9
        this.ctx.strokeText('合計ランキング', this.canvas.width / 2, panelY + 78)
        this.ctx.fillText('合計ランキング', this.canvas.width / 2, panelY + 78)

        this.renderTotalRankingRows(panelX, panelY, panelWidth)
        this.renderCurrentTotalRank(panelX, panelY, panelWidth, panelHeight)
    }

    private renderTotalRankingRows(panelX: number, panelY: number, panelWidth: number) {
        const entries = this.getTopRankings('total', 3)
        this.ctx.textAlign = 'center'
        this.ctx.textBaseline = 'middle'
        this.ctx.font = '800 54px "Comic Sans MS", "Chalkboard SE", "Marker Felt", sans-serif'
        if (entries.length === 0) {
            this.ctx.fillStyle = '#fff8d7'
            this.ctx.fillText('まだ記録がありません', panelX + panelWidth / 2, panelY + 270)
            return
        }

        entries.forEach((entry, index) => {
            const rowY = panelY + 180 + index * 82
            const isCurrent = entry.id === this.currentRankingEntryId
            if (isCurrent) {
                this.ctx.fillStyle = 'rgba(255, 230, 107, 0.35)'
                this.ctx.fillRect(panelX + 90, rowY - 38, panelWidth - 180, 74)
            }
            this.ctx.fillStyle = isCurrent ? '#fff27a' : '#fff8d7'
            const name = entry.name?.trim() || (isCurrent ? 'あなた' : 'なまえなし')
            const text = `${index + 1}位　${name}　${entry.total}個`
            this.ctx.fillText(text, panelX + panelWidth / 2, rowY)
        })
    }

    private renderCurrentTotalRank(panelX: number, panelY: number, panelWidth: number, panelHeight: number) {
        const currentRank = this.getCurrentRank('total')
        this.ctx.textAlign = 'center'
        this.ctx.textBaseline = 'middle'
        this.ctx.font = '800 44px "Comic Sans MS", "Chalkboard SE", "Marker Felt", sans-serif'
        this.ctx.fillStyle = '#fff0a8'
        const rankText = currentRank ? `今回の結果　${currentRank}位　${this.getTotalFruitCount()}個` : `今回の結果　${this.getTotalFruitCount()}個`
        this.ctx.fillText(rankText, panelX + panelWidth / 2, panelY + panelHeight - 88)
    }

    private drawRoundedPanel(x: number, y: number, width: number, height: number) {
        this.ctx.save()
        this.ctx.fillStyle = 'rgba(84, 51, 24, 0.9)'
        this.ctx.strokeStyle = 'rgba(255, 231, 151, 0.95)'
        this.ctx.lineWidth = 5
        this.ctx.beginPath()
        this.ctx.roundRect(x, y, width, height, 28)
        this.ctx.fill()
        this.ctx.stroke()
        this.ctx.restore()
    }

    private getTopRankings(metric: CoreFruitType | 'total', limit: number) {
        return this.getSortedRankings(metric)
            .slice(0, limit)
    }

    private getSortedRankings(metric: CoreFruitType | 'total') {
        return [...this.rankingEntries]
            .sort((left, right) => {
                const leftValue = metric === 'total' ? left.total : left.counts[metric]
                const rightValue = metric === 'total' ? right.total : right.counts[metric]
                if (rightValue !== leftValue) {
                    return rightValue - leftValue
                }
                return left.playedAt.localeCompare(right.playedAt)
            })
    }

    private getCurrentRank(metric: CoreFruitType | 'total') {
        if (!this.currentRankingEntryId) {
            return null
        }

        const index = this.getSortedRankings(metric)
            .findIndex((entry) => entry.id === this.currentRankingEntryId)
        return index >= 0 ? index + 1 : null
    }

    private applyDamage(enemy: Enemy, amount: number, textColor: string = '#fff', fruitType: FruitType) {
        const wasAlive = !enemy.markedForDeletion
        enemy.takeDamage(amount)
        this.floatingTexts.push(new FloatingText(enemy.x + enemy.width * 0.2, enemy.y, `-${Math.round(amount)}`, textColor))
        if (wasAlive && enemy.markedForDeletion) {
            const collectionQueued = this.placeGrownPlant(enemy, fruitType)
            if (!collectionQueued) {
                this.collectFruit(fruitType)
            }
        }
    }

    private async submitRankingResult() {
        if (this.rankingSubmitted) {
            return
        }
        this.rankingSubmitted = true
        const counts = this.getFruitCountsSnapshot()

        try {
            if (typeof window !== 'undefined' && typeof window.electron?.submitRanking === 'function') {
                const result = await window.electron.submitRanking(counts)
                this.currentRankingEntryId = result.entry.id
                this.rankingEntries = result.entries
                await this.setRemoteGameResultState('ended', counts)
                return
            }
        } catch (error) {
            console.error('Could not submit ranking result.', error)
        }

        const result = this.submitRankingToLocalStorage(counts)
        this.currentRankingEntryId = result.entry.id
        this.rankingEntries = result.entries
        await this.setRemoteGameResultState('ended', counts)
    }

    private async setRemoteGameResultState(status: 'playing' | 'ended', counts: Record<CoreFruitType, number> | null) {
        const state = {
            status,
            currentEntryId: status === 'ended' ? this.currentRankingEntryId : null,
            counts,
        }
        let updated = false
        try {
            if (typeof window !== 'undefined' && typeof window.electron?.setGameResultState === 'function') {
                await window.electron.setGameResultState(state)
                updated = true
            }
        } catch (error) {
            console.error('Could not update remote game result state.', error)
        }

        if (updated) {
            return
        }

        try {
            await fetch('http://127.0.0.1:8030/api/game-results', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...state,
                    persistRanking: status === 'ended',
                }),
            })
                .then(async (response) => {
                    if (!response.ok) return
                    const result = await response.json() as { currentEntryId?: string | null, rankings?: RankingEntry[] }
                    if (status === 'ended' && result.currentEntryId) {
                        this.currentRankingEntryId = result.currentEntryId
                    }
                    if (Array.isArray(result.rankings)) {
                        this.rankingEntries = result.rankings
                    }
                })
        } catch (error) {
            console.error('Could not update remote game result state via HTTP.', error)
        }
    }

    private getFruitCountsSnapshot(): Record<CoreFruitType, number> {
        return {
            banana: this.fruitCounts.banana,
            apple: this.fruitCounts.apple,
            grape: this.fruitCounts.grape,
        }
    }

    private async loadRankings() {
        try {
            if (typeof window !== 'undefined' && typeof window.electron?.getRankings === 'function') {
                this.rankingEntries = await window.electron.getRankings()
                return
            }
        } catch (error) {
            console.error('Could not load rankings.', error)
        }

        this.rankingEntries = this.readLocalStorageRankings()
    }

    private submitRankingToLocalStorage(counts: Record<CoreFruitType, number>): RankingSubmitResult {
        const entry: RankingEntry = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            playedAt: new Date().toISOString(),
            counts,
            total: counts.banana + counts.apple + counts.grape,
        }
        const entries = [...this.readLocalStorageRankings(), entry]
        window.localStorage.setItem(RANKING_STORAGE_KEY, JSON.stringify(entries))
        return { entry, entries }
    }

    private readLocalStorageRankings(): RankingEntry[] {
        try {
            const rawValue = window.localStorage.getItem(RANKING_STORAGE_KEY)
            if (!rawValue) {
                return []
            }
            const entries = JSON.parse(rawValue) as unknown
            if (!Array.isArray(entries)) {
                return []
            }
            return entries.filter((entry): entry is RankingEntry => (
                Boolean(entry)
                && typeof entry === 'object'
                && typeof (entry as RankingEntry).id === 'string'
                && typeof (entry as RankingEntry).playedAt === 'string'
                && typeof (entry as RankingEntry).total === 'number'
                && typeof (entry as RankingEntry).counts?.banana === 'number'
                && typeof (entry as RankingEntry).counts?.apple === 'number'
                && typeof (entry as RankingEntry).counts?.grape === 'number'
            ))
        } catch (error) {
            console.error('Could not read local ranking fallback.', error)
            return []
        }
    }

    private placeGrownPlant(enemy: Enemy, fruitType: FruitType) {
        if (fruitType !== 'banana' && fruitType !== 'apple' && fruitType !== 'grape') return false
        const plant = this.pickRandomNamedImage(this.plantImages)
        const fruit = this.pickRandomNamedImage(this.fruitImages[fruitType])
        const plantLayout = this.grownPlantManifest.plants.find((entry) => entry.name === plant?.name)
        const fruitLayout = this.grownPlantManifest.fruits[fruitType].find((entry) => entry.name === fruit?.name)
        if (!plant || !fruit || !plantLayout || !fruitLayout) {
            return false
        }

        const centerX = enemy.x + enemy.width / 2
        const centerY = enemy.y + enemy.height / 2
        const plantWidth = enemy.width * 1.5
        const plantHeight = enemy.height * 1.5
        const grownPlant = new GrownPlant(
            centerX,
            centerY,
            plantWidth,
            plantHeight,
            plant.image,
            fruit.image,
            {
                plant: plantLayout,
                fruit: fruitLayout,
            },
        )
        this.grownPlants.push(grownPlant)

        const scaleX = plantWidth / plantLayout.width
        const scaleY = plantHeight / plantLayout.height
        const scale = (scaleX + scaleY) / 2
        const plantX = centerX - plantWidth / 2
        const plantY = centerY - plantHeight / 2
        const fruitWidth = fruitLayout.width * scale
        const fruitHeight = fruitLayout.height * scale
        const fruitCenter = {
            x: plantX + plantLayout.anchorX * scaleX - fruitLayout.anchorX * scale + fruitWidth / 2,
            y: plantY + plantLayout.anchorY * scaleY - fruitLayout.anchorY * scale + fruitHeight / 2,
        }

        this.harvestedFruits.push(new HarvestedFruit(
            fruit.image,
            fruitType,
            fruitCenter,
            fruitWidth,
            fruitHeight,
            () => this.getBoxBounds(),
            () => grownPlant.hideFruit(),
            (collectedFruitType) => {
                this.collectFruit(collectedFruitType)
                grownPlant.fadeOutAfter(0.3, 0.7)
            },
        ))
        return true
    }

    private collectFruit(fruitType: FruitType) {
        if (fruitType !== 'banana' && fruitType !== 'apple' && fruitType !== 'grape') return
        this.fruitCounts[fruitType] += 1
        this.boxPopTimer = 0.22
    }

    private async loadEnemyImages() {
        try {
            const imageAssets =
                typeof window !== 'undefined' && typeof window.electron?.getEnemyImageAssets === 'function'
                    ? window.electron.getEnemyImageAssets()
                    : await this.loadEnemyImageUrlsFromDevServer()
            const animations = await this.loadEnemyGrowAnimations()

            const loadedImages = await Promise.all(
                imageAssets.map(async (asset) => {
                    const image = await this.loadImage(asset.url)
                    if (!image) {
                        return null
                    }

                    return {
                        name: asset.name,
                        image,
                        growAnimation: animations.get(asset.name),
                    }
                }),
            )
            this.enemyImages = loadedImages.filter((image): image is EnemyImageAsset => Boolean(image))
        } catch (error) {
            console.error('Could not load enemy images.', error)
        }
    }

    private pickRandomEnemyImage() {
        const availableImages = this.enemyImages.filter((asset) => asset.image.complete && asset.image.naturalWidth > 0 && asset.image.naturalHeight > 0)
        if (availableImages.length === 0) {
            return undefined
        }

        return availableImages[Math.floor(Math.random() * availableImages.length)]
    }

    private async loadGrownPlantAssets() {
        try {
            this.grownPlantManifest = await this.loadGrownPlantManifest()
            const imageAssets =
                typeof window !== 'undefined' && typeof window.electron?.getGrownPlantImageAssets === 'function'
                    ? window.electron.getGrownPlantImageAssets()
                    : this.getGrownPlantImageUrlsFromManifest(this.grownPlantManifest)

            const loadedPlants = await Promise.all(
                imageAssets.plants.map(async (asset) => {
                    const image = await this.loadImage(asset.url)
                    return image ? { name: asset.name, image } : null
                }),
            )
            this.plantImages = loadedPlants.filter((asset): asset is NamedImageAsset => Boolean(asset))

            const fruitTypes: CoreFruitType[] = ['banana', 'apple', 'grape']
            const fruitEntries = await Promise.all(
                fruitTypes.map(async (fruitType) => {
                    const loadedFruits = await Promise.all(
                        imageAssets.fruits[fruitType].map(async (asset) => {
                            const image = await this.loadImage(asset.url)
                            return image ? { name: asset.name, image } : null
                        }),
                    )
                    return [fruitType, loadedFruits.filter((asset): asset is NamedImageAsset => Boolean(asset))] as const
                }),
            )
            for (const [fruitType, images] of fruitEntries) {
                this.fruitImages[fruitType] = images
            }
        } catch (error) {
            console.error('Could not load grown plant assets.', error)
        }
    }

    private async loadGrownPlantManifest(): Promise<GrownPlantManifest> {
        const response = await fetch('grown-plant-layouts/index.json')
        if (!response.ok) {
            throw new Error(`Could not load grown plant manifest: ${response.status}`)
        }

        return await response.json() as GrownPlantManifest
    }

    private getGrownPlantImageUrlsFromManifest(manifest: GrownPlantManifest) {
        return {
            plants: manifest.plants.map((plant) => ({
                name: plant.name,
                url: `/local-grown-plant/plant/${plant.name}`,
            })),
            fruits: {
                banana: manifest.fruits.banana.map((fruit) => ({
                    name: fruit.name,
                    url: `/local-grown-plant/banana/${fruit.name}`,
                })),
                apple: manifest.fruits.apple.map((fruit) => ({
                    name: fruit.name,
                    url: `/local-grown-plant/apple/${fruit.name}`,
                })),
                grape: manifest.fruits.grape.map((fruit) => ({
                    name: fruit.name,
                    url: `/local-grown-plant/grape/${fruit.name}`,
                })),
            },
        }
    }

    private pickRandomNamedImage(images: NamedImageAsset[]) {
        const availableImages = images.filter((asset) => asset.image.complete && asset.image.naturalWidth > 0 && asset.image.naturalHeight > 0)
        if (availableImages.length === 0) {
            return undefined
        }

        return availableImages[Math.floor(Math.random() * availableImages.length)]
    }

    private async loadEnemyGrowAnimations() {
        const animations = new Map<string, EnemyGrowAnimation>()
        const response = await fetch('enemy-grow-animations/index.json')
        if (!response.ok) {
            return animations
        }

        const manifest = await response.json() as EnemyGrowAnimationManifest[]
        const loadedAnimations = await Promise.all(
            manifest.map(async (entry) => {
                const image = await this.loadImage(`enemy-grow-animations/${entry.sheet}`)
                if (!image) {
                    return null
                }

                return [entry.source, {
                    image,
                    frameWidth: entry.frameWidth,
                    frameHeight: entry.frameHeight,
                    frames: entry.frames,
                    duration: entry.duration,
                }] as const
            }),
        )

        for (const animation of loadedAnimations) {
            if (animation) {
                animations.set(animation[0], animation[1])
            }
        }

        return animations
    }

    private async loadEnemyImageUrlsFromDevServer() {
        const response = await fetch('/local-enemy/index.json')
        if (!response.ok) {
            return []
        }

        const fileNames = await response.json() as string[]
        return fileNames.map((fileName) => ({
            name: fileName,
            url: `/local-enemy/${fileName}`,
        }))
    }

    private async loadImage(src: string): Promise<HTMLImageElement | null> {
        return await new Promise((resolve) => {
            const image = new Image()
            image.onload = () => resolve(image)
            image.onerror = () => resolve(null)
            image.src = src
        })
    }

    private triggerAppleExplosion(bullet: DrawnBullet, directEnemy: Enemy) {
        if (bullet.hasTriggeredPrimaryEffect) return
        bullet.markConsumed()
        const centerX = directEnemy.x + directEnemy.width / 2
        const centerY = directEnemy.y + directEnemy.height / 2
        const appleSize = Math.max(bullet.width, bullet.height)
        const explosionRadius = (APPLE_EXPLOSION_BASE_RADIUS + appleSize * 0.9) * (2 / 3)
        this.effects.push(new ExplosionEffect(centerX, centerY, explosionRadius, 'apple'))

        for (const enemy of this.enemies) {
            if (enemy.markedForDeletion) continue
            const dx = enemy.x + enemy.width / 2 - centerX
            const dy = enemy.y + enemy.height / 2 - centerY
            const distance = Math.hypot(dx, dy)
            if (distance > explosionRadius + enemy.width * 0.5) continue
            const falloff = 1 - Math.min(1, distance / explosionRadius)
            const damage = bullet.power * APPLE_EXPLOSION_DAMAGE_FACTOR * (0.8 + falloff * 1.1)
            this.applyDamage(enemy, damage, '#ffb36b', 'apple')
        }
    }

    private triggerGrapeBurst(bullet: DrawnBullet, directEnemy: Enemy) {
        if (bullet.hasTriggeredPrimaryEffect) return
        bullet.markConsumed()
        this.applyDamage(directEnemy, bullet.power, '#c88cff', 'grape')
        const originX = directEnemy.x + directEnemy.width / 2
        const originY = directEnemy.y + directEnemy.height / 2
        this.effects.push(new ExplosionEffect(originX, originY, 70, 'grape'))
        const grapeSize = Math.min(bullet.width, bullet.height)
        const shardRadius = Math.max(7, Math.min(30, Math.round((7 + Math.max(0, grapeSize - 24) * 0.42) * (2 / 3))))
        const shardLife = 2.8 + Math.min(1.4, shardRadius * 0.08)

        for (let i = 0; i < GRAPE_SHARD_COUNT; i++) {
            const angle = -Math.PI * 0.95 + ((Math.PI * 1.9) * (i / Math.max(1, GRAPE_SHARD_COUNT - 1)))
            const speed = GRAPE_SHARD_SPEED + (i % 4) * 35 + shardRadius * 4
            const shard = new GrapeShard(
                originX,
                originY,
                angle,
                speed,
                bullet.power * GRAPE_SHARD_POWER_FACTOR,
                shardRadius,
                shardLife,
            )
            this.grapeShards.push(shard)
        }
    }
}
