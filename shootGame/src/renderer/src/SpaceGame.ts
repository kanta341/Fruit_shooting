import { DrawnBullet } from './game/entities/DrawnBullet'
import { ExplosionEffect } from './game/entities/ExplosionEffect'
import { GrapeShard } from './game/entities/GrapeShard'
import { RemoteDrawingSource } from './game/inputs/RemoteDrawingSource'
import { FruitType, ShotBatch } from './game/interfaces/BulletSource'

const SPACE_API_BASE = 'http://127.0.0.1:8030/api/space-data'
const VOICE_API_BASE = 'http://127.0.0.1:8030/api/voice'
const SPACE_CONFIG_URL = 'http://127.0.0.1:8030/api/space-config'
const FEVER_STATE_URL = 'http://127.0.0.1:8030/api/fever-state'
const SPACE_CONTROL_URL = 'http://127.0.0.1:8030/api/space-control'
const GAME_FLOW_URL = 'http://127.0.0.1:8030/api/game-flow'
const UI_SOUND_EVENTS_URL = 'http://127.0.0.1:8030/api/ui-sound-events'
const BOSS_DEFEATS_URL = 'http://127.0.0.1:8030/api/boss-defeats/increment'
const CONFIG_REFRESH_INTERVAL = 10
const FEVER_REFRESH_INTERVAL = 0.25
const CONTROL_REFRESH_INTERVAL = 1.0
const INITIAL_ENEMY_SPEED = 14
const MAX_ENEMY_SPEED = 44
const PLAYER_MAX_HP = 3
const BOSS_MAX_HP = 20
const BASE_ENEMY_SIZE = 320
const SIZE_VARIANTS = [0.88, 0.94, 1.0, 1.06, 1.12]
const POP_PERIOD = 1.4
const POP_AMPLITUDE = 0.12
const WAVE_PERIOD = 3.5
const WAVE_AMPLITUDE = 12
const APPLE_EXPLOSION_REFERENCE_SIZE = 160
const APPLE_EXPLOSION_REFERENCE_RADIUS = 360
const APPLE_EXPLOSION_MIN_SCALE = 0.5
const APPLE_EXPLOSION_MAX_SCALE = 1.6
const SPACE_GRAPE_SHARD_SCALE = 1.6
const SPACE_GRAPE_SHARD_SPEED = 1650
const SPACE_ENEMY_DEATH_DURATION = 0.5
const SOUND_ASSETS: Record<string, string | Partial<Record<FruitType, string>>> = {
    bgmStart: `${VOICE_API_BASE}/background/チュートリアルBGM.mp3`,
    bgmMain: `${VOICE_API_BASE}/background/戦闘BGM.mp3`,
    bgmMainEasy: `${VOICE_API_BASE}/background/戦闘BGM_easy.mp3`,
    bgmMainNormal: `${VOICE_API_BASE}/background/戦闘BGM_normal.mp3`,
    bgmMainHard: `${VOICE_API_BASE}/background/戦闘BGM_hard.mp3`,
    bgmMainChallenge: `${VOICE_API_BASE}/background/戦闘BGM_veryhard.mp3`,
    bgmBoss: `${VOICE_API_BASE}/background/ボス音.mp3`,
    bgmFever: `${VOICE_API_BASE}/background/フィーバー音.mp3`,
    bgmClear: '',
    bgmGameOver: '',
    gameClear: `${VOICE_API_BASE}/human/ゲームクリア.wav`,
    gameOver: `${VOICE_API_BASE}/human/ゲームオーバー.wav`,
    feverEnter: `${VOICE_API_BASE}/other/フィーバー突入.mp3`,
    enemyReachBottom: `${VOICE_API_BASE}/enemy/敵到達音.mp3`,
    bossEnter: `${VOICE_API_BASE}/enemy/ボス登場音.mp3`,
    grapeBurst: `${VOICE_API_BASE}/fruit/破裂/ブドウ破裂1.mp3`,
    grapeShardLaunch: `${VOICE_API_BASE}/fruit/破裂/ブドウ破裂1.mp3`,
    applePop: '',
    uiButton: `${VOICE_API_BASE}/other/ボタン音.mp3`,
    humanHandoff: `${VOICE_API_BASE}/human/交代.wav`,
    humanDifficulty: `${VOICE_API_BASE}/human/難易度.wav`,
    humanTutorialApple: `${VOICE_API_BASE}/human/りんご.wav`,
    humanTutorialBanana: `${VOICE_API_BASE}/human/バナナ.wav`,
    humanTutorialGrape: `${VOICE_API_BASE}/human/ブドウ.wav`,
    humanStart: `${VOICE_API_BASE}/human/スタート.wav`,
    fruitShoot: {
        apple: `${VOICE_API_BASE}/fruit/発射/りんご発射.mp3`,
        banana: `${VOICE_API_BASE}/fruit/発射/バナナ発射.mp3`,
        grape: `${VOICE_API_BASE}/fruit/発射/ブドウ発射.mp3`,
        berry: `${VOICE_API_BASE}/fruit/発射/いちご発射.mp3`,
        lemon: `${VOICE_API_BASE}/fruit/発射/レモン発射.mp3`,
        orange: `${VOICE_API_BASE}/fruit/発射/みかん発射.mp3`,
        peach: `${VOICE_API_BASE}/fruit/発射/モモ発射.mp3`,
        suika: `${VOICE_API_BASE}/fruit/発射/スイカ発射.mp3`,
    },
    fruitHit: {
        apple: `${VOICE_API_BASE}/fruit/破裂/りんご破裂.mp3`,
        banana: `${VOICE_API_BASE}/fruit/破裂/バナナ破裂.mp3`,
        grape: `${VOICE_API_BASE}/fruit/破裂/ブドウ破裂2.mp3`,
        berry: `${VOICE_API_BASE}/fruit/破裂/いちご破裂.mp3`,
        lemon: `${VOICE_API_BASE}/fruit/破裂/レモン破裂.mp3`,
        orange: `${VOICE_API_BASE}/fruit/破裂/みかん破裂.mp3`,
        peach: `${VOICE_API_BASE}/fruit/破裂/モモ破裂.mp3`,
        suika: `${VOICE_API_BASE}/fruit/破裂/スイカ破裂.mp3`,
    },
}

type SpaceEnemyRequirement = 'apple' | 'banana' | 'grape' | null
type GameFlowPhase = 'playing' | 'ended' | 'handoff' | 'difficulty' | 'tutorial' | 'tutorial_done'
type GameDifficulty = 'easy' | 'normal' | 'hard' | 'challenge'
type SpaceDifficultyMode = 'all' | GameDifficulty
type GameFlowState = {
    phase: GameFlowPhase
    result: 'clear' | 'over' | null
    difficulty: GameDifficulty
    signal: number
}

const DIFFICULTY_SETTINGS: Record<GameDifficulty, { speed: number; spawn: number; label: string }> = {
    easy: { speed: 0.78, spawn: 1.35, label: 'EASY' },
    normal: { speed: 1.0, spawn: 1.0, label: 'NORMAL' },
    hard: { speed: 1.22, spawn: 0.72, label: 'HARD' },
    challenge: { speed: 1.38, spawn: 0.58, label: 'CHALLENGE' },
}
const TUTORIAL_FRUIT_ORDER: FruitType[] = ['apple', 'banana', 'grape']

export type SpaceEnemyConfig = {
    id: string
    label: string
    enabled: boolean
    imagePath: string
    requiredFruit: SpaceEnemyRequirement
    isBoss: boolean
    hasHp?: boolean
    hp?: number
    difficultyMode?: SpaceDifficultyMode
    spawnInterval: number    // seconds between spawns (lower = more frequent)
    spawnStart: number       // game seconds when this type starts appearing
    spawnEnd: number         // game seconds when this type stops (0 = never)
    spawnRateChange: number  // interval change per 60s of active time (negative = more frequent)
    sizeScale: number
    speedScale: number
}

export type SpaceSpeedConfig = {
    initialSpeed: number   // speed at game start (px/s)
    maxSpeed: number       // speed cap reached as game progresses
}

export type SpaceGameConfig = {
    enemies: SpaceEnemyConfig[]
    speedConfig: SpaceSpeedConfig
}

const DEFAULT_CONFIG: SpaceGameConfig = {
    enemies: [
        { id: 'normal', label: 'ノーマル', enabled: true, imagePath: 'enemy/normal_enemy.png', requiredFruit: null, isBoss: false, hasHp: false, hp: 1, difficultyMode: 'all', spawnInterval: 6.0, spawnStart: 0, spawnEnd: 0, spawnRateChange: -0.20, sizeScale: 1.0, speedScale: 1.0 },
        { id: 'apple', label: 'りんご専用', enabled: true, imagePath: 'enemy/apple_enemy.png', requiredFruit: 'apple', isBoss: false, hasHp: false, hp: 1, difficultyMode: 'all', spawnInterval: 12.0, spawnStart: 15, spawnEnd: 0, spawnRateChange: -0.20, sizeScale: 1.0, speedScale: 1.0 },
        { id: 'banana', label: 'バナナ専用', enabled: true, imagePath: 'enemy/banana_enemy.png', requiredFruit: 'banana', isBoss: false, hasHp: false, hp: 1, difficultyMode: 'all', spawnInterval: 12.0, spawnStart: 15, spawnEnd: 0, spawnRateChange: -0.20, sizeScale: 1.0, speedScale: 1.0 },
        { id: 'grape', label: 'ぶどう専用', enabled: true, imagePath: 'enemy/grape_enemy.png', requiredFruit: 'grape', isBoss: false, hasHp: false, hp: 1, difficultyMode: 'all', spawnInterval: 15.0, spawnStart: 20, spawnEnd: 0, spawnRateChange: -0.20, sizeScale: 1.0, speedScale: 1.0 },
        { id: 'boss', label: 'ボス', enabled: true, imagePath: 'enemy/boss_enemy.png', requiredFruit: null, isBoss: true, hasHp: true, hp: 20, difficultyMode: 'all', spawnInterval: 0, spawnStart: 120, spawnEnd: 0, spawnRateChange: 0, sizeScale: 1.5, speedScale: 0.6 },
    ],
    speedConfig: { initialSpeed: 14, maxSpeed: 44 },
}

type SpaceEnemy = {
    id: number
    configId: string
    imagePath: string
    requiredFruit: SpaceEnemyRequirement
    isBoss: boolean
    hasHp: boolean
    baseX: number
    y: number
    baseSize: number
    speed: number
    markedForDeletion: boolean
    dying?: boolean
    deathAge?: number
    deathDuration?: number
    deathDx?: number
    deathDy?: number
    deathShakePhase?: number
    bossHp?: number
    bossMaxHp?: number
    popPhase: number
    wavePhase: number
}

type SpaceVisualEffect = {
    markedForDeletion: boolean
    update(dt: number): void
    render(ctx: CanvasRenderingContext2D): void
}

class FruitPopEffect implements SpaceVisualEffect {
    markedForDeletion = false
    private age = 0

    constructor(
        private readonly bullet: DrawnBullet,
        private readonly centerX: number,
        private readonly centerY: number,
        private readonly duration: number,
        private readonly cycles: number,
        private readonly minScale: number,
        private readonly maxScale: number,
        private readonly onComplete: () => void,
    ) {}

    update(dt: number): void {
        this.age += dt
        if (this.age >= this.duration) {
            this.markedForDeletion = true
            this.onComplete()
        }
    }

    render(ctx: CanvasRenderingContext2D): void {
        const progress = Math.min(1, this.age / this.duration)
        const wave = 1 - Math.cos(progress * Math.PI * 2 * this.cycles)
        const envelope = 1 - progress * 0.18
        const scale = this.minScale + (this.maxScale - this.minScale) * (wave / 2) * envelope
        this.bullet.renderAt(
            ctx,
            this.centerX,
            this.centerY,
            this.bullet.width * scale,
            this.bullet.height * scale,
            this.bullet.rotation,
        )
    }
}

export class SpaceGame {
    private canvas: HTMLCanvasElement
    private ctx: CanvasRenderingContext2D
    private lastTime = 0
    private running = false
    private frameId = 0

    private bullets: DrawnBullet[] = []
    private enemies: SpaceEnemy[] = []
    private effects: SpaceVisualEffect[] = []
    private shards: GrapeShard[] = []
    private bulletSource: RemoteDrawingSource

    private bgImage = new Image()
    private bgLoaded = false
    private enemyImages: Record<string, HTMLImageElement> = {}
    private enemyImagesLoaded: Record<string, boolean> = {}

    private hp = PLAYER_MAX_HP
    private score = 0
    private elapsed = 0
    private spawnTimers: Record<string, number> = {}
    private enemyCounter = 0
    private gameOver = false
    private gameClear = false
    private spawnedBossIds = new Set<string>()

    private config: SpaceGameConfig = DEFAULT_CONFIG
    private configFetchTimer = 0
    private feverFetchTimer = 0
    private feverActive = false
    private feverUntil = 0
    private controlFetchTimer = 0
    private uiSoundFetchTimer = 0
    private lastRestartSignal = -1
    private gameFlowFetchTimer = 0
    private gameFlow: GameFlowState = { phase: 'playing', result: null, difficulty: 'normal', signal: 0 }
    private lastGameFlowSignal = -1
    private tutorialEnemyId: number | null = null
    private tutorialCompletePending = false
    private tutorialHitCount = 0
    private lastTutorialPromptIndex = -1
    private audioCache = new Map<string, HTMLAudioElement>()
    private currentBgmKey: string | null = null
    private currentBackgroundPath = ''
    private lastFeverSoundActive = false
    private bossBgmStarted = false

    private retryButton: HTMLButtonElement

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Could not get 2d context')
        this.ctx = ctx

        this.bgImage.crossOrigin = 'anonymous'
        this.bgImage.onload = () => { this.bgLoaded = true }
        this.updateBackgroundImage()

        this.ensureEnemyImages(DEFAULT_CONFIG.enemies)
        this.resetSpawnTimers(DEFAULT_CONFIG.enemies)

        this.bulletSource = new RemoteDrawingSource(() => canvas.width)
        this.bulletSource.onShoot((batch?: ShotBatch) => {
            if (!this.gameOver && batch) this.spawnBullets(batch)
        })
        this.preloadAudioAssets()

        this.retryButton = document.createElement('button')
        this.retryButton.textContent = ''
        Object.assign(this.retryButton.style, {
            position: 'absolute',
            top: '60%',
            left: '50%',
            transform: 'translate(-50%,-50%)',
            padding: '14px 32px',
            fontSize: '22px',
            fontFamily: 'monospace',
            fontWeight: '700',
            cursor: 'pointer',
            display: 'none',
            background: '#fff',
            border: 'none',
            borderRadius: '8px',
        })
        document.body.appendChild(this.retryButton)

        void this.fetchConfig()
        void this.fetchFeverState()
        void this.fetchGameFlow()
    }

    start() {
        this.running = true
        this.lastTime = performance.now()
        this.frameId = requestAnimationFrame((t) => this.loop(t))
    }

    stop() {
        this.running = false
        cancelAnimationFrame(this.frameId)
        this.stopBgm()
        this.retryButton.remove()
    }

    resize(w: number, h: number) {
        void [w, h]
    }

    private loop(time: number) {
        if (!this.running) return
        const dt = Math.min((time - this.lastTime) / 1000, 0.1)
        this.lastTime = time
        this.update(dt)
        this.render()
        this.frameId = requestAnimationFrame((t) => this.loop(t))
    }

    private ensureEnemyImages(enemies: SpaceEnemyConfig[]) {
        for (const enemy of enemies) {
            if (this.enemyImages[enemy.imagePath]) continue
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => { this.enemyImagesLoaded[enemy.imagePath] = true }
            img.src = `${SPACE_API_BASE}/${enemy.imagePath}`
            this.enemyImages[enemy.imagePath] = img
            this.enemyImagesLoaded[enemy.imagePath] = false
        }
    }

    private resetSpawnTimers(enemies: SpaceEnemyConfig[]) {
        this.spawnTimers = {}
        for (const enemy of enemies) {
            this.spawnTimers[enemy.id] = 0
        }
    }

    private syncSpawnTimers(enemies: SpaceEnemyConfig[]) {
        for (const enemy of enemies) {
            if (!(enemy.id in this.spawnTimers)) {
                this.spawnTimers[enemy.id] = 0
            }
        }
        for (const id of Object.keys(this.spawnTimers)) {
            if (!enemies.some((enemy) => enemy.id === id)) {
                delete this.spawnTimers[id]
                this.spawnedBossIds.delete(id)
            }
        }
    }

    private async fetchConfig() {
        try {
            const response = await fetch(SPACE_CONFIG_URL)
            if (!response.ok) return
            const config = await response.json() as SpaceGameConfig
            this.config = config
            this.ensureEnemyImages(config.enemies)
            this.syncSpawnTimers(config.enemies)
        } catch {
            // keep current config
        }
    }

    private getSoundSource(key: string, fruitType?: FruitType) {
        const entry = SOUND_ASSETS[key]
        if (typeof entry === 'string') return entry
        if (fruitType && entry) return entry[fruitType] ?? ''
        return ''
    }

    private getAudio(src: string) {
        let audio = this.audioCache.get(src)
        if (!audio) {
            audio = new Audio(src)
            audio.preload = 'auto'
            audio.load()
            this.audioCache.set(src, audio)
        }
        return audio
    }

    private preloadAudioAssets() {
        const visit = (value: string | Partial<Record<FruitType, string>> | undefined) => {
            if (!value) return
            if (typeof value === 'string') {
                if (value) this.getAudio(value)
                return
            }
            Object.values(value).forEach((src) => {
                if (src) this.getAudio(src)
            })
        }
        Object.values(SOUND_ASSETS).forEach(visit)
    }

    private playSound(key: string, fruitType?: FruitType) {
        const src = this.getSoundSource(key, fruitType)
        if (!src) return
        try {
            const audio = this.getAudio(src).cloneNode(true) as HTMLAudioElement
            audio.volume = 1
            void audio.play().catch((error) => {
                console.warn('[space-audio] sound play failed', key, src, error)
            })
        } catch (error) {
            console.warn('[space-audio] sound setup failed', key, src, error)
        }
    }

    private playBgm(key: string) {
        const src = this.getSoundSource(key)
        if (!src || this.currentBgmKey === key) return
        this.stopBgm()
        try {
            const audio = this.getAudio(src)
            audio.loop = true
            audio.currentTime = 0
            void audio.play().catch((error) => {
                console.warn('[space-audio] bgm play failed', key, src, error)
                if (this.currentBgmKey === key) {
                    this.currentBgmKey = null
                }
            })
            this.currentBgmKey = key
        } catch (error) {
            console.warn('[space-audio] bgm setup failed', key, src, error)
        }
    }

    private getBattleBgmKey() {
        if (this.gameFlow.difficulty === 'easy') return 'bgmMainEasy'
        if (this.gameFlow.difficulty === 'challenge') return 'bgmMainChallenge'
        if (this.gameFlow.difficulty === 'hard') return 'bgmMainHard'
        return 'bgmMainNormal'
    }

    private getBackgroundPath() {
        if (this.gameFlow.difficulty === 'challenge') return 'back_img/space_veryhard.png'
        if (this.gameFlow.difficulty === 'hard') return 'back_img/space_hard.png'
        return 'back_img/space.png'
    }

    private getTutorialPromptSoundKey() {
        const fruit = TUTORIAL_FRUIT_ORDER[Math.min(this.tutorialHitCount, TUTORIAL_FRUIT_ORDER.length - 1)]
        if (fruit === 'banana') return 'humanTutorialBanana'
        if (fruit === 'grape') return 'humanTutorialGrape'
        return 'humanTutorialApple'
    }

    private updateBackgroundImage() {
        const path = this.getBackgroundPath()
        if (this.currentBackgroundPath === path) return
        this.currentBackgroundPath = path
        this.bgLoaded = false
        this.bgImage.src = `${SPACE_API_BASE}/${path}`
    }

    private stopBgm() {
        if (!this.currentBgmKey) return
        const src = this.getSoundSource(this.currentBgmKey)
        const audio = src ? this.audioCache.get(src) : null
        if (audio) {
            audio.pause()
            audio.currentTime = 0
        }
        this.currentBgmKey = null
    }

    private async fetchFeverState() {
        try {
            const response = await fetch(FEVER_STATE_URL)
            if (!response.ok) return
            const state = await response.json() as { active?: boolean; until?: number }
            this.feverActive = Boolean(state.active)
            this.feverUntil = Number(state.until ?? 0)
        } catch {
            // keep current fever state
        }
    }

    private async fetchSpaceControl() {
        try {
            const response = await fetch(SPACE_CONTROL_URL)
            if (!response.ok) return
            const data = await response.json() as { restartSignal?: number }
            const signal = Number(data.restartSignal ?? 0)
            if (this.lastRestartSignal === -1) {
                this.lastRestartSignal = signal
            } else if (signal !== this.lastRestartSignal) {
                this.lastRestartSignal = signal
                if (this.gameFlow.phase === 'playing') {
                    this.restart()
                }
            }
        } catch {
            // ignore
        }
    }

    private async fetchGameFlow() {
        try {
            const response = await fetch(`${GAME_FLOW_URL}?t=${Date.now()}`, { cache: 'no-store' })
            if (!response.ok) return
            const state = await response.json() as GameFlowState
            this.applyGameFlow(state)
        } catch {
            // keep current flow state
        }
    }

    private async fetchUiSoundEvents() {
        try {
            const response = await fetch(`${UI_SOUND_EVENTS_URL}?t=${Date.now()}`, { cache: 'no-store' })
            if (!response.ok) return
            const data = await response.json() as { events?: Array<{ key?: string }> }
            for (const event of data.events ?? []) {
                if (event.key) this.playSound(event.key)
            }
        } catch {
            // ignore sound event polling errors
        }
    }

    private applyGameFlow(state: GameFlowState) {
        const previousPhase = this.gameFlow.phase
        const previousSignal = this.lastGameFlowSignal
        this.gameFlow = state
        this.updateBackgroundImage()
        if (previousSignal === state.signal) return
        this.lastGameFlowSignal = state.signal
        if (state.phase === 'tutorial') {
            this.feverActive = false
            this.lastFeverSoundActive = false
            this.bossBgmStarted = false
            this.stopBgm()
            this.startTutorial()
            this.playBgm('bgmStart')
        } else if (state.phase === 'playing' && previousPhase !== 'playing') {
            this.playSound('humanStart')
            this.restart()
        } else if (state.phase === 'ended') {
            this.gameOver = true
            this.gameClear = state.result === 'clear'
            this.retryButton.style.display = 'none'
            this.playSound(state.result === 'clear' ? 'gameClear' : 'gameOver')
            this.playBgm('bgmStart')
        } else if (state.phase === 'tutorial_done') {
            this.stopBgm()
        } else if (state.phase === 'handoff') {
            this.playSound('humanHandoff')
            this.playBgm('bgmStart')
            this.bullets = []
            this.shards = []
            this.effects = []
            this.enemies = []
            this.gameOver = false
            this.gameClear = false
        } else if (state.phase === 'difficulty') {
            this.playSound('humanDifficulty')
            this.playBgm('bgmStart')
            this.bullets = []
            this.shards = []
            this.effects = []
            this.enemies = []
            this.gameOver = false
            this.gameClear = false
        }
    }

    private async postGameFlow(payload: Partial<GameFlowState> & { phase: GameFlowPhase }) {
        try {
            await fetch(GAME_FLOW_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
        } catch {
            // flow UI will recover on the next poll
        }
    }

    private async incrementBossDefeatCount() {
        try {
            await fetch(BOSS_DEFEATS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ difficulty: this.gameFlow.difficulty, delta: 1 }),
            })
        } catch {
            // Boss defeat recording is non-blocking for gameplay.
        }
    }

    private spawnBullets(batch: ShotBatch) {
        const startY = this.canvas.height
        for (const shot of batch) {
            this.playSound('fruitShoot', shot.fruitType)
            this.bullets.push(new DrawnBullet(0, startY, shot))
        }
    }

    private spawnEnemy(config: SpaceEnemyConfig) {
        const progress = Math.min(1, this.elapsed / 60)
        const { initialSpeed, maxSpeed } = this.config.speedConfig
        const difficulty = DIFFICULTY_SETTINGS[this.gameFlow.difficulty] ?? DIFFICULTY_SETTINGS.normal
        const speed = (initialSpeed + (maxSpeed - initialSpeed) * progress) * config.speedScale * difficulty.speed
        const sizeVariant = config.isBoss ? 1.0 : SIZE_VARIANTS[Math.floor(Math.random() * SIZE_VARIANTS.length)]
        const baseSize = BASE_ENEMY_SIZE * sizeVariant * config.sizeScale
        const baseX = baseSize / 2 + Math.random() * Math.max(0, this.canvas.width - baseSize)
        const hasHp = Boolean(config.hasHp || config.isBoss)
        const maxHp = Math.max(1, Number(config.hp ?? (config.isBoss ? BOSS_MAX_HP : 1)))
        this.enemies.push({
            id: this.enemyCounter++,
            configId: config.id,
            imagePath: config.imagePath,
            requiredFruit: config.requiredFruit,
            isBoss: config.isBoss,
            baseX,
            y: -baseSize,
            baseSize,
            speed,
            markedForDeletion: false,
            dying: false,
            hasHp,
            bossHp: hasHp ? maxHp : undefined,
            bossMaxHp: hasHp ? maxHp : undefined,
            popPhase: Math.random() * Math.PI * 2,
            wavePhase: Math.random() * Math.PI * 2,
        })
        if (config.isBoss && !this.bossBgmStarted) {
            this.bossBgmStarted = true
            this.playSound('bossEnter')
            this.playBgm('bgmBoss')
        }
    }

    private startTutorial() {
        this.retryButton.style.display = 'none'
        this.gameOver = false
        this.gameClear = false
        this.spawnedBossIds.clear()
        this.hp = PLAYER_MAX_HP
        this.score = 0
        this.elapsed = 0
        this.resetSpawnTimers(this.config.enemies)
        this.bullets = []
        this.effects = []
        this.shards = []
        this.tutorialCompletePending = false
        this.tutorialHitCount = 0
        this.lastTutorialPromptIndex = -1
        this.spawnTutorialEnemy()
    }

    private spawnTutorialEnemy() {
        const size = Math.max(230, Math.min(320, Math.min(this.canvas.width, this.canvas.height) * 0.26))
        const imagePath = 'enemy/normal_enemy.png'
        this.ensureEnemyImages([{ ...DEFAULT_CONFIG.enemies[0], imagePath }])
        this.tutorialEnemyId = this.enemyCounter++
        const promptIndex = Math.min(this.tutorialHitCount, TUTORIAL_FRUIT_ORDER.length - 1)
        const requiredFruit = TUTORIAL_FRUIT_ORDER[promptIndex] as SpaceEnemyRequirement
        if (this.lastTutorialPromptIndex !== promptIndex) {
            this.lastTutorialPromptIndex = promptIndex
            this.playSound(this.getTutorialPromptSoundKey())
        }
        this.enemies = [{
            id: this.tutorialEnemyId,
            configId: 'tutorial',
            imagePath,
            requiredFruit,
            isBoss: false,
            hasHp: false,
            baseX: this.canvas.width / 2,
            y: Math.max(82, this.canvas.height * 0.2),
            baseSize: size,
            speed: 0,
            markedForDeletion: false,
            dying: false,
            popPhase: 0,
            wavePhase: 0,
        }]
    }

    private ensureTutorialEnemy() {
        if (this.gameFlow.phase !== 'tutorial') return
        if (this.tutorialCompletePending) return
        if (this.enemies.some((enemy) => enemy.configId === 'tutorial' && !enemy.markedForDeletion)) return
        this.spawnTutorialEnemy()
    }

    private currentSpawnInterval(cfg: SpaceEnemyConfig): number {
        const activeTime = Math.max(0, this.elapsed - cfg.spawnStart)
        const interval = cfg.spawnInterval + cfg.spawnRateChange * (activeTime / 60)
        const difficulty = DIFFICULTY_SETTINGS[this.gameFlow.difficulty] ?? DIFFICULTY_SETTINGS.normal
        return Math.max(0.05, interval * difficulty.spawn)
    }

    private updateSpawns(dt: number) {
        for (const cfg of this.config.enemies) {
            if (!cfg.enabled) continue
            if (this.elapsed < cfg.spawnStart) continue
            if (cfg.spawnEnd > 0 && this.elapsed > cfg.spawnEnd) continue
            if (cfg.isBoss) {
                if (!this.spawnedBossIds.has(cfg.id)) {
                    this.spawnedBossIds.add(cfg.id)
                    this.spawnEnemy(cfg)
                }
                continue
            }

            this.spawnTimers[cfg.id] = (this.spawnTimers[cfg.id] ?? 0) + dt
            const interval = this.currentSpawnInterval(cfg)
            if (this.spawnTimers[cfg.id] >= interval) {
                this.spawnTimers[cfg.id] = 0
                this.spawnEnemy(cfg)
            }
        }
    }

    private enemyBounds(e: SpaceEnemy) {
        const scale = 1 + POP_AMPLITUDE * Math.sin(2 * Math.PI * this.elapsed / POP_PERIOD + e.popPhase)
        let deathScale = 1
        let deathOffsetX = 0
        let deathOffsetY = 0
        if (e.dying) {
            const progress = Math.min(1, (e.deathAge ?? 0) / Math.max(0.001, e.deathDuration ?? SPACE_ENEMY_DEATH_DURATION))
            deathScale = Math.max(0.02, 1 - progress)
            deathOffsetX = (e.deathDx ?? 0) * progress
                + Math.sin(progress * Math.PI * 34 + (e.deathShakePhase ?? 0)) * 12 * (1 - progress)
            deathOffsetY = (e.deathDy ?? 0) * progress
        }
        const size = e.baseSize * scale * deathScale
        const cx = e.baseX + WAVE_AMPLITUDE * Math.sin(2 * Math.PI * this.elapsed / WAVE_PERIOD + e.wavePhase) + deathOffsetX
        const cy = e.y + e.baseSize * scale / 2 + deathOffsetY
        return { cx, cy, x: cx - size / 2, y: cy - size / 2, size }
    }

    private canBulletKillEnemy(bullet: DrawnBullet, enemy: SpaceEnemy): boolean {
        const required = enemy.requiredFruit
        return required === null || bullet.fruitType === required
    }

    private canShardKillEnemy(enemy: SpaceEnemy): boolean {
        // Shards are a grape effect — only affect grape-compatible enemies
        const required = enemy.requiredFruit
        return required === null || required === 'grape'
    }

    private startEnemyDeath(enemy: SpaceEnemy) {
        if (enemy.dying || enemy.markedForDeletion) return
        enemy.dying = true
        enemy.deathAge = 0
        enemy.deathDuration = SPACE_ENEMY_DEATH_DURATION
        const angle = Math.random() * Math.PI * 2
        const distance = enemy.baseSize * (0.12 + Math.random() * 0.1)
        enemy.deathDx = Math.cos(angle) * distance
        enemy.deathDy = Math.sin(angle) * distance
        enemy.deathShakePhase = Math.random() * Math.PI * 2
    }

    private update(dt: number) {
        this.controlFetchTimer += dt
        if (this.controlFetchTimer >= CONTROL_REFRESH_INTERVAL) {
            this.controlFetchTimer = 0
            void this.fetchSpaceControl()
        }
        this.gameFlowFetchTimer += dt
        if (this.gameFlowFetchTimer >= 0.35) {
            this.gameFlowFetchTimer = 0
            void this.fetchGameFlow()
        }
        this.uiSoundFetchTimer += dt
        if (this.uiSoundFetchTimer >= 0.12) {
            this.uiSoundFetchTimer = 0
            void this.fetchUiSoundEvents()
        }
        if (
            (this.gameFlow.phase === 'tutorial' || this.gameFlow.phase === 'handoff' || this.gameFlow.phase === 'difficulty')
            && this.currentBgmKey !== 'bgmStart'
        ) {
            this.playBgm('bgmStart')
        }
        this.ensureTutorialEnemy()

        if (this.gameOver || this.gameFlow.phase === 'handoff' || this.gameFlow.phase === 'difficulty' || this.gameFlow.phase === 'ended') return
        if (this.gameFlow.phase === 'tutorial_done') return

        this.bulletSource.update(dt)
        if (this.gameFlow.phase === 'playing') {
            this.elapsed += dt
        }

        this.configFetchTimer += dt
        if (this.configFetchTimer >= CONFIG_REFRESH_INTERVAL) {
            this.configFetchTimer = 0
            void this.fetchConfig()
        }
        this.feverFetchTimer += dt
        if (this.feverFetchTimer >= FEVER_REFRESH_INTERVAL) {
            this.feverFetchTimer = 0
            void this.fetchFeverState()
        }
        if (this.feverActive && this.feverUntil > 0 && Date.now() > this.feverUntil) {
            this.feverActive = false
        }
        if (this.gameFlow.phase === 'playing' && this.feverActive && !this.lastFeverSoundActive) {
            this.playSound('feverEnter')
            this.playBgm('bgmFever')
        } else if (!this.feverActive && this.lastFeverSoundActive && this.gameFlow.phase === 'playing') {
            this.playBgm(this.bossBgmStarted ? 'bgmBoss' : this.getBattleBgmKey())
        }
        this.lastFeverSoundActive = this.gameFlow.phase === 'playing' && this.feverActive

        if (this.gameFlow.phase === 'playing') {
            this.updateSpawns(dt)
        }

        for (const b of this.bullets) b.update(dt)
        for (const s of this.shards) s.update(dt)
        for (const ef of this.effects) ef.update(dt)

        for (const e of this.enemies) {
            if (e.dying) {
                e.deathAge = (e.deathAge ?? 0) + dt
                if (e.deathAge >= (e.deathDuration ?? SPACE_ENEMY_DEATH_DURATION)) {
                    e.markedForDeletion = true
                }
                continue
            }
            if (this.gameFlow.phase === 'playing') {
                e.y += e.speed * dt
            }
            const bounds = this.enemyBounds(e)
            if (bounds.cy >= this.canvas.height - bounds.size * 0.08) {
                this.playSound('enemyReachBottom')
                this.effects.push(new ExplosionEffect(bounds.cx, Math.min(this.canvas.height - 10, bounds.cy), bounds.size * (e.isBoss ? 1.75 : 1.35), 'apple'))
                this.startEnemyDeath(e)
                if (e.isBoss) {
                    this.hp = 0
                    this.triggerGameOver()
                } else {
                    this.hp = Math.max(0, this.hp - 1)
                    if (this.hp === 0) this.triggerGameOver()
                }
            }
        }

        // Bullet ↔ Enemy
        for (const b of this.bullets) {
            if (b.markedForDeletion) continue
            for (const e of this.enemies) {
                if (e.markedForDeletion || e.dying) continue
                if (b.hasHitEnemy(e.id)) continue
                const bounds = this.enemyBounds(e)
                if (!this.aabbOverlap(b, { x: bounds.x, y: bounds.y, width: bounds.size, height: bounds.size })) continue

                if (!this.canBulletKillEnemy(b, e)) {
                    // Wrong fruit type — bullet passes through immune enemy
                    continue
                }

                b.recordHitEnemy(e.id)
                this.onBulletHitEnemy(b, e, bounds.cx, bounds.cy, bounds.size)
                if (!b.isPiercing) break
            }
        }

        // Shard ↔ Enemy
        for (const s of this.shards) {
            if (s.markedForDeletion) continue
            for (const e of this.enemies) {
                if (e.markedForDeletion || e.dying) continue
                if (s.hasHitEnemy(e.id)) continue
                if (!this.canShardKillEnemy(e)) continue
                const bounds = this.enemyBounds(e)
                if (!s.canImpact) continue
                if (!this.aabbOverlap(s, { x: bounds.x, y: bounds.y, width: bounds.size, height: bounds.size })) continue
                this.playSound('fruitHit', 'grape')
                s.recordHitEnemy(e.id)
                const killed = this.killEnemy(e, 0.2)
                this.effects.push(new ExplosionEffect(bounds.cx, bounds.cy, bounds.size * 0.5, 'grape'))
                if (killed && e.isBoss) this.triggerGameClear()
                s.markedForDeletion = true
            }
        }

        this.bullets = this.bullets.filter(b => !b.markedForDeletion)
        this.enemies = this.enemies.filter(e => !e.markedForDeletion)
        this.shards = this.shards.filter(s => !s.markedForDeletion)
        this.effects = this.effects.filter(ef => !ef.markedForDeletion)
    }

    private onBulletHitEnemy(b: DrawnBullet, e: SpaceEnemy, cx: number, cy: number, size: number) {
        if (b.fruitType === 'banana') {
            this.playSound('fruitHit', b.fruitType)
            const killed = this.killEnemy(e)
            this.effects.push(new ExplosionEffect(cx, cy, size * 0.45, 'apple'))
            if (killed && e.isBoss) this.triggerGameClear()
        } else if (b.fruitType === 'apple') {
            b.markConsumed()
            this.playSound('applePop')
            this.effects.push(new FruitPopEffect(b, cx, cy, 0.95, 3, 0.72, 1.38, () => {
                this.resolveAppleExplosion(b, cx, cy)
            }))
        } else if (b.fruitType === 'grape') {
            this.playSound('fruitHit', b.fruitType)
            b.markConsumed()
            this.effects.push(new FruitPopEffect(b, cx, cy, 0.32, 1, 0.62, 1.26, () => {
                this.resolveGrapeBurst(b, cx, cy)
            }))
        } else {
            // Static fruits: simple hit
            this.playSound('fruitHit', b.fruitType)
            const killed = this.killEnemy(e)
            b.markConsumed()
            if (killed && e.isBoss) this.triggerGameClear()
        }
    }

    private resolveAppleExplosion(b: DrawnBullet, cx: number, cy: number) {
        this.playSound('fruitHit', 'apple')
        const appleSize = Math.max(b.width, b.height)
        const sizeScale = Math.max(
            APPLE_EXPLOSION_MIN_SCALE,
            Math.min(APPLE_EXPLOSION_MAX_SCALE, appleSize / APPLE_EXPLOSION_REFERENCE_SIZE),
        )
        const explosionRadius = APPLE_EXPLOSION_REFERENCE_RADIUS * sizeScale
        this.effects.push(new ExplosionEffect(cx, cy, explosionRadius, 'apple'))
        for (const enemy of this.enemies) {
            if (enemy.markedForDeletion || enemy.dying) continue
            if (!this.canBulletKillEnemy(b, enemy)) continue
            const ob = this.enemyBounds(enemy)
            if (Math.hypot(ob.cx - cx, ob.cy - cy) < explosionRadius + ob.size / 2) {
                const killed = this.killEnemy(enemy)
                if (killed && enemy.isBoss) this.triggerGameClear()
            }
        }
    }

    private resolveGrapeBurst(b: DrawnBullet, cx: number, cy: number) {
        this.playSound('grapeBurst')
        this.effects.push(new ExplosionEffect(cx, cy, 70 * 2.5, 'grape'))
        const grapeSize = Math.min(b.width, b.height)
        const shardRadius = Math.max(7, Math.min(30, Math.round((7 + Math.max(0, grapeSize - 24) * 0.42) * (2 / 3)))) * SPACE_GRAPE_SHARD_SCALE
        const shardLife = 1.1
        const directionsPerRotation = 12
        const rotations = 2
        const shardCount = directionsPerRotation * rotations
        for (let i = 0; i < shardCount; i++) {
            const angle = (Math.PI * 2 * i) / directionsPerRotation + (Math.random() - 0.5) * 0.12
            const activationDelay = i * 0.035
            window.setTimeout(() => this.playSound('grapeShardLaunch'), activationDelay * 1000)
            this.shards.push(new GrapeShard(
                cx,
                cy,
                angle,
                SPACE_GRAPE_SHARD_SPEED + (i % 4) * 140,
                Math.max(10, b.power * 0.55),
                shardRadius,
                shardLife,
                undefined,
                activationDelay,
            ))
        }
    }

    private killEnemy(enemy: SpaceEnemy, damage = 1) {
        if (enemy.dying || enemy.markedForDeletion) return false
        if (enemy.hasHp || enemy.isBoss) {
            enemy.bossMaxHp = enemy.bossMaxHp ?? BOSS_MAX_HP
            enemy.bossHp = Math.max(0, (enemy.bossHp ?? enemy.bossMaxHp) - damage)
            if (enemy.bossHp > 0) {
                return false
            }
        }
        this.startEnemyDeath(enemy)
        this.score++
        if (enemy.configId === 'tutorial') {
            this.tutorialHitCount += 1
            if (this.tutorialHitCount >= TUTORIAL_FRUIT_ORDER.length) {
                this.tutorialCompletePending = true
                window.setTimeout(() => {
                    void this.postGameFlow({ phase: 'tutorial_done', difficulty: this.gameFlow.difficulty })
                }, 650)
            } else {
                window.setTimeout(() => {
                    this.spawnTutorialEnemy()
                }, 650)
            }
        }
        return true
    }

    private aabbOverlap(
        a: { x: number; y: number; width: number; height: number },
        b: { x: number; y: number; width: number; height: number },
    ) {
        return a.x < b.x + b.width && a.x + a.width > b.x
            && a.y < b.y + b.height && a.y + a.height > b.y
    }

    private triggerGameOver() {
        this.gameOver = true
        this.gameClear = false
        this.retryButton.style.display = 'none'
        void this.postGameFlow({ phase: 'ended', result: 'over', difficulty: this.gameFlow.difficulty })
    }

    private triggerGameClear() {
        if (this.gameOver) return
        this.gameOver = true
        this.gameClear = true
        this.retryButton.style.display = 'none'
        void this.incrementBossDefeatCount()
        void this.postGameFlow({ phase: 'ended', result: 'clear', difficulty: this.gameFlow.difficulty })
    }

    private restart() {
        this.retryButton.style.display = 'none'
        this.retryButton.style.background = '#fff'
        this.gameOver = false
        this.gameClear = false
        this.spawnedBossIds.clear()
        this.hp = PLAYER_MAX_HP
        this.score = 0
        this.elapsed = 0
        this.configFetchTimer = 0
        this.resetSpawnTimers(this.config.enemies)
        this.bullets = []
        this.enemies = []
        this.effects = []
        this.shards = []
        this.tutorialEnemyId = null
        this.tutorialCompletePending = false
        this.tutorialHitCount = 0
        this.bossBgmStarted = false
        this.lastFeverSoundActive = false
        this.playBgm(this.getBattleBgmKey())
        void this.fetchConfig()
    }

    private render() {
        const { ctx, canvas } = this
        const w = canvas.width
        const h = canvas.height

        if (this.bgLoaded) {
            ctx.drawImage(this.bgImage, 0, 0, w, h)
        } else {
            ctx.fillStyle = '#05080f'
            ctx.fillRect(0, 0, w, h)
        }

        for (const e of this.enemies) {
            const { cx, cy, size } = this.enemyBounds(e)
            const img = this.enemyImages[e.imagePath]
            ctx.save()
            ctx.translate(cx, cy)
            if (e.dying) {
                const progress = Math.min(1, (e.deathAge ?? 0) / Math.max(0.001, e.deathDuration ?? SPACE_ENEMY_DEATH_DURATION))
                ctx.globalAlpha = Math.max(0, 1 - progress)
            }
            if (this.enemyImagesLoaded[e.imagePath] && img.naturalWidth > 0) {
                ctx.drawImage(img, -size / 2, -size / 2, size, size)
            } else {
                ctx.fillStyle = e.isBoss ? '#aa0000' : '#e03030'
                ctx.fillRect(-size / 2, -size / 2, size, size)
            }
            ctx.restore()
            if ((e.hasHp || e.isBoss) && !e.dying) {
                this.renderBossHealthBar(cx, cy, size, e)
            }
        }

        for (const ef of this.effects) ef.render(ctx)
        for (const s of this.shards) s.render(ctx)
        for (const b of this.bullets) b.render(ctx)

        this.renderHUD()
        if (this.feverActive) {
            this.renderFeverBorder()
        }
        if (!this.gameOver && this.gameFlow.phase !== 'playing') {
            this.renderGameFlowOverlay()
        }

        if (this.gameOver) {
            const title = this.gameClear ? 'GAME CLEAR' : 'GAME OVER'
            const sub = this.gameClear ? 'ボス撃破' : 'また次の挑戦へ'
            const accent = this.gameClear ? '#fff27a' : '#ff6f91'
            ctx.save()
            ctx.fillStyle = this.gameClear ? 'rgba(14, 12, 32, 0.68)' : 'rgba(16, 5, 16, 0.72)'
            ctx.fillRect(0, 0, w, h)
            const pulse = 0.55 + 0.45 * Math.sin(this.elapsed * 8)
            ctx.globalCompositeOperation = 'lighter'
            for (let i = 0; i < 48; i++) {
                const x = ((i * 97 + this.elapsed * 56) % (w + 140)) - 70
                const y = ((i * 53 + Math.sin(this.elapsed * 2 + i) * 18) % (h + 120)) - 60
                const r = 2 + (i % 4) * 1.4
                ctx.fillStyle = i % 3 === 0
                    ? `rgba(255,242,122,${0.28 + pulse * 0.38})`
                    : i % 3 === 1
                        ? `rgba(116,218,255,${0.2 + pulse * 0.28})`
                        : `rgba(255,111,190,${0.2 + pulse * 0.28})`
                ctx.beginPath()
                ctx.moveTo(x, y - r * 2.3)
                ctx.lineTo(x + r * 0.7, y - r * 0.7)
                ctx.lineTo(x + r * 2.3, y)
                ctx.lineTo(x + r * 0.7, y + r * 0.7)
                ctx.lineTo(x, y + r * 2.3)
                ctx.lineTo(x - r * 0.7, y + r * 0.7)
                ctx.lineTo(x - r * 2.3, y)
                ctx.lineTo(x - r * 0.7, y - r * 0.7)
                ctx.closePath()
                ctx.fill()
            }
            ctx.globalCompositeOperation = 'source-over'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillStyle = accent
            ctx.font = `900 ${Math.round(Math.max(68, Math.min(128, w * 0.105)))}px monospace`
            ctx.shadowColor = 'rgba(0,0,0,0.9)'
            ctx.shadowBlur = this.gameClear ? 28 : 18
            ctx.fillText(title, w / 2, h / 2 - 22)
            ctx.shadowBlur = 0
            ctx.fillStyle = 'rgba(255,255,255,0.88)'
            ctx.font = `800 ${Math.round(Math.max(26, Math.min(42, w * 0.034)))}px "Hiragino Sans", "Yu Gothic", sans-serif`
            ctx.fillText(sub, w / 2, h / 2 + 82)
            ctx.restore()
        }
    }

    private renderFeverBorder() {
        const { ctx, canvas } = this
        const t = this.elapsed
        const pulse = 0.55 + 0.45 * Math.sin(t * 12)
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const border = Math.max(18, Math.min(canvas.width, canvas.height) * 0.035)
        const gradTop = ctx.createLinearGradient(0, 0, 0, border * 3)
        gradTop.addColorStop(0, `rgba(255, 244, 118, ${0.5 + pulse * 0.28})`)
        gradTop.addColorStop(0.45, `rgba(255, 80, 210, ${0.18 + pulse * 0.14})`)
        gradTop.addColorStop(1, 'rgba(255, 255, 255, 0)')
        ctx.fillStyle = gradTop
        ctx.fillRect(0, 0, canvas.width, border * 3)
        ctx.save()
        ctx.translate(0, canvas.height)
        ctx.scale(1, -1)
        ctx.fillRect(0, 0, canvas.width, border * 3)
        ctx.restore()
        const gradSide = ctx.createLinearGradient(0, 0, border * 3, 0)
        gradSide.addColorStop(0, `rgba(82, 214, 255, ${0.45 + pulse * 0.25})`)
        gradSide.addColorStop(0.55, `rgba(255, 244, 118, ${0.14 + pulse * 0.12})`)
        gradSide.addColorStop(1, 'rgba(255, 255, 255, 0)')
        ctx.fillStyle = gradSide
        ctx.fillRect(0, 0, border * 3, canvas.height)
        ctx.save()
        ctx.translate(canvas.width, 0)
        ctx.scale(-1, 1)
        ctx.fillRect(0, 0, border * 3, canvas.height)
        ctx.restore()
        for (let i = 0; i < 34; i++) {
            const side = i % 4
            const phase = t * (2.4 + (i % 5) * 0.28) + i * 1.7
            const edgePos = (Math.sin(phase) * 0.5 + 0.5)
            const inset = 10 + (i % 4) * 12
            const x = side === 0 ? edgePos * canvas.width : side === 1 ? canvas.width - inset : side === 2 ? edgePos * canvas.width : inset
            const y = side === 0 ? inset : side === 1 ? edgePos * canvas.height : side === 2 ? canvas.height - inset : edgePos * canvas.height
            const r = 2.2 + (i % 3) * 1.2
            ctx.fillStyle = `rgba(255, 255, 210, ${0.35 + pulse * 0.45})`
            ctx.beginPath()
            ctx.moveTo(x, y - r * 2)
            ctx.lineTo(x + r * 0.72, y - r * 0.72)
            ctx.lineTo(x + r * 2, y)
            ctx.lineTo(x + r * 0.72, y + r * 0.72)
            ctx.lineTo(x, y + r * 2)
            ctx.lineTo(x - r * 0.72, y + r * 0.72)
            ctx.lineTo(x - r * 2, y)
            ctx.lineTo(x - r * 0.72, y - r * 0.72)
            ctx.closePath()
            ctx.fill()
        }
        ctx.restore()
    }

    private renderGameFlowOverlay() {
        const { ctx, canvas } = this
        const w = canvas.width
        const h = canvas.height
        let title = ''
        let copy = ''
        if (this.gameFlow.phase === 'handoff') {
            title = '次の人と交代してください'
            copy = '交代したら、お絵描き画面の「はじめる」を押してください'
        } else if (this.gameFlow.phase === 'difficulty') {
            title = '難易度を選択してください'
            copy = 'お絵描き画面でイージー・ノーマル・ハード・チャレンジを選びます'
        } else if (this.gameFlow.phase === 'tutorial') {
            ctx.save()
            ctx.textAlign = 'left'
            ctx.textBaseline = 'top'
            ctx.shadowColor = 'rgba(0, 0, 0, 0.75)'
            ctx.shadowBlur = 8
            ctx.fillStyle = 'rgba(255, 242, 122, 0.9)'
            ctx.font = `900 ${Math.round(Math.max(20, Math.min(30, w * 0.024)))}px "Hiragino Sans", "Yu Gothic", sans-serif`
            ctx.fillText('チュートリアル', 26, 26)
            ctx.restore()
            return
        } else if (this.gameFlow.phase === 'tutorial_done') {
            title = 'チュートリアル終了'
            copy = 'お絵描き画面の「ゲームを始める」を押してください'
        } else {
            return
        }
        const panelW = Math.min(w * 0.78, 900)
        const panelH = Math.min(h * 0.36, 320)
        const x = w / 2 - panelW / 2
        const y = h / 2 - panelH / 2
        ctx.save()
        ctx.fillStyle = 'rgba(4, 8, 18, 0.66)'
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
        ctx.beginPath()
        ctx.roundRect(x, y, panelW, panelH, 28)
        ctx.fill()
        ctx.strokeStyle = 'rgba(255, 242, 122, 0.42)'
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.shadowColor = 'rgba(0, 0, 0, 0.7)'
        ctx.shadowBlur = 10
        ctx.fillStyle = '#fff27a'
        ctx.font = `900 ${Math.round(Math.max(32, Math.min(58, w * 0.048)))}px "Hiragino Sans", "Yu Gothic", sans-serif`
        ctx.fillText(title, w / 2, h / 2 - 36)
        ctx.shadowBlur = 0
        ctx.fillStyle = 'rgba(255, 248, 215, 0.9)'
        ctx.font = `800 ${Math.round(Math.max(20, Math.min(32, w * 0.026)))}px "Hiragino Sans", "Yu Gothic", sans-serif`
        ctx.fillText(copy, w / 2, h / 2 + 42)
        ctx.restore()
    }

    private renderHUD() {
        const { ctx, canvas } = this
        const pad = 24
        const hudSize = Math.round(Math.max(24, Math.min(34, Math.min(canvas.width, canvas.height) * 0.034)))
        const topY = Math.max(34, hudSize + 10)

        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.8)'
        ctx.shadowBlur = 4
        ctx.font = `900 ${hudSize}px monospace`
        ctx.textBaseline = 'middle'

        ctx.textAlign = 'center'
        const bossConfigs = this.config.enemies.filter((enemy) => enemy.enabled && enemy.isBoss)
        const nextBoss = bossConfigs
            .filter((enemy) => !this.spawnedBossIds.has(enemy.id))
            .sort((left, right) => left.spawnStart - right.spawnStart)[0]
        const bossActive = this.enemies.some((enemy) => enemy.isBoss && !enemy.markedForDeletion)
        const timeToGo = nextBoss ? Math.max(0, nextBoss.spawnStart - this.elapsed) : 0
        if (this.gameFlow.phase === 'playing' && nextBoss && timeToGo <= 30 && timeToGo > 0) {
            ctx.fillStyle = '#ff6600'
            ctx.fillText(`BOSS  ${Math.ceil(timeToGo)}s`, canvas.width / 2, topY)
        } else if (bossActive && !this.gameClear) {
            ctx.fillStyle = '#ff2222'
            ctx.fillText('BOSS!', canvas.width / 2, topY)
        } else {
            ctx.fillStyle = '#aad4ff'
            ctx.fillText(`${Math.floor(this.elapsed)}s`, canvas.width / 2, topY)
        }

        ctx.textAlign = 'right'
        let hearts = ''
        for (let i = 0; i < PLAYER_MAX_HP; i++) {
            hearts += i < this.hp ? '♥' : '♡'
        }
        ctx.fillStyle = '#ff4466'
        const heartSize = Math.round(Math.max(42, Math.min(62, Math.min(canvas.width, canvas.height) * 0.058)))
        ctx.font = `900 ${heartSize}px monospace`
        ctx.fillText(hearts, canvas.width - pad, topY)

        ctx.restore()
    }

    private renderBossHealthBar(cx: number, cy: number, size: number, enemy: SpaceEnemy) {
        const hp = enemy.bossHp ?? BOSS_MAX_HP
        const maxHp = enemy.bossMaxHp ?? BOSS_MAX_HP
        const barW = size * 0.88
        const barH = 12
        const x = cx - barW / 2
        const y = cy + size / 2 + 8
        const { ctx } = this
        ctx.save()
        ctx.fillStyle = 'rgba(0,0,0,0.55)'
        ctx.beginPath()
        ctx.roundRect(x - 2, y - 2, barW + 4, barH + 4, 6)
        ctx.fill()
        const ratio = Math.max(0, hp / maxHp)
        const hue = ratio * 120
        ctx.fillStyle = `hsl(${hue},90%,48%)`
        ctx.beginPath()
        ctx.roundRect(x, y, barW * ratio, barH, 4)
        ctx.fill()
        ctx.restore()
    }
}
