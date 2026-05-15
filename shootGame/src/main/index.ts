import { app, BrowserWindow, ipcMain } from 'electron'
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { extname, join, resolve } from 'path'
import { createInterface, Interface } from 'readline'

// Suppress the warning on macOS about secure restorable state, as we don't need it for this game.
// This is a known Electron console noise issue.
if (process.platform === 'darwin') {
    app.commandLine.appendSwitch('disable-features', 'IOSurfaceCapturer') // Unrelated but sometimes helpful
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// The specific warning "Opt-in to secure coding explicitly..." is best ignored or handled by newer Electron.
// To silence it, we can't easily do it from JS without native modules, but we can ensure we don't crash.
// However, adding a specific internal field sometimes works, but let's stick to standard practice:
// Just ensure the app handles the ready event correctly.

const distPath = join(__dirname, '../dist')
process.env.DIST = distPath
process.env.PUBLIC = app.isPackaged ? distPath : join(distPath, '../public')

let win: BrowserWindow | null
let controlServer: Server | null = null

const GAME_CONTROL_PORT = 8030
const REMOTE_DRAW_FRAME_WIDTH = 800
const REMOTE_DRAW_FRAME_HEIGHT = 450
const REMOTE_DRAW_PROCESSING_WIDTH = 280
const REMOTE_DRAW_PROCESSING_HEIGHT = Math.max(
    1,
    Math.round((REMOTE_DRAW_FRAME_HEIGHT / REMOTE_DRAW_FRAME_WIDTH) * REMOTE_DRAW_PROCESSING_WIDTH),
)
const gameControlState = {
    paused: false,
}
const controlLogs: string[] = []
const remotePredictSessions = new Map<string, RemotePredictSession>()
const remoteShotQueue: QueuedRemoteShot[] = []
let nextRemotePredictionId = 0
let nextRemoteShotId = 0
let feverUntil = 0
let tutorialState = { index: 0, token: 0 }
let nextUiSoundEventId = 0
const uiSoundEvents: Array<{ id: number; key: string }> = []
const bossMirrorState: {
    drawImage: string | null
    gameImage: string | null
    drawUpdatedAt: number
    gameUpdatedAt: number
} = {
    drawImage: null,
    gameImage: null,
    drawUpdatedAt: 0,
    gameUpdatedAt: 0,
}
let spaceRestartSignal = 0
let gameFlowState: GameFlowState = {
    phase: 'playing',
    result: null,
    difficulty: 'normal',
    signal: Date.now(),
    totalPlaySeconds: 0,
    attemptCount: 0,
    shouldHandoff: false,
}
const remoteDrawConfig = {
    realtimeIntervalMs: 50,
    generatedBorderThreshold: 0.35,
    generatedAlphaThreshold: 0.5,
}
const remotePredictDurations: number[] = []
const gameResultState: GameResultState = {
    status: 'playing',
    currentEntryId: null,
    counts: null,
}

type SpaceEnemyType = 'normal' | 'apple' | 'banana' | 'grape' | 'boss'
type SpaceEnemyRequirement = 'apple' | 'banana' | 'grape' | null
type SmallStaticFruitType = 'berry' | 'lemon' | 'peach'
type StaticFruitType = SmallStaticFruitType | 'dorian'
type FruitName = 'banana' | 'apple' | 'grape' | StaticFruitType
type GameFlowPhase = 'playing' | 'ended' | 'handoff' | 'difficulty' | 'tutorial' | 'tutorial_done'
type GameDifficulty = 'easy' | 'normal' | 'hard' | 'challenge'
type SpaceDifficultyMode = 'all' | GameDifficulty
type GameFlowState = {
    phase: GameFlowPhase
    result: 'clear' | 'over' | null
    difficulty: GameDifficulty
    signal: number
    totalPlaySeconds: number
    attemptCount: number
    shouldHandoff: boolean
}

type SpaceEnemyConfig = {
    id: string
    label: string
    enabled: boolean
    imagePath: string
    requiredFruit: SpaceEnemyRequirement
    isBoss: boolean
    hasHp: boolean
    hp: number
    difficultyMode: SpaceDifficultyMode
    spawnInterval: number
    spawnStart: number
    spawnEnd: number
    spawnRateChange: number
    sizeScale: number
    speedScale: number
}

type SpaceSpeedConfig = {
    initialSpeed: number
    maxSpeed: number
}

type SpaceGameConfig = {
    enemies: SpaceEnemyConfig[]
    speedConfig: SpaceSpeedConfig
}

type SpaceGameConfigSet = Record<GameDifficulty, SpaceGameConfig>
type BossDefeatCounts = Record<GameDifficulty, number>

type LegacySpaceGameConfig = {
    enemyTypes?: Record<SpaceEnemyType, Partial<SpaceEnemyConfig>>
    speedConfig?: Partial<SpaceSpeedConfig>
}

type SpaceConfigPreset = {
    id: string
    name: string
    createdAt: string
    config: SpaceGameConfig
}

const DEFAULT_SPACE_GAME_CONFIG: SpaceGameConfig = {
    enemies: [
        { id: 'normal', label: 'ノーマル', enabled: true, imagePath: 'enemy/normal_enemy.png', requiredFruit: null, isBoss: false, hasHp: false, hp: 1, difficultyMode: 'all', spawnInterval: 6.0, spawnStart: 0, spawnEnd: 0, spawnRateChange: -0.20, sizeScale: 1.0, speedScale: 1.0 },
        { id: 'apple', label: 'りんご専用', enabled: true, imagePath: 'enemy/apple_enemy.png', requiredFruit: 'apple', isBoss: false, hasHp: false, hp: 1, difficultyMode: 'all', spawnInterval: 12.0, spawnStart: 15, spawnEnd: 0, spawnRateChange: -0.20, sizeScale: 1.0, speedScale: 1.0 },
        { id: 'banana', label: 'バナナ専用', enabled: true, imagePath: 'enemy/banana_enemy.png', requiredFruit: 'banana', isBoss: false, hasHp: false, hp: 1, difficultyMode: 'all', spawnInterval: 12.0, spawnStart: 15, spawnEnd: 0, spawnRateChange: -0.20, sizeScale: 1.0, speedScale: 1.0 },
        { id: 'grape', label: 'ぶどう専用', enabled: true, imagePath: 'enemy/grape_enemy.png', requiredFruit: 'grape', isBoss: false, hasHp: false, hp: 1, difficultyMode: 'all', spawnInterval: 15.0, spawnStart: 20, spawnEnd: 0, spawnRateChange: -0.20, sizeScale: 1.0, speedScale: 1.0 },
        { id: 'boss', label: 'ボス', enabled: true, imagePath: 'enemy/boss_enemy.png', requiredFruit: null, isBoss: true, hasHp: true, hp: 20, difficultyMode: 'all', spawnInterval: 0, spawnStart: 120, spawnEnd: 0, spawnRateChange: 0, sizeScale: 1.5, speedScale: 0.6 },
    ],
    speedConfig: { initialSpeed: 14, maxSpeed: 44 },
}

const cloneDefaultSpaceGameConfig = (): SpaceGameConfig => JSON.parse(JSON.stringify(DEFAULT_SPACE_GAME_CONFIG)) as SpaceGameConfig
const cloneDefaultSpaceGameConfigSet = (): SpaceGameConfigSet => ({
    easy: cloneDefaultSpaceGameConfig(),
    normal: cloneDefaultSpaceGameConfig(),
    hard: cloneDefaultSpaceGameConfig(),
    challenge: cloneDefaultSpaceGameConfig(),
})

let spaceGameConfigs: SpaceGameConfigSet = cloneDefaultSpaceGameConfigSet()
let bossDefeatCounts: BossDefeatCounts = { easy: 0, normal: 0, hard: 0, challenge: 0 }

const GAME_DIFFICULTIES: GameDifficulty[] = ['easy', 'normal', 'hard', 'challenge']
const DIFFICULTY_LABELS: Record<GameDifficulty, string> = {
    easy: 'イージー',
    normal: 'ノーマル',
    hard: 'ハード',
    challenge: 'チャレンジ',
}

const legacyEnemyImagePath: Record<SpaceEnemyType, string> = {
    normal: 'enemy/normal_enemy.png',
    apple: 'enemy/apple_enemy.png',
    banana: 'enemy/banana_enemy.png',
    grape: 'enemy/grape_enemy.png',
    boss: 'enemy/boss_enemy.png',
}

const legacyEnemyLabel: Record<SpaceEnemyType, string> = {
    normal: 'ノーマル',
    apple: 'りんご専用',
    banana: 'バナナ専用',
    grape: 'ぶどう専用',
    boss: 'ボス',
}

const inferEnemyRequirement = (imagePath: string): SpaceEnemyRequirement => {
    const lower = imagePath.toLowerCase()
    if (lower.includes('apple')) return 'apple'
    if (lower.includes('banana')) return 'banana'
    if (lower.includes('grape')) return 'grape'
    return null
}

const clampFinite = (value: unknown, fallback: number, min: number, max: number): number => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return fallback
    return Math.max(min, Math.min(max, numeric))
}

const normalizeDifficultyMode = (value: unknown): SpaceDifficultyMode => {
    return value === 'easy' || value === 'normal' || value === 'hard' || value === 'challenge' ? value : 'all'
}

const normalizeSpaceGameConfig = (incoming: unknown): SpaceGameConfig => {
    const src = (incoming && typeof incoming === 'object') ? incoming as Partial<SpaceGameConfig> & LegacySpaceGameConfig : {}
    const defaultConfig = JSON.parse(JSON.stringify(DEFAULT_SPACE_GAME_CONFIG)) as SpaceGameConfig
    const speedSrc = (src.speedConfig ?? {}) as Partial<SpaceSpeedConfig>
    const speedConfig: SpaceSpeedConfig = {
        initialSpeed: clampFinite(speedSrc.initialSpeed, defaultConfig.speedConfig.initialSpeed, 1, 2000),
        maxSpeed: clampFinite(speedSrc.maxSpeed, defaultConfig.speedConfig.maxSpeed, 1, 2000),
    }
    const rawEnemies = Array.isArray(src.enemies)
        ? src.enemies
        : (Object.keys(src.enemyTypes ?? {}) as SpaceEnemyType[]).map((type) => ({
            id: type,
            label: legacyEnemyLabel[type] ?? type,
            imagePath: legacyEnemyImagePath[type] ?? 'enemy/normal_enemy.png',
            requiredFruit: inferEnemyRequirement(legacyEnemyImagePath[type] ?? ''),
            isBoss: type === 'boss',
            hasHp: type === 'boss',
            hp: type === 'boss' ? 20 : 1,
            difficultyMode: 'all' as SpaceDifficultyMode,
            sizeScale: type === 'boss' ? 1.5 : 1.0,
            speedScale: type === 'boss' ? 0.6 : 1.0,
            ...src.enemyTypes?.[type],
        }))
    const enemies = rawEnemies.map((raw, index) => {
        const item = raw as Partial<SpaceEnemyConfig>
        const imagePath = typeof item.imagePath === 'string' && item.imagePath.startsWith('enemy/') ? item.imagePath : 'enemy/normal_enemy.png'
        const isBoss = Boolean(item.isBoss)
        const hasHp = item.hasHp != null ? Boolean(item.hasHp) : isBoss
        const fallbackId = `enemy-${index + 1}`
        const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 80) : fallbackId
        return {
            id,
            label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 80) : id,
            enabled: item.enabled !== false,
            imagePath,
            requiredFruit: inferEnemyRequirement(imagePath),
            isBoss,
            hasHp,
            hp: clampFinite(item.hp, isBoss ? 20 : 1, 1, 500),
            difficultyMode: normalizeDifficultyMode(item.difficultyMode),
            spawnInterval: clampFinite(item.spawnInterval, isBoss ? 0 : 10, 0, 60),
            spawnStart: clampFinite(item.spawnStart, 0, 0, 600),
            spawnEnd: clampFinite(item.spawnEnd, 0, 0, 600),
            spawnRateChange: clampFinite(item.spawnRateChange, 0, -10, 10),
            sizeScale: clampFinite(item.sizeScale, isBoss ? 1.5 : 1, 0.1, 5),
            speedScale: clampFinite(item.speedScale, isBoss ? 0.6 : 1, 0.05, 5),
        }
    })
    return { enemies: enemies.length > 0 ? enemies : defaultConfig.enemies, speedConfig }
}

const isSpaceGameConfigSetShape = (incoming: unknown): incoming is Partial<SpaceGameConfigSet> => {
    return Boolean(
        incoming
        && typeof incoming === 'object'
        && ('easy' in incoming || 'normal' in incoming || 'hard' in incoming),
    )
}

const normalizeSpaceGameConfigSet = (incoming: unknown): SpaceGameConfigSet => {
    if (isSpaceGameConfigSetShape(incoming)) {
        return {
            easy: normalizeSpaceGameConfig(incoming.easy),
            normal: normalizeSpaceGameConfig(incoming.normal),
            hard: normalizeSpaceGameConfig(incoming.hard),
            challenge: normalizeSpaceGameConfig(incoming.challenge),
        }
    }
    const config = normalizeSpaceGameConfig(incoming)
    return {
        easy: normalizeSpaceGameConfig(config),
        normal: normalizeSpaceGameConfig(config),
        hard: normalizeSpaceGameConfig(config),
        challenge: normalizeSpaceGameConfig(config),
    }
}

const getActiveSpaceGameConfig = (): SpaceGameConfig => spaceGameConfigs[gameFlowState.difficulty] ?? spaceGameConfigs.normal


type PredictRequest = {
    image: string
    sketch_overlay: string
    bbox: {
        left: number
        top: number
        right: number
        bottom: number
        width: number
        height: number
    }
    image_id: string
    fruit_name: string
    judge_mode: string
    predict_mode?: 'generated' | 'judge' | 'shape_match'
    generated_variant?: 'banana_400' | 'apple_512' | 'grape_400'
    banana_postprocess?: boolean
    keep_largest?: boolean
    alpha_keep_largest?: boolean
    apple_skip_inner_alpha?: boolean
    apple_skip_radial_variance?: boolean
    apple_radial_variance_threshold?: number
    non_alpha_mode?: boolean
    apple_align_input_fill?: boolean
    static_fruit_name?: StaticFruitType
    border_threshold?: number
    alpha_threshold?: number
    canvas_width: number
    canvas_height: number
}

type PredictResponse = {
    stage_image?: string
    composite_image?: string
    structure_preview_image?: string
    border_preview_image?: string
    cleaned_border_preview_image?: string
    image_id?: string
    bullet_assets?: Array<{
        image: string
        origin_x: number
        origin_y: number
        width: number
        height: number
        source_width?: number
        source_height?: number
        fruit_name?: FruitName
        image_id?: string
    }>
    components?: Array<{
        fruit_name?: FruitName
        image_id?: string
    }>
    generated_crop?: {
        left: number
        top: number
        right: number
        bottom: number
        size: number
    }
    generator_thresholds?: {
        border_threshold: number
        alpha_threshold: number
    }
    generated_variant?: 'banana_400' | 'apple_512' | 'grape_400'
    banana_postprocess?: boolean
    keep_largest?: boolean
    non_alpha_mode?: boolean
    apple_align_input_fill?: boolean
    skipped?: boolean
    skip_reason?: string
    centroid_canvas?: { x: number, y: number }
    pipeline_timings?: Record<string, number>
    profiling?: Record<string, number>
}

type RemotePredictPayload = PredictRequest & {
    session_id: string
    frame_width: number
    frame_height: number
}

type RemotePredictSession = {
    predictionId: number
    result: PredictResponse
    frameWidth: number
    frameHeight: number
    processingWidth: number
    processingHeight: number
    updatedAt: number
}

type QueuedRemoteShot = {
    id: number
    image_id?: string
    bullet_assets?: PredictResponse['bullet_assets']
    processing_width: number
    processing_height: number
    frame_width: number
    frame_height: number
    launch_x?: number
    launch_y?: number
    launch_vx?: number
    launch_vy?: number
}

type FruitCounts = {
    banana: number
    apple: number
    grape: number
}

type RankingEntry = {
    id: string
    playedAt: string
    counts: FruitCounts
    total: number
    name?: string
}

type GameResultState = {
    status: 'playing' | 'ended'
    currentEntryId: string | null
    counts: FruitCounts | null
}

type GameResultStateRequest = GameResultState & {
    persistRanking?: boolean
}

type RemoteDrawStats = {
    current_interval_ms: number
    generated_border_threshold: number
    generated_alpha_threshold: number
    latest_total_ms: number | null
    average_total_ms: number | null
    sample_count: number
    utilization_ratio: number | null
    recommendation: string
}

const getRankingFilePath = () => join(app.getPath('userData'), 'fruit-rankings.json')
const getSpaceConfigFilePath = () => join(app.getPath('userData'), 'space-game-config.json')
const getSpaceConfigPresetsFilePath = () => join(app.getPath('userData'), 'space-game-config-presets.json')
const getBossDefeatCountsFilePath = () => join(app.getPath('userData'), 'boss-defeat-counts.json')

const readSpaceConfigFromDisk = (): SpaceGameConfigSet => {
    const filePath = getSpaceConfigFilePath()
    if (!existsSync(filePath)) return cloneDefaultSpaceGameConfigSet()
    try {
        return normalizeSpaceGameConfigSet(JSON.parse(readFileSync(filePath, 'utf-8')))
    } catch (error) {
        console.error('Could not read space game config.', error)
        return cloneDefaultSpaceGameConfigSet()
    }
}

const writeSpaceConfigToDisk = (config: SpaceGameConfigSet) => {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(getSpaceConfigFilePath(), JSON.stringify(config, null, 2), 'utf-8')
}

const normalizeBossDefeatCounts = (incoming: unknown): BossDefeatCounts => {
    const source = incoming && typeof incoming === 'object' ? incoming as Partial<Record<GameDifficulty, unknown>> : {}
    return {
        easy: clampFinite(source.easy, 0, 0, 999999),
        normal: clampFinite(source.normal, 0, 0, 999999),
        hard: clampFinite(source.hard, 0, 0, 999999),
        challenge: clampFinite(source.challenge, 0, 0, 999999),
    }
}

const readBossDefeatCountsFromDisk = (): BossDefeatCounts => {
    const filePath = getBossDefeatCountsFilePath()
    if (!existsSync(filePath)) return normalizeBossDefeatCounts(null)
    try {
        return normalizeBossDefeatCounts(JSON.parse(readFileSync(filePath, 'utf-8')))
    } catch (error) {
        console.error('Could not read boss defeat counts.', error)
        return normalizeBossDefeatCounts(null)
    }
}

const writeBossDefeatCountsToDisk = (counts: BossDefeatCounts) => {
    mkdirSync(app.getPath('userData'), { recursive: true })
    bossDefeatCounts = normalizeBossDefeatCounts(counts)
    writeFileSync(getBossDefeatCountsFilePath(), JSON.stringify(bossDefeatCounts, null, 2), 'utf-8')
}

const readSpaceConfigPresets = (): SpaceConfigPreset[] => {
    const filePath = getSpaceConfigPresetsFilePath()
    if (!existsSync(filePath)) return []
    try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
        if (!Array.isArray(data)) return []
        return data.filter((entry): entry is SpaceConfigPreset => (
            Boolean(entry)
            && typeof entry === 'object'
            && typeof (entry as SpaceConfigPreset).id === 'string'
            && typeof (entry as SpaceConfigPreset).name === 'string'
            && Boolean((entry as SpaceConfigPreset).config)
        )).map((entry) => ({ ...entry, config: normalizeSpaceGameConfig(entry.config) }))
    } catch (error) {
        console.error('Could not read space config presets.', error)
        return []
    }
}

const writeSpaceConfigPresets = (presets: SpaceConfigPreset[]) => {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(getSpaceConfigPresetsFilePath(), JSON.stringify(presets, null, 2), 'utf-8')
}

const listEnemyImagePaths = (): string[] => {
    const enemyDir = resolve(__dirname, '../../space_data/enemy')
    try {
        return readdirSync(enemyDir)
            .filter((name) => /\.(png|webp|jpe?g)$/i.test(name))
            .sort((a, b) => a.localeCompare(b))
            .map((name) => `enemy/${name}`)
    } catch {
        return DEFAULT_SPACE_GAME_CONFIG.enemies.map((enemy) => enemy.imagePath)
    }
}

const readRankings = (): RankingEntry[] => {
    const rankingFilePath = getRankingFilePath()
    if (!existsSync(rankingFilePath)) {
        return []
    }

    try {
        const data = JSON.parse(readFileSync(rankingFilePath, 'utf-8')) as unknown
        if (!Array.isArray(data)) {
            return []
        }

        return data.filter((entry): entry is RankingEntry => (
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
        console.error('Could not read rankings.', error)
        return []
    }
}

const writeRankings = (entries: RankingEntry[]) => {
    const rankingFilePath = getRankingFilePath()
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(rankingFilePath, JSON.stringify(entries, null, 2), 'utf-8')
    win?.webContents.send('ranking:changed', entries)
}

const createRankingEntry = (counts: FruitCounts): RankingEntry => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    playedAt: new Date().toISOString(),
    counts,
    total: counts.banana + counts.apple + counts.grape,
})

const getRankingDisplayName = (entry: RankingEntry) => {
    const name = entry.name?.trim()
    return name || 'なまえなし'
}

const sanitizeRankingName = (value: unknown) => {
    if (typeof value !== 'string') {
        return ''
    }
    return value.trim().replace(/\s+/g, ' ').slice(0, 12)
}

const getSortedRankings = (entries: RankingEntry[], metric: keyof FruitCounts | 'total') => (
    [...entries].sort((left, right) => {
        const leftValue = metric === 'total' ? left.total : left.counts[metric]
        const rightValue = metric === 'total' ? right.total : right.counts[metric]
        if (rightValue !== leftValue) {
            return rightValue - leftValue
        }
        return left.playedAt.localeCompare(right.playedAt)
    })
)

const updateRankingNameIfTotalTopThree = (entryId: string, name: string) => {
    const entries = readRankings()
    const rankIndex = getSortedRankings(entries, 'total').findIndex((entry) => entry.id === entryId)
    if (rankIndex < 0 || rankIndex >= 3) {
        return { ok: false, entries, error: 'Entry is not in total top three.' }
    }
    const sanitizedName = sanitizeRankingName(name)
    if (!sanitizedName) {
        return { ok: false, entries, error: 'Name is required.' }
    }
    const updatedEntries = entries.map((entry) => (
        entry.id === entryId ? { ...entry, name: sanitizedName } : entry
    ))
    writeRankings(updatedEntries)
    return { ok: true, entries: updatedEntries, error: null }
}

const resetRankings = () => {
    writeRankings([])
    setGameResultState({
        status: 'playing',
        currentEntryId: null,
        counts: null,
    })
    appendControlLog('rankings reset')
    return readRankings()
}

const setGameResultState = (state: GameResultState) => {
    gameResultState.status = state.status
    gameResultState.currentEntryId = state.currentEntryId
    gameResultState.counts = state.counts
    appendControlLog(
        `game-result state=${state.status} entry=${state.currentEntryId ?? '-'} counts=${state.counts ? JSON.stringify(state.counts) : '-'}`,
    )
}

type WorkerReadyReply = { type: 'ready' }
type WorkerSuccessReply = { id: number; ok: true; result: PredictResponse }
type WorkerErrorReply = { id: number | null; ok: false; error: string; profiling?: Record<string, number> }
type WorkerReply = WorkerReadyReply | WorkerSuccessReply | WorkerErrorReply

class PythonPredictWorker {
    private process: ChildProcessWithoutNullStreams | null = null
    private stdoutReader: Interface | null = null
    private nextRequestId = 0
    private pending = new Map<
        number,
        {
            resolve: (value: PredictResponse) => void
            reject: (reason?: unknown) => void
            startedAt: number
            writeCompletedAt: number
        }
    >()
    private startupPromise: Promise<void> | null = null
    private readyResolver: (() => void) | null = null

    async predict(payload: PredictRequest): Promise<PredictResponse> {
        await this.ensureStarted()

        return await new Promise<PredictResponse>((resolvePromise, rejectPromise) => {
            const requestId = ++this.nextRequestId
            const startedAt = performance.now()
            this.pending.set(requestId, {
                resolve: resolvePromise,
                reject: rejectPromise,
                startedAt,
                writeCompletedAt: startedAt,
            })

            try {
                this.process?.stdin.write(`${JSON.stringify({ id: requestId, payload })}\n`)
                const pending = this.pending.get(requestId)
                if (pending) {
                    pending.writeCompletedAt = performance.now()
                }
            } catch (error) {
                this.pending.delete(requestId)
                rejectPromise(error)
            }
        })
    }

    dispose() {
        this.rejectAll(new Error('Python predictor stopped'))
        this.stdoutReader?.close()
        this.stdoutReader = null
        if (this.process) {
            this.process.kill()
            this.process = null
        }
        this.startupPromise = null
    }

    private async ensureStarted(): Promise<void> {
        if (this.process) {
            return
        }
        if (!this.startupPromise) {
            this.startupPromise = this.start()
        }
        await this.startupPromise
    }

    private async start(): Promise<void> {
        const projectRoot = resolve(__dirname, '../..')
        const workerScript = join(projectRoot, 'src', 'electron_predict_worker.py')
        if (!existsSync(workerScript)) {
            throw new Error(`Predict worker script not found: ${workerScript}`)
        }

        const commands = [
            join(projectRoot, 'venv', 'bin', 'python'),
            process.env.PYTHON_EXECUTABLE,
            'python3',
            'python',
        ].filter(
            (value): value is string => Boolean(value),
        )
        let lastError: unknown = null

        for (const command of commands) {
            try {
                await this.spawnWorker(command, workerScript, projectRoot)
                return
            } catch (error) {
                lastError = error
            }
        }

        throw lastError ?? new Error('Could not start Python predictor')
    }

    private async spawnWorker(command: string, workerScript: string, projectRoot: string): Promise<void> {
        await new Promise<void>((resolvePromise, rejectPromise) => {
            const child = spawn(command, ['-u', workerScript], {
                cwd: projectRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            let settled = false
            const settleResolve = () => {
                if (settled) return
                settled = true
                resolvePromise()
            }
            const settleReject = (error: unknown) => {
                if (settled) return
                settled = true
                child.kill()
                rejectPromise(error)
            }

            child.once('spawn', () => {
                this.readyResolver = settleResolve
                this.attachProcess(child)
            })
            child.once('error', (error) => {
                settleReject(error)
            })
            child.once('exit', (code, signal) => {
                if (!settled) {
                    settleReject(new Error(`Python predictor exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
                }
            })
            child.stderr.on('data', (chunk) => {
                const text = chunk.toString().trim()
                if (text) {
                    console.error(`[python predictor] ${text}`)
                }
            })
        })
    }

    private attachProcess(child: ChildProcessWithoutNullStreams) {
        this.process = child
        this.stdoutReader = createInterface({ input: child.stdout })
        this.stdoutReader.on('line', (line) => {
            this.handleLine(line)
        })
        child.once('exit', (code, signal) => {
            const message = `Python predictor exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
            this.process = null
            this.stdoutReader?.close()
            this.stdoutReader = null
            this.startupPromise = null
            this.rejectAll(new Error(message))
        })
    }

    private handleLine(line: string) {
        if (!line.trim()) {
            return
        }

        let payload: WorkerReply
        try {
            payload = JSON.parse(line) as WorkerReply
        } catch (error) {
            console.error('Could not parse Python predictor response:', line, error)
            return
        }

        if ('type' in payload && payload.type === 'ready') {
            this.readyResolver?.()
            this.readyResolver = null
            return
        }

        const response = payload as WorkerSuccessReply | WorkerErrorReply

        if (response.id == null) {
            console.error('Python predictor returned an untracked error:', response)
            return
        }

        const pending = this.pending.get(response.id)
        if (!pending) {
            return
        }
        this.pending.delete(response.id)
        const resolvedAt = performance.now()
        const mainTimings = {
            main_total_ms: Number((resolvedAt - pending.startedAt).toFixed(3)),
            main_write_overhead_ms: Number((pending.writeCompletedAt - pending.startedAt).toFixed(3)),
            main_wait_for_worker_ms: Number((resolvedAt - pending.writeCompletedAt).toFixed(3)),
        }

        if (response.ok) {
            response.result.profiling = {
                ...(response.result.profiling ?? {}),
                ...mainTimings,
            }
            pending.resolve(response.result)
            return
        }

        pending.reject(
            new Error(
                `${response.error} ${JSON.stringify({
                    ...(response.profiling ?? {}),
                    ...mainTimings,
                })}`,
            ),
        )
    }

    private rejectAll(error: Error) {
        for (const { reject } of this.pending.values()) {
            reject(error)
        }
        this.pending.clear()
    }
}

const predictor = new PythonPredictWorker()

const appendControlLog = (message: string) => {
    const timestamp = new Date().toISOString()
    const line = `${timestamp} ${message}`
    controlLogs.push(line)
    if (controlLogs.length > 80) {
        controlLogs.shift()
    }
    console.log(`[game-control] ${line}`)
}

const pushRemotePredictDuration = (durationMs: number) => {
    remotePredictDurations.push(durationMs)
    if (remotePredictDurations.length > 40) {
        remotePredictDurations.shift()
    }
}

const buildRemoteDrawStats = (): RemoteDrawStats => {
    const sampleCount = remotePredictDurations.length
    const latest = sampleCount > 0 ? remotePredictDurations[sampleCount - 1] : null
    const average = sampleCount > 0
        ? Number((remotePredictDurations.reduce((sum, value) => sum + value, 0) / sampleCount).toFixed(1))
        : null
    const utilization = average != null
        ? Number((average / remoteDrawConfig.realtimeIntervalMs).toFixed(2))
        : null

    let recommendation = 'まだ推論サンプルがありません'
    if (utilization != null) {
        if (utilization >= 1.0) {
            recommendation = '更新頻度が速すぎます。間隔を長くした方が安定します'
        } else if (utilization >= 0.75) {
            recommendation = 'かなり攻めた設定です。軽い破綻ならこのまま、安定重視なら少し遅くします'
        } else if (utilization >= 0.45) {
            recommendation = 'おおむね適切です'
        } else {
            recommendation = '余裕があります。もっと短い間隔も試せます'
        }
    }

    return {
        current_interval_ms: remoteDrawConfig.realtimeIntervalMs,
        generated_border_threshold: remoteDrawConfig.generatedBorderThreshold,
        generated_alpha_threshold: remoteDrawConfig.generatedAlphaThreshold,
        latest_total_ms: latest != null ? Number(latest.toFixed(1)) : null,
        average_total_ms: average,
        sample_count: sampleCount,
        utilization_ratio: utilization,
        recommendation,
    }
}

const renderGameControlPage = () => {
    const configSetJson = JSON.stringify(spaceGameConfigs)
    const defaultConfigJson = JSON.stringify(DEFAULT_SPACE_GAME_CONFIG)
    const defaultConfigSetJson = JSON.stringify(cloneDefaultSpaceGameConfigSet())
    const enemyImageOptionsJson = JSON.stringify(listEnemyImagePaths())
    const presetsJson = JSON.stringify(readSpaceConfigPresets().map(({ id, name, createdAt }) => ({ id, name, createdAt })))
    const bossCountsJson = JSON.stringify(bossDefeatCounts)

    return `<!doctype html>
<html lang="ja">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Game Control — 難易度設定</title>
    <style>
        :root {
            color-scheme: light;
            --panel: rgba(255,251,245,0.97);
            --border: #d6cab8;
            --text: #2b241c;
            --accent: #2d6a4f;
            --accent-strong: #1f4b39;
            font-family: "Hiragino Sans","Yu Gothic",sans-serif;
        }
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; padding: 24px; background: linear-gradient(180deg,#f7f1e8 0%,#efe4d5 100%); color: var(--text); }
        h1 { margin: 0 0 6px; font-size: 1.4rem; }
        h2 { margin: 28px 0 10px; font-size: 1.05rem; color: #4a3e32; }
        .subtitle { margin: 0 0 22px; color: #6a5d50; font-size: 0.93rem; }
        .panel {
            background: var(--panel);
            border: 1px solid var(--border);
            border-radius: 20px;
            padding: 24px;
            box-shadow: 0 14px 36px rgba(60,44,26,.12);
            max-width: 1280px;
        }
        .enemy-list { display: grid; gap: 12px; }
        .enemy-row {
            display: grid;
            grid-template-columns: 82px minmax(110px, 1fr) minmax(150px, 1.5fr) repeat(3, minmax(64px, 0.55fr)) repeat(7, minmax(74px, 0.7fr)) 56px;
            gap: 8px;
            align-items: center;
            padding: 10px;
            border: 1px solid #e1d4c4;
            border-radius: 14px;
            background: #fffaf3;
        }
        .enemy-row.header {
            background: #f0e8db;
            color: #5a4e42;
            font-size: 0.78rem;
            font-weight: 900;
        }
        .enemy-preview { width: 54px; height: 54px; object-fit: contain; justify-self: center; }
        input.text, input.num, select {
            width: 100%; padding: 7px 9px; border: 1px solid #ccbda6;
            border-radius: 8px; font: inherit; font-size: 0.9rem;
            background: white;
        }
        input[type=checkbox] { width: 18px; height: 18px; cursor: pointer; accent-color: var(--accent); }
        .check-wrap { display: grid; place-items: center; }
        .speed-row {
            display: flex; flex-wrap: wrap; gap: 24px; align-items: center;
            padding: 16px; background: #f8f0e6; border-radius: 14px;
            border: 1px solid var(--border); margin-bottom: 8px;
        }
        .speed-field { display: flex; flex-direction: column; gap: 4px; }
        .speed-field label { font-size: 0.82rem; font-weight: 700; color: #5a4e42; }
        .actions { margin-top: 20px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
        .difficulty-tabs { display: flex; gap: 10px; margin: 18px 0 18px; flex-wrap: wrap; }
        .difficulty-tab { background: #d5c7b6; color: #44382d; padding: 12px 18px; }
        .difficulty-tab.active { background: linear-gradient(180deg,var(--accent),var(--accent-strong)); color: white; }
        button {
            appearance: none; border: none; border-radius: 14px;
            padding: 14px 22px; font: inherit; font-weight: 800;
            cursor: pointer; color: white;
            background: linear-gradient(180deg,var(--accent),var(--accent-strong));
        }
        button.reset-btn { background: linear-gradient(180deg,#8b5e3c,#6b4228); }
        button.danger-btn { background: linear-gradient(180deg,#9f2f2f,#7d2424); padding: 10px 12px; }
        button.secondary-btn { background: linear-gradient(180deg,#526070,#3c4654); }
        .preset-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px; }
        .preset-row input, .preset-row select { width: min(280px, 100%); }
        .boss-count-grid { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 12px; }
        .boss-count-card { background: #fff7ed; border: 1px solid #e1d4c4; border-radius: 14px; padding: 14px; display: grid; gap: 8px; }
        .boss-count-card strong { color: #493b2e; }
        .boss-count-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
        .boss-count-actions button { padding: 9px 8px; border-radius: 10px; font-size: 0.82rem; }
        #status { font-size: 0.92rem; color: #5a4e42; }
        .hint-row { margin-top: 18px; font-size: 0.84rem; color: #7a6d5b; line-height: 1.65; }
        a { color: var(--accent); }
    </style>
</head>
<body>
    <div class="panel">
        <h1>難易度設定</h1>
        <p class="subtitle">イージー・ノーマル・ハード・チャレンジそれぞれに、別々の敵セットを割り当てます。変更はゲーム内に10秒以内で反映されます。</p>

        <div class="difficulty-tabs">
            <button class="difficulty-tab active" data-difficulty-tab="easy" type="button">イージー用セット</button>
            <button class="difficulty-tab" data-difficulty-tab="normal" type="button">ノーマル用セット</button>
            <button class="difficulty-tab" data-difficulty-tab="hard" type="button">ハード用セット</button>
            <button class="difficulty-tab" data-difficulty-tab="challenge" type="button">チャレンジ用セット</button>
        </div>

        <h2>落下速度</h2>
        <div class="speed-row">
            <div class="speed-field">
                <label for="initialSpeedInput">初期速度 (px/秒)</label>
                <input id="initialSpeedInput" class="num" type="number" min="1" max="2000" step="1">
            </div>
            <div class="speed-field">
                <label for="maxSpeedInput">最大速度 (px/秒)</label>
                <input id="maxSpeedInput" class="num" type="number" min="1" max="2000" step="1">
            </div>
        </div>

        <h2>敵設定</h2>
        <div class="enemy-list" id="enemyList"></div>
        <div class="actions">
            <button class="secondary-btn" id="addEnemyBtn">敵を追加</button>
            <button id="saveBtn">保存する</button>
            <button class="reset-btn" id="resetBtn">デフォルトに戻す</button>
            <button class="danger-btn" id="restartGameBtn" style="background:linear-gradient(180deg,#c05a00,#8c3e00);padding:14px 22px;">ゲームをリスタート</button>
            <span id="status"></span>
        </div>
        <h2>設定セット</h2>
        <div class="preset-row">
            <input id="presetNameInput" class="text" type="text" placeholder="保存するセット名">
            <button id="savePresetBtn">セット保存</button>
        </div>
        <div class="preset-row">
            <select id="presetSelect"></select>
            <button class="secondary-btn" id="loadPresetBtn">セット読込</button>
            <button class="danger-btn" id="deletePresetBtn">セット削除</button>
        </div>
        <h2>ボス討伐数</h2>
        <div class="boss-count-grid" id="bossCountGrid"></div>
        <div class="actions">
            <button id="saveBossCountsBtn">討伐数を保存</button>
            <button class="reset-btn" id="resetBossCountsBtn">討伐数を全リセット</button>
            <a href="/boss" target="_blank">/boss 表示を開く</a>
        </div>
        <div class="hint-row">
            <b>初期速度 / 最大速度</b>: ゲーム開始時〜60秒後に向けて速度が増加する範囲 (px/秒)。<br>
            <b>画像</b>: enemyフォルダ内の画像を選択。同じ画像を複数の敵で使っても問題ありません。apple / banana / grape の画像は対応するフルーツだけ有効、それ以外は全フルーツ有効です。<br>
            <b>大きさ / 速度倍率</b>: 現在のばらつきやアニメーションを保ったまま、個別に倍率をかけます。<br>
            <b>体力</b>: チェックすると複数回ヒットで倒れる敵になり、体力ゲージが出ます。ブドウの散弾ダメージは通常弾の1/5です。<br>
            <b>ボス</b>: チェックすると出現開始秒に1体だけ出現し、倒すとゲームクリアになります。<br>
            <b>難易度セット</b>: 上のタブで選んでいる難易度だけを編集します。ゲーム開始時に選んだ難易度に対応するセットが使われます。
        </div>
        <div class="hint-row"><a href="/">← Game Control トップ</a></div>
    </div>
    <script>
        const DEFAULT_CONFIG = ${defaultConfigJson};
        const DEFAULT_CONFIG_SET = ${defaultConfigSetJson};
        const IMAGE_OPTIONS = ${enemyImageOptionsJson};
        const BUTTON_SOUND = '/api/voice/other/ボタン音.mp3';
        let buttonAudio = null;
        let currentDifficulty = 'easy';
        let currentConfigs = ${configSetJson};
        let currentConfig = currentConfigs[currentDifficulty];
        let bossCounts = ${bossCountsJson};
        let presets = ${presetsJson};
        const DIFFICULTY_LABELS = { easy: 'イージー', normal: 'ノーマル', hard: 'ハード', challenge: 'チャレンジ' };

        function playButtonSound() {
            try {
                if (!buttonAudio) {
                    buttonAudio = new Audio(BUTTON_SOUND);
                    buttonAudio.preload = 'auto';
                    buttonAudio.load();
                }
                buttonAudio.currentTime = 0;
                void buttonAudio.play();
            } catch {}
        }

        function imageRequirement(imagePath) {
            const lower = String(imagePath || '').toLowerCase();
            if (lower.includes('apple')) return 'apple';
            if (lower.includes('banana')) return 'banana';
            if (lower.includes('grape')) return 'grape';
            return null;
        }

        function escapeAttr(value) {
            return String(value ?? '').replace(/[&<>"']/g, function(ch) {
                return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
            });
        }

        function makeEnemy(overrides = {}) {
            const id = overrides.id || ('enemy-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
            const imagePath = overrides.imagePath || (IMAGE_OPTIONS[0] || 'enemy/normal_enemy.png');
            return {
                id,
                label: overrides.label || '追加敵',
                enabled: overrides.enabled !== false,
                imagePath,
                requiredFruit: imageRequirement(imagePath),
                isBoss: Boolean(overrides.isBoss),
                hasHp: Boolean(overrides.hasHp || overrides.isBoss),
                hp: Number(overrides.hp ?? (overrides.isBoss ? 20 : 1)),
                spawnInterval: Number(overrides.spawnInterval ?? 10),
                spawnStart: Number(overrides.spawnStart ?? 0),
                spawnEnd: Number(overrides.spawnEnd ?? 0),
                spawnRateChange: Number(overrides.spawnRateChange ?? 0),
                sizeScale: Number(overrides.sizeScale ?? 1),
                speedScale: Number(overrides.speedScale ?? 1),
            };
        }

        function renderPresets() {
            const select = document.getElementById('presetSelect');
            select.innerHTML = '';
            if (presets.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = '保存済みセットなし';
                select.appendChild(opt);
                return;
            }
            presets.forEach((preset) => {
                const opt = document.createElement('option');
                opt.value = preset.id;
                opt.textContent = preset.name;
                select.appendChild(opt);
            });
        }

        function renderBossCounts() {
            const grid = document.getElementById('bossCountGrid');
            grid.innerHTML = '';
            ['easy', 'normal', 'hard', 'challenge'].forEach((difficulty) => {
                const card = document.createElement('div');
                card.className = 'boss-count-card';
                card.innerHTML =
                    '<strong>' + DIFFICULTY_LABELS[difficulty] + '</strong>' +
                    '<input class="num" type="number" min="0" max="999999" step="1" data-boss-count="' + difficulty + '" value="' + Number(bossCounts[difficulty] || 0) + '">' +
                    '<div class="boss-count-actions">' +
                        '<button class="secondary-btn" type="button" data-boss-delta="' + difficulty + ':1">+1</button>' +
                        '<button class="secondary-btn" type="button" data-boss-delta="' + difficulty + ':-1">-1</button>' +
                        '<button class="danger-btn" type="button" data-boss-reset="' + difficulty + '">0</button>' +
                    '</div>';
                grid.appendChild(card);
            });
        }

        function syncBossCountsFromForm() {
            document.querySelectorAll('[data-boss-count]').forEach((input) => {
                const key = input.dataset.bossCount;
                bossCounts[key] = Math.max(0, Math.round(Number(input.value || 0)));
            });
            return bossCounts;
        }

        async function saveBossCounts() {
            const resp = await fetch('/api/boss-defeats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(syncBossCountsFromForm()),
            });
            const data = await resp.json();
            if (resp.ok) {
                bossCounts = data.counts || bossCounts;
                renderBossCounts();
                document.getElementById('status').textContent = '✓ 討伐数を保存しました';
            } else {
                document.getElementById('status').textContent = 'エラー: ' + (data.error || '保存失敗');
            }
        }

        function renderEnemies() {
            const list = document.getElementById('enemyList');
            list.innerHTML = '<div class="enemy-row header"><div>画像</div><div>名前</div><div>画像ファイル</div><div>有効</div><div>ボス</div><div>体力</div><div>HP</div><div>間隔</div><div>開始</div><div>終了</div><div>変化</div><div>大きさ</div><div>速度</div><div></div></div>';
            currentConfig.enemies.forEach((enemy, index) => {
                const row = document.createElement('div');
                row.className = 'enemy-row';
                row.dataset.index = String(index);
                const options = IMAGE_OPTIONS.map((path) => '<option value="' + escapeAttr(path) + '"' + (path === enemy.imagePath ? ' selected' : '') + '>' + escapeAttr(path.replace('enemy/', '')) + '</option>').join('');
                row.innerHTML =
                    '<img class="enemy-preview" src="/api/space-data/' + escapeAttr(enemy.imagePath) + '">' +
                    '<input class="text" data-field="label" value="' + escapeAttr(enemy.label) + '">' +
                    '<select data-field="imagePath">' + options + '</select>' +
                    '<label class="check-wrap"><input type="checkbox" data-field="enabled"' + (enemy.enabled ? ' checked' : '') + '></label>' +
                    '<label class="check-wrap"><input type="checkbox" data-field="isBoss"' + (enemy.isBoss ? ' checked' : '') + '></label>' +
                    '<label class="check-wrap"><input type="checkbox" data-field="hasHp"' + (enemy.hasHp ? ' checked' : '') + '></label>' +
                    '<input class="num" type="number" data-field="hp" value="' + (enemy.hp ?? (enemy.isBoss ? 20 : 1)) + '" min="1" max="500" step="1">' +
                    '<input class="num" type="number" data-field="spawnInterval" value="' + enemy.spawnInterval + '" min="0" max="60" step="0.1">' +
                    '<input class="num" type="number" data-field="spawnStart" value="' + enemy.spawnStart + '" min="0" max="600" step="1">' +
                    '<input class="num" type="number" data-field="spawnEnd" value="' + enemy.spawnEnd + '" min="0" max="600" step="1">' +
                    '<input class="num" type="number" data-field="spawnRateChange" value="' + enemy.spawnRateChange + '" min="-10" max="10" step="0.01">' +
                    '<input class="num" type="number" data-field="sizeScale" value="' + enemy.sizeScale + '" min="0.1" max="5" step="0.05">' +
                    '<input class="num" type="number" data-field="speedScale" value="' + enemy.speedScale + '" min="0.05" max="5" step="0.05">' +
                    '<button class="danger-btn" data-delete="' + index + '">削除</button>';
                list.appendChild(row);
            });
        }

        function syncConfigFromForm() {
            currentConfig.speedConfig = {
                initialSpeed: parseFloat(document.getElementById('initialSpeedInput').value),
                maxSpeed: parseFloat(document.getElementById('maxSpeedInput').value),
            };
            currentConfig.enemies = Array.from(document.querySelectorAll('#enemyList .enemy-row:not(.header)')).map((row) => {
                const index = Number(row.dataset.index);
                const enemy = { ...currentConfig.enemies[index] };
                row.querySelectorAll('[data-field]').forEach((field) => {
                    const key = field.dataset.field;
                    if (field.type === 'checkbox') enemy[key] = field.checked;
                    else if (field.tagName === 'SELECT' || key === 'label') enemy[key] = field.value;
                    else enemy[key] = parseFloat(field.value);
                });
                enemy.hasHp = Boolean(enemy.hasHp || enemy.isBoss);
                enemy.hp = Math.max(1, Number(enemy.hp || (enemy.isBoss ? 20 : 1)));
                enemy.requiredFruit = imageRequirement(enemy.imagePath);
                return enemy;
            });
            currentConfigs[currentDifficulty] = currentConfig;
            return currentConfig;
        }

        function setActiveDifficulty(difficulty, shouldSync = true) {
            if (shouldSync) syncConfigFromForm();
            currentDifficulty = difficulty;
            currentConfig = currentConfigs[currentDifficulty] || JSON.parse(JSON.stringify(DEFAULT_CONFIG));
            currentConfigs[currentDifficulty] = currentConfig;
            document.getElementById('initialSpeedInput').value = currentConfig.speedConfig.initialSpeed;
            document.getElementById('maxSpeedInput').value = currentConfig.speedConfig.maxSpeed;
            document.querySelectorAll('[data-difficulty-tab]').forEach((button) => {
                button.classList.toggle('active', button.dataset.difficultyTab === currentDifficulty);
            });
            renderEnemies();
        }

        async function save() {
            syncConfigFromForm();
            const resp = await fetch('/api/space-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(currentConfigs),
            });
            const data = await resp.json();
            const status = document.getElementById('status');
            if (resp.ok) {
                status.textContent = '✓ 保存しました';
                setTimeout(() => { status.textContent = ''; }, 2000);
            } else {
                status.textContent = 'エラー: ' + (data.error || '不明なエラー');
            }
        }

        function resetToDefault() {
            currentConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
            currentConfigs[currentDifficulty] = currentConfig;
            document.getElementById('initialSpeedInput').value = currentConfig.speedConfig.initialSpeed;
            document.getElementById('maxSpeedInput').value = currentConfig.speedConfig.maxSpeed;
            renderEnemies();
        }

        async function refreshPresets() {
            const resp = await fetch('/api/space-config-presets');
            const data = await resp.json();
            presets = data.presets || [];
            renderPresets();
        }

        async function savePreset() {
            const name = document.getElementById('presetNameInput').value.trim();
            if (!name) {
                document.getElementById('status').textContent = 'セット名を入力してください';
                return;
            }
            const resp = await fetch('/api/space-config-presets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, config: syncConfigFromForm() }),
            });
            const data = await resp.json();
            if (!resp.ok) {
                document.getElementById('status').textContent = 'エラー: ' + (data.error || '保存失敗');
                return;
            }
            document.getElementById('presetNameInput').value = '';
            presets = data.presets || [];
            renderPresets();
            document.getElementById('status').textContent = '✓ セット保存しました';
        }

        async function loadPreset() {
            const id = document.getElementById('presetSelect').value;
            if (!id) return;
            const resp = await fetch('/api/space-config-presets/' + encodeURIComponent(id));
            const data = await resp.json();
            if (!resp.ok) return;
            currentConfig = data.config;
            currentConfigs[currentDifficulty] = currentConfig;
            document.getElementById('initialSpeedInput').value = currentConfig.speedConfig.initialSpeed;
            document.getElementById('maxSpeedInput').value = currentConfig.speedConfig.maxSpeed;
            renderEnemies();
            await save();
        }

        async function deletePreset() {
            const id = document.getElementById('presetSelect').value;
            if (!id) return;
            const resp = await fetch('/api/space-config-presets/' + encodeURIComponent(id), { method: 'DELETE' });
            const data = await resp.json();
            presets = data.presets || [];
            renderPresets();
        }

        document.getElementById('enemyList').addEventListener('change', (event) => {
            const row = event.target.closest('.enemy-row');
            if (!row || row.classList.contains('header')) return;
            if (event.target.dataset.field === 'imagePath') {
                const img = row.querySelector('.enemy-preview');
                img.src = '/api/space-data/' + event.target.value;
            }
        });
        document.getElementById('enemyList').addEventListener('click', (event) => {
            const deleteIndex = event.target.dataset.delete;
            if (deleteIndex == null) return;
            syncConfigFromForm();
            currentConfig.enemies.splice(Number(deleteIndex), 1);
            renderEnemies();
        });
        document.getElementById('addEnemyBtn').addEventListener('click', () => {
            syncConfigFromForm();
            currentConfig.enemies.push(makeEnemy());
            renderEnemies();
        });
        document.getElementById('saveBtn').addEventListener('click', save);
        document.getElementById('resetBtn').addEventListener('click', () => {
            resetToDefault();
            save();
        });
        document.getElementById('savePresetBtn').addEventListener('click', savePreset);
        document.getElementById('loadPresetBtn').addEventListener('click', loadPreset);
        document.getElementById('deletePresetBtn').addEventListener('click', deletePreset);
        document.getElementById('saveBossCountsBtn').addEventListener('click', saveBossCounts);
        document.getElementById('resetBossCountsBtn').addEventListener('click', async () => {
            bossCounts = { easy: 0, normal: 0, hard: 0, challenge: 0 };
            renderBossCounts();
            await saveBossCounts();
        });
        document.getElementById('bossCountGrid').addEventListener('click', async (event) => {
            const deltaSpec = event.target.dataset && event.target.dataset.bossDelta;
            const resetKey = event.target.dataset && event.target.dataset.bossReset;
            if (deltaSpec) {
                syncBossCountsFromForm();
                const parts = deltaSpec.split(':');
                bossCounts[parts[0]] = Math.max(0, Math.round(Number(bossCounts[parts[0]] || 0) + Number(parts[1] || 0)));
                renderBossCounts();
                await saveBossCounts();
            } else if (resetKey) {
                syncBossCountsFromForm();
                bossCounts[resetKey] = 0;
                renderBossCounts();
                await saveBossCounts();
            }
        });
        document.getElementById('restartGameBtn').addEventListener('click', async () => {
            const statusEl = document.getElementById('status');
            statusEl.textContent = 'リスタート中...';
            try {
                const resp = await fetch('/api/space-control', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'restart' }),
                });
                if (resp.ok) {
                    statusEl.textContent = 'ゲームをリスタートしました';
                } else {
                    statusEl.textContent = 'エラーが発生しました';
                }
            } catch {
                statusEl.textContent = 'エラーが発生しました';
            }
            setTimeout(() => { statusEl.textContent = ''; }, 3000);
        });
        document.querySelectorAll('[data-difficulty-tab]').forEach((button) => {
            button.addEventListener('click', () => setActiveDifficulty(button.dataset.difficultyTab));
        });
        document.addEventListener('click', (event) => {
            if (event.target && event.target.closest && event.target.closest('button')) playButtonSound();
        }, true);
        setActiveDifficulty(currentDifficulty, false);
        renderBossCounts();
        renderPresets();
        refreshPresets();
    </script>
</body>
</html>`
}

const renderBossPage = () => {
    const countsJson = JSON.stringify(bossDefeatCounts)
    const labelsJson = JSON.stringify(DIFFICULTY_LABELS)
    return `<!doctype html>
<html lang="ja">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Boss Rotation Board</title>
    <style>
        :root { color-scheme: dark; font-family: "Hiragino Sans","Yu Gothic",sans-serif; }
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; overflow: hidden; color: #fff; background: #070817; }
        .slide { position: fixed; inset: 0; opacity: 1; transform: none; }
        .stars, .stars::before, .stars::after {
            position: absolute; inset: 0; content: ""; pointer-events: none;
            background-image:
                radial-gradient(circle, rgba(255,255,255,.95) 0 1px, transparent 1.6px),
                radial-gradient(circle, rgba(255,241,166,.8) 0 1px, transparent 1.8px);
            background-size: 72px 72px, 118px 118px; opacity: .5;
        }
        .stars::before { transform: translate(23px, 17px); opacity: .36; }
        .stars::after { transform: translate(-31px, 44px); opacity: .24; }
        .record {
            background:
                radial-gradient(circle at 50% 18%, rgba(255,210,94,.24), transparent 28%),
                radial-gradient(circle at 16% 72%, rgba(102,182,255,.18), transparent 32%),
                linear-gradient(180deg, #090b22 0%, #151238 54%, #090817 100%);
        }
        main { position: relative; z-index: 1; min-height: 100vh; padding: clamp(22px, 4vw, 54px); display: grid; grid-template-rows: auto 1fr; gap: clamp(16px, 2.4vw, 30px); }
        header { text-align: center; display: grid; gap: 8px; }
        .kicker { font-size: clamp(16px, 2vw, 24px); color: #ffd86b; font-weight: 900; letter-spacing: .08em; }
        h1 { margin: 0; font-size: clamp(36px, 6.4vw, 86px); line-height: .95; text-shadow: 0 0 28px rgba(255,205,76,.45); }
        .subtitle { font-size: clamp(16px, 2.3vw, 28px); color: rgba(255,255,255,.82); font-weight: 800; }
        .grid { align-self: center; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: clamp(12px, 2vw, 24px); }
        .card {
            min-width: 0; min-height: clamp(260px, 38vh, 420px); border: 2px solid rgba(255,255,255,.18); border-radius: 22px;
            padding: clamp(12px, 1.8vw, 24px); background: linear-gradient(180deg, rgba(255,255,255,.12), rgba(255,255,255,.05));
            box-shadow: 0 22px 60px rgba(0,0,0,.34), inset 0 0 28px rgba(255,255,255,.04);
            display: grid; grid-template-rows: auto minmax(96px, 1fr) auto; justify-items: center; align-items: center;
            overflow: hidden;
        }
        .card.easy { --accent: #66d68f; } .card.normal { --accent: #67b7ff; } .card.hard { --accent: #ff8a56; } .card.challenge { --accent: #ff4fb8; }
        .label { color: var(--accent); font-weight: 1000; font-size: clamp(18px, 2.2vw, 32px); text-shadow: 0 0 18px color-mix(in srgb, var(--accent), transparent 45%); white-space: nowrap; }
        .boss-wrap { width: min(66%, 210px); aspect-ratio: 1; display: grid; place-items: center; filter: drop-shadow(0 18px 28px rgba(0,0,0,.5)); }
        .boss-wrap img { width: 100%; height: 100%; object-fit: contain; }
        .count-wrap { min-width: 0; width: 100%; text-align: center; }
        .count {
            display: block; max-width: 100%; font-size: clamp(42px, 6.8vw, 112px); font-weight: 1000; line-height: .86;
            color: #fff; text-shadow: 0 0 24px var(--accent); font-variant-numeric: tabular-nums;
            white-space: nowrap; overflow: hidden; text-overflow: clip;
        }
        .count.digits-4 { font-size: clamp(38px, 5.6vw, 92px); }
        .count.digits-5 { font-size: clamp(32px, 4.8vw, 78px); }
        .count.digits-6 { font-size: clamp(28px, 4vw, 66px); }
        .unit { margin-top: 8px; font-size: clamp(18px, 2.2vw, 30px); color: rgba(255,255,255,.82); font-weight: 900; }
        @media (max-width: 900px) {
            .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .card { min-height: clamp(220px, 36vh, 340px); }
        }
    </style>
</head>
<body>
    <section class="slide record active" data-slide="record">
        <div class="stars"></div>
        <main><header><div class="kicker">BOSS HUNT RECORD</div><h1>ボス討伐ボード</h1></header><section class="grid" id="bossGrid"></section></main>
    </section>
    <script>
        const counts = ${countsJson};
        const labels = ${labelsJson};
        const order = ['easy', 'normal', 'hard', 'challenge'];
        function digitClass(count) {
            const digits = String(Math.max(0, Math.floor(Number(count) || 0))).length;
            if (digits >= 6) return 'digits-6';
            if (digits === 5) return 'digits-5';
            if (digits === 4) return 'digits-4';
            return '';
        }
        function renderCounts() {
            const grid = document.getElementById('bossGrid');
            grid.innerHTML = '';
            order.forEach((difficulty) => {
                const count = Number(counts[difficulty] || 0);
                const card = document.createElement('article');
                card.className = 'card ' + difficulty;
                card.innerHTML = '<div class="label">' + labels[difficulty] + '</div><div class="boss-wrap"><img src="/api/space-data/enemy/boss_enemy.png" alt="boss"></div><div class="count-wrap"><div class="count ' + digitClass(count) + '">' + count + '</div><div class="unit">体 討伐</div></div>';
                grid.appendChild(card);
            });
        }
        async function refresh() {
            try {
                const countsResponse = await fetch('/api/boss-defeats?t=' + Date.now(), { cache: 'no-store' });
                if (countsResponse.ok) {
                    Object.assign(counts, (await countsResponse.json()).counts || {});
                    renderCounts();
                }
            } catch {}
        }
        renderCounts();
        refresh();
        setInterval(refresh, 1000);
    </script>
</body>
</html>`
}

const renderControlPage = () => `<!doctype html>
<html lang="ja">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Game Control</title>
    <style>
        :root {
            color-scheme: light;
            --panel: rgba(255, 251, 245, 0.96);
            --border: #d6cab8;
            --text: #2b241c;
            --accent: #2d6a4f;
            --accent-strong: #1f4b39;
            --danger: #9f2f2f;
            --danger-strong: #7d2424;
            font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background:
                radial-gradient(circle at top, rgba(233, 197, 135, 0.35), transparent 40%),
                linear-gradient(180deg, #f7f1e8 0%, #efe4d5 100%);
            color: var(--text);
        }
        .panel {
            width: min(92vw, 440px);
            padding: 28px 24px;
            border: 1px solid var(--border);
            border-radius: 24px;
            background: var(--panel);
            box-shadow: 0 18px 40px rgba(62, 46, 28, 0.14);
        }
        h1 { margin: 0 0 8px; font-size: 1.5rem; }
        p { margin: 0 0 20px; line-height: 1.6; color: #5f5345; }
        .status {
            margin-bottom: 20px;
            padding: 14px 16px;
            border-radius: 16px;
            background: #f0e7db;
            font-weight: 700;
        }
        .buttons { display: grid; gap: 12px; }
        button {
            appearance: none;
            border: none;
            border-radius: 16px;
            padding: 18px 20px;
            font: inherit;
            font-size: 1.05rem;
            font-weight: 800;
            color: white;
            cursor: pointer;
        }
        .pause { background: linear-gradient(180deg, var(--danger), var(--danger-strong)); }
        .resume { background: linear-gradient(180deg, var(--accent), var(--accent-strong)); }
        .hint { margin-top: 18px; font-size: 0.92rem; color: #746655; }
        .logs {
            margin-top: 18px;
            padding: 12px;
            border-radius: 14px;
            background: #201812;
            color: #d4f5df;
            font: 12px/1.5 monospace;
            height: 220px;
            overflow: auto;
            white-space: pre-wrap;
        }
        .stats {
            margin-top: 18px;
            padding: 14px;
            border-radius: 14px;
            background: #f0e7db;
        }
        .stats-row {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            align-items: center;
        }
        .stats-row input {
            width: 120px;
            padding: 10px 12px;
            border-radius: 10px;
            border: 1px solid #ccbda6;
            font: inherit;
        }
        .stats-grid {
            margin-top: 12px;
            display: grid;
            gap: 6px;
            font-size: 0.95rem;
            color: #4d4235;
        }
    </style>
</head>
<body>
    <main class="panel">
        <h1>Game Control</h1>
        <p>iPad から PC 側ゲームの一時停止と再開を操作します。</p>
        <div id="status" class="status">状態を取得中...</div>
        <div class="buttons">
            <button class="pause" id="pauseButton" type="button">Pause</button>
            <button class="resume" id="resumeButton" type="button">Resume</button>
        </div>
        <div class="hint">同じ Wi-Fi に接続した iPad の Safari でこのページを開いて使います。</div>
        <div class="hint"><a href="/draw">iPad drawing app</a> &nbsp;|&nbsp; <a href="/gameControl">難易度設定</a></div>
        <div class="stats">
            <div class="stats-row">
                <input id="intervalInput" type="number" min="60" max="1000" step="10">
                <input id="borderThresholdInput" type="number" min="0" max="1" step="0.01">
                <input id="alphaThresholdInput" type="number" min="0" max="1" step="0.01">
                <button id="saveConfigButton" type="button">Set Config</button>
            </div>
            <div id="statsGrid" class="stats-grid">統計を取得中...</div>
        </div>
        <div id="logs" class="logs">ログを取得中...</div>
    </main>
    <script>
        async function refreshStatus() {
            const response = await fetch('/api/status');
            const data = await response.json();
            document.getElementById('status').textContent = data.paused ? '現在: Paused' : '現在: Running';
        }

        async function refreshStats() {
            const response = await fetch('/api/remote-draw/stats');
            const data = await response.json();
            const intervalInput = document.getElementById('intervalInput');
            const borderThresholdInput = document.getElementById('borderThresholdInput');
            const alphaThresholdInput = document.getElementById('alphaThresholdInput');
            if (document.activeElement !== intervalInput) {
                intervalInput.value = String(data.current_interval_ms);
            }
            if (document.activeElement !== borderThresholdInput) {
                borderThresholdInput.value = String(data.generated_border_threshold);
            }
            if (document.activeElement !== alphaThresholdInput) {
                alphaThresholdInput.value = String(data.generated_alpha_threshold);
            }
            document.getElementById('statsGrid').textContent = [
                'current interval: ' + data.current_interval_ms + ' ms',
                'generated border threshold: ' + data.generated_border_threshold,
                'generated alpha threshold: ' + data.generated_alpha_threshold,
                'latest infer: ' + (data.latest_total_ms == null ? '-' : data.latest_total_ms + ' ms'),
                'average infer: ' + (data.average_total_ms == null ? '-' : data.average_total_ms + ' ms'),
                'samples: ' + data.sample_count,
                'utilization: ' + (data.utilization_ratio == null ? '-' : Math.round(data.utilization_ratio * 100) + '%'),
                'recommendation: ' + data.recommendation,
            ].join('\\n');
        }

        async function refreshLogs() {
            const response = await fetch('/api/logs');
            const data = await response.json();
            document.getElementById('logs').textContent = (data.logs || []).join('\\n');
        }

        async function sendCommand(action) {
            const response = await fetch('/api/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action }),
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Control request failed');
            }
            await refreshStatus();
            await refreshLogs();
        }

        document.getElementById('pauseButton').addEventListener('click', async () => {
            await sendCommand('pause');
        });

        document.getElementById('resumeButton').addEventListener('click', async () => {
            await sendCommand('resume');
        });
        document.getElementById('saveConfigButton').addEventListener('click', async () => {
            const intervalValue = Number(document.getElementById('intervalInput').value);
            const borderThresholdValue = Number(document.getElementById('borderThresholdInput').value);
            const alphaThresholdValue = Number(document.getElementById('alphaThresholdInput').value);
            const response = await fetch('/api/remote-draw/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    realtime_interval_ms: intervalValue,
                    generated_border_threshold: borderThresholdValue,
                    generated_alpha_threshold: alphaThresholdValue,
                }),
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Could not save config');
            }
            await refreshStats();
            await refreshLogs();
        });

        refreshStatus();
        refreshStats();
        refreshLogs();
        setInterval(refreshStatus, 2000);
        setInterval(refreshStats, 1200);
        setInterval(refreshLogs, 1500);
    </script>
</body>
</html>`

const renderRemoteDrawPage = (draw2 = false) => `<!doctype html>
<html lang="ja">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
    <title>Remote Fruit Draw</title>
    <style>
        html, body {
            margin: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #fff;
            -webkit-user-select: none;
            user-select: none;
            -webkit-touch-callout: none;
        }
        body {
            position: fixed;
            inset: 0;
            overscroll-behavior: none;
            touch-action: none;
            -webkit-user-select: none;
            user-select: none;
            -webkit-touch-callout: none;
        }
        .stage {
            position: fixed;
            inset: 0;
            width: 100vw;
            height: 100vh;
            overflow: hidden;
            background: #fff;
            touch-action: none;
            -webkit-user-select: none;
            user-select: none;
            -webkit-touch-callout: none;
        }
        .stage img,
        .stage canvas {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
        }
        .stage img {
            object-fit: fill;
            pointer-events: none;
        }
        .stage canvas {
            touch-action: none;
            opacity: 0;
        }
        #stagePreview {
            z-index: 2;
        }
        #staticFruitPreview {
            inset: auto;
            z-index: 3;
            object-fit: contain;
        }
        #swipeFruitPreview {
            position: absolute;
            inset: auto;
            z-index: 18;
            object-fit: contain;
            pointer-events: none;
            transform: translate(calc(var(--swipe-base-x, 0px) + var(--swipe-drag-x, 0px)), calc(var(--swipe-base-y, 0px) + var(--swipe-drag-y, 0px)));
            transition: transform 0.34s cubic-bezier(0.18, 0.78, 0.28, 1), filter 0.2s ease;
            filter: drop-shadow(0 12px 24px rgba(0, 0, 0, 0.2));
        }
        #displayCanvas {
            z-index: 6;
            opacity: 1;
            pointer-events: none;
        }
        #stageCanvas {
            z-index: 7;
        }
        .preview-stack {
            position: absolute;
            right: 16px;
            top: 50%;
            z-index: 10;
            transform: translateY(-50%);
            pointer-events: none;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .preview-card {
            position: relative;
            width: clamp(126px, 18vw, 220px);
            height: clamp(88px, 15vh, 160px);
            border: 2px solid rgba(35, 31, 26, 0.42);
            border-radius: 16px;
            overflow: hidden;
            background: rgba(255, 255, 255, 0.92);
            box-shadow: 0 14px 34px rgba(0, 0, 0, 0.18);
        }
        .preview-card img,
        .preview-card-placeholder {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
        }
        .preview-card img {
            object-fit: contain;
        }
        .preview-card-placeholder {
            display: grid;
            place-items: center;
            box-sizing: border-box;
            padding: 12px;
            color: rgba(35, 31, 26, 0.62);
            font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
            font-size: 13px;
            font-weight: 800;
            line-height: 1.35;
            text-align: center;
        }
        .pixel-graph-panel {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding-top: 8px;
        }
        .pixel-graph-section {
            background: rgba(12, 9, 5, 0.82);
            border-radius: 8px;
            padding: 5px 7px 4px;
            border: 1px solid rgba(255,255,255,0.09);
        }
        .pixel-graph-label {
            font-family: monospace;
            font-size: 10px;
            font-weight: 700;
            margin-bottom: 3px;
        }
        .pixel-graph-proc-label { color: #7ec8ff; }
        .pixel-graph-ui-label { color: #ffb86c; }
        .pixel-graph-section canvas {
            display: block;
            position: static;
            inset: auto;
            width: 100%;
            height: auto;
            opacity: 1;
            touch-action: auto;
            border-radius: 3px;
        }
        .shape-match-panel {
            background: rgba(12, 9, 5, 0.78);
            border-radius: 8px;
            padding: 6px 8px;
            border: 1px solid rgba(255,255,255,0.09);
            margin-top: 6px;
        }
        .shape-match-title {
            font-family: monospace;
            font-size: 10px;
            font-weight: 700;
            color: #ffd86b;
            margin-bottom: 4px;
        }
        .shape-match-row {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            font-family: monospace;
            font-size: 10px;
            color: rgba(255,255,255,0.72);
            line-height: 1.55;
        }
        .shape-match-row.winner {
            color: #fff27a;
            font-weight: 800;
        }
        .shape-match-val {
            color: #fff;
            text-align: right;
            flex-shrink: 0;
        }
        .timing-panel {
            background: rgba(12, 9, 5, 0.82);
            border-radius: 8px;
            padding: 6px 8px;
            border: 1px solid rgba(255,255,255,0.09);
            margin-top: 6px;
        }
        .timing-panel-title {
            font-family: monospace;
            font-size: 10px;
            font-weight: 700;
            color: #a8e6a3;
            margin-bottom: 4px;
        }
        .timing-row {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            font-family: monospace;
            font-size: 10px;
            color: rgba(255,255,255,0.72);
            line-height: 1.5;
        }
        .timing-row.timing-total {
            color: #ffe066;
            font-weight: 700;
            border-top: 1px solid rgba(255,255,255,0.12);
            margin-top: 2px;
            padding-top: 2px;
        }
        .timing-val {
            color: #fff;
            text-align: right;
            flex-shrink: 0;
        }
        .preview-card-label {
            position: absolute;
            left: 10px;
            top: 10px;
            z-index: 1;
            border-radius: 999px;
            padding: 4px 8px;
            background: rgba(35, 31, 26, 0.72);
            color: #fff8d7;
            font-size: 12px;
            font-weight: 800;
            line-height: 1;
        }
        .mode-toggle {
            position: absolute;
            right: clamp(154px, calc(18vw + 28px), 252px);
            bottom: 16px;
            z-index: 12;
            border: 0;
            border-radius: 999px;
            padding: 12px 18px;
            background: rgba(35, 31, 26, 0.86);
            color: #fff8d7;
            font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
            font-size: 14px;
            font-weight: 800;
            letter-spacing: 0.02em;
            box-shadow: 0 12px 28px rgba(0, 0, 0, 0.16);
        }
        #productionModeToggleButton {
            position: absolute;
            bottom: 16px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 14;
            border: 0;
            border-radius: 999px;
            padding: 14px 32px;
            background: rgba(160, 30, 30, 0.88);
            color: #fff;
            font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
            font-size: 15px;
            font-weight: 900;
            letter-spacing: 0.06em;
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
            cursor: pointer;
        }
        #productionModeToggleButton.active {
            background: rgba(34, 120, 56, 0.92);
        }
        #fireButton {
            position: absolute;
            left: 16px;
            bottom: 78px;
            z-index: 14;
            border: 0;
            border-radius: 999px;
            padding: 14px 30px;
            background: rgba(28, 88, 160, 0.92);
            color: #fff;
            font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
            font-size: 16px;
            font-weight: 900;
            letter-spacing: 0.06em;
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
            cursor: pointer;
        }
        #fireButton:disabled {
            opacity: 0.42;
            cursor: default;
        }
        #clearButton {
            display: none;
        }
        .stage.draw2 #fireButton,
        .stage.draw2 #clearButton {
            bottom: 24px;
            z-index: 18;
            min-width: 156px;
            min-height: 78px;
            border-radius: 26px;
            padding: 18px 34px;
            font-size: 24px;
            letter-spacing: 0.08em;
        }
        .stage.draw2 #fireButton {
            left: auto;
            right: 24px;
            background: linear-gradient(180deg, rgba(38, 132, 255, 0.98), rgba(15, 76, 190, 0.98));
            box-shadow: 0 18px 42px rgba(24, 92, 210, 0.34);
        }
        .stage.draw2 #fireButton:not(:disabled) {
            animation: draw2FireButtonPulse 0.9s ease-in-out infinite;
        }
        .stage.draw2 #clearButton {
            display: block;
            position: absolute;
            left: 24px;
            background: rgba(54, 58, 68, 0.86);
            color: #fff;
            font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
            font-weight: 900;
            box-shadow: 0 14px 34px rgba(0, 0, 0, 0.2);
            cursor: pointer;
        }
        .stage.draw2 #clearButton:disabled {
            opacity: 0.42;
            cursor: default;
        }
        .swipe-shot-overlay {
            position: absolute;
            inset: 0;
            z-index: 16;
            display: none;
            background: rgba(8, 10, 15, 0.22);
            pointer-events: none;
        }
        .stage.draw2.swipe-shot-ready .swipe-shot-overlay {
            display: block;
        }
        .swipe-shot-hint {
            position: absolute;
            left: 50%;
            bottom: 118px;
            transform: translateX(-50%);
            border-radius: 999px;
            padding: 11px 20px;
            background: rgba(255, 255, 255, 0.78);
            color: rgba(20, 24, 32, 0.88);
            font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
            font-size: 16px;
            font-weight: 900;
            box-shadow: 0 16px 36px rgba(0, 0, 0, 0.14);
            backdrop-filter: blur(8px);
        }
        .stage.draw2.swipe-shot-ready #stagePreview,
        .stage.draw2.swipe-shot-ready #staticFruitPreview {
            opacity: 0;
        }
        .stage.draw2.swipe-shot-ready #swipeFruitPreview:not([hidden]) {
            animation: swipeFruitGlow 0.76s ease-in-out infinite;
        }
        .stage.draw2.swipe-shot-local-fly #swipeFruitPreview:not([hidden]) {
            filter: drop-shadow(0 16px 28px rgba(0, 0, 0, 0.26)) drop-shadow(0 0 18px rgba(255, 255, 255, 0.9));
        }
        @keyframes swipeFruitGlow {
            0%, 100% { filter: drop-shadow(0 12px 24px rgba(0, 0, 0, 0.2)) drop-shadow(0 0 0 rgba(255,255,255,0)); }
            50% { filter: drop-shadow(0 14px 28px rgba(0, 0, 0, 0.22)) drop-shadow(0 0 18px rgba(255,255,255,0.9)); }
        }
        .stage.draw2.swipe-dragging #swipeFruitPreview {
            animation: none !important;
            transition: none !important;
        }
        .stage.draw2.swipe-dragging .swipe-shot-hint {
            opacity: 0;
            transition: opacity 0.15s ease;
        }
       .stage.draw2 #productionModeToggleButton,
        .stage.draw2 #nonAlphaModeToggleButton {
            display: none !important;
        }
        .fruit-card-row {
            display: none;
        }
        .stage.draw2 .fruit-card-row {
            position: absolute;
            top: 12px;
            left: 50%;
            z-index: 17;
            transform: translateX(-50%);
            display: flex;
            gap: 10px;
            pointer-events: none;
        }
        .fruit-card {
            position: relative;
            width: 58px;
            height: 58px;
            border-radius: 11px;
            background: rgba(255, 255, 255, 0.22);
            border: 1px solid rgba(35, 38, 44, 0.12);
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.08);
            display: grid;
            place-items: center;
            overflow: visible;
        }
        .fruit-card img {
            position: static;
            width: 82%;
            height: 82%;
            object-fit: contain;
            filter: grayscale(1) saturate(0) brightness(1.05);
            opacity: 0.52;
            transition: filter 0.35s ease, opacity 0.35s ease, transform 0.35s ease;
        }
        .fruit-card.collected img {
            filter: none;
            opacity: 1;
        }
        .fruit-card.reveal {
            animation: fruitCardReveal 0.74s ease-out;
        }
        .fruit-card.reveal::before,
        .fruit-card.reveal::after {
            content: "";
            position: absolute;
            inset: -7px;
            border-radius: 16px;
            pointer-events: none;
            background:
                radial-gradient(circle at 18% 24%, rgba(255,255,255,0.95) 0 2px, transparent 3px),
                radial-gradient(circle at 82% 20%, rgba(255,238,120,0.95) 0 2px, transparent 3px),
                radial-gradient(circle at 70% 78%, rgba(255,255,255,0.95) 0 2px, transparent 3px),
                radial-gradient(circle at 28% 82%, rgba(128,210,255,0.9) 0 2px, transparent 3px);
            animation: fruitCardSparkle 0.74s ease-out;
        }
        @keyframes fruitCardReveal {
            0% { transform: scale(0.72) rotate(-18deg); }
            45% { transform: scale(1.22) rotate(12deg); }
            72% { transform: scale(0.94) rotate(-5deg); }
            100% { transform: scale(1) rotate(0); }
        }
        @keyframes fruitCardSparkle {
            0% { opacity: 0; transform: scale(0.6) rotate(0); }
            35% { opacity: 1; }
            100% { opacity: 0; transform: scale(1.32) rotate(35deg); }
        }
        .stage.draw2.fever-active .fruit-card-row {
            animation: feverCardRowPulse 0.48s ease-in-out infinite;
        }
        .stage.draw2.tutorial-card-highlight .fruit-card-row {
            z-index: 36;
            animation: feverCardRowPulse 0.48s ease-in-out infinite;
            filter: drop-shadow(0 0 20px rgba(255, 242, 122, 0.82));
        }
        .stage.draw2.tutorial-card-highlight .fruit-card {
            border-color: rgba(255, 242, 122, 0.92);
            box-shadow: 0 0 0 3px rgba(255, 242, 122, 0.24), 0 0 24px rgba(255, 242, 122, 0.58);
        }
        @keyframes feverCardRowPulse {
            0%, 100% { transform: translateX(-50%) scale(1); }
            50% { transform: translateX(-50%) scale(1.04); }
        }
        @keyframes draw2FireButtonPulse {
            0%, 100% {
                box-shadow: 0 18px 42px rgba(24, 92, 210, 0.34), 0 0 0 rgba(75, 162, 255, 0);
            }
            50% {
                box-shadow: 0 20px 48px rgba(24, 92, 210, 0.42), 0 0 28px rgba(75, 162, 255, 0.88);
            }
        }
        .stage.production-mode .preview-stack,
        .stage.production-mode #centroidOverlay,
        .stage.production-mode .crop-overlay {
            display: none !important;
        }
        .stage.production-mode .mode-toggle:not(#nonAlphaModeToggleButton) {
            display: none !important;
        }
        #judgeProbPanel {
            position: absolute;
            top: 50%;
            right: 16px;
            transform: translateY(-50%);
            z-index: 15;
            display: none;
            flex-direction: column;
            gap: 8px;
            background: rgba(0, 0, 0, 0.86);
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 20px;
            padding: 18px 22px;
            color: white;
            min-width: 180px;
            pointer-events: none;
        }
        .stage.production-mode #judgeProbPanel {
            display: flex;
        }
        .judge-prob-title {
            font-family: "Hiragino Sans", "Yu Gothic", monospace;
            font-size: 11px;
            font-weight: 700;
            color: rgba(255, 255, 255, 0.45);
            letter-spacing: 0.1em;
            margin-bottom: 4px;
        }
        .judge-prob-row {
            font-family: "Hiragino Sans", "Yu Gothic", monospace;
            font-size: 15px;
            font-weight: 800;
            line-height: 1.4;
            color: rgba(255, 255, 255, 0.55);
            transition: color 0.15s, font-size 0.15s;
        }
        .judge-prob-row.winner {
            color: #fff027;
            font-size: 18px;
        }
        .judge-prob-status {
            font-family: monospace;
            font-size: 11px;
            color: rgba(255, 255, 255, 0.32);
            margin-top: 4px;
        }
        .judge-prob-meta {
            font-family: monospace;
            font-size: 10px;
            color: rgba(255, 255, 255, 0.42);
            line-height: 1.45;
        }
        .stage.draw2 #judgeProbPanel {
            right: 16px;
            top: 16px;
            transform: none;
            width: min(240px, 32vw);
            min-width: 188px;
            gap: 7px;
            padding: 10px 12px;
            border: 0;
            border-radius: 12px;
            background: rgba(10, 12, 16, 0.24);
            box-shadow: none;
            backdrop-filter: blur(3px);
        }
        .stage.draw2 .judge-prob-title {
            display: none;
        }
        .stage.draw2 .judge-prob-row {
            display: block;
            color: rgba(24, 26, 30, 0.72);
            font-size: 11px;
        }
        .stage.draw2 .judge-prob-meta,
        .stage.draw2 .judge-prob-status {
            display: none;
        }
        /* Temporary: keep probability/debug logic alive, but hide the draw2 debug UI. */
        .stage.draw2 #judgeProbPanel,
        .stage.draw2 #shapeMatchPanel,
        .stage.draw2 #shapeMatchResultPanel {
            display: none !important;
        }
        .shape-match-result-panel {
            position: absolute;
            top: 136px;
            right: 16px;
            z-index: 16;
            display: none;
            width: min(240px, 32vw);
            min-width: 188px;
            padding: 10px 12px;
            border-radius: 12px;
            background: rgba(10, 12, 16, 0.28);
            color: rgba(24, 26, 30, 0.78);
            box-shadow: none;
            backdrop-filter: blur(3px);
            pointer-events: none;
        }
        .stage.draw2 .shape-match-result-panel:not([hidden]) {
            display: block;
        }
        .shape-match-result-winner {
            color: rgba(24, 26, 30, 0.88);
            font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
            font-size: 12px;
            font-weight: 900;
            margin-bottom: 7px;
        }
        .shape-match-result-row {
            display: grid;
            grid-template-columns: 42px 1fr 46px;
            align-items: center;
            gap: 7px;
            font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
            font-size: 11px;
            font-weight: 800;
            line-height: 1.45;
            color: rgba(24, 26, 30, 0.58);
        }
        .shape-match-result-row + .shape-match-result-row {
            margin-top: 5px;
        }
        .shape-match-result-row.winner {
            color: rgba(28, 40, 55, 0.94);
        }
        .shape-match-result-track {
            height: 6px;
            border-radius: 999px;
            background: rgba(24, 26, 30, 0.14);
            overflow: hidden;
        }
        .shape-match-result-fill {
            height: 100%;
            border-radius: inherit;
            background: rgba(255, 255, 255, 0.56);
            transition: width 0.18s ease;
        }
        .shape-match-result-row.winner .shape-match-result-fill {
            background: linear-gradient(90deg, rgba(255, 118, 154, 0.88), rgba(255, 216, 102, 0.88));
            box-shadow: 0 0 12px rgba(255, 185, 96, 0.52);
        }
        .shape-match-result-value {
            text-align: right;
            font-variant-numeric: tabular-nums;
        }
        .lemon-point-debug {
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid rgba(24, 26, 30, 0.12);
            font-family: monospace;
            font-size: 10px;
            color: rgba(24, 26, 30, 0.72);
        }
        .lemon-point-debug svg {
            display: block;
            width: 96px;
            height: 96px;
            margin-top: 5px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.24);
            border: 1px solid rgba(24, 26, 30, 0.10);
        }
        .lemon-point-debug .candidate {
            fill: rgba(37, 99, 235, 0.76);
        }
        .lemon-point-debug .selected {
            fill: rgba(239, 68, 68, 0.95);
            stroke: rgba(255, 255, 255, 0.9);
            stroke-width: 1.8;
        }
        .meter-label-line {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 3px;
            font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
            font-weight: 900;
        }
        .meter-value {
            font-family: monospace;
        }
        .meter-track {
            height: 8px;
            border-radius: 999px;
            overflow: hidden;
            background: rgba(35, 38, 44, 0.12);
            border: 1px solid rgba(35, 38, 44, 0.08);
        }
        .meter-fill {
            width: 0%;
            height: 100%;
            border-radius: inherit;
            background: linear-gradient(90deg, rgba(160, 170, 185, 0.82), rgba(212, 218, 226, 0.92));
            transition: width 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
        }
        .stage.draw2 .judge-prob-row.winner .meter-fill.apple {
            background: linear-gradient(90deg, #ff4e57, #ffb0a8);
            box-shadow: 0 0 18px rgba(255, 69, 78, 0.86);
        }
        .stage.draw2 .judge-prob-row.winner .meter-fill.banana {
            background: linear-gradient(90deg, #ffe04e, #fff5a8);
            box-shadow: 0 0 18px rgba(255, 224, 78, 0.9);
        }
        .stage.draw2 .judge-prob-row.winner .meter-fill.grape {
            background: linear-gradient(90deg, #8d56ff, #d6b4ff);
            box-shadow: 0 0 18px rgba(145, 88, 255, 0.86);
        }
        .crop-overlay {
            position: absolute;
            z-index: 11;
            border: 2px dashed rgba(34, 148, 99, 0.95);
            border-radius: 10px;
            box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55) inset;
            pointer-events: none;
        }
        .result-overlay {
            position: absolute;
            inset: 0;
            z-index: 20;
            display: none;
            overflow-x: auto;
            overflow-y: hidden;
            scroll-snap-type: x mandatory;
            touch-action: pan-x;
            background: rgba(27, 18, 11, 0.92);
            color: #fff8d7;
            font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
        }
        .result-overlay.is-visible {
            display: flex;
        }
        .result-page {
            position: relative;
            flex: 0 0 100%;
            min-width: 100%;
            height: 100%;
            box-sizing: border-box;
            padding: min(8vh, 68px) min(7vw, 72px);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            scroll-snap-align: start;
        }
        .result-title {
            margin-bottom: 28px;
            color: #fff0a8;
            font-size: clamp(48px, 10vw, 104px);
            font-weight: 900;
        }
        .result-row {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: clamp(20px, 4vw, 42px);
            margin: 10px 0;
            font-weight: 900;
        }
        .result-row img {
            width: clamp(108px, 19vw, 190px);
            height: clamp(108px, 19vw, 190px);
            object-fit: contain;
            flex: 0 0 auto;
        }
        .result-count {
            font-size: clamp(42px, 8vw, 82px);
            line-height: 1;
        }
        .result-rows {
            position: relative;
            width: min(760px, 88vw);
            height: clamp(560px, 68vh, 740px);
            margin: -4px 0 10px;
        }
        .result-rows .result-row {
            position: absolute;
            left: 50%;
            width: 100%;
            transform: translate(-50%, -50%);
        }
        .result-rows .result-row:nth-child(1) {
            top: 8%;
        }
        .result-rows .result-row:nth-child(2) {
            top: 50%;
        }
        .result-rows .result-row:nth-child(3) {
            top: 92%;
        }
        .result-rows .result-row img {
            width: clamp(142px, 24vw, 248px);
            height: clamp(142px, 24vw, 248px);
        }
        .result-total {
            margin-top: 18px;
            color: #fff27a;
            font-size: clamp(54px, 11vw, 104px);
            font-weight: 900;
        }
        .ranking-row {
            width: min(780px, 88vw);
            margin: 12px 0;
            padding: 12px 22px;
            border-radius: 28px;
            background: rgba(255, 248, 215, 0.12);
            font-size: clamp(34px, 6.8vw, 64px);
            font-weight: 900;
        }
        .ranking-row.highlight {
            background: rgba(255, 230, 107, 0.35);
            color: #fff27a;
        }
        .ranking-current {
            width: min(780px, 88vw);
            box-sizing: border-box;
            margin-top: 50px;
            padding: 14px 24px;
            border-radius: 28px;
            background: rgba(255, 230, 107, 0.28);
            color: #fff27a;
            font-size: clamp(34px, 6.8vw, 64px);
            font-weight: 900;
        }
        .ranking-name-form {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            margin-top: 18px;
            width: min(780px, 88vw);
        }
        .ranking-name-form input {
            min-width: 0;
            flex: 1;
            border: 0;
            border-radius: 999px;
            padding: 14px 18px;
            background: rgba(255, 248, 215, 0.96);
            color: #3f2a18;
            font-size: clamp(24px, 5vw, 44px);
            font-weight: 900;
            text-align: center;
        }
        .ranking-name-form button {
            border: 0;
            border-radius: 999px;
            padding: 14px 22px;
            background: #fff27a;
            color: #3f2a18;
            font-size: clamp(22px, 4.5vw, 38px);
            font-weight: 900;
        }
        .swipe-hint {
            position: absolute;
            right: clamp(12px, 3vw, 34px);
            top: 50%;
            transform: translateY(-50%);
            width: clamp(44px, 8vw, 72px);
            height: clamp(44px, 8vw, 72px);
            border-radius: 999px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(255, 242, 122, 0.24);
            color: #fff27a;
            font-size: clamp(54px, 10vw, 92px);
            font-weight: 900;
            line-height: 0.8;
            pointer-events: none;
        }
        .fruit-ranking-title {
            margin-top: 12px;
            color: #ffe9a6;
            font-size: clamp(28px, 5.2vw, 54px);
            font-weight: 900;
            white-space: nowrap;
        }
        .fruit-columns {
            display: flex;
            align-items: stretch;
            justify-content: center;
            gap: clamp(6px, 1.4vw, 18px);
            width: min(1040px, 94vw);
        }
        .fruit-column {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
        }
        .fruit-icon {
            width: clamp(74px, 11vw, 124px);
            height: clamp(74px, 11vw, 124px);
            object-fit: contain;
            flex: 0 0 auto;
        }
        .fruit-ranking-row {
            width: 100%;
            box-sizing: border-box;
            margin: 3px 0;
            padding: 8px 4px;
            border-radius: 16px;
            background: rgba(255, 248, 215, 0.12);
            font-size: clamp(16px, 2.7vw, 28px);
            font-weight: 900;
            line-height: 1.1;
            white-space: nowrap;
        }
        .fruit-ranking-row.highlight {
            background: rgba(255, 230, 107, 0.35);
            color: #fff27a;
        }
        .flow-overlay {
            position: absolute;
            inset: 0;
            z-index: 30;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 36px;
            box-sizing: border-box;
            background:
                radial-gradient(circle at 50% 16%, rgba(255, 242, 122, 0.18), transparent 28%),
                linear-gradient(135deg, rgba(8, 12, 24, 0.84), rgba(18, 10, 22, 0.9));
            color: #fff8d7;
            font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
            text-align: center;
            backdrop-filter: blur(5px);
            overflow: hidden;
            transition: opacity 0.28s ease;
        }
        .flow-overlay.is-visible {
            display: flex;
        }
        .flow-overlay::before,
        .flow-overlay::after {
            content: "";
            position: absolute;
            pointer-events: none;
        }
        .flow-overlay.is-transitioning::after {
            inset: -12%;
            background: linear-gradient(115deg, transparent 0 36%, rgba(255, 242, 122, 0.92) 48%, rgba(255, 255, 255, 0.94) 52%, transparent 64% 100%);
            transform: translateX(-110%);
            animation: flowWipe 0.62s ease-in-out forwards;
        }
        @keyframes flowWipe {
            0% { transform: translateX(-110%); }
            100% { transform: translateX(110%); }
        }
        .flow-overlay.phase-ended {
            background:
                radial-gradient(circle at 18% 24%, rgba(255, 242, 122, 0.5), transparent 20%),
                radial-gradient(circle at 82% 22%, rgba(86, 214, 255, 0.38), transparent 23%),
                radial-gradient(circle at 50% 92%, rgba(255, 80, 210, 0.34), transparent 30%),
                linear-gradient(145deg, rgba(14, 18, 36, 0.88), rgba(45, 18, 54, 0.9));
        }
        .flow-overlay.phase-ended.result-over {
            background:
                radial-gradient(circle at 50% 110%, rgba(80, 92, 116, 0.34), transparent 32%),
                linear-gradient(150deg, rgba(20, 24, 34, 0.9), rgba(38, 34, 44, 0.94));
        }
        .flow-overlay.phase-ended::before {
            inset: 0;
            background:
                radial-gradient(circle at 12% 18%, rgba(255,255,255,0.95) 0 3px, transparent 4px),
                radial-gradient(circle at 28% 72%, rgba(255,242,122,0.95) 0 3px, transparent 4px),
                radial-gradient(circle at 72% 34%, rgba(130,225,255,0.9) 0 3px, transparent 4px),
                radial-gradient(circle at 88% 76%, rgba(255,145,218,0.9) 0 3px, transparent 4px);
            background-size: 140px 140px, 180px 180px, 160px 160px, 190px 190px;
            animation: celebrationSparkles 1.15s linear infinite;
            opacity: 0.86;
        }
        .flow-overlay.phase-ended.result-over::before {
            background:
                radial-gradient(circle at 18% 12%, rgba(160,170,185,0.52) 0 2px, transparent 3px),
                radial-gradient(circle at 62% 28%, rgba(120,130,148,0.44) 0 2px, transparent 3px),
                radial-gradient(circle at 42% 78%, rgba(105,112,128,0.38) 0 2px, transparent 3px);
            background-size: 180px 180px, 220px 220px, 160px 160px;
            animation: sadDrift 2.4s linear infinite;
            opacity: 0.55;
        }
        @keyframes sadDrift {
            from { transform: translateY(-80px); }
            to { transform: translateY(120px); }
        }
        @keyframes celebrationSparkles {
            from { transform: translateY(0); }
            to { transform: translateY(140px); }
        }
        .flow-overlay.phase-ended .flow-panel {
            width: min(860px, 90vw);
            background: transparent;
            border: 0;
            box-shadow: none;
            padding: 0;
        }
        .flow-overlay.phase-ended .flow-kicker {
            color: rgba(255,255,255,0.84);
            font-size: clamp(22px, 4vw, 38px);
            letter-spacing: 0.1em;
        }
        .flow-overlay.phase-ended .flow-title {
            color: #fff27a;
            font-size: clamp(68px, 14vw, 142px);
            text-shadow: 0 0 24px rgba(255, 242, 122, 0.64), 0 14px 38px rgba(0, 0, 0, 0.42);
        }
        .flow-overlay.phase-ended.result-over .flow-title {
            color: #bfc8d8;
            text-shadow: 0 12px 34px rgba(0, 0, 0, 0.48);
        }
        .flow-overlay.phase-ended .flow-copy {
            display: none;
        }
        .flow-overlay.phase-ended .flow-actions {
            margin-top: 38px;
        }
        .flow-overlay.phase-ended .flow-button {
            transform: scale(1.05);
        }
        .flow-overlay.phase-difficulty {
            background:
                radial-gradient(circle at 50% 8%, rgba(86, 214, 255, 0.26), transparent 30%),
                linear-gradient(160deg, rgba(7, 18, 36, 0.92), rgba(10, 38, 48, 0.9));
        }
        .flow-overlay.phase-difficulty .flow-panel {
            background: rgba(8, 18, 32, 0.54);
            border-color: rgba(126, 226, 255, 0.26);
        }
        .flow-overlay.phase-difficulty .flow-actions {
            display: grid;
            grid-template-columns: repeat(2, minmax(170px, 1fr));
            align-items: stretch;
            gap: 16px;
            width: min(760px, 86vw);
            margin-left: auto;
            margin-right: auto;
        }
        .flow-overlay.phase-difficulty .flow-button {
            width: 100%;
            min-width: 0;
            min-height: 118px;
            border-radius: 22px;
            color: #fff;
            border: 1px solid rgba(255,255,255,0.18);
            box-shadow: 0 18px 42px rgba(0,0,0,0.26);
            text-shadow: 0 2px 10px rgba(0,0,0,0.28);
        }
        .flow-overlay.phase-difficulty .flow-button.easy,
        .flow-overlay.phase-difficulty .flow-button.normal {
            box-shadow: 0 0 0 3px rgba(255,255,255,0.18), 0 22px 52px rgba(0,0,0,0.30);
            transform: scale(1.03);
        }
        .flow-overlay.phase-difficulty .flow-button.easy {
            background: linear-gradient(180deg, #4ade80, #15803d);
        }
        .flow-overlay.phase-difficulty .flow-button.normal {
            background: linear-gradient(180deg, #60a5fa, #1d4ed8);
        }
        .flow-overlay.phase-difficulty .flow-button.hard {
            background: linear-gradient(180deg, #fb923c, #c2410c);
        }
        .flow-overlay.phase-difficulty .flow-button.challenge {
            background: linear-gradient(180deg, #c084fc, #7e22ce);
        }
        .flow-overlay.phase-difficulty .flow-button::after {
            display: block;
            margin-top: 8px;
            font-size: clamp(12px, 1.6vw, 16px);
            font-weight: 900;
            opacity: 0.82;
        }
        .flow-overlay.phase-difficulty .flow-button.easy::after,
        .flow-overlay.phase-difficulty .flow-button.normal::after {
            content: "おすすめ";
        }
        .flow-overlay.phase-difficulty .flow-button.hard::after {
            content: "なれてきた人向け";
        }
        .flow-overlay.phase-difficulty .flow-button.challenge::after {
            content: "上級チャレンジ";
        }
        @media (max-width: 680px) {
            .flow-overlay.phase-difficulty .flow-actions {
                grid-template-columns: 1fr;
            }
        }
        .flow-overlay.phase-tutorial {
            align-items: flex-start;
            justify-content: flex-start;
            padding: 0;
            background: transparent;
            backdrop-filter: none;
            pointer-events: none;
        }
        .flow-overlay.phase-tutorial::before {
            inset: 0;
            background: transparent;
            transition: background 0.25s ease;
        }
        .flow-overlay.phase-tutorial.tutorial-fire-step::before {
            background:
                radial-gradient(circle at calc(100% - 104px) calc(100% - 66px), transparent 0 106px, rgba(0, 0, 0, 0.68) 128px),
                rgba(0, 0, 0, 0.12);
        }
        .flow-overlay.phase-tutorial.tutorial-direct-step::before {
            background: rgba(0, 0, 0, 0.10);
        }
        .flow-overlay.phase-tutorial .flow-panel {
            pointer-events: auto;
            width: min(430px, 44vw);
            margin: 84px 0 0 18px;
            padding: 18px 20px;
            border-radius: 20px;
            background: rgba(10, 12, 16, 0.5);
            border: 1px solid rgba(255,255,255,0.18);
            box-shadow: 0 18px 54px rgba(0,0,0,0.22);
            text-align: left;
        }
        .flow-overlay.phase-tutorial.tutorial-fire-step .flow-panel {
            background: rgba(15, 22, 34, 0.76);
            border-color: rgba(75, 162, 255, 0.52);
        }
        .flow-overlay.phase-tutorial .flow-title {
            font-size: clamp(22px, 3.4vw, 34px);
        }
        .flow-overlay.phase-tutorial.tutorial-fire-step .flow-title {
            color: #8bd0ff;
        }
        .flow-overlay.phase-tutorial.tutorial-direct-step .flow-title {
            color: #fff27a;
        }
        .flow-overlay.phase-tutorial .flow-copy {
            font-size: clamp(14px, 2vw, 20px);
            line-height: 1.42;
            margin-top: 10px;
        }
        .flow-overlay.phase-tutorial .flow-actions {
            justify-content: flex-start;
            margin-top: 14px;
        }
        .flow-overlay.phase-tutorial .flow-button {
            min-width: 120px;
            padding: 11px 20px;
            font-size: clamp(14px, 2vw, 20px);
        }
        .flow-overlay.phase-tutorial_done {
            align-items: flex-start;
            justify-content: center;
            padding-top: 114px;
            background: transparent;
            backdrop-filter: none;
            pointer-events: none;
        }
        .flow-overlay.phase-tutorial_done .flow-panel {
            pointer-events: auto;
            width: min(560px, 86vw);
            padding: 18px 22px;
            border-radius: 20px;
            background: rgba(255, 255, 255, 0.82);
            border: 1px solid rgba(255, 211, 72, 0.52);
            box-shadow: 0 20px 52px rgba(40, 34, 20, 0.16);
            color: #2f2714;
            position: relative;
        }
        .flow-overlay.phase-tutorial_done .flow-title {
            color: #2f2714;
            font-size: clamp(25px, 4vw, 38px);
            line-height: 1.15;
        }
        .flow-overlay.phase-tutorial_done .flow-kicker {
            color: rgba(47, 39, 20, 0.58);
        }
        .flow-overlay.phase-tutorial_done .flow-copy {
            color: rgba(47, 39, 20, 0.72);
            font-size: clamp(15px, 2.2vw, 20px);
        }
        .flow-overlay.phase-tutorial_done .flow-actions {
            margin-top: 18px;
        }
        .flow-overlay.phase-tutorial_done .flow-button {
            min-width: 138px;
            padding: 12px 22px;
            font-size: clamp(16px, 2.4vw, 22px);
        }
        .flow-overlay.phase-tutorial_done .flow-panel::before {
            content: "";
            position: absolute;
            left: 50%;
            top: -54px;
            width: 4px;
            height: 42px;
            border-radius: 999px;
            background: linear-gradient(180deg, rgba(255, 217, 74, 0), rgba(255, 190, 40, 0.95));
            box-shadow: 0 0 18px rgba(255, 205, 52, 0.72);
        }
        .flow-overlay.phase-tutorial_done .flow-panel::after {
            content: "";
            position: absolute;
            left: calc(50% - 9px);
            top: -18px;
            width: 18px;
            height: 18px;
            border-right: 4px solid rgba(255, 190, 40, 0.95);
            border-bottom: 4px solid rgba(255, 190, 40, 0.95);
            transform: rotate(45deg);
            filter: drop-shadow(0 0 10px rgba(255, 205, 52, 0.72));
        }
        .flow-overlay.phase-tutorial_done.start-ready {
            align-items: center;
            padding-top: 36px;
            background:
                radial-gradient(circle at 50% 18%, rgba(255, 242, 122, 0.30), transparent 28%),
                linear-gradient(145deg, rgba(12, 20, 34, 0.78), rgba(18, 44, 42, 0.84));
            backdrop-filter: blur(4px);
            pointer-events: auto;
        }
        .flow-overlay.phase-tutorial_done.start-ready .flow-panel {
            width: min(760px, 88vw);
            padding: clamp(28px, 5vw, 54px);
            border-radius: 28px;
            background: rgba(255, 255, 255, 0.12);
            border: 1px solid rgba(255, 255, 255, 0.18);
            box-shadow: 0 28px 90px rgba(0, 0, 0, 0.34);
            color: #fff8d7;
        }
        .flow-overlay.phase-tutorial_done.start-ready .flow-panel::before,
        .flow-overlay.phase-tutorial_done.start-ready .flow-panel::after {
            display: none;
        }
        .flow-overlay.phase-tutorial_done.start-ready .flow-title {
            color: #fff27a;
            font-size: clamp(50px, 9vw, 96px);
        }
        .flow-overlay.phase-tutorial_done.start-ready .flow-kicker,
        .flow-overlay.phase-tutorial_done.start-ready .flow-copy {
            color: inherit;
        }
        .tutorial-fever-guide {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: clamp(6px, 1.4vw, 12px);
            width: min(560px, 76vw);
            margin: 22px auto 0;
        }
        .tutorial-fever-card {
            width: clamp(42px, 7.2vw, 72px);
            height: clamp(42px, 7.2vw, 72px);
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.16);
            border: 1px solid rgba(255, 242, 122, 0.42);
            display: grid;
            place-items: center;
            animation: tutorialCardPop 1.05s ease-in-out infinite;
            animation-delay: calc(var(--card-index) * 0.08s);
            flex: 0 0 auto;
        }
        .tutorial-fever-card img {
            width: 78%;
            height: 78%;
            object-fit: contain;
            filter: drop-shadow(0 0 12px rgba(255, 242, 122, 0.45));
        }
        @keyframes tutorialCardPop {
            0%, 100% { transform: translateY(0) scale(1); }
            50% { transform: translateY(-5px) scale(1.08); }
        }
        .stage.draw2.tutorial-fire-step #fireButton {
            z-index: 34;
            animation: draw2FireButtonPulse 0.46s ease-in-out infinite;
        }
        .stage.draw2.tutorial-fire-step #fireButton:not(:disabled)::after {
            content: "";
            position: absolute;
            inset: -12px;
            border-radius: 32px;
            border: 3px solid rgba(255, 255, 255, 0.84);
            pointer-events: none;
            animation: tutorialFireRing 0.8s ease-out infinite;
        }
        @keyframes tutorialFireRing {
            from { opacity: 0.9; transform: scale(0.94); }
            to { opacity: 0; transform: scale(1.18); }
        }
        .flow-panel {
            width: min(760px, 88vw);
            border-radius: 28px;
            padding: clamp(28px, 5vw, 54px);
            background: rgba(255, 255, 255, 0.12);
            border: 1px solid rgba(255, 255, 255, 0.18);
            box-shadow: 0 28px 90px rgba(0, 0, 0, 0.34);
        }
        .flow-kicker {
            margin-bottom: 10px;
            color: rgba(255, 248, 215, 0.72);
            font-size: clamp(18px, 3vw, 28px);
            font-weight: 900;
        }
        .flow-title {
            margin: 0;
            color: #fff27a;
            font-size: clamp(48px, 10vw, 96px);
            font-weight: 1000;
            line-height: 1.03;
            text-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
        }
        .flow-copy {
            margin: 22px auto 0;
            max-width: 680px;
            color: rgba(255, 248, 215, 0.9);
            font-size: clamp(22px, 4.4vw, 38px);
            font-weight: 900;
            line-height: 1.42;
        }
        .flow-actions {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: center;
            gap: 14px;
            margin-top: 28px;
        }
        .flow-button {
            border: 0;
            border-radius: 999px;
            padding: 18px 34px;
            min-width: 168px;
            background: linear-gradient(180deg, #fff27a, #ffb02e);
            color: #312112;
            font-size: clamp(22px, 4vw, 34px);
            font-weight: 1000;
            box-shadow: 0 14px 34px rgba(255, 176, 46, 0.32);
        }
        .flow-button.secondary {
            background: rgba(255, 255, 255, 0.18);
            color: #fff8d7;
            box-shadow: none;
        }
        .stage canvas.apple-guide {
            position: absolute;
            inset: auto;
            left: 50%;
            top: 50%;
            width: min(390px, 42vw, 68vh);
            height: min(390px, 42vw, 68vh);
            margin: 0;
            transform: translate(-50%, -50%);
            opacity: 1;
            filter: drop-shadow(0 8px 20px rgba(0, 0, 0, 0.08));
            mix-blend-mode: normal;
            pointer-events: none;
            object-fit: contain;
            touch-action: none;
        }
        @media (orientation: portrait) {
            .stage {
                transform: rotate(90deg);
                transform-origin: center center;
                width: 100vh;
                height: 100vw;
                top: 50%;
                left: 50%;
                inset: auto;
                margin-left: -50vh;
                margin-top: -50vw;
            }
        }
    </style>
</head>
<body>
    <div class="stage${draw2 ? ' draw2 production-mode' : ''}" id="mainStage">
        <img id="stagePreview" alt="generated fruit" hidden>
        <img id="staticFruitPreview" alt="static fruit" hidden>
        <img id="swipeFruitPreview" alt="swipe fruit" hidden>
        <canvas id="stageCanvas" width="${REMOTE_DRAW_PROCESSING_WIDTH}" height="${REMOTE_DRAW_PROCESSING_HEIGHT}"></canvas>
        <canvas id="displayCanvas" width="${REMOTE_DRAW_PROCESSING_WIDTH}" height="${REMOTE_DRAW_PROCESSING_HEIGHT}"></canvas>
        <div id="fruitCardRow" class="fruit-card-row"></div>
        <div id="swipeShotOverlay" class="swipe-shot-overlay">
            <div class="swipe-shot-hint">フルーツを上にスワイプ</div>
        </div>
        <div id="cropOverlay" class="crop-overlay" hidden></div>
        <div class="preview-stack">
            <div class="preview-card">
                <div class="preview-card-label">線画補完</div>
                <img id="borderPreview" alt="border inference preview" hidden>
                <div id="borderPreviewPlaceholder" class="preview-card-placeholder">補完結果</div>
            </div>
            <div class="preview-card">
                <div class="preview-card-label">最大連結成分</div>
                <img id="cleanedBorderPreview" alt="cleaned border preview" hidden>
                <div id="cleanedBorderPreviewPlaceholder" class="preview-card-placeholder">最大連結部分</div>
            </div>
            <div class="preview-card">
                <div class="preview-card-label">生成結果</div>
                <img id="structurePreview" alt="generated fruit with sketch lines" hidden>
                <div id="structurePreviewPlaceholder" class="preview-card-placeholder">線の確認</div>
            </div>
            <div class="pixel-graph-panel">
                <div class="pixel-graph-section">
                    <div class="pixel-graph-label pixel-graph-proc-label">モデル入力空間 128×128px（スケール不変）</div>
                    <canvas id="procGraph" width="154" height="64"></canvas>
                </div>
                <div class="pixel-graph-section">
                    <div class="pixel-graph-label pixel-graph-ui-label">UI表示空間</div>
                    <canvas id="uiGraph" width="154" height="64"></canvas>
                </div>
                <div id="timingPanel" class="timing-panel" hidden>
                    <div class="timing-panel-title">処理時間 (ms)</div>
                    <div id="timingRows"></div>
                </div>
                <div id="shapeMatchPanel" class="shape-match-panel" hidden>
                    <div class="shape-match-title">小フルーツ形状一致度</div>
                    <div id="shapeMatchRows"></div>
                </div>
            </div>
        </div>
        <button id="appleRadialVarianceSkipToggleButton" class="mode-toggle" type="button" style="bottom:432px;">形状スキップ: OFF</button>
        <div id="appleRadialVarianceThresholdPanel" class="mode-toggle" style="bottom:380px;display:flex;align-items:center;gap:6px;padding:8px 14px;">
            <span style="font-size:12px;white-space:nowrap;">しきい値:</span>
            <input id="appleRadialVarianceThresholdInput" type="number" min="1" max="9999" value="50" style="width:56px;border:0;border-radius:8px;background:rgba(255,255,255,0.18);color:#fff8d7;font-size:13px;font-weight:800;text-align:center;padding:4px 2px;">
        </div>
        <button id="appleInnerAlphaSkipToggleButton" class="mode-toggle" type="button" style="bottom:328px;">穴スキップ: OFF</button>
        <button id="alphaKeepLargestToggleButton" class="mode-toggle" type="button" style="bottom:276px;">カラー最大連結: OFF</button>
        <button id="keepLargestToggleButton" class="mode-toggle" type="button" style="bottom:224px;">最大連結のみ: ON</button>
        <button id="lowPixelSkipToggleButton" class="mode-toggle" type="button" style="bottom:172px;">低ピクセルスキップ: OFF</button>
        <button id="bananaPostprocessToggleButton" class="mode-toggle" type="button" style="bottom:120px;">バナナ補正: OFF</button>
        <button id="variantToggleButton" class="mode-toggle" type="button" style="bottom:68px;">生成モデル: バナナ400</button>
        <button id="nonAlphaModeToggleButton" class="mode-toggle" type="button" style="bottom:16px;">nonAlpha: OFF</button>
        <button id="centroidDisplayToggleButton" class="mode-toggle" type="button" style="bottom:16px;right:auto;left:16px;">重心表示: OFF</button>
        <canvas id="centroidOverlay" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:13;"></canvas>
        <button id="clearButton" type="button">クリア</button>
        <button id="fireButton" type="button">発射</button>
        <button id="productionModeToggleButton" type="button">本番モード</button>
        <div id="judgeProbPanel">
            <div class="judge-prob-title">識別確率</div>
            <div class="judge-prob-row" id="judgeProbApple">りんご: --</div>
            <div class="judge-prob-row" id="judgeProbBanana">バナナ: --</div>
            <div class="judge-prob-row" id="judgeProbGrape">ブドウ: --</div>
            <div class="judge-prob-meta" id="bananaInkStatus">バナナ線量: --</div>
            <div class="judge-prob-status" id="judgeProbStatus">待機中</div>
        </div>
        <div id="shapeMatchResultPanel" class="shape-match-result-panel" hidden>
            <div id="shapeMatchResultWinner" class="shape-match-result-winner">一致: --</div>
            <div id="shapeMatchResultRows"></div>
        </div>
        <div id="gameResultOverlay" class="result-overlay"></div>
        <div id="gameFlowOverlay" class="flow-overlay"></div>
    </div>
    <script>
        const CONFIG = {
            frameWidth: ${REMOTE_DRAW_FRAME_WIDTH},
            frameHeight: ${REMOTE_DRAW_FRAME_HEIGHT},
            processingWidth: ${REMOTE_DRAW_PROCESSING_WIDTH},
            processingHeight: ${REMOTE_DRAW_PROCESSING_HEIGHT},
            realtimeIntervalMs: 50,
            desiredDisplayLineWidth: 5.7,
            spaceDataUrl: 'http://127.0.0.1:${GAME_CONTROL_PORT}/api/space-data',
        };
        const DRAW2_MODE = ${draw2 ? 'true' : 'false'};
        const sessionId = (() => {
            const key = 'remote-draw-session-id';
            const existing = window.localStorage.getItem(key);
            if (existing) return existing;
            const created = (window.crypto && 'randomUUID' in window.crypto)
                ? window.crypto.randomUUID()
                : 'session-' + Math.random().toString(36).slice(2);
            window.localStorage.setItem(key, created);
            return created;
        })();
        const generatedVariantStorageKey = 'remote-draw-generated-variant';
        const bananaPostprocessStorageKey = 'remote-draw-banana-postprocess';
        const lowPixelSkipStorageKey = 'remote-draw-low-pixel-skip';
        const keepLargestStorageKey = 'remote-draw-keep-largest';
        const alphaKeepLargestStorageKey = 'remote-draw-alpha-keep-largest';
        const appleSkipInnerAlphaStorageKey = 'remote-draw-apple-skip-inner-alpha';
        const appleSkipRadialVarianceStorageKey = 'remote-draw-apple-skip-radial-variance';
        const appleRadialVarianceThresholdStorageKey = 'remote-draw-apple-radial-variance-threshold';
        const centroidDisplayStorageKey = 'remote-draw-centroid-display';
        const nonAlphaModeStorageKey = 'remote-draw-non-alpha-mode';
        const drawMode = 'generated';
        let generatedVariant = ['banana_400', 'apple_512', 'grape_400'].includes(window.localStorage.getItem(generatedVariantStorageKey))
            ? window.localStorage.getItem(generatedVariantStorageKey)
            : 'banana_400';
        let bananaPostprocessEnabled = window.localStorage.getItem(bananaPostprocessStorageKey) === '1';
        let lowPixelSkipEnabled = window.localStorage.getItem(lowPixelSkipStorageKey) === '1';
        let keepLargestEnabled = window.localStorage.getItem(keepLargestStorageKey) !== '0';
        let alphaKeepLargestEnabled = window.localStorage.getItem(alphaKeepLargestStorageKey) === '1';
        let appleSkipInnerAlphaEnabled = window.localStorage.getItem(appleSkipInnerAlphaStorageKey) === '1';
        let appleSkipRadialVarianceEnabled = window.localStorage.getItem(appleSkipRadialVarianceStorageKey) === '1';
        let appleRadialVarianceThreshold = parseInt(window.localStorage.getItem(appleRadialVarianceThresholdStorageKey) || '50', 10);
        let centroidDisplayEnabled = window.localStorage.getItem(centroidDisplayStorageKey) === '1';
        let nonAlphaModeEnabled = DRAW2_MODE ? false : window.localStorage.getItem(nonAlphaModeStorageKey) === '1';
        let latestCentroid = null;
        const canvas = document.getElementById('stageCanvas');
        const ctx = canvas.getContext('2d');
        const displayCanvas = document.getElementById('displayCanvas');
        const displayCtx = displayCanvas.getContext('2d');
        const preview = document.getElementById('stagePreview');
        const staticFruitPreview = document.getElementById('staticFruitPreview');
        const swipeFruitPreview = document.getElementById('swipeFruitPreview');
        const borderPreview = document.getElementById('borderPreview');
        const borderPreviewPlaceholder = document.getElementById('borderPreviewPlaceholder');
        const cleanedBorderPreview = document.getElementById('cleanedBorderPreview');
        const cleanedBorderPreviewPlaceholder = document.getElementById('cleanedBorderPreviewPlaceholder');
        const structurePreview = document.getElementById('structurePreview');
        const structurePreviewPlaceholder = document.getElementById('structurePreviewPlaceholder');
        const cropOverlay = document.getElementById('cropOverlay');
        const fruitCardRow = document.getElementById('fruitCardRow');
        const swipeShotOverlay = document.getElementById('swipeShotOverlay');
        const resultOverlay = document.getElementById('gameResultOverlay');
        const gameFlowOverlay = document.getElementById('gameFlowOverlay');
        const variantToggleButton = document.getElementById('variantToggleButton');
        const bananaPostprocessToggleButton = document.getElementById('bananaPostprocessToggleButton');
        const lowPixelSkipToggleButton = document.getElementById('lowPixelSkipToggleButton');
        const keepLargestToggleButton = document.getElementById('keepLargestToggleButton');
        const alphaKeepLargestToggleButton = document.getElementById('alphaKeepLargestToggleButton');
        const appleInnerAlphaSkipToggleButton = document.getElementById('appleInnerAlphaSkipToggleButton');
        const appleRadialVarianceSkipToggleButton = document.getElementById('appleRadialVarianceSkipToggleButton');
        const appleRadialVarianceThresholdPanel = document.getElementById('appleRadialVarianceThresholdPanel');
        const appleRadialVarianceThresholdInput = document.getElementById('appleRadialVarianceThresholdInput');
        const nonAlphaModeToggleButton = document.getElementById('nonAlphaModeToggleButton');
        const centroidDisplayToggleButton = document.getElementById('centroidDisplayToggleButton');
        const centroidOverlay = document.getElementById('centroidOverlay');
        const timingPanel = document.getElementById('timingPanel');
        const timingRows = document.getElementById('timingRows');
        const shapeMatchPanel = document.getElementById('shapeMatchPanel');
        const shapeMatchRows = document.getElementById('shapeMatchRows');
        const shapeMatchResultPanel = document.getElementById('shapeMatchResultPanel');
        const shapeMatchResultWinner = document.getElementById('shapeMatchResultWinner');
        const shapeMatchResultRows = document.getElementById('shapeMatchResultRows');
        const mainStage = document.getElementById('mainStage');
        const productionModeToggleButton = document.getElementById('productionModeToggleButton');
        const clearButton = document.getElementById('clearButton');
        const fireButton = document.getElementById('fireButton');
        const judgeProbApple = document.getElementById('judgeProbApple');
        const judgeProbBanana = document.getElementById('judgeProbBanana');
        const judgeProbGrape = document.getElementById('judgeProbGrape');
        const bananaInkStatus = document.getElementById('bananaInkStatus');
        const judgeProbStatus = document.getElementById('judgeProbStatus');
        let productionModeEnabled = DRAW2_MODE;
        let productionModeInterval = null;
        const PRODUCTION_FRUITS = ['banana_400', 'apple_512', 'grape_400'];
        let latestJudgeScores = null;
        let judgePollingTimer = null;
        let judgeRequestInFlight = false;
        let lastPredictionFruitName = null;
        let shapeMatchedStaticFruit = null;
        let lastShapeMatchResult = null;
        let pendingSwipeShot = null;
        let swipeStartPoint = null;
        let swipeDragStartClient = null;
        let swipeFruitOffset = { x: 0, y: 0 };
        let swipePreviewSerial = 0;
        let swipeInertiaFrame = null;
        let directSwipeCandidate = null;
        let latestPreviewAsset = null;
        let suppressDirectSwipeUntilNextStroke = false;
        let drawing = false;
        let drawingSuspendedByGuide = false;
        let canvasDirty = false;
        let predictInFlight = false;
        let activePointerId = null;
        let pendingCommitAfterPrediction = false;
        let latestPredictionId = null;
        let canvasRevision = 0;
        let submittedCanvasRevision = 0;
        let latestRequestSerial = 0;
        let latestAppliedSerial = 0;
        let activeStrokeSerial = 0;
        let strokePoints = [];
        let colorPreviewActive = false;
        let clearAfterCommit = false;
        let productionSelectedVariant = null;
        let productionSelectedAt = 0;
        let lastNonSkippedApplePayload = null;
        const FRUIT_CARD_TYPES = ['berry', 'lemon', 'peach', 'apple', 'banana', 'grape', 'dorian'];
        const FEVER_STATIC_IMAGE_PATHS = {
            berry: 'other_fruit/berry.png',
            lemon: 'other_fruit/Lemon.png',
            peach: 'other_fruit/peach.png',
            dorian: 'other_fruit/dorian.png',
        };
        const FEVER_STATIC_FRUIT_SIZE = { berry: 45, lemon: 50, peach: 55, dorian: 80 };
        const fruitCardState = new Set();
        const shotHistory = [];
        let feverActive = false;
        let feverTimer = null;
        let feverEndTimer = null;
        let feverShotIndex = 0;
        let gameFlowPhase = 'playing';
        let lastGameFlowSignal = null;
        let tutorialDoneStep = 'cards';
        let tutorialStep = 'draw';
        let tutorialGuideImage = null;
        let tutorialGuidePoints = null;
        let tutorialGuideFruit = null;
        let tutorialCoveredGuideKeys = new Set();
        let tutorialForceApple = false;
        let tutorialFruitIndex = 0;
        let lastTutorialGuidePoint = null;
        const TUTORIAL_FRUITS = ['apple', 'banana', 'grape'];
        const TUTORIAL_GUIDE_IMAGES = {
            apple: '/api/space-data/sample/guide.png',
            banana: '/api/space-data/sample/guide_banana.png',
            grape: '/api/space-data/sample/guide_grape.png',
        };
        let realtimeIntervalMs = CONFIG.realtimeIntervalMs;
        let lastRealtimePredictAt = 0;
        const STATIC_DORIAN_SIZE_THRESHOLD = ${DORIAN_SIZE_THRESHOLD};
        const STATIC_SMALL_FRUIT_SIZE_THRESHOLD = 70;
        const SMALL_STATIC_FRUITS = ['berry', 'lemon', 'peach'];
        const BANANA_MIN_INK_PIXELS = 500;
        const JUDGE_ENTER_THRESHOLD = 0.7;
        const JUDGE_RELEASE_THRESHOLD = 0.4;
        const JUDGE_MIN_HOLD_MS = 1000;
        const AUDIO_ASSETS = {
            uiNext: '/api/voice/other/ボタン音.mp3',
            uiDifficulty: '/api/voice/other/ボタン音.mp3',
            lineDraw: '',
            clearSketch: '/api/voice/other/画面クリア.mp3',
            fireBlocked: '',
            fruitShoot: {
                apple: '/api/voice/fruit/発射/りんご発射.mp3',
                banana: '/api/voice/fruit/発射/バナナ発射.mp3',
                grape: '/api/voice/fruit/発射/ブドウ発射.mp3',
                berry: '/api/voice/fruit/発射/いちご発射.mp3',
                lemon: '/api/voice/fruit/発射/レモン発射.mp3',
                peach: '/api/voice/fruit/発射/モモ発射.mp3',
                dorian: '/api/voice/fruit/発射/スイカ発射.mp3',
            },
        };
        const audioCache = new Map();
        let lastLineSoundAt = 0;
        function playUiSound(key, fruitName) {
            let src = '';
            if (key === 'fruitShoot') {
                src = AUDIO_ASSETS.fruitShoot[fruitName] || '';
            } else {
                src = AUDIO_ASSETS[key] || '';
            }
            if (!src) return;
            try {
                let audio = audioCache.get(src);
                if (!audio) {
                    audio = new Audio(src);
                    audio.preload = 'auto';
                    audioCache.set(src, audio);
                }
                audio.pause();
                audio.currentTime = 0;
                void audio.play();
            } catch (error) {
                console.warn('[audio]', error);
            }
        }
        function playPcUiSound(key) {
            fetch('/api/ui-sound-events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key }),
            }).catch(function() {});
        }
        function collectAudioSources(value, out) {
            if (!value) return out;
            if (typeof value === 'string') {
                if (value) out.add(value);
                return out;
            }
            Object.keys(value).forEach(function(key) {
                collectAudioSources(value[key], out);
            });
            return out;
        }
        function preloadUiAudio() {
            collectAudioSources(AUDIO_ASSETS, new Set()).forEach(function(src) {
                try {
                    if (audioCache.has(src)) return;
                    const audio = new Audio(src);
                    audio.preload = 'auto';
                    audio.load();
                    audioCache.set(src, audio);
                } catch (error) {
                    console.warn('[audio preload]', error);
                }
            });
        }
        preloadUiAudio();
        const GRAPH_WHITE_THRESHOLD = 245;
        const GRAPH_MAX_HISTORY = 30;
        const procGraphCanvas = document.getElementById('procGraph');
        const uiGraphCanvas = document.getElementById('uiGraph');
        let pixelCountHistory = [];

        function getGeneratedVariantLabel() {
            switch (generatedVariant) {
                case 'banana_400':
                    return 'バナナ400';
                case 'apple_512':
                    return 'りんご512';
                case 'grape_400':
                    return 'ブドウ400';
                default:
                    return 'バナナ400';
            }
        }

        function updateVariantToggleButton() {
            variantToggleButton.textContent = '生成モデル: ' + getGeneratedVariantLabel();
        }

        function updateBananaPostprocessToggleButton() {
            const visible = generatedVariant === 'banana_400';
            bananaPostprocessToggleButton.hidden = !visible;
            bananaPostprocessToggleButton.textContent = bananaPostprocessEnabled ? 'バナナ補正: ON' : 'バナナ補正: OFF';
        }

        function updateLowPixelSkipToggleButton() {
            const visible = generatedVariant === 'banana_400' || generatedVariant === 'apple_512';
            lowPixelSkipToggleButton.hidden = !visible;
            lowPixelSkipToggleButton.textContent = lowPixelSkipEnabled ? '低ピクセルスキップ: ON' : '低ピクセルスキップ: OFF';
            lowPixelSkipToggleButton.style.background = lowPixelSkipEnabled ? 'rgba(34, 80, 56, 0.92)' : 'rgba(35, 31, 26, 0.86)';
        }

        function updateKeepLargestToggleButton() {
            const visible = generatedVariant === 'banana_400' || generatedVariant === 'apple_512';
            keepLargestToggleButton.hidden = !visible;
            keepLargestToggleButton.textContent = keepLargestEnabled ? '最大連結のみ: ON' : '最大連結のみ: OFF';
            keepLargestToggleButton.style.background = keepLargestEnabled ? 'rgba(34, 80, 56, 0.92)' : 'rgba(35, 31, 26, 0.86)';
        }
        function updateAlphaKeepLargestToggleButton() {
            alphaKeepLargestToggleButton.textContent = alphaKeepLargestEnabled ? 'カラー最大連結: ON' : 'カラー最大連結: OFF';
            alphaKeepLargestToggleButton.style.background = alphaKeepLargestEnabled ? 'rgba(34, 80, 56, 0.92)' : 'rgba(35, 31, 26, 0.86)';
        }
        function updateAppleOnlyControls() {
            const isApple = generatedVariant === 'apple_512';
            appleInnerAlphaSkipToggleButton.hidden = !isApple;
            appleRadialVarianceSkipToggleButton.hidden = !isApple;
            appleRadialVarianceThresholdPanel.hidden = !isApple;
            appleInnerAlphaSkipToggleButton.textContent = appleSkipInnerAlphaEnabled ? '穴スキップ: ON' : '穴スキップ: OFF';
            appleInnerAlphaSkipToggleButton.style.background = appleSkipInnerAlphaEnabled ? 'rgba(34, 80, 56, 0.92)' : 'rgba(35, 31, 26, 0.86)';
            appleRadialVarianceSkipToggleButton.textContent = appleSkipRadialVarianceEnabled ? '形状スキップ: ON' : '形状スキップ: OFF';
            appleRadialVarianceSkipToggleButton.style.background = appleSkipRadialVarianceEnabled ? 'rgba(34, 80, 56, 0.92)' : 'rgba(35, 31, 26, 0.86)';
        }
        function updateNonAlphaModeToggleButton() {
            const visible = generatedVariant === 'apple_512' || generatedVariant === 'grape_400' || productionModeEnabled;
            nonAlphaModeToggleButton.hidden = !visible;
            nonAlphaModeToggleButton.textContent = nonAlphaModeEnabled ? 'nonAlpha: ON' : 'nonAlpha: OFF';
            nonAlphaModeToggleButton.style.background = nonAlphaModeEnabled ? 'rgba(34, 80, 56, 0.92)' : 'rgba(35, 31, 26, 0.86)';
        }
        function updateCentroidDisplayToggleButton() {
            centroidDisplayToggleButton.textContent = centroidDisplayEnabled ? '重心表示: ON' : '重心表示: OFF';
            centroidDisplayToggleButton.style.background = centroidDisplayEnabled ? 'rgba(34, 80, 56, 0.92)' : 'rgba(35, 31, 26, 0.86)';
        }
        const JUDGE_CONFIDENCE_THRESHOLD = JUDGE_ENTER_THRESHOLD;
        function setJudgeMeterRow(row, fruitKey, label, value, active) {
            if (!DRAW2_MODE) {
                row.textContent = label + ': ' + (value == null ? '--' : (value * 100).toFixed(1) + '%');
                row.className = 'judge-prob-row' + (active ? ' winner' : '');
                return;
            }
            const pct = value == null ? 0 : Math.max(0, Math.min(100, value * 100));
            row.className = 'judge-prob-row' + (active ? ' winner' : '');
            row.innerHTML =
                '<div class="meter-label-line">' +
                    '<span>' + label + '</span>' +
                    '<span class="meter-value">' + (value == null ? '--' : pct.toFixed(1) + '%') + '</span>' +
                '</div>' +
                '<div class="meter-track"><div class="meter-fill ' + fruitKey + '" style="width:' + pct.toFixed(1) + '%"></div></div>';
        }
        function updateJudgeProbDisplay() {
            const scores = latestJudgeScores;
            const inkPixels = countInkPixels();
            if (!scores) {
                setJudgeMeterRow(judgeProbApple, 'apple', 'りんご', null, false);
                setJudgeMeterRow(judgeProbBanana, 'banana', 'バナナ', null, false);
                setJudgeMeterRow(judgeProbGrape, 'grape', 'ブドウ', null, false);
                bananaInkStatus.textContent = 'バナナ線量: ' + inkPixels + ' / ' + BANANA_MIN_INK_PIXELS;
                judgeProbStatus.textContent = '待機中';
                return;
            }
            const apple = scores.apple || 0;
            const banana = scores.banana || 0;
            const grape = scores.grape || 0;
            const max = Math.max(apple, banana, grape);
            const bananaAllowed = inkPixels >= BANANA_MIN_INK_PIXELS;
            const bananaDisplay = bananaAllowed ? banana : banana * 0.5;
            const fmt = function(v) { return (v * 100).toFixed(1) + '%'; };
            setJudgeMeterRow(judgeProbApple, 'apple', 'りんご', apple, apple === max && max >= JUDGE_CONFIDENCE_THRESHOLD);
            setJudgeMeterRow(judgeProbBanana, 'banana', 'バナナ', bananaDisplay, banana === max && max >= JUDGE_CONFIDENCE_THRESHOLD && bananaAllowed);
            setJudgeMeterRow(judgeProbGrape, 'grape', 'ブドウ', grape, grape === max && max >= JUDGE_CONFIDENCE_THRESHOLD);
            bananaInkStatus.textContent = 'バナナ線量: ' + inkPixels + ' / ' + BANANA_MIN_INK_PIXELS;
            if (productionSelectedVariant) {
                const selectedLabel = productionSelectedVariant === 'apple_512' ? 'りんご' : productionSelectedVariant === 'banana_400' ? 'バナナ' : 'ブドウ';
                judgeProbStatus.textContent = selectedLabel + ' を保持';
            } else if (max >= JUDGE_CONFIDENCE_THRESHOLD) {
                const winner = apple === max ? 'りんご' : banana === max ? 'バナナ' : 'ブドウ';
                judgeProbStatus.textContent = winner === 'バナナ' && !bananaAllowed
                    ? 'バナナ線量不足'
                    : winner + ' を生成';
            } else {
                judgeProbStatus.textContent = '確信度不足 (< ' + Math.round(JUDGE_CONFIDENCE_THRESHOLD * 100) + '%)';
            }
        }
        async function runJudge() {
            if (judgeRequestInFlight || !canvasDirty) return;
            const bbox = getInkBounds();
            if (!bbox) return;
            judgeRequestInFlight = true;
            try {
                const response = await fetch('/api/remote-draw/judge', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image: buildInputDataUrl(),
                        bbox,
                        canvas_width: canvas.width,
                        canvas_height: canvas.height,
                    }),
                });
                if (!response.ok) return;
                const data = await response.json();
                latestJudgeScores = data;
                if (productionModeEnabled) {
                    const winner = resolveProductionVariant(data, bbox);
                    if (winner) {
                        generatedVariant = winner;
                    }
                }
                updateJudgeProbDisplay();
            } catch (e) {
                console.warn('[judge]', e);
            } finally {
                judgeRequestInFlight = false;
            }
        }
        function enterProductionMode() {
            productionModeEnabled = true;
            mainStage.classList.add('production-mode');
            productionModeToggleButton.classList.add('active');
            productionModeToggleButton.textContent = '本番モード: ON';
            latestJudgeScores = null;
            lastPredictionFruitName = null;
            productionSelectedVariant = null;
            productionSelectedAt = 0;
            shapeMatchedStaticFruit = null;
            updateJudgeProbDisplay();
            updateNonAlphaModeToggleButton();
            judgePollingTimer = window.setInterval(function() {
                void runJudge();
            }, 100);
        }
        function exitProductionMode() {
            productionModeEnabled = false;
            mainStage.classList.remove('production-mode');
            productionModeToggleButton.classList.remove('active');
            productionModeToggleButton.textContent = '本番モード';
            if (judgePollingTimer !== null) {
                window.clearInterval(judgePollingTimer);
                judgePollingTimer = null;
            }
            if (productionModeInterval !== null) {
                window.clearInterval(productionModeInterval);
                productionModeInterval = null;
            }
            latestJudgeScores = null;
            productionSelectedVariant = null;
            productionSelectedAt = 0;
            shapeMatchedStaticFruit = null;
            updateJudgeProbDisplay();
            updateVariantToggleButton();
            updateBananaPostprocessToggleButton();
            updateLowPixelSkipToggleButton();
            updateKeepLargestToggleButton();
            updateAlphaKeepLargestToggleButton();
            updateAppleOnlyControls();
            updateNonAlphaModeToggleButton();
            updateCentroidDisplayToggleButton();
            drawCentroidOverlay();
        }
        const TIMING_LABELS = {
            prepare_input_ms:      '入力前処理',
            border_model_ms:       '境界線モデル',
            normalize_to_2px_ms:   '2px正規化',
            keep_largest_border_ms:'最大連結(線画)',
            color_model_ms:        'カラーモデル',
            keep_largest_alpha_ms: '最大連結(色)',
            endpoint_close_ms:    '端点補正',
            fill_mask_ms:         'fill mask',
            apple_align_input_fill_ms: 'りんご位置調整',
            radial_variance_ms:    '放射分散計算',
            inner_alpha_check_ms:  '穴チェック',
            postprocess_ms:        '後処理',
            build_images_ms:       '画像生成',
            total_ms:              '合計',
        };
        function updateTimingPanel(timings) {
            if (!timings || Object.keys(timings).length === 0) {
                timingPanel.hidden = true;
                return;
            }
            timingPanel.hidden = false;
            timingRows.innerHTML = '';
            const keys = Object.keys(TIMING_LABELS);
            keys.forEach(function(key) {
                if (key === 'total_ms') return;
                if (!(key in timings)) return;
                const row = document.createElement('div');
                row.className = 'timing-row';
                const label = document.createElement('span');
                label.textContent = TIMING_LABELS[key] || key;
                const val = document.createElement('span');
                val.className = 'timing-val';
                val.textContent = timings[key].toFixed(1);
                row.appendChild(label);
                row.appendChild(val);
                timingRows.appendChild(row);
            });
            if ('total_ms' in timings) {
                const row = document.createElement('div');
                row.className = 'timing-row timing-total';
                const label = document.createElement('span');
                label.textContent = TIMING_LABELS['total_ms'];
                const val = document.createElement('span');
                val.className = 'timing-val';
                val.textContent = timings['total_ms'].toFixed(1);
                row.appendChild(label);
                row.appendChild(val);
                timingRows.appendChild(row);
            }
        }
        function labelForSmallFruit(fruitName) {
            if (fruitName === 'berry') return 'いちご';
            if (fruitName === 'lemon') return 'レモン';
            if (fruitName === 'peach') return '桃';
            return fruitName || '--';
        }
        function updateShapeMatchPanel(result) {
            if (!shapeMatchPanel || !shapeMatchRows) return;
            if (!result || !result.rule_scores) {
                lastShapeMatchResult = null;
                shapeMatchPanel.hidden = true;
                shapeMatchRows.innerHTML = '';
                if (shapeMatchResultPanel && shapeMatchResultRows) {
                    shapeMatchResultPanel.hidden = true;
                    shapeMatchResultRows.innerHTML = '';
                    if (shapeMatchResultWinner) shapeMatchResultWinner.textContent = '一致: --';
                }
                return;
            }
            lastShapeMatchResult = result;
            shapeMatchPanel.hidden = false;
            shapeMatchRows.innerHTML = '';
            if (shapeMatchResultPanel && shapeMatchResultRows) {
                shapeMatchResultPanel.hidden = false;
                shapeMatchResultRows.innerHTML = '';
                if (shapeMatchResultWinner) {
                    shapeMatchResultWinner.textContent = '閉曲線一致: ' + labelForSmallFruit(result.rule_best || result.best);
                }
            }
            function appendRows(target, sourceScores, prefix, rowClassName) {
                const title = document.createElement('div');
                title.className = rowClassName === 'shape-match-result-row' ? 'shape-match-result-winner' : 'shape-match-title';
                title.textContent = prefix;
                target.appendChild(title);
                ['berry', 'lemon', 'peach'].forEach(function(type) {
                    const item = sourceScores[type] || {};
                    const score = Number(item.score || 0);
                    const pct = Math.max(0, Math.min(100, score * 100));
                    const winner = (result.rule_best || result.best) === type;
                    if (rowClassName === 'shape-match-row') {
                        const row = document.createElement('div');
                        row.className = 'shape-match-row' + (winner ? ' winner' : '');
                        const label = document.createElement('span');
                        label.textContent = labelForSmallFruit(type);
                        const value = document.createElement('span');
                        value.className = 'shape-match-val';
                        value.textContent = pct.toFixed(1) + '%';
                        row.appendChild(label);
                        row.appendChild(value);
                        target.appendChild(row);
                        return;
                    }
                    const visibleRow = document.createElement('div');
                    visibleRow.className = 'shape-match-result-row' + (winner ? ' winner' : '');
                    const visibleLabel = document.createElement('span');
                    visibleLabel.textContent = labelForSmallFruit(type);
                    const track = document.createElement('div');
                    track.className = 'shape-match-result-track';
                    const fill = document.createElement('div');
                    fill.className = 'shape-match-result-fill';
                    fill.style.width = pct.toFixed(1) + '%';
                    const visibleValue = document.createElement('span');
                    visibleValue.className = 'shape-match-result-value';
                    visibleValue.textContent = pct.toFixed(1) + '%';
                    track.appendChild(fill);
                    visibleRow.appendChild(visibleLabel);
                    visibleRow.appendChild(track);
                    visibleRow.appendChild(visibleValue);
                    target.appendChild(visibleRow);
                });
            }
            function appendLemonPointDebug(target) {
                const rule = result.rule || {};
                const components = Array.isArray(rule.components) ? rule.components : [];
                const top = components[0] || {};
                const candidates = Array.isArray(top.lemon_point_candidates) ? top.lemon_point_candidates : [];
                const selected = Array.isArray(top.lemon_selected_points) ? top.lemon_selected_points : [];
                const debug = document.createElement('div');
                debug.className = 'lemon-point-debug';
                const text = document.createElement('div');
                text.textContent = 'レモン頂点候補: ' + candidates.length + ' / 採用: ' + selected.length;
                debug.appendChild(text);
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('viewBox', '0 0 128 128');
                svg.setAttribute('aria-label', 'lemon point debug');
                candidates.forEach(function(point) {
                    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    circle.setAttribute('class', 'candidate');
                    circle.setAttribute('cx', String(Math.max(0, Math.min(128, Number(point.x || 0)))));
                    circle.setAttribute('cy', String(Math.max(0, Math.min(128, Number(point.y || 0)))));
                    circle.setAttribute('r', '2.4');
                    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                    title.textContent = '(' + Math.round(Number(point.x || 0)) + ', ' + Math.round(Number(point.y || 0)) + ') angle=' + Number(point.angle || 0).toFixed(1);
                    circle.appendChild(title);
                    svg.appendChild(circle);
                });
                selected.forEach(function(point) {
                    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    circle.setAttribute('class', 'selected');
                    circle.setAttribute('cx', String(Math.max(0, Math.min(128, Number(point.x || 0)))));
                    circle.setAttribute('cy', String(Math.max(0, Math.min(128, Number(point.y || 0)))));
                    circle.setAttribute('r', '4.2');
                    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                    title.textContent = 'selected (' + Math.round(Number(point.x || 0)) + ', ' + Math.round(Number(point.y || 0)) + ') angle=' + Number(point.angle || 0).toFixed(1);
                    circle.appendChild(title);
                    svg.appendChild(circle);
                });
                debug.appendChild(svg);
                target.appendChild(debug);
            }
            appendRows(shapeMatchRows, result.rule_scores || {}, '閉曲線判定', 'shape-match-row');
            if (shapeMatchResultRows) {
                appendRows(shapeMatchResultRows, result.rule_scores || {}, '閉曲線判定', 'shape-match-result-row');
                appendLemonPointDebug(shapeMatchResultRows);
            }
        }
        function drawCentroidOverlay() {
            const oc = centroidOverlay;
            oc.width = window.innerWidth;
            oc.height = window.innerHeight;
            const octx = oc.getContext('2d');
            octx.clearRect(0, 0, oc.width, oc.height);
            if (!centroidDisplayEnabled || !latestCentroid || generatedVariant !== 'apple_512') return;
            const rect = canvas.getBoundingClientRect();
            const scaleX = rect.width / canvas.width;
            const scaleY = rect.height / canvas.height;
            const cx = rect.left + latestCentroid.x * scaleX;
            const cy = rect.top + latestCentroid.y * scaleY;
            const r = 8;
            octx.strokeStyle = 'rgba(220, 40, 40, 0.92)';
            octx.lineWidth = 2.5;
            octx.beginPath();
            octx.moveTo(cx - r, cy); octx.lineTo(cx + r, cy);
            octx.moveTo(cx, cy - r); octx.lineTo(cx, cy + r);
            octx.stroke();
            octx.beginPath();
            octx.arc(cx, cy, 3.5, 0, Math.PI * 2);
            octx.fillStyle = 'rgba(220, 40, 40, 0.92)';
            octx.fill();
        }

        function updateLineWidth() {
            const rect = canvas.getBoundingClientRect();
            const scaleX = rect.width / canvas.width;
            const scaleY = rect.height / canvas.height;
            const scale = Math.max((scaleX + scaleY) / 2, 0.001);
            ctx.lineWidth = Math.max(1, CONFIG.desiredDisplayLineWidth / scale);
            updateGeneratedModeCropGuide();
        }
        function renderDisplayLines(forceBlack) {
            displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
            if (strokePoints.length === 0) return;
            displayCtx.lineCap = 'round';
            displayCtx.lineJoin = 'round';
            const totalPointCount = strokePoints.reduce(function(total, point) {
                return total + (point ? 1 : 0);
            }, 0);
            function drawSegmentedLines(style, width, mode, recentStart) {
                displayCtx.strokeStyle = style;
                displayCtx.lineWidth = width;
                displayCtx.beginPath();
                let previous = null;
                let previousIndex = -1;
                let pointIndex = 0;
                for (let i = 0; i < strokePoints.length; i += 1) {
                    const point = strokePoints[i];
                    if (!point) {
                        previous = null;
                        previousIndex = -1;
                        continue;
                    }
                    if (previous) {
                        const drawAll = mode === 'all';
                        const drawOld = mode === 'old' && previousIndex < recentStart && pointIndex < recentStart;
                        const drawRecent = mode === 'recent' && pointIndex >= recentStart;
                        if (drawAll || drawOld || drawRecent) {
                            displayCtx.moveTo(previous.x, previous.y);
                            displayCtx.lineTo(point.x, point.y);
                        }
                    }
                    previous = point;
                    previousIndex = pointIndex;
                    pointIndex += 1;
                }
                displayCtx.stroke();
            }
            if (forceBlack || !colorPreviewActive || totalPointCount < 3) {
                displayCtx.strokeStyle = '#000';
                displayCtx.lineWidth = ctx.lineWidth;
                drawSegmentedLines('#000', ctx.lineWidth, 'all', 0);
                return;
            }
            const recentStart = Math.max(1, totalPointCount - 8);
            drawSegmentedLines('rgba(80, 80, 80, 0.55)', Math.max(1, ctx.lineWidth * 0.52), 'old', recentStart);
            drawSegmentedLines('#000', ctx.lineWidth, 'recent', recentStart);
        }
        function resetCanvasVisuals() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = '#000';
            updateLineWidth();
        }
        function clearPreview() {
            preview.hidden = true;
            preview.removeAttribute('src');
            staticFruitPreview.hidden = true;
            staticFruitPreview.removeAttribute('src');
            latestPreviewAsset = null;
            borderPreview.hidden = true;
            borderPreview.removeAttribute('src');
            borderPreviewPlaceholder.hidden = false;
            cleanedBorderPreview.hidden = true;
            cleanedBorderPreview.removeAttribute('src');
            cleanedBorderPreviewPlaceholder.hidden = false;
            structurePreview.hidden = true;
            structurePreview.removeAttribute('src');
            structurePreviewPlaceholder.hidden = false;
            latestCentroid = null;
            drawCentroidOverlay();
            timingPanel.hidden = true;
            timingRows.innerHTML = '';
            updateShapeMatchPanel(null);
            colorPreviewActive = false;
        }
        function updateCropOverlay(crop) {
            if (DRAW2_MODE) {
                cropOverlay.hidden = true;
                return;
            }
            if (!crop) {
                cropOverlay.hidden = true;
                return;
            }
            const rect = canvas.getBoundingClientRect();
            const scaleX = rect.width / canvas.width;
            const scaleY = rect.height / canvas.height;
            cropOverlay.hidden = false;
            cropOverlay.style.left = (crop.left * scaleX) + 'px';
            cropOverlay.style.top = (crop.top * scaleY) + 'px';
            cropOverlay.style.width = Math.max(1, (crop.right - crop.left) * scaleX) + 'px';
            cropOverlay.style.height = Math.max(1, (crop.bottom - crop.top) * scaleY) + 'px';
        }
        function pointFromEvent(event) {
            const rect = canvas.getBoundingClientRect();
            return {
                x: (event.clientX - rect.left) * (canvas.width / rect.width),
                y: (event.clientY - rect.top) * (canvas.height / rect.height),
            };
        }
        function isInkAt(index, pixels) {
            return pixels[index + 3] > 0 && (pixels[index] < 220 || pixels[index + 1] < 220 || pixels[index + 2] < 220);
        }
        function countInkPixels() {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const analysis = getRelevantInkAnalysis(imageData);
            return analysis ? analysis.inkPixels : 0;
        }
        function getRectDistance(a, b) {
            const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
            const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
            return Math.sqrt(dx * dx + dy * dy);
        }
        function getRelevantInkAnalysis(imageData) {
            const pixels = imageData.data;
            const width = imageData.width;
            const height = imageData.height;
            const visited = new Uint8Array(width * height);
            const components = [];
            const queue = [];
            for (let y = 0; y < height; y += 1) {
                for (let x = 0; x < width; x += 1) {
                    const start = y * width + x;
                    if (visited[start]) continue;
                    visited[start] = 1;
                    const pixelIndex = start * 4;
                    if (!isInkAt(pixelIndex, pixels)) continue;
                    let head = 0;
                    let count = 0;
                    let minX = x;
                    let minY = y;
                    let maxX = x;
                    let maxY = y;
                    queue.length = 0;
                    queue.push(start);
                    while (head < queue.length) {
                        const current = queue[head];
                        head += 1;
                        const cx = current % width;
                        const cy = Math.floor(current / width);
                        count += 1;
                        minX = Math.min(minX, cx);
                        minY = Math.min(minY, cy);
                        maxX = Math.max(maxX, cx);
                        maxY = Math.max(maxY, cy);
                        for (let oy = -1; oy <= 1; oy += 1) {
                            for (let ox = -1; ox <= 1; ox += 1) {
                                if (ox === 0 && oy === 0) continue;
                                const nx = cx + ox;
                                const ny = cy + oy;
                                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                                const next = ny * width + nx;
                                if (visited[next]) continue;
                                visited[next] = 1;
                                if (isInkAt(next * 4, pixels)) queue.push(next);
                            }
                        }
                    }
                    components.push({
                        count,
                        left: minX,
                        top: minY,
                        right: maxX + 1,
                        bottom: maxY + 1,
                        width: maxX - minX + 1,
                        height: maxY - minY + 1,
                    });
                }
            }
            if (components.length === 0) return null;
            components.sort(function(a, b) { return b.count - a.count; });
            const largest = components[0];
            const threshold = Math.max(largest.width, largest.height, 1);
            const relevant = components.filter(function(component, index) {
                if (index === 0) return true;
                return getRectDistance(component, largest) < threshold;
            });
            let minX = width;
            let minY = height;
            let maxX = -1;
            let maxY = -1;
            let inkPixels = 0;
            relevant.forEach(function(component) {
                minX = Math.min(minX, component.left);
                minY = Math.min(minY, component.top);
                maxX = Math.max(maxX, component.right - 1);
                maxY = Math.max(maxY, component.bottom - 1);
                inkPixels += component.count;
            });
            if (maxX < 0 || maxY < 0) return null;
            return {
                left: minX,
                top: minY,
                right: maxX + 1,
                bottom: maxY + 1,
                width: maxX - minX + 1,
                height: maxY - minY + 1,
                inkPixels,
                componentCount: components.length,
                relevantComponentCount: relevant.length,
                ignoredComponentCount: components.length - relevant.length,
            };
        }
        function getInkBounds() {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const analysis = getRelevantInkAnalysis(imageData);
            if (!analysis) return null;
            return {
                left: analysis.left,
                top: analysis.top,
                right: analysis.right,
                bottom: analysis.bottom,
                width: analysis.width,
                height: analysis.height,
            };
        }
        function computeGeneratedCropRect(bbox) {
            const width = Math.max(1, Math.round(bbox.width));
            const height = Math.max(1, Math.round(bbox.height));
            const centerX = (bbox.left + bbox.right) / 2;
            const centerY = (bbox.top + bbox.bottom) / 2;
            const padding = Math.max(4, Math.round(Math.max(width, height) * 0.08));
            let size = (Math.max(width, height) + padding * 2) * 2;
            size = Math.max(8, Math.min(size, Math.max(canvas.width, canvas.height)));
            let left = Math.round(centerX - size / 2);
            let top = Math.round(centerY - size / 2);
            return {
                left,
                top,
                right: left + size,
                bottom: top + size,
                size: size,
            };
        }
        function updateGeneratedModeCropGuide(bbox) {
            const resolvedBbox = bbox || getInkBounds();
            updateCropOverlay(resolvedBbox ? computeGeneratedCropRect(resolvedBbox) : null);
        }
        function getForcedStaticFruitType(bbox) {
            const maxDim = Math.max(bbox.width, bbox.height);
            if (maxDim >= STATIC_DORIAN_SIZE_THRESHOLD) return 'dorian';
            return null;
        }
        function isStaticFruitName(fruitName) {
            return fruitName === 'dorian' || SMALL_STATIC_FRUITS.indexOf(fruitName) >= 0;
        }
        function normalizeFruitCardType(fruitName) {
            return FRUIT_CARD_TYPES.indexOf(fruitName) >= 0 ? fruitName : null;
        }
        function renderFruitCards() {
            if (!DRAW2_MODE) return;
            fruitCardRow.innerHTML = '';
            FRUIT_CARD_TYPES.forEach(function(type) {
                const card = document.createElement('div');
                card.className = 'fruit-card' + (fruitCardState.has(type) ? ' collected' : '');
                card.dataset.fruit = type;
                const img = document.createElement('img');
                img.src = '/api/space-data/fruit_cards/' + type + '.png';
                img.alt = type;
                card.appendChild(img);
                fruitCardRow.appendChild(card);
            });
        }
        function revealFruitCard(fruitName) {
            if (!DRAW2_MODE) return;
            const type = normalizeFruitCardType(fruitName);
            if (!type || fruitCardState.has(type)) return;
            fruitCardState.add(type);
            const card = fruitCardRow.querySelector('[data-fruit="' + type + '"]');
            if (card) {
                card.classList.add('collected', 'reveal');
                window.setTimeout(function() { card.classList.remove('reveal'); }, 820);
            }
            if (fruitCardState.size >= FRUIT_CARD_TYPES.length) {
                startFeverTime();
            }
        }
        function resetFruitCards() {
            fruitCardState.clear();
            renderFruitCards();
        }
        function buildFeverBaseShot(fruitType) {
            const imagePath = FEVER_STATIC_IMAGE_PATHS[fruitType];
            if (imagePath) {
                const size = FEVER_STATIC_FRUIT_SIZE[fruitType] || 55;
                return {
                    processing_width: CONFIG.processingWidth,
                    processing_height: CONFIG.processingHeight,
                    frame_width: CONFIG.frameWidth,
                    frame_height: CONFIG.frameHeight,
                    bullet_assets: [{
                        image: CONFIG.spaceDataUrl + '/' + imagePath,
                        origin_x: Math.round((CONFIG.processingWidth - size) / 2),
                        origin_y: Math.round((CONFIG.processingHeight - size) / 2),
                        width: size,
                        height: size,
                        fruit_name: fruitType,
                    }],
                };
            }
            const match = shotHistory.slice().reverse().find(function(s) {
                return s.bullet_assets && s.bullet_assets[0] && s.bullet_assets[0].fruit_name === fruitType;
            });
            if (match) return match;
            if (shotHistory.length === 0) return null;
            return shotHistory[Math.floor(Math.random() * shotHistory.length)];
        }
        function cloneShotForFever(shot) {
            const cloned = JSON.parse(JSON.stringify(shot));
            const pw = cloned.processing_width || CONFIG.processingWidth;
            const ph = cloned.processing_height || CONFIG.processingHeight;
            const assets = cloned.bullet_assets || [];
            assets.forEach(function(asset) {
                const maxX = Math.max(1, pw - Math.max(1, asset.width || 1));
                const maxY = Math.max(1, ph - Math.max(1, asset.height || 1));
                asset.origin_x = Math.round(Math.random() * maxX);
                asset.origin_y = Math.round(Math.random() * Math.min(maxY, ph * 0.68));
            });
            const angle = (Math.random() - 0.5) * Math.PI * 0.65;
            cloned.launch_vx = Math.sin(angle);
            cloned.launch_vy = -Math.cos(angle);
            cloned.launch_x = Math.random() * pw;
            cloned.launch_y = ph;
            return cloned;
        }
        async function enqueueFeverShot(shot) {
            await fetch('/api/remote-shot/enqueue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shot }),
            });
        }
        async function setFeverState(active) {
            try {
                await fetch('/api/fever-state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ active, duration_ms: active ? 8000 : 0 }),
                });
            } catch (error) {
                console.warn('[fever]', error);
            }
        }
        function startFeverTime() {
            if (!DRAW2_MODE || feverActive) return;
            feverActive = true;
            mainStage.classList.add('fever-active');
            void setFeverState(true);
            feverTimer = window.setInterval(function() {
                const fruitType = FRUIT_CARD_TYPES[feverShotIndex % FRUIT_CARD_TYPES.length];
                feverShotIndex += 1;
                const base = buildFeverBaseShot(fruitType);
                if (!base) return;
                void enqueueFeverShot(cloneShotForFever(base));
            }, 200);
            feverEndTimer = window.setTimeout(function() {
                if (feverTimer !== null) window.clearInterval(feverTimer);
                feverTimer = null;
                feverEndTimer = null;
                feverActive = false;
                mainStage.classList.remove('fever-active');
                resetFruitCards();
                void setFeverState(false);
            }, 8000);
        }
        function getScoreForVariant(scores, variant) {
            if (!scores || !variant) return 0;
            if (variant === 'apple_512') return scores.apple || 0;
            if (variant === 'banana_400') return scores.banana || 0;
            if (variant === 'grape_400') return scores.grape || 0;
            return 0;
        }
        function getJudgeCandidate(scores, bbox) {
            if (!scores) return null;
            const inkPixels = countInkPixels();
            const entries = [
                ['apple_512', scores.apple || 0],
                ['banana_400', scores.banana || 0],
                ['grape_400', scores.grape || 0],
            ];
            entries.sort(function(left, right) { return right[1] - left[1]; });
            const variant = entries[0][0];
            const score = entries[0][1];
            if (score < JUDGE_ENTER_THRESHOLD) return null;
            if (variant === 'banana_400' && inkPixels < BANANA_MIN_INK_PIXELS) return null;
            return variant;
        }
        function getTopJudgeVariant(scores, allowLowInkBanana) {
            if (!scores) return null;
            const inkPixels = countInkPixels();
            const entries = [
                ['apple_512', scores.apple || 0],
                ['banana_400', scores.banana || 0],
                ['grape_400', scores.grape || 0],
            ];
            entries.sort(function(left, right) { return right[1] - left[1]; });
            for (const entry of entries) {
                if (entry[0] === 'banana_400' && !allowLowInkBanana && inkPixels < BANANA_MIN_INK_PIXELS) continue;
                return entry[0];
            }
            return null;
        }
        async function runShapeMatchForFire(bbox) {
            const response = await fetch('/api/remote-draw/shape-match', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: buildInputDataUrl(),
                    bbox,
                    canvas_width: canvas.width,
                    canvas_height: canvas.height,
                }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '形状一致度の判定に失敗しました');
            updateShapeMatchPanel(result);
            return result;
        }
        async function prepareProductionFirePrediction() {
            if (!DRAW2_MODE || !productionModeEnabled || gameFlowPhase === 'tutorial') return false;
            const bbox = getInkBounds();
            if (!bbox) return false;
            const forcedStaticFruit = getForcedStaticFruitType(bbox);
            if (forcedStaticFruit) {
                shapeMatchedStaticFruit = forcedStaticFruit;
                latestPredictionId = null;
                lastPredictionFruitName = forcedStaticFruit;
                productionSelectedVariant = null;
                productionSelectedAt = 0;
                colorPreviewActive = false;
                canvasRevision += 1;
                submittedCanvasRevision = Math.min(submittedCanvasRevision, canvasRevision - 1);
                updateFireButtonState();
                return true;
            }
            if (!latestJudgeScores) {
                await runJudge();
            }
            const winner = resolveProductionVariant(latestJudgeScores, bbox);
            if (winner) {
                generatedVariant = winner;
                productionSelectedVariant = winner;
                productionSelectedAt = Date.now();
                shapeMatchedStaticFruit = null;
                latestPredictionId = null;
                lastPredictionFruitName = null;
                colorPreviewActive = false;
                canvasRevision += 1;
                submittedCanvasRevision = Math.min(submittedCanvasRevision, canvasRevision - 1);
                updateJudgeProbDisplay();
                updateFireButtonState();
                return true;
            }
            let shapeResult = null;
            try {
                shapeResult = await runShapeMatchForFire(bbox);
            } catch (error) {
                console.warn('[shape-match]', error);
                return false;
            }
            const best = shapeResult && shapeResult.best;
            if (!best || SMALL_STATIC_FRUITS.indexOf(best) < 0) return false;
            shapeMatchedStaticFruit = best;
            latestPredictionId = null;
            lastPredictionFruitName = best;
            productionSelectedVariant = null;
            productionSelectedAt = 0;
            colorPreviewActive = false;
            canvasRevision += 1;
            submittedCanvasRevision = Math.min(submittedCanvasRevision, canvasRevision - 1);
            updateJudgeProbDisplay();
            updateFireButtonState();
            return true;
        }
        function resolveProductionVariant(scores, bbox) {
            const now = Date.now();
            if (productionSelectedVariant) {
                const selectedScore = getScoreForVariant(scores, productionSelectedVariant);
                if (now - productionSelectedAt < JUDGE_MIN_HOLD_MS || selectedScore >= JUDGE_RELEASE_THRESHOLD) {
                    return productionSelectedVariant;
                }
                productionSelectedVariant = null;
                productionSelectedAt = 0;
            }
            const candidate = getJudgeCandidate(scores, bbox);
            if (candidate) {
                productionSelectedVariant = candidate;
                productionSelectedAt = now;
            }
            return productionSelectedVariant;
        }
        function renderStaticFruitPreview(asset) {
            if (!asset || !asset.image) return;
            latestPreviewAsset = asset;
            staticFruitPreview.src = asset.image;
            staticFruitPreview.hidden = false;
            staticFruitPreview.style.left = ((asset.origin_x / canvas.width) * 100) + '%';
            staticFruitPreview.style.top = ((asset.origin_y / canvas.height) * 100) + '%';
            staticFruitPreview.style.width = ((asset.width / canvas.width) * 100) + '%';
            staticFruitPreview.style.height = ((asset.height / canvas.height) * 100) + '%';
            preview.hidden = true;
            preview.removeAttribute('src');
            colorPreviewActive = true;
            renderDisplayLines(false);
            updateFireButtonState();
        }
        function hideColorPreview() {
            preview.hidden = true;
            preview.removeAttribute('src');
            staticFruitPreview.hidden = true;
            staticFruitPreview.removeAttribute('src');
            latestPreviewAsset = null;
            colorPreviewActive = false;
            renderDisplayLines(true);
            updateFireButtonState();
        }
        function applyGeneratedPreviewPayload(payload, bbox) {
            const resolvedCrop = payload.generated_crop || computeGeneratedCropRect(bbox);
            const stageImageSrc = payload.stage_image;
            staticFruitPreview.hidden = true;
            staticFruitPreview.removeAttribute('src');
            latestPreviewAsset = Array.isArray(payload.bullet_assets) && payload.bullet_assets.length > 0 ? payload.bullet_assets[0] : null;
            const suppressLowPixelSkip = productionModeEnabled && generatedVariant === 'apple_512' && !payload.non_alpha_mode;
            if (!suppressLowPixelSkip && lowPixelSkipEnabled && (generatedVariant === 'banana_400' || generatedVariant === 'apple_512')) {
                measurePixelCounts(stageImageSrc, resolvedCrop).then(function(counts) {
                    pixelCountHistory.push(counts);
                    if (pixelCountHistory.length > GRAPH_MAX_HISTORY) pixelCountHistory.shift();
                    updateGraphs();
                    if (counts.processing > 0.1 * 128 * 128) {
                        preview.src = stageImageSrc;
                        preview.hidden = false;
                        colorPreviewActive = true;
                        renderDisplayLines(false);
                        updateFireButtonState();
                    }
                });
            } else {
                preview.src = stageImageSrc;
                preview.hidden = false;
                colorPreviewActive = true;
                renderDisplayLines(false);
                updateFireButtonState();
                measurePixelCounts(stageImageSrc, resolvedCrop).then(function(counts) {
                    pixelCountHistory.push(counts);
                    if (pixelCountHistory.length > GRAPH_MAX_HISTORY) pixelCountHistory.shift();
                    updateGraphs();
                });
            }
        }
        function buildSketchOverlayDataUrl() {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const pixels = imageData.data;
            for (let index = 0; index < pixels.length; index += 4) {
                const isInk = isInkAt(index, pixels);
                pixels[index] = 0;
                pixels[index + 1] = 0;
                pixels[index + 2] = 0;
                pixels[index + 3] = isInk ? 255 : 0;
            }
            const overlayCanvas = document.createElement('canvas');
            overlayCanvas.width = canvas.width;
            overlayCanvas.height = canvas.height;
            overlayCanvas.getContext('2d').putImageData(imageData, 0, 0);
            return overlayCanvas.toDataURL('image/png');
        }
        function buildInputDataUrl() {
            const exportCanvas = document.createElement('canvas');
            exportCanvas.width = canvas.width;
            exportCanvas.height = canvas.height;
            const exportCtx = exportCanvas.getContext('2d');
            exportCtx.fillStyle = '#fff';
            exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
            exportCtx.drawImage(canvas, 0, 0);
            return exportCanvas.toDataURL('image/png');
        }
        async function syncRemoteConfig() {
            try {
                const response = await fetch('/api/remote-draw/config');
                if (!response.ok) return;
                const payload = await response.json();
                if (typeof payload.realtime_interval_ms === 'number' && Number.isFinite(payload.realtime_interval_ms)) {
                    realtimeIntervalMs = payload.realtime_interval_ms;
                }
            } catch (error) {
                console.warn(error);
            }
        }
        function sortedRankings(rankings, metric) {
            return [...rankings].sort((left, right) => {
                const leftValue = metric === 'total' ? left.total : left.counts[metric];
                const rightValue = metric === 'total' ? right.total : right.counts[metric];
                if (rightValue !== leftValue) return rightValue - leftValue;
                return String(left.playedAt).localeCompare(String(right.playedAt));
            });
        }
        function currentRank(rankings, metric, currentEntryId) {
            if (!currentEntryId) return null;
            const index = sortedRankings(rankings, metric).findIndex((entry) => entry.id === currentEntryId);
            return index >= 0 ? index + 1 : null;
        }
        function rankingDisplayName(entry, isCurrent) {
            const name = typeof entry.name === 'string' ? entry.name.trim() : '';
            return name || (isCurrent ? 'あなた' : 'なまえなし');
        }
        function createPage(titleText) {
            const page = document.createElement('div');
            page.className = 'result-page';
            const title = document.createElement('div');
            title.className = 'result-title';
            title.textContent = titleText;
            page.appendChild(title);
            return page;
        }
        function createRankingRow(text, highlighted, className) {
            const row = document.createElement('div');
            row.className = className + (highlighted ? ' highlight' : '');
            row.textContent = text;
            return row;
        }
        function createFruitIcon(fruitType, className) {
            const image = document.createElement('img');
            image.className = className;
            image.src = '/api/fruit-icon/' + fruitType;
            image.alt = fruitType;
            return image;
        }
        function createSwipeHint() {
            const hint = document.createElement('div');
            hint.className = 'swipe-hint';
            hint.textContent = '›';
            hint.setAttribute('aria-label', '右にスライド');
            return hint;
        }
        function createNameEntryForm(entryId) {
            const form = document.createElement('form');
            form.className = 'ranking-name-form';
            const input = document.createElement('input');
            input.dataset.resultNameInput = 'true';
            input.type = 'text';
            input.maxLength = 12;
            input.placeholder = '名前を入力';
            input.autocomplete = 'off';
            const button = document.createElement('button');
            button.type = 'submit';
            button.textContent = '保存';
            form.onsubmit = async (event) => {
                event.preventDefault();
                const name = input.value.trim();
                if (!name) return;
                button.textContent = '保存中';
                button.disabled = true;
                try {
                    const response = await fetch('/api/ranking-name', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ entryId, name }),
                    });
                    if (!response.ok) throw new Error('ranking name update failed: ' + response.status);
                    input.blur();
                    await syncGameResults();
                } catch (error) {
                    console.warn(error);
                    button.textContent = '再試行';
                    button.disabled = false;
                }
            };
            form.appendChild(input);
            form.appendChild(button);
            return form;
        }
        function renderGameResults(payload) {
            if (!payload || payload.status !== 'ended' || !payload.counts) {
                resultOverlay.classList.remove('is-visible');
                resultOverlay.innerHTML = '';
                return;
            }
            if (document.activeElement instanceof HTMLInputElement && document.activeElement.dataset.resultNameInput === 'true') {
                return;
            }

            resultOverlay.innerHTML = '';
            resultOverlay.classList.add('is-visible');
            const counts = payload.counts;
            const total = counts.apple + counts.banana + counts.grape;

            const resultPage = createPage('結果発表');
            const rowsContainer = document.createElement('div');
            rowsContainer.className = 'result-rows';
            [['apple', counts.apple], ['grape', counts.grape], ['banana', counts.banana]].forEach(([fruitType, count]) => {
                const row = document.createElement('div');
                row.className = 'result-row';
                const countNode = document.createElement('div');
                countNode.className = 'result-count';
                countNode.textContent = '×' + count;
                row.appendChild(createFruitIcon(fruitType, ''));
                row.appendChild(countNode);
                rowsContainer.appendChild(row);
            });
            resultPage.appendChild(rowsContainer);
            const totalNode = document.createElement('div');
            totalNode.className = 'result-total';
            totalNode.textContent = '合計　×' + total;
            resultPage.appendChild(totalNode);
            resultPage.appendChild(createSwipeHint());
            resultOverlay.appendChild(resultPage);

            const totalPage = createPage('合計ランキング');
            const totalPageTitle = totalPage.firstElementChild;
            if (totalPageTitle) {
                totalPageTitle.style.fontSize = 'clamp(42px, 8vw, 82px)';
            }
            sortedRankings(payload.rankings || [], 'total').slice(0, 3).forEach((entry, index) => {
                const isCurrent = entry.id === payload.currentEntryId;
                totalPage.appendChild(createRankingRow((index + 1) + '位　' + rankingDisplayName(entry, isCurrent) + '　' + entry.total + '個', isCurrent, 'ranking-row'));
            });
            const rank = currentRank(payload.rankings || [], 'total', payload.currentEntryId);
            const current = document.createElement('div');
            current.className = 'ranking-current';
            current.textContent = rank ? 'あなた　' + rank + '位　' + total + '個' : 'あなた　' + total + '個';
            totalPage.appendChild(current);
            if (rank && rank <= 3 && payload.currentEntryId) {
                totalPage.appendChild(createNameEntryForm(payload.currentEntryId));
            }
            totalPage.appendChild(createSwipeHint());
            resultOverlay.appendChild(totalPage);

            const fruitPage = createPage('フルーツ別ランキング');
            const fruitPageTitle = fruitPage.firstElementChild;
            if (fruitPageTitle) {
                fruitPageTitle.style.fontSize = 'clamp(28px, 5.2vw, 54px)';
                fruitPageTitle.style.marginBottom = '14px';
                fruitPageTitle.style.whiteSpace = 'nowrap';
            }
            const columns = document.createElement('div');
            columns.className = 'fruit-columns';
            ['apple', 'banana', 'grape'].forEach((metric) => {
                const column = document.createElement('section');
                column.className = 'fruit-column';
                column.appendChild(createFruitIcon(metric, 'fruit-icon'));
                const fruitRankings = sortedRankings(payload.rankings || [], metric).slice(0, 3);
                if (fruitRankings.length === 0) {
                    column.appendChild(createRankingRow('記録なし', false, 'fruit-ranking-row'));
                } else {
                    fruitRankings.forEach((entry, index) => {
                        column.appendChild(createRankingRow((index + 1) + '位 ' + entry.counts[metric] + '個', entry.id === payload.currentEntryId, 'fruit-ranking-row'));
                    });
                }
                column.appendChild(createRankingRow('あなた ' + counts[metric] + '個', true, 'fruit-ranking-row'));
                columns.appendChild(column);
            });
            fruitPage.appendChild(columns);
            resultOverlay.appendChild(fruitPage);
        }
        async function syncGameResults() {
            try {
                const response = await fetch('/api/game-results?t=' + Date.now(), { cache: 'no-store' });
                if (!response.ok) return;
                renderGameResults(await response.json());
            } catch (error) {
                console.warn(error);
            }
        }
        function setGameFlowOverlayVisible(visible) {
            gameFlowOverlay.classList.toggle('is-visible', visible);
            updateFireButtonState();
        }
        function setFlowOverlayPhase(phase) {
            gameFlowOverlay.classList.remove('phase-ended', 'phase-handoff', 'phase-difficulty', 'phase-tutorial', 'phase-tutorial_done');
            gameFlowOverlay.classList.remove('result-clear', 'result-over');
            gameFlowOverlay.classList.remove('tutorial-fire-step', 'tutorial-direct-step');
            gameFlowOverlay.classList.remove('start-ready');
            mainStage.classList.remove('tutorial-card-highlight');
            if (phase) gameFlowOverlay.classList.add('phase-' + phase);
        }
        function flowButton(label, className, onClick) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'flow-button' + (className ? ' ' + className : '');
            button.textContent = label;
            button.addEventListener('click', function(event) {
                playPcUiSound('uiButton');
                onClick(event);
            });
            return button;
        }
        function renderFlowPanel(kicker, title, copy, actions, guide) {
            gameFlowOverlay.innerHTML = '';
            const panel = document.createElement('section');
            panel.className = 'flow-panel';
            if (kicker) {
                const kickerNode = document.createElement('div');
                kickerNode.className = 'flow-kicker';
                kickerNode.textContent = kicker;
                panel.appendChild(kickerNode);
            }
            const titleNode = document.createElement('h1');
            titleNode.className = 'flow-title';
            titleNode.textContent = title;
            panel.appendChild(titleNode);
            if (copy) {
                const copyNode = document.createElement('div');
                copyNode.className = 'flow-copy';
                copyNode.textContent = copy;
                panel.appendChild(copyNode);
            }
            if (guide) panel.appendChild(guide);
            if (actions && actions.length) {
                const actionRow = document.createElement('div');
                actionRow.className = 'flow-actions';
                actions.forEach(function(action) { actionRow.appendChild(action); });
                panel.appendChild(actionRow);
            }
            gameFlowOverlay.appendChild(panel);
        }
        async function postGameFlow(payload) {
            await fetch('/api/game-flow', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        }
        function waitMs(ms) {
            return new Promise(function(resolve) { window.setTimeout(resolve, ms); });
        }
        async function transitionGameFlow(payload) {
            gameFlowOverlay.classList.add('is-transitioning');
            await waitMs(560);
            await postGameFlow(payload);
            await waitMs(120);
            gameFlowOverlay.classList.remove('is-transitioning');
        }
        function currentTutorialFruit() {
            return TUTORIAL_FRUITS[Math.max(0, Math.min(TUTORIAL_FRUITS.length - 1, tutorialFruitIndex))] || 'apple';
        }
        async function syncTutorialProgress() {
            if (gameFlowPhase !== 'tutorial') return;
            try {
                const response = await fetch('/api/tutorial-state?t=' + Date.now(), { cache: 'no-store' });
                if (!response.ok) return;
                const state = await response.json();
                const index = Math.max(0, Math.min(TUTORIAL_FRUITS.length - 1, Number(state.index || 0)));
                if (index !== tutorialFruitIndex) {
                    tutorialFruitIndex = index;
                    resetTutorialGuideProgress();
                    await clearRemoteSession();
                    renderGameFlow({ phase: 'tutorial', difficulty: state.difficulty || 'normal', result: null, signal: lastGameFlowSignal });
                }
            } catch (error) {
                console.warn('[tutorial-state]', error);
            }
        }
        function tutorialFruitLabel(fruit) {
            if (fruit === 'apple') return 'りんご';
            if (fruit === 'banana') return 'バナナ';
            if (fruit === 'grape') return 'ブドウ';
            return fruit;
        }
        function isTutorialDirectSwipeFruit() {
            const fruit = currentTutorialFruit();
            return fruit === 'apple' || fruit === 'grape';
        }
        function currentTutorialTitle() {
            const fruit = currentTutorialFruit();
            if (tutorialStep === 'direct') {
                return fruit === 'grape' ? 'ブドウを斜めに飛ばして' : 'りんごをスワイプして飛ばして';
            }
            if (tutorialStep === 'button') return '出てこない時は発射ボタン';
            if (tutorialStep === 'swipe') return tutorialFruitLabel(fruit) + 'をスワイプして飛ばして';
            return '線に沿って' + tutorialFruitLabel(fruit) + 'を描いて';
        }
        function createTutorialFeverGuide() {
            const guide = document.createElement('div');
            guide.className = 'tutorial-fever-guide';
            FRUIT_CARD_TYPES.forEach(function(type, index) {
                const card = document.createElement('div');
                card.className = 'tutorial-fever-card';
                card.style.setProperty('--card-index', String(index));
                const img = document.createElement('img');
                img.src = '/api/space-data/fruit_cards/' + type + '.png';
                img.alt = type;
                card.appendChild(img);
                guide.appendChild(card);
            });
            return guide;
        }
        function fruitNameForVariant(variant) {
            if (variant === 'apple_512') return 'apple';
            if (variant === 'banana_400') return 'banana';
            if (variant === 'grape_400') return 'grape';
            return null;
        }
        function resetTutorialGuideProgress() {
            tutorialCoveredGuideKeys.clear();
            tutorialForceApple = false;
            lastTutorialGuidePoint = null;
            tutorialGuideImage = null;
            tutorialGuidePoints = null;
            tutorialGuideFruit = null;
        }
        function ensureTutorialGuideImage() {
            const fruit = currentTutorialFruit();
            if (tutorialGuideImage && tutorialGuideFruit === fruit) return tutorialGuideImage;
            const image = new Image();
            image.crossOrigin = 'anonymous';
            image.src = TUTORIAL_GUIDE_IMAGES[fruit] || TUTORIAL_GUIDE_IMAGES.apple;
            image.onload = function() {
                tutorialGuidePoints = buildTutorialGuidePoints(image);
                document.querySelectorAll('.apple-guide').forEach(function(canvasEl) {
                    renderTutorialGuideCanvas(canvasEl, image);
                });
            };
            tutorialGuideImage = image;
            tutorialGuideFruit = fruit;
            tutorialGuidePoints = null;
            return image;
        }
        function buildTutorialGuidePoints(image) {
            const w = image.naturalWidth || image.width;
            const h = image.naturalHeight || image.height;
            if (!w || !h) return [];
            const size = 280;
            const c = document.createElement('canvas');
            c.width = size;
            c.height = size;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.fillStyle = '#fff';
            g.fillRect(0, 0, size, size);
            const scale = Math.min(size / w, size / h);
            const dw = w * scale;
            const dh = h * scale;
            const dx = (size - dw) / 2;
            const dy = (size - dh) / 2;
            g.drawImage(image, dx, dy, dw, dh);
            const data = g.getImageData(0, 0, size, size).data;
            let binary = new Uint8Array(size * size);
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    const i = (y * size + x) * 4;
                    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    binary[y * size + x] = data[i + 3] > 24 && lum < 150 ? 1 : 0;
                }
            }
            const neighbors = function(arr, x, y) {
                const p2 = arr[(y - 1) * size + x];
                const p3 = arr[(y - 1) * size + x + 1];
                const p4 = arr[y * size + x + 1];
                const p5 = arr[(y + 1) * size + x + 1];
                const p6 = arr[(y + 1) * size + x];
                const p7 = arr[(y + 1) * size + x - 1];
                const p8 = arr[y * size + x - 1];
                const p9 = arr[(y - 1) * size + x - 1];
                return [p2, p3, p4, p5, p6, p7, p8, p9];
            };
            const transitionCount = function(ns) {
                let c = 0;
                for (let i = 0; i < ns.length; i++) {
                    if (ns[i] === 0 && ns[(i + 1) % ns.length] === 1) c += 1;
                }
                return c;
            };
            for (let iter = 0; iter < 42; iter++) {
                let changed = false;
                for (let step = 0; step < 2; step++) {
                    const remove = [];
                    for (let y = 1; y < size - 1; y++) {
                        for (let x = 1; x < size - 1; x++) {
                            const idx = y * size + x;
                            if (!binary[idx]) continue;
                            const ns = neighbors(binary, x, y);
                            const sum = ns.reduce(function(a, b) { return a + b; }, 0);
                            const transitions = transitionCount(ns);
                            const p2 = ns[0], p4 = ns[2], p6 = ns[4], p8 = ns[6];
                            const keepA = step === 0 ? p2 * p4 * p6 === 0 : p2 * p4 * p8 === 0;
                            const keepB = step === 0 ? p4 * p6 * p8 === 0 : p2 * p6 * p8 === 0;
                            if (sum >= 2 && sum <= 6 && transitions === 1 && keepA && keepB) {
                                remove.push(idx);
                            }
                        }
                    }
                    if (remove.length > 0) {
                        remove.forEach(function(idx) { binary[idx] = 0; });
                        changed = true;
                    }
                }
                if (!changed) break;
            }
            const points = [];
            for (let y = 1; y < size - 1; y += 2) {
                for (let x = 1; x < size - 1; x += 2) {
                    if (binary[y * size + x]) {
                        points.push({ nx: x / size, ny: y / size, key: points.length });
                    }
                }
            }
            return points;
        }
        function renderTutorialGuideCanvas(canvasEl, image) {
            if (!(canvasEl instanceof HTMLCanvasElement)) return;
            const size = 420;
            canvasEl.width = size;
            canvasEl.height = size;
            const g = canvasEl.getContext('2d', { willReadFrequently: true });
            g.clearRect(0, 0, size, size);
            const w = image.naturalWidth || image.width;
            const h = image.naturalHeight || image.height;
            const scale = Math.min(size / w, size / h);
            const dw = w * scale;
            const dh = h * scale;
            const dx = (size - dw) / 2;
            const dy = (size - dh) / 2;
            const temp = document.createElement('canvas');
            temp.width = size;
            temp.height = size;
            const t = temp.getContext('2d', { willReadFrequently: true });
            t.fillStyle = '#fff';
            t.fillRect(0, 0, size, size);
            t.drawImage(image, dx, dy, dw, dh);
            const img = t.getImageData(0, 0, size, size);
            const data = img.data;
            for (let i = 0; i < data.length; i += 4) {
                const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
                if (data[i + 3] > 24 && lum < 150) {
                    data[i] = 82;
                    data[i + 1] = 88;
                    data[i + 2] = 96;
                    data[i + 3] = 82;
                } else {
                    data[i + 3] = 0;
                }
            }
            g.putImageData(img, 0, 0);
        }
        function createAppleGuide() {
            const canvasGuide = document.createElement('canvas');
            canvasGuide.className = 'apple-guide';
            canvasGuide.setAttribute('aria-hidden', 'true');
            const image = ensureTutorialGuideImage();
            if (image.complete && image.naturalWidth) {
                tutorialGuidePoints = tutorialGuidePoints || buildTutorialGuidePoints(image);
                renderTutorialGuideCanvas(canvasGuide, image);
            }
            return canvasGuide;
        }
        function getTutorialGuidePoint(point) {
            if (gameFlowPhase !== 'tutorial' || tutorialStep !== 'draw') return point;
            if (!tutorialGuidePoints) {
                const image = ensureTutorialGuideImage();
                if (image.complete && image.naturalWidth) {
                    tutorialGuidePoints = buildTutorialGuidePoints(image);
                }
            }
            const candidates = tutorialGuidePoints || [];
            if (candidates.length === 0) return point;
            const guideEl = gameFlowOverlay.querySelector('.apple-guide');
            if (!guideEl) return point;
            const guideRect = guideEl.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            const guideX = (guideRect.left - canvasRect.left) / canvasRect.width * canvas.width;
            const guideY = (guideRect.top - canvasRect.top) / canvasRect.height * canvas.height;
            const guideW = guideRect.width / canvasRect.width * canvas.width;
            const guideH = guideRect.height / canvasRect.height * canvas.height;
            let nearest = null;
            let nearestDist = Infinity;
            candidates.forEach(function(candidate) {
                const x = guideX + candidate.nx * guideW;
                const y = guideY + candidate.ny * guideH;
                const dist = Math.hypot(point.x - x, point.y - y);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearest = { x, y };
                }
            });
            const maxDistance = Math.max(canvas.width, canvas.height) * 0.12;
            if (!nearest || nearestDist > maxDistance) return null;
            return nearest;
        }
        function markTutorialGuideCoverage(snappedPoint) {
            if (gameFlowPhase !== 'tutorial' || tutorialStep !== 'draw' || !tutorialGuidePoints || tutorialForceApple) return;
            const guideEl = gameFlowOverlay.querySelector('.apple-guide');
            if (!guideEl) return;
            const guideRect = guideEl.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            const guideX = (guideRect.left - canvasRect.left) / canvasRect.width * canvas.width;
            const guideY = (guideRect.top - canvasRect.top) / canvasRect.height * canvas.height;
            const guideW = guideRect.width / canvasRect.width * canvas.width;
            const guideH = guideRect.height / canvasRect.height * canvas.height;
            const radius = Math.max(10, Math.min(24, Math.min(guideW, guideH) * 0.04));
            tutorialGuidePoints.forEach(function(candidate) {
                if (tutorialCoveredGuideKeys.has(candidate.key)) return;
                const x = guideX + candidate.nx * guideW;
                const y = guideY + candidate.ny * guideH;
                if (Math.hypot(snappedPoint.x - x, snappedPoint.y - y) <= radius) {
                    tutorialCoveredGuideKeys.add(candidate.key);
                }
            });
            const ratio = tutorialCoveredGuideKeys.size / Math.max(1, tutorialGuidePoints.length);
            if (ratio >= 0.9) {
                forceTutorialApplePrediction();
            }
        }
        function forceTutorialApplePrediction() {
            if (tutorialForceApple) return;
            tutorialForceApple = true;
            const fruit = currentTutorialFruit();
            const variant = fruit === 'banana' ? 'banana_400' : fruit === 'grape' ? 'grape_400' : 'apple_512';
            latestJudgeScores = {
                apple: fruit === 'apple' ? 0.99 : 0.01,
                banana: fruit === 'banana' ? 0.99 : 0.01,
                grape: fruit === 'grape' ? 0.99 : 0.01,
            };
            productionSelectedVariant = variant;
            productionSelectedAt = Date.now();
            generatedVariant = variant;
            updateJudgeProbDisplay();
            updateFireButtonState();
            canvasRevision += 1;
            submittedCanvasRevision = Math.min(submittedCanvasRevision, canvasRevision - 1);
            latestPredictionId = null;
            lastPredictionFruitName = null;
            colorPreviewActive = false;
            if (fruit !== 'banana' && canvasDirty && !predictInFlight) {
                void runPrediction(false);
            } else if (fruit === 'banana') {
                hideColorPreview();
            }
        }
        function renderGameFlow(state) {
            const flowSignalChanged = state.signal !== lastGameFlowSignal;
            if (flowSignalChanged) {
                lastGameFlowSignal = state.signal;
                tutorialDoneStep = 'cards';
                if (state.phase === 'tutorial' || state.phase === 'tutorial_done' || state.phase === 'playing') {
                    resetFruitCards();
                }
                if (state.phase === 'tutorial') {
                    tutorialFruitIndex = 0;
                    resetTutorialGuideProgress();
                }
            }
            gameFlowPhase = state.phase || 'playing';
            if (!DRAW2_MODE) {
                setGameFlowOverlayVisible(false);
                return;
            }
            if (gameFlowPhase === 'ended') {
                const isClear = state.result === 'clear';
                const shouldHandoff = Boolean(state.shouldHandoff);
                const totalSeconds = Math.max(0, Math.round(Number(state.totalPlaySeconds || 0)));
                const attemptCount = Math.max(0, Math.round(Number(state.attemptCount || 0)));
                setFlowOverlayPhase('ended');
                gameFlowOverlay.classList.add(isClear ? 'result-clear' : 'result-over');
                renderFlowPanel(
                    isClear ? 'MISSION COMPLETE' : 'MISSION FAILED',
                    shouldHandoff
                        ? (isClear ? 'ゲームクリア' : 'ゲームオーバー')
                        : 'もう一度チャレンジ',
                    shouldHandoff
                        ? ''
                        : 'プレイ時間 ' + totalSeconds + '秒 / 80秒　' + attemptCount + '回目。まだ続けられます。',
                    [flowButton(shouldHandoff ? '次へ' : '難易度を選ぶ', '', async function() {
                        await transitionGameFlow({ phase: shouldHandoff ? 'handoff' : 'difficulty', difficulty: state.difficulty || 'normal' });
                    })],
                );
                setGameFlowOverlayVisible(true);
            } else if (gameFlowPhase === 'handoff') {
                setFlowOverlayPhase('handoff');
                renderFlowPanel(
                    'PLAYER CHANGE',
                    '次の人と交代してください',
                    '次の人と交代したら「はじめる」ボタンを押してください。',
                    [flowButton('はじめる', '', async function() { await transitionGameFlow({ phase: 'difficulty', difficulty: state.difficulty || 'normal' }); })],
                );
                setGameFlowOverlayVisible(true);
            } else if (gameFlowPhase === 'difficulty') {
                setFlowOverlayPhase('difficulty');
                renderFlowPanel(
                    'SELECT LEVEL',
                    '難易度を選んでください',
                    '初めての人はイージーかノーマルを推奨。はじめに短いチュートリアルを行います。',
                    [
                        flowButton('イージー', 'easy', async function() { await transitionGameFlow({ phase: 'tutorial', difficulty: 'easy' }); await clearRemoteSession(); }),
                        flowButton('ノーマル', 'normal', async function() { await transitionGameFlow({ phase: 'tutorial', difficulty: 'normal' }); await clearRemoteSession(); }),
                        flowButton('ハード', 'hard', async function() { await transitionGameFlow({ phase: 'tutorial', difficulty: 'hard' }); await clearRemoteSession(); }),
                        flowButton('チャレンジ', 'challenge', async function() { await transitionGameFlow({ phase: 'tutorial', difficulty: 'challenge' }); await clearRemoteSession(); }),
                    ],
                );
                setGameFlowOverlayVisible(true);
            } else if (gameFlowPhase === 'tutorial') {
                tutorialStep = getTutorialStep();
                setFlowOverlayPhase('tutorial');
                renderFlowPanel(
                    'TUTORIAL',
                    currentTutorialTitle(),
                    '',
                    [flowButton('スキップ', 'secondary', async function() { await transitionGameFlow({ phase: 'playing', difficulty: state.difficulty || 'normal' }); await clearRemoteSession(); })],
                    createAppleGuide(),
                );
                updateTutorialStepUi();
                setGameFlowOverlayVisible(true);
            } else if (gameFlowPhase === 'tutorial_done') {
                setFlowOverlayPhase('tutorial_done');
                mainStage.classList.add('tutorial-card-highlight');
                gameFlowOverlay.classList.toggle('start-ready', tutorialDoneStep === 'start');
                if (tutorialDoneStep === 'start') {
                    mainStage.classList.remove('tutorial-card-highlight');
                    renderFlowPanel(
                        'TUTORIAL COMPLETE',
                        'チュートリアル終了',
                        '準備ができたらゲームを始めましょう。',
                        [flowButton('ゲームを始める', '', async function() { resetFruitCards(); await transitionGameFlow({ phase: 'playing', difficulty: state.difficulty || 'normal' }); await clearRemoteSession(); })],
                    );
                } else {
                    renderFlowPanel(
                        'FEVER TIME',
                        '7つ集めるとフィーバータイム',
                        '上のフルーツカードを全部そろえよう。',
                        [flowButton('次へ', '', function() { tutorialDoneStep = 'start'; renderGameFlow(state); })],
                    );
                }
                setGameFlowOverlayVisible(true);
            } else {
                gameFlowOverlay.innerHTML = '';
                setFlowOverlayPhase('');
                setGameFlowOverlayVisible(false);
            }
        }
        async function syncGameFlow() {
            try {
                const response = await fetch('/api/game-flow?t=' + Date.now(), { cache: 'no-store' });
                if (!response.ok) return;
                renderGameFlow(await response.json());
            } catch (error) {
                console.warn(error);
            }
        }
        async function commitLatestPrediction(enqueueShot) {
            if (!latestPredictionId) return;
            if (productionModeEnabled) {
                const isStaticFruit = isStaticFruitName(lastPredictionFruitName);
                if (!isStaticFruit) {
                    if (!latestJudgeScores) return;
                    if (DRAW2_MODE && gameFlowPhase !== 'tutorial' && latestJudgeScores && !productionSelectedVariant) {
                        productionSelectedVariant = generatedVariant;
                        productionSelectedAt = Date.now();
                    }
                    if (!productionSelectedVariant) return;
                }
            }
            const response = await fetch('/api/remote-draw/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sessionId, prediction_id: latestPredictionId, enqueue: enqueueShot !== false }),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Failed to commit remote shot');
            if (DRAW2_MODE && payload.shot && enqueueShot !== false) {
                shotHistory.push(payload.shot);
                if (shotHistory.length > 64) shotHistory.shift();
                const shotFruit = payload.shot.bullet_assets && payload.shot.bullet_assets[0]
                    ? payload.shot.bullet_assets[0].fruit_name
                    : lastPredictionFruitName;
                revealFruitCard(shotFruit);
            }
            return payload.shot || true;
        }
        function shouldPrepareSwipeShot() {
            return DRAW2_MODE && productionModeEnabled && (gameFlowPhase === 'playing' || gameFlowPhase === 'tutorial');
        }
        function getPendingFireFruitName() {
            if (gameFlowPhase === 'tutorial') return currentTutorialFruit();
            if (lastPredictionFruitName) return lastPredictionFruitName;
            if (productionSelectedVariant) return fruitNameForVariant(productionSelectedVariant);
            if (generatedVariant) return fruitNameForVariant(generatedVariant);
            if (latestJudgeScores) return fruitNameForVariant(getTopJudgeVariant(latestJudgeScores, true));
            return null;
        }
        function playPendingFireSound() {
            const fruitName = getPendingFireFruitName();
            if (fruitName) playUiSound('fruitShoot', fruitName);
        }
        function resetSwipeDrag() {
            swipeDragStartClient = null;
            mainStage.classList.remove('swipe-dragging');
            mainStage.style.removeProperty('--swipe-drag-x');
            mainStage.style.removeProperty('--swipe-drag-y');
        }
        function stopSwipeInertia() {
            if (swipeInertiaFrame !== null) {
                window.cancelAnimationFrame(swipeInertiaFrame);
                swipeInertiaFrame = null;
            }
        }
        function setSwipeFruitOffset(x, y) {
            swipeFruitOffset = { x, y };
            mainStage.style.setProperty('--swipe-base-x', x.toFixed(1) + 'px');
            mainStage.style.setProperty('--swipe-base-y', y.toFixed(1) + 'px');
        }
        function buildTransparentSwipePreview(src, done) {
            const img = new Image();
            img.onload = function() {
                try {
                    const tmp = document.createElement('canvas');
                    tmp.width = Math.max(1, img.naturalWidth || img.width);
                    tmp.height = Math.max(1, img.naturalHeight || img.height);
                    const tctx = tmp.getContext('2d');
                    if (!tctx) {
                        done(src);
                        return;
                    }
                    tctx.drawImage(img, 0, 0, tmp.width, tmp.height);
                    const imageData = tctx.getImageData(0, 0, tmp.width, tmp.height);
                    const data = imageData.data;
                    for (let i = 0; i < data.length; i += 4) {
                        if (data[i] > 246 && data[i + 1] > 246 && data[i + 2] > 246) data[i + 3] = 0;
                    }
                    tctx.putImageData(imageData, 0, 0);
                    done(tmp.toDataURL('image/png'));
                } catch (error) {
                    done(src);
                }
            };
            img.onerror = function() { done(src); };
            img.src = src;
        }
        function renderSwipeFruitPreviewAsset(asset, keepWithoutPending) {
            if (!asset || !asset.image) {
                swipeFruitPreview.hidden = true;
                swipeFruitPreview.removeAttribute('src');
                return;
            }
            const serial = ++swipePreviewSerial;
            swipeFruitPreview.src = asset.image;
            swipeFruitPreview.hidden = false;
            buildTransparentSwipePreview(asset.image, function(src) {
                if (serial !== swipePreviewSerial || (!keepWithoutPending && !pendingSwipeShot)) return;
                swipeFruitPreview.src = src;
                swipeFruitPreview.hidden = false;
            });
            swipeFruitPreview.style.left = ((asset.origin_x / canvas.width) * 100) + '%';
            swipeFruitPreview.style.top = ((asset.origin_y / canvas.height) * 100) + '%';
            swipeFruitPreview.style.width = ((asset.width / canvas.width) * 100) + '%';
            swipeFruitPreview.style.height = ((asset.height / canvas.height) * 100) + '%';
            setSwipeFruitOffset(0, 0);
        }
        function renderSwipeFruitPreview(shot) {
            const asset = shot && shot.bullet_assets && shot.bullet_assets[0];
            renderSwipeFruitPreviewAsset(asset, false);
        }
        function setSwipeShotReady(shot) {
            pendingSwipeShot = shot || null;
            swipeStartPoint = null;
            stopSwipeInertia();
            resetSwipeDrag();
            if (pendingSwipeShot) {
                renderSwipeFruitPreview(pendingSwipeShot);
            } else {
                swipePreviewSerial += 1;
                swipeFruitPreview.hidden = true;
                swipeFruitPreview.removeAttribute('src');
                setSwipeFruitOffset(0, 0);
            }
            mainStage.classList.toggle('swipe-shot-ready', Boolean(pendingSwipeShot));
            setFireButtonDisabled(Boolean(pendingSwipeShot));
            clearButton.disabled = Boolean(pendingSwipeShot);
        }
        function cancelPreparedSwipeShot(suppressNextDirectSwipe) {
            pendingSwipeShot = null;
            swipeStartPoint = null;
            directSwipeCandidate = null;
            activePointerId = null;
            drawing = false;
            drawingSuspendedByGuide = false;
            stopSwipeInertia();
            resetSwipeDrag();
            swipePreviewSerial += 1;
            swipeFruitPreview.hidden = true;
            swipeFruitPreview.removeAttribute('src');
            setSwipeFruitOffset(0, 0);
            mainStage.classList.remove('swipe-shot-ready', 'swipe-shot-bounce', 'swipe-shot-local-fly');
            suppressDirectSwipeUntilNextStroke = Boolean(suppressNextDirectSwipe);
            setFireButtonDisabled(false);
        }
        function pointFromClient(clientX, clientY) {
            const rect = canvas.getBoundingClientRect();
            const x = ((clientX - rect.left) / rect.width) * canvas.width;
            const y = ((clientY - rect.top) / rect.height) * canvas.height;
            return {
                x: Math.max(0, Math.min(canvas.width, x)),
                y: Math.max(0, Math.min(canvas.height, y)),
            };
        }
        function moveSwipeFruitOffsetBy(deltaX, deltaY) {
            let nextX = swipeFruitOffset.x + deltaX;
            let nextY = swipeFruitOffset.y + deltaY;
            const rect = swipeFruitPreview.getBoundingClientRect();
            const baseTop = rect.top - swipeFruitOffset.y;
            const margin = 1;
            let bouncedY = false;
            if (baseTop + nextY + rect.height > window.innerHeight - margin) {
                nextY = window.innerHeight - margin - rect.height - baseTop;
                bouncedY = true;
            }
            setSwipeFruitOffset(nextX, nextY);
            return { bouncedY, rect: swipeFruitPreview.getBoundingClientRect() };
        }
        function normalizeLaunchVelocity(vx, vy) {
            const sideSpeed = Math.abs(vx);
            if (vy >= 0) {
                vy = -Math.max(0.02, sideSpeed * 0.12);
            } else {
                const minimumUpward = sideSpeed * 0.55;
                if (Math.abs(vy) < minimumUpward) {
                    vy = -minimumUpward;
                }
            }
            const len = Math.max(1, Math.hypot(vx, vy));
            return { x: vx / len, y: vy / len };
        }
        async function enqueuePreparedSwipeShotFromMotion(vx, vy) {
            if (!pendingSwipeShot) return false;
            playPendingFireSound();
            const shot = JSON.parse(JSON.stringify(pendingSwipeShot));
            shot.launch_x = CONFIG.processingWidth / 2;
            shot.launch_y = CONFIG.processingHeight;
            const launchVelocity = normalizeLaunchVelocity(vx, vy);
            shot.launch_vx = launchVelocity.x;
            shot.launch_vy = launchVelocity.y;
            const response = await fetch('/api/remote-shot/enqueue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shot }),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || '発射キューへの追加に失敗しました');
            shotHistory.push(shot);
            if (shotHistory.length > 64) shotHistory.shift();
            const shotFruit = shot.bullet_assets && shot.bullet_assets[0] ? shot.bullet_assets[0].fruit_name : lastPredictionFruitName;
            revealFruitCard(shotFruit);
            setSwipeShotReady(null);
            await clearRemoteSession(true);
            return true;
        }
        function startSwipeInertia(endClientX, endClientY) {
            if (!pendingSwipeShot || !swipeDragStartClient) return;
            const dragDx = endClientX - swipeDragStartClient.x;
            const dragDy = endClientY - swipeDragStartClient.y;
            const dragLen = Math.hypot(dragDx, dragDy);
            if (dragLen < 3) return;
            moveSwipeFruitOffsetBy(dragDx, dragDy);
            resetSwipeDrag();
            let vx = dragDx * 6.8;
            let vy = dragDy * 6.8;
            let lastT = performance.now();
            stopSwipeInertia();
            const step = (now) => {
                if (!pendingSwipeShot) {
                    swipeInertiaFrame = null;
                    return;
                }
                const dt = Math.min(0.032, Math.max(0.001, (now - lastT) / 1000));
                lastT = now;
                const moved = moveSwipeFruitOffsetBy(vx * dt, vy * dt);
                if (moved.bouncedY) vy *= -0.78;
                const rect = moved.rect;
                const exitedTop = rect.top <= -2 && vy < 0;
                const exitedLeft = rect.left <= 1 && vx < 0;
                const exitedRight = rect.right >= window.innerWidth - 1 && vx > 0;
                if (exitedTop || exitedLeft || exitedRight) {
                    swipeInertiaFrame = null;
                    enqueuePreparedSwipeShotFromMotion(vx, vy).catch(function(error) {
                        console.warn('[swipe-shot]', error);
                        playUiSound('fireBlocked');
                    });
                    return;
                }
                const friction = Math.pow(0.94, dt * 60);
                vx *= friction;
                vy *= friction;
                if (Math.hypot(vx, vy) < 18) {
                    swipeInertiaFrame = null;
                    return;
                }
                swipeInertiaFrame = window.requestAnimationFrame(step);
            };
            mainStage.classList.add('swipe-shot-local-fly');
            window.setTimeout(function() { mainStage.classList.remove('swipe-shot-local-fly'); }, 360);
            swipeInertiaFrame = window.requestAnimationFrame(step);
        }
        function buildBossDrawMirrorDataUrl() {
            const mirror = document.createElement('canvas');
            mirror.width = CONFIG.frameWidth;
            mirror.height = CONFIG.frameHeight;
            const mctx = mirror.getContext('2d');
            mctx.fillStyle = '#fff';
            mctx.fillRect(0, 0, mirror.width, mirror.height);
            try {
                if (!preview.hidden && preview.complete && preview.naturalWidth > 0) {
                    mctx.drawImage(preview, 0, 0, mirror.width, mirror.height);
                }
                if (!staticFruitPreview.hidden && staticFruitPreview.complete && staticFruitPreview.naturalWidth > 0) {
                    const left = parseFloat(staticFruitPreview.style.left || '0') / 100 * mirror.width;
                    const top = parseFloat(staticFruitPreview.style.top || '0') / 100 * mirror.height;
                    const width = parseFloat(staticFruitPreview.style.width || '0') / 100 * mirror.width;
                    const height = parseFloat(staticFruitPreview.style.height || '0') / 100 * mirror.height;
                    if (width > 0 && height > 0) mctx.drawImage(staticFruitPreview, left, top, width, height);
                }
            } catch (error) {}
            mctx.drawImage(displayCanvas, 0, 0, mirror.width, mirror.height);
            return mirror.toDataURL('image/jpeg', 0.78);
        }
        function postBossDrawMirror() {
            if (!DRAW2_MODE) return;
            try {
                fetch('/api/boss-mirror/draw', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image: buildBossDrawMirrorDataUrl() }),
                }).catch(function() {});
            } catch (error) {}
        }
        async function runPrediction(commitAfter) {
            if (predictInFlight || !canvasDirty) {
                if (commitAfter) pendingCommitAfterPrediction = true;
                return;
            }
            if (canvasRevision === submittedCanvasRevision) {
                if (commitAfter && latestPredictionId != null && !drawing) {
                    pendingCommitAfterPrediction = false;
                    const prepareSwipe = shouldPrepareSwipeShot();
                    const committed = await commitLatestPrediction(!prepareSwipe);
                    if (committed && prepareSwipe && typeof committed === 'object') {
                        setSwipeShotReady(committed);
                        clearAfterCommit = false;
                    } else if (committed && clearAfterCommit) {
                        await clearRemoteSession(true);
                    }
                }
                return;
            }
            const bbox = getInkBounds();
            if (!bbox) return;
            const forcedStaticFruit = getForcedStaticFruitType(bbox);
            let effectiveForcedStaticFruit = gameFlowPhase === 'tutorial' ? null : forcedStaticFruit;
            if (
                productionModeEnabled
                && gameFlowPhase === 'tutorial'
                && currentTutorialFruit() === 'banana'
                && !commitAfter
                && !pendingCommitAfterPrediction
            ) {
                latestPredictionId = null;
                lastPredictionFruitName = null;
                updateCropOverlay(computeGeneratedCropRect(bbox));
                hideColorPreview();
                return;
            }
            if (productionModeEnabled && !effectiveForcedStaticFruit) {
                if (gameFlowPhase === 'tutorial' && tutorialForceApple) {
                    const fruit = currentTutorialFruit();
                    latestJudgeScores = {
                        apple: fruit === 'apple' ? 0.99 : 0.01,
                        banana: fruit === 'banana' ? 0.99 : 0.01,
                        grape: fruit === 'grape' ? 0.99 : 0.01,
                    };
                    productionSelectedVariant = fruit === 'banana' ? 'banana_400' : fruit === 'grape' ? 'grape_400' : 'apple_512';
                    productionSelectedAt = Date.now();
                } else {
                    await runJudge();
                }
                let winner = gameFlowPhase === 'tutorial' && tutorialForceApple
                    ? productionSelectedVariant
                    : resolveProductionVariant(latestJudgeScores, bbox);
                if (winner) {
                    shapeMatchedStaticFruit = null;
                    lastPredictionFruitName = null;
                    effectiveForcedStaticFruit = null;
                }
                if (!winner && commitAfter && DRAW2_MODE && gameFlowPhase !== 'tutorial') {
                    winner = getTopJudgeVariant(latestJudgeScores, true);
                    if (winner) {
                        productionSelectedVariant = winner;
                        productionSelectedAt = Date.now();
                    }
                }
                if (!winner) {
                    if (DRAW2_MODE && gameFlowPhase !== 'tutorial') {
                        let shapeResult = null;
                        try {
                            shapeResult = await runShapeMatchForFire(bbox);
                        } catch (error) {
                            console.warn('[shape-match]', error);
                        }
                        const rule = shapeResult && shapeResult.rule;
                        const best = shapeResult && (shapeResult.rule_best || shapeResult.best);
                        const bestScore = best && shapeResult.rule_scores && shapeResult.rule_scores[best]
                            ? Number(shapeResult.rule_scores[best].score || 0)
                            : 0;
                        if (rule && Number(rule.closed_region_count || 0) >= 1 && best && SMALL_STATIC_FRUITS.indexOf(best) >= 0 && bestScore >= 0.5) {
                            shapeMatchedStaticFruit = best;
                            effectiveForcedStaticFruit = best;
                            lastPredictionFruitName = best;
                            productionSelectedVariant = null;
                        } else {
                            shapeMatchedStaticFruit = null;
                        }
                    }
                }
                if (!winner && !effectiveForcedStaticFruit) {
                    latestPredictionId = null;
                    lastPredictionFruitName = null;
                    preview.hidden = true;
                    preview.removeAttribute('src');
                    staticFruitPreview.hidden = true;
                    staticFruitPreview.removeAttribute('src');
                    colorPreviewActive = false;
                    renderDisplayLines(true);
                    updateCropOverlay(computeGeneratedCropRect(bbox));
                    updateFireButtonState();
                    return;
                }
                generatedVariant = winner;
            }
            const requestSerial = ++latestRequestSerial;
            const requestRevision = canvasRevision;
            submittedCanvasRevision = requestRevision;
            const strokeSerial = activeStrokeSerial;
            predictInFlight = true;
            try {
                const response = await fetch('/api/remote-draw/predict', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        session_id: sessionId,
                        image: buildInputDataUrl(),
                        sketch_overlay: buildSketchOverlayDataUrl(),
                        bbox,
                        image_id: 'AUTO',
                        fruit_name: 'banana',
                        judge_mode: 'components',
                        predict_mode: drawMode,
                        generated_variant: generatedVariant,
                        banana_postprocess: bananaPostprocessEnabled,
                        keep_largest: keepLargestEnabled,
                        alpha_keep_largest: alphaKeepLargestEnabled,
                        apple_skip_inner_alpha: appleSkipInnerAlphaEnabled,
                        apple_skip_radial_variance: appleSkipRadialVarianceEnabled,
                        apple_radial_variance_threshold: appleRadialVarianceThreshold,
                        non_alpha_mode: nonAlphaModeEnabled,
                        apple_align_input_fill: productionModeEnabled && generatedVariant === 'apple_512' && !nonAlphaModeEnabled,
                        static_fruit_name: effectiveForcedStaticFruit,
                        canvas_width: canvas.width,
                        canvas_height: canvas.height,
                        frame_width: CONFIG.frameWidth,
                        frame_height: CONFIG.frameHeight,
                    }),
                });
                const payload = await response.json();
                if (!response.ok) throw new Error(payload.error || '生成に失敗しました');
                if (strokeSerial !== activeStrokeSerial) return;
                if (requestSerial >= latestAppliedSerial) {
                    latestAppliedSerial = requestSerial;
                    latestPredictionId = payload.prediction_id;
                    if (Array.isArray(payload.bullet_assets) && payload.bullet_assets.length > 0) {
                        lastPredictionFruitName = payload.bullet_assets[0].fruit_name || null;
                    }
                    const staticAsset = Array.isArray(payload.bullet_assets)
                        ? payload.bullet_assets.find(function(asset) { return asset && isStaticFruitName(asset.fruit_name); })
                        : null;
                    updateCropOverlay(payload.generated_crop || computeGeneratedCropRect(bbox));
                    if (payload.centroid_canvas) {
                        latestCentroid = payload.centroid_canvas;
                        drawCentroidOverlay();
                    }
                    updateTimingPanel(payload.pipeline_timings || null);
                    if (staticAsset) {
                        renderStaticFruitPreview(staticAsset);
                    } else if (payload.stage_image && !payload.skipped) {
                        if (productionModeEnabled && generatedVariant === 'apple_512' && !payload.non_alpha_mode) {
                            lastNonSkippedApplePayload = payload;
                        }
                        applyGeneratedPreviewPayload(payload, bbox);
                    } else if (payload.skipped) {
                        if (
                            productionModeEnabled
                            && generatedVariant === 'apple_512'
                            && !payload.non_alpha_mode
                            && lastNonSkippedApplePayload
                        ) {
                            latestPredictionId = lastNonSkippedApplePayload.prediction_id;
                            applyGeneratedPreviewPayload(lastNonSkippedApplePayload, bbox);
                        } else {
                            hideColorPreview();
                        }
                    }
                    if (payload.border_preview_image) {
                        borderPreview.src = payload.border_preview_image;
                        borderPreview.hidden = false;
                        borderPreviewPlaceholder.hidden = true;
                    }
                    if (payload.cleaned_border_preview_image) {
                        cleanedBorderPreview.src = payload.cleaned_border_preview_image;
                        cleanedBorderPreview.hidden = false;
                        cleanedBorderPreviewPlaceholder.hidden = true;
                    }
                    if (!payload.skipped) {
                        const structureImage = payload.structure_preview_image || payload.composite_image || payload.stage_image;
                        if (structureImage) {
                            structurePreview.src = structureImage;
                            structurePreview.hidden = false;
                            structurePreviewPlaceholder.hidden = true;
                        }
                    }
                }
                if (requestRevision === canvasRevision && (commitAfter || pendingCommitAfterPrediction) && !drawing) {
                    pendingCommitAfterPrediction = false;
                    const prepareSwipe = shouldPrepareSwipeShot();
                    const committed = await commitLatestPrediction(!prepareSwipe);
                    if (committed && prepareSwipe && typeof committed === 'object') {
                        setSwipeShotReady(committed);
                        clearAfterCommit = false;
                    } else if (committed && clearAfterCommit) {
                        await clearRemoteSession(true);
                    }
                }
            } catch (error) {
                console.error(error);
            } finally {
                predictInFlight = false;
                if (pendingCommitAfterPrediction && !drawing && latestPredictionId) {
                    pendingCommitAfterPrediction = false;
                    const prepareSwipe = shouldPrepareSwipeShot();
                    const committed = await commitLatestPrediction(!prepareSwipe);
                    if (committed && prepareSwipe && typeof committed === 'object') {
                        setSwipeShotReady(committed);
                        clearAfterCommit = false;
                    } else if (committed && clearAfterCommit) {
                        await clearRemoteSession(true);
                    }
                } else if (canvasDirty && canvasRevision > submittedCanvasRevision) {
                    const shouldCommitAfterLatest = pendingCommitAfterPrediction && !drawing;
                    void runPrediction(shouldCommitAfterLatest);
                }
            }
        }
        function getInputId(event) {
            if (event && event.pointerId !== undefined && event.pointerId !== null) return 'pointer:' + event.pointerId;
            if (event && event.identifier !== undefined && event.identifier !== null) return 'touch:' + event.identifier;
            return 'mouse';
        }
        function getLatestFruitClientRect() {
            if (!latestPreviewAsset || !latestPreviewAsset.image || !colorPreviewActive || !latestPredictionId) return null;
            const rect = canvas.getBoundingClientRect();
            const left = rect.left + (latestPreviewAsset.origin_x / canvas.width) * rect.width;
            const top = rect.top + (latestPreviewAsset.origin_y / canvas.height) * rect.height;
            const width = (latestPreviewAsset.width / canvas.width) * rect.width;
            const height = (latestPreviewAsset.height / canvas.height) * rect.height;
            if (!(width > 0 && height > 0)) return null;
            const padding = Math.max(12, Math.min(width, height) * 0.16);
            return {
                left: left - padding,
                top: top - padding,
                right: left + width + padding,
                bottom: top + height + padding,
            };
        }
        function isPointInLatestFruit(clientX, clientY) {
            const rect = getLatestFruitClientRect();
            return Boolean(rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom);
        }
        function isDirectSwipeLaunchGesture(dx, dy) {
            const distance = Math.hypot(dx, dy);
            if (distance < 24) return false;
            const downwardAllowance = Math.max(4, Math.abs(dx) * 0.08);
            return dy <= downwardAllowance;
        }
        function isPointInSwipeFruitPreview(clientX, clientY) {
            if (swipeFruitPreview.hidden) return false;
            const rect = swipeFruitPreview.getBoundingClientRect();
            if (!(rect.width > 0 && rect.height > 0)) return false;
            const padding = Math.max(10, Math.min(rect.width, rect.height) * 0.12);
            return clientX >= rect.left - padding
                && clientX <= rect.right + padding
                && clientY >= rect.top - padding
                && clientY <= rect.bottom + padding;
        }
        function canStartDirectFruitSwipe(event) {
            return DRAW2_MODE
                && productionModeEnabled
                && (gameFlowPhase === 'playing' || (gameFlowPhase === 'tutorial' && isTutorialDirectSwipeFruit()))
                && !pendingSwipeShot
                && !suppressDirectSwipeUntilNextStroke
                && !predictInFlight
                && !drawing
                && canvasDirty
                && colorPreviewActive
                && latestPredictionId
                && latestPreviewAsset
                && isPointInLatestFruit(event.clientX, event.clientY);
        }
        async function prepareDirectSwipeShot() {
            try {
                return await commitLatestPrediction(false);
            } catch (error) {
                console.warn('[direct-swipe]', error);
                return null;
            }
        }
        function beginDirectSwipeCandidate(event) {
            if (!canStartDirectFruitSwipe(event)) return false;
            const point = pointFromEvent(event);
            directSwipeCandidate = {
                inputId: getInputId(event),
                startClient: { x: event.clientX, y: event.clientY },
                latestClient: { x: event.clientX, y: event.clientY },
                points: [point],
                shotPromise: prepareDirectSwipeShot(),
            };
            activePointerId = directSwipeCandidate.inputId;
            renderSwipeFruitPreviewAsset(latestPreviewAsset, true);
            mainStage.classList.add('swipe-shot-ready', 'swipe-dragging');
            mainStage.style.removeProperty('--swipe-drag-x');
            mainStage.style.removeProperty('--swipe-drag-y');
            try { canvas.setPointerCapture?.(event.pointerId); } catch (error) {}
            event.preventDefault();
            return true;
        }
        function updateDirectSwipeCandidate(event) {
            if (!directSwipeCandidate || activePointerId !== getInputId(event)) return false;
            const dx = event.clientX - directSwipeCandidate.startClient.x;
            const dy = event.clientY - directSwipeCandidate.startClient.y;
            directSwipeCandidate.latestClient = { x: event.clientX, y: event.clientY };
            directSwipeCandidate.points.push(pointFromEvent(event));
            mainStage.style.setProperty('--swipe-drag-x', dx.toFixed(1) + 'px');
            mainStage.style.setProperty('--swipe-drag-y', dy.toFixed(1) + 'px');
            event.preventDefault();
            return true;
        }
        function replayDirectSwipeAsStroke(points) {
            if (!points || points.length === 0) return;
            activeStrokeSerial += 1;
            latestPredictionId = null;
            latestPreviewAsset = null;
            shapeMatchedStaticFruit = null;
            updateShapeMatchPanel(null);
            if (strokePoints.length > 0) strokePoints.push(null);
            ctx.beginPath();
            points.forEach(function(point, index) {
                strokePoints.push(point);
                if (index === 0) {
                    ctx.moveTo(point.x, point.y);
                    ctx.lineTo(point.x, point.y);
                } else {
                    ctx.lineTo(point.x, point.y);
                }
            });
            ctx.stroke();
            renderDisplayLines(true);
            canvasDirty = true;
            canvasRevision += 1;
            updateGeneratedModeCropGuide();
            setFireButtonDisabled(false);
            if (!predictInFlight) void runPrediction(false);
        }
        async function finishDirectSwipeCandidate(event) {
            if (!directSwipeCandidate || activePointerId !== getInputId(event)) return false;
            const candidate = directSwipeCandidate;
            directSwipeCandidate = null;
            activePointerId = null;
            const endClientX = event.clientX;
            const endClientY = event.clientY;
            const dx = endClientX - candidate.startClient.x;
            const dy = endClientY - candidate.startClient.y;
            const shouldLaunch = isDirectSwipeLaunchGesture(dx, dy);
            resetSwipeDrag();
            if (!shouldLaunch) {
                mainStage.classList.remove('swipe-shot-ready');
                swipePreviewSerial += 1;
                swipeFruitPreview.hidden = true;
                swipeFruitPreview.removeAttribute('src');
                setSwipeFruitOffset(0, 0);
                suppressDirectSwipeUntilNextStroke = true;
                event.preventDefault();
                return true;
            }
            const shot = await candidate.shotPromise;
            if (!shot || typeof shot !== 'object') {
                mainStage.classList.remove('swipe-shot-ready');
                swipePreviewSerial += 1;
                swipeFruitPreview.hidden = true;
                swipeFruitPreview.removeAttribute('src');
                setSwipeFruitOffset(0, 0);
                suppressDirectSwipeUntilNextStroke = true;
                playUiSound('fireBlocked');
                event.preventDefault();
                return true;
            }
            setSwipeShotReady(shot);
            swipeStartPoint = pointFromClient(candidate.startClient.x, candidate.startClient.y);
            swipeDragStartClient = { x: candidate.startClient.x, y: candidate.startClient.y };
            mainStage.style.setProperty('--swipe-drag-x', dx.toFixed(1) + 'px');
            mainStage.style.setProperty('--swipe-drag-y', dy.toFixed(1) + 'px');
            startSwipeInertia(endClientX, endClientY);
            event.preventDefault();
            return true;
        }
        function cancelDirectSwipeCandidate() {
            if (!directSwipeCandidate) return false;
            directSwipeCandidate = null;
            activePointerId = null;
            resetSwipeDrag();
            mainStage.classList.remove('swipe-shot-ready');
            swipePreviewSerial += 1;
            swipeFruitPreview.hidden = true;
            swipeFruitPreview.removeAttribute('src');
            setSwipeFruitOffset(0, 0);
            return true;
        }
        function startDraw(event) {
            if (beginDirectSwipeCandidate(event)) return;
            if (!isDrawInputEnabled()) return;
            if (drawing) return;
            const wasDirectSwipeSuppressed = suppressDirectSwipeUntilNextStroke;
            suppressDirectSwipeUntilNextStroke = false;
            const point = getTutorialGuidePoint(pointFromEvent(event));
            if (!point) {
                suppressDirectSwipeUntilNextStroke = wasDirectSwipeSuppressed;
                event.preventDefault();
                return;
            }
            lastTutorialGuidePoint = point;
            drawing = true;
            drawingSuspendedByGuide = false;
            activeStrokeSerial += 1;
            activePointerId = getInputId(event);
            pendingCommitAfterPrediction = false;
            latestPredictionId = null;
            latestPreviewAsset = null;
            shapeMatchedStaticFruit = null;
            updateShapeMatchPanel(null);
            if (!canvasDirty && strokePoints.length === 0) {
                canvasRevision = 0;
                submittedCanvasRevision = 0;
                latestRequestSerial = 0;
                latestAppliedSerial = 0;
                colorPreviewActive = false;
                resetCanvasVisuals();
                clearPreview();
                pixelCountHistory = [];
                updateGraphs();
            }
            if (strokePoints.length > 0) {
                strokePoints.push(null);
            }
            strokePoints.push(point);
            ctx.beginPath();
            ctx.moveTo(point.x, point.y);
            ctx.lineTo(point.x, point.y);
            ctx.stroke();
            markTutorialGuideCoverage(point);
            renderDisplayLines(true);
            canvasDirty = true;
            canvasRevision += 1;
            setFireButtonDisabled(false);
            updateGeneratedModeCropGuide({
                left: point.x,
                top: point.y,
                right: point.x + 1,
                bottom: point.y + 1,
                width: 1,
                height: 1,
            });
            if (event.pointerId !== undefined && event.pointerId !== null) {
                canvas.setPointerCapture?.(event.pointerId);
            }
            event.preventDefault();
        }
        function draw(event) {
            if (updateDirectSwipeCandidate(event)) return;
            if (!drawing || activePointerId !== getInputId(event)) return;
            const point = getTutorialGuidePoint(pointFromEvent(event));
            if (!point) {
                strokePoints.push(null);
                ctx.beginPath();
                drawingSuspendedByGuide = true;
                renderDisplayLines(false);
                event.preventDefault();
                return;
            }
            if (drawingSuspendedByGuide) {
                strokePoints.push(null);
                ctx.beginPath();
                ctx.moveTo(point.x, point.y);
                drawingSuspendedByGuide = false;
            } else if (gameFlowPhase === 'tutorial' && lastTutorialGuidePoint) {
                const maxSegment = Math.max(10, Math.min(canvas.width, canvas.height) * 0.045);
                if (Math.hypot(point.x - lastTutorialGuidePoint.x, point.y - lastTutorialGuidePoint.y) > maxSegment) {
                    strokePoints.push(null);
                    ctx.beginPath();
                    ctx.moveTo(point.x, point.y);
                }
            }
            strokePoints.push(point);
            ctx.lineTo(point.x, point.y);
            ctx.stroke();
            markTutorialGuideCoverage(point);
            lastTutorialGuidePoint = point;
            if (gameFlowPhase === 'tutorial') {
                const now = Date.now();
                if (now - lastLineSoundAt > 90) {
                    lastLineSoundAt = now;
                    playUiSound('lineDraw');
                }
            }
            renderDisplayLines(false);
            canvasDirty = true;
            canvasRevision += 1;
            updateGeneratedModeCropGuide();
            event.preventDefault();
        }
        async function endDraw(event) {
            if (event && await finishDirectSwipeCandidate(event)) return;
            if (!drawing || (event && activePointerId !== getInputId(event))) return;
            drawing = false;
            lastTutorialGuidePoint = null;
            activePointerId = null;
            ctx.beginPath();
            setFireButtonDisabled(false);
            if (canvasDirty) {
                if (!predictInFlight) void runPrediction(false);
            }
        }
        function touchPointEvent(touch, sourceEvent) {
            return {
                clientX: touch.clientX,
                clientY: touch.clientY,
                identifier: touch.identifier,
                preventDefault: function() { sourceEvent.preventDefault(); },
            };
        }
        function findActiveTouch(event) {
            if (activePointerId && activePointerId.indexOf('touch:') === 0) {
                const id = Number(activePointerId.slice(6));
                for (const touch of Array.from(event.touches || [])) {
                    if (touch.identifier === id) return touch;
                }
                for (const touch of Array.from(event.changedTouches || [])) {
                    if (touch.identifier === id) return touch;
                }
                return null;
            }
            return (event.changedTouches && event.changedTouches[0]) || (event.touches && event.touches[0]) || null;
        }
        function handleTouchStart(event) {
            const touch = findActiveTouch(event);
            if (!touch) return;
            startDraw(touchPointEvent(touch, event));
        }
        function handleTouchMove(event) {
            const touch = findActiveTouch(event);
            if (!touch) return;
            draw(touchPointEvent(touch, event));
        }
        function handleTouchEnd(event) {
            const touch = findActiveTouch(event);
            if (!touch) return;
            endDraw(touchPointEvent(touch, event));
        }
        function measurePixelCounts(stageSrc, crop) {
            return new Promise(function(resolve) {
                var img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = function() {
                    try {
                        var MODEL_SIZE = 128;
                        // Processing space: crop to generated_crop region → resize to 128×128
                        var cropLeft = Math.max(0, crop.left);
                        var cropTop = Math.max(0, crop.top);
                        var cropRight = Math.min(img.naturalWidth, crop.right);
                        var cropBottom = Math.min(img.naturalHeight, crop.bottom);
                        var cropW = Math.max(1, cropRight - cropLeft);
                        var cropH = Math.max(1, cropBottom - cropTop);
                        var procC = document.createElement('canvas');
                        procC.width = MODEL_SIZE; procC.height = MODEL_SIZE;
                        var procCx = procC.getContext('2d');
                        procCx.drawImage(img, cropLeft, cropTop, cropW, cropH, 0, 0, MODEL_SIZE, MODEL_SIZE);
                        var procData = procCx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
                        var procCount = 0;
                        for (var j = 0; j < procData.length; j += 4) {
                            if (procData[j] < GRAPH_WHITE_THRESHOLD || procData[j+1] < GRAPH_WHITE_THRESHOLD || procData[j+2] < GRAPH_WHITE_THRESHOLD) {
                                procCount++;
                            }
                        }
                        // UI space: resize whole stage image to screen dimensions
                        var uiW = window.innerWidth, uiH = window.innerHeight;
                        var uiC = document.createElement('canvas');
                        uiC.width = uiW; uiC.height = uiH;
                        var uiCx = uiC.getContext('2d');
                        uiCx.drawImage(img, 0, 0, uiW, uiH);
                        var uiData = uiCx.getImageData(0, 0, uiW, uiH).data;
                        var uiCount = 0;
                        for (var i = 0; i < uiData.length; i += 4) {
                            if (uiData[i] < GRAPH_WHITE_THRESHOLD || uiData[i+1] < GRAPH_WHITE_THRESHOLD || uiData[i+2] < GRAPH_WHITE_THRESHOLD) {
                                uiCount++;
                            }
                        }
                        resolve({ processing: procCount, ui: uiCount });
                    } catch(e) { resolve({ processing: 0, ui: 0 }); }
                };
                img.onerror = function() { resolve({ processing: 0, ui: 0 }); };
                img.src = stageSrc;
            });
        }
        function drawSingleGraph(gc, values, lineColor, fillColor, totalPixels) {
            if (!gc) return;
            var gctx = gc.getContext('2d');
            var w = gc.width, h = gc.height;
            gctx.clearRect(0, 0, w, h);
            var padL = 3, padR = 3, padT = 3, padB = 15;
            var cw = w - padL - padR, ch = h - padT - padB;
            gctx.fillStyle = 'rgba(0,0,0,0.22)';
            gctx.beginPath();
            gctx.roundRect(0, 0, w, h, 3);
            gctx.fill();
            if (values.length === 0) {
                gctx.fillStyle = 'rgba(255,255,255,0.22)';
                gctx.font = '9px monospace';
                gctx.textAlign = 'center';
                gctx.textBaseline = 'middle';
                gctx.fillText('no data', w / 2, (h - padB) / 2 + padT);
                return;
            }
            var maxVal = Math.max.apply(null, values.concat([1]));
            var getX = function(i) { return padL + (values.length === 1 ? cw / 2 : (i / (values.length - 1)) * cw); };
            var getY = function(v) { return padT + ch * (1 - v / maxVal); };
            gctx.strokeStyle = 'rgba(255,255,255,0.07)';
            gctx.lineWidth = 0.5;
            gctx.beginPath();
            gctx.moveTo(padL, padT + ch / 2);
            gctx.lineTo(padL + cw, padT + ch / 2);
            gctx.stroke();
            if (values.length > 1) {
                gctx.beginPath();
                values.forEach(function(v, i) {
                    var x = getX(i), y = getY(v);
                    if (i === 0) gctx.moveTo(x, y); else gctx.lineTo(x, y);
                });
                gctx.lineTo(getX(values.length - 1), padT + ch);
                gctx.lineTo(padL, padT + ch);
                gctx.closePath();
                gctx.fillStyle = fillColor;
                gctx.fill();
            }
            gctx.strokeStyle = lineColor;
            gctx.lineWidth = 1.5;
            gctx.lineJoin = 'round';
            gctx.beginPath();
            values.forEach(function(v, i) {
                var x = getX(i), y = getY(v);
                if (i === 0) gctx.moveTo(x, y); else gctx.lineTo(x, y);
            });
            gctx.stroke();
            gctx.fillStyle = lineColor;
            values.forEach(function(v, i) {
                gctx.beginPath();
                gctx.arc(getX(i), getY(v), i === values.length - 1 ? 2.5 : 1.5, 0, Math.PI * 2);
                gctx.fill();
            });
            var latest = values[values.length - 1];
            var pct = totalPixels > 0 ? (latest / totalPixels * 100).toFixed(1) : '?';
            gctx.font = 'bold 9px monospace';
            gctx.textBaseline = 'bottom';
            gctx.fillStyle = lineColor;
            gctx.textAlign = 'left';
            gctx.fillText(latest.toLocaleString(), padL, h - 1);
            gctx.fillStyle = 'rgba(255,255,255,0.45)';
            gctx.textAlign = 'right';
            gctx.fillText(pct + '%', w - padR, h - 1);
        }
        function updateGraphs() {
            var procVals = pixelCountHistory.map(function(h) { return h.processing; });
            var uiVals = pixelCountHistory.map(function(h) { return h.ui; });
            var procTotal = 128 * 128;
            var uiTotal = window.innerWidth * window.innerHeight;
            drawSingleGraph(procGraphCanvas, procVals, '#7ec8ff', 'rgba(126,200,255,0.14)', procTotal);
            drawSingleGraph(uiGraphCanvas, uiVals, '#ffb86c', 'rgba(255,184,108,0.14)', uiTotal);
        }
        function hasFireableFruit() {
            if (pendingSwipeShot) return false;
            if (gameFlowPhase === 'tutorial') {
                const expectedFruit = currentTutorialFruit();
                const predictedFruit = lastPredictionFruitName || fruitNameForVariant(generatedVariant) || fruitNameForVariant(productionSelectedVariant);
                if (expectedFruit === 'banana' && tutorialForceApple && !colorPreviewActive) return true;
                return Boolean(latestPredictionId && colorPreviewActive && predictedFruit === expectedFruit);
            }
            if (DRAW2_MODE && productionModeEnabled && canvasDirty) {
                return gameFlowPhase === 'playing';
            }
            return Boolean(latestPredictionId && colorPreviewActive);
        }
        function isDrawInputEnabled() {
            return !pendingSwipeShot && (gameFlowPhase === 'playing' || gameFlowPhase === 'tutorial');
        }
        function getTutorialStep() {
            if (gameFlowPhase !== 'tutorial') return 'draw';
            if (pendingSwipeShot) return 'swipe';
            const fruit = currentTutorialFruit();
            if (fruit === 'banana' && tutorialForceApple && !colorPreviewActive) return 'button';
            if (hasFireableFruit()) return isTutorialDirectSwipeFruit() ? 'direct' : 'button';
            return 'draw';
        }
        function updateTutorialStepUi() {
            tutorialStep = getTutorialStep();
            const fireStep = gameFlowPhase === 'tutorial' && tutorialStep === 'button';
            const directStep = gameFlowPhase === 'tutorial' && (tutorialStep === 'direct' || tutorialStep === 'swipe');
            mainStage.classList.toggle('tutorial-fire-step', fireStep);
            gameFlowOverlay.classList.toggle('tutorial-fire-step', fireStep);
            gameFlowOverlay.classList.toggle('tutorial-direct-step', directStep);
            if (gameFlowPhase === 'tutorial') {
                const title = gameFlowOverlay.querySelector('.flow-title');
                if (title) title.textContent = currentTutorialTitle();
            }
        }
        function updateFireButtonState() {
            if (DRAW2_MODE) {
                const disabled = !isDrawInputEnabled() || drawing || !canvasDirty || !hasFireableFruit();
                fireButton.disabled = disabled;
                clearButton.disabled = !isDrawInputEnabled() || !canvasDirty;
                mainStage.classList.toggle('fire-ready', !disabled);
                updateTutorialStepUi();
                return;
            }
            fireButton.disabled = !canvasDirty;
            clearButton.disabled = !canvasDirty;
            mainStage.classList.remove('fire-ready');
        }
        function setFireButtonDisabled(disabled) {
            if (DRAW2_MODE) {
                fireButton.disabled = disabled || !isDrawInputEnabled() || drawing || !canvasDirty || !hasFireableFruit();
                clearButton.disabled = !isDrawInputEnabled() || !canvasDirty;
                mainStage.classList.toggle('fire-ready', !fireButton.disabled);
                updateTutorialStepUi();
                return;
            }
            fireButton.disabled = disabled;
            clearButton.disabled = disabled && !canvasDirty;
            mainStage.classList.remove('fire-ready');
        }
        updateGraphs();
        async function clearRemoteSession(preserveShapeMatchResult) {
            const preservedShapeMatchResult = preserveShapeMatchResult ? lastShapeMatchResult : null;
            pendingSwipeShot = null;
            swipeStartPoint = null;
            directSwipeCandidate = null;
            suppressDirectSwipeUntilNextStroke = false;
            stopSwipeInertia();
            mainStage.classList.remove('swipe-shot-ready', 'swipe-shot-bounce', 'swipe-dragging');
            swipePreviewSerial += 1;
            swipeFruitPreview.hidden = true;
            swipeFruitPreview.removeAttribute('src');
            setSwipeFruitOffset(0, 0);
            drawing = false;
            drawingSuspendedByGuide = false;
            lastTutorialGuidePoint = null;
            activeStrokeSerial += 1;
            canvasDirty = false;
            predictInFlight = false;
            pendingCommitAfterPrediction = false;
            clearAfterCommit = false;
            latestPredictionId = null;
            shapeMatchedStaticFruit = null;
            canvasRevision = 0;
            submittedCanvasRevision = 0;
            strokePoints = [];
            colorPreviewActive = false;
            productionSelectedVariant = null;
            productionSelectedAt = 0;
            lastNonSkippedApplePayload = null;
            resetTutorialGuideProgress();
            resetCanvasVisuals();
            clearPreview();
            if (preservedShapeMatchResult) {
                updateShapeMatchPanel(preservedShapeMatchResult);
            }
            updateCropOverlay(null);
            setFireButtonDisabled(true);
            await fetch('/api/remote-draw/clear', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sessionId }),
            });
        }
        canvas.addEventListener('pointerdown', startDraw);
        canvas.addEventListener('pointermove', draw);
        canvas.addEventListener('pointerup', endDraw);
        canvas.addEventListener('pointercancel', endDraw);
        if (!window.PointerEvent) {
            canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
            canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
            canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
            canvas.addEventListener('touchcancel', handleTouchEnd, { passive: false });
        }
        document.addEventListener('selectstart', function(event) {
            event.preventDefault();
        });
        document.addEventListener('contextmenu', function(event) {
            event.preventDefault();
        });
        if (!window.PointerEvent) {
            canvas.addEventListener('mousedown', startDraw);
            canvas.addEventListener('mousemove', function(event) {
                if (event.buttons !== 1) return;
                draw(event);
            });
            window.addEventListener('mouseup', endDraw);
        }
        canvas.addEventListener('pointerleave', (event) => {
            if (!drawing) return;
            if (event.buttons === 0) endDraw(event);
        });
        window.addEventListener('resize', function() {
            updateLineWidth();
            renderDisplayLines(false);
        });
        variantToggleButton.addEventListener('click', async () => {
            const variants = ['banana_400', 'apple_512', 'grape_400'];
            const currentIndex = variants.indexOf(generatedVariant);
            generatedVariant = variants[(currentIndex + 1) % variants.length] || 'banana_400';
            window.localStorage.setItem(generatedVariantStorageKey, generatedVariant);
            updateVariantToggleButton();
            updateBananaPostprocessToggleButton();
            updateLowPixelSkipToggleButton();
            updateKeepLargestToggleButton();
            updateAppleOnlyControls();
            updateNonAlphaModeToggleButton();
            latestCentroid = null;
            drawCentroidOverlay();
            await clearRemoteSession();
        });
        bananaPostprocessToggleButton.addEventListener('click', async () => {
            bananaPostprocessEnabled = !bananaPostprocessEnabled;
            window.localStorage.setItem(bananaPostprocessStorageKey, bananaPostprocessEnabled ? '1' : '0');
            updateBananaPostprocessToggleButton();
            await clearRemoteSession();
        });
        lowPixelSkipToggleButton.addEventListener('click', () => {
            lowPixelSkipEnabled = !lowPixelSkipEnabled;
            window.localStorage.setItem(lowPixelSkipStorageKey, lowPixelSkipEnabled ? '1' : '0');
            updateLowPixelSkipToggleButton();
        });
        keepLargestToggleButton.addEventListener('click', async () => {
            keepLargestEnabled = !keepLargestEnabled;
            window.localStorage.setItem(keepLargestStorageKey, keepLargestEnabled ? '1' : '0');
            updateKeepLargestToggleButton();
            await clearRemoteSession();
        });
        alphaKeepLargestToggleButton.addEventListener('click', async () => {
            alphaKeepLargestEnabled = !alphaKeepLargestEnabled;
            window.localStorage.setItem(alphaKeepLargestStorageKey, alphaKeepLargestEnabled ? '1' : '0');
            updateAlphaKeepLargestToggleButton();
            await clearRemoteSession();
        });
        appleInnerAlphaSkipToggleButton.addEventListener('click', () => {
            appleSkipInnerAlphaEnabled = !appleSkipInnerAlphaEnabled;
            window.localStorage.setItem(appleSkipInnerAlphaStorageKey, appleSkipInnerAlphaEnabled ? '1' : '0');
            updateAppleOnlyControls();
        });
        appleRadialVarianceSkipToggleButton.addEventListener('click', () => {
            appleSkipRadialVarianceEnabled = !appleSkipRadialVarianceEnabled;
            window.localStorage.setItem(appleSkipRadialVarianceStorageKey, appleSkipRadialVarianceEnabled ? '1' : '0');
            updateAppleOnlyControls();
        });
        appleRadialVarianceThresholdInput.addEventListener('change', () => {
            const v = parseInt(appleRadialVarianceThresholdInput.value, 10);
            if (Number.isFinite(v) && v > 0) {
                appleRadialVarianceThreshold = v;
                window.localStorage.setItem(appleRadialVarianceThresholdStorageKey, String(v));
            }
        });
        nonAlphaModeToggleButton.addEventListener('click', async () => {
            nonAlphaModeEnabled = !nonAlphaModeEnabled;
            window.localStorage.setItem(nonAlphaModeStorageKey, nonAlphaModeEnabled ? '1' : '0');
            updateNonAlphaModeToggleButton();
            await clearRemoteSession();
        });
        centroidDisplayToggleButton.addEventListener('click', () => {
            centroidDisplayEnabled = !centroidDisplayEnabled;
            window.localStorage.setItem(centroidDisplayStorageKey, centroidDisplayEnabled ? '1' : '0');
            updateCentroidDisplayToggleButton();
            drawCentroidOverlay();
        });
        productionModeToggleButton.addEventListener('click', () => {
            if (DRAW2_MODE) return;
            if (productionModeEnabled) {
                exitProductionMode();
            } else {
                enterProductionMode();
            }
        });
        fireButton.addEventListener('click', async () => {
            if (pendingSwipeShot) return;
            if (!canvasDirty || drawing) {
                playUiSound('fireBlocked');
                return;
            }
            if (DRAW2_MODE && gameFlowPhase === 'tutorial' && tutorialForceApple && predictInFlight && !latestPredictionId) {
                clearAfterCommit = true;
                pendingCommitAfterPrediction = true;
                setFireButtonDisabled(true);
                return;
            }
            if (DRAW2_MODE && !hasFireableFruit()) {
                playUiSound('fireBlocked');
                return;
            }
            setFireButtonDisabled(true);
            clearAfterCommit = true;
            pendingCommitAfterPrediction = true;
            if (DRAW2_MODE && productionModeEnabled && gameFlowPhase !== 'tutorial' && !(latestPredictionId && colorPreviewActive)) {
                const prepared = await prepareProductionFirePrediction();
                if (!prepared) {
                    playUiSound('fireBlocked');
                    pendingCommitAfterPrediction = false;
                    clearAfterCommit = false;
                    setFireButtonDisabled(false);
                    return;
                }
            }
            if (!shouldPrepareSwipeShot()) playPendingFireSound();
            if (predictInFlight) return;
            await runPrediction(true);
            if (canvasDirty && !pendingSwipeShot) setFireButtonDisabled(false);
        });
        mainStage.addEventListener('pointerdown', (event) => {
            if (!pendingSwipeShot) return;
            event.preventDefault();
            if (!isPointInSwipeFruitPreview(event.clientX, event.clientY)) {
                cancelPreparedSwipeShot(true);
                return;
            }
            swipeStartPoint = pointFromClient(event.clientX, event.clientY);
            swipeDragStartClient = { x: event.clientX, y: event.clientY };
            mainStage.classList.add('swipe-dragging');
            try { mainStage.setPointerCapture(event.pointerId); } catch (error) {}
        });
        mainStage.addEventListener('pointermove', (event) => {
            if (!pendingSwipeShot || !swipeDragStartClient) return;
            event.preventDefault();
            const dx = event.clientX - swipeDragStartClient.x;
            const dy = event.clientY - swipeDragStartClient.y;
            mainStage.style.setProperty('--swipe-drag-x', dx.toFixed(1) + 'px');
            mainStage.style.setProperty('--swipe-drag-y', dy.toFixed(1) + 'px');
        });
        mainStage.addEventListener('pointerup', (event) => {
            if (!pendingSwipeShot || !swipeDragStartClient) return;
            event.preventDefault();
            const endClientX = event.clientX;
            const endClientY = event.clientY;
            startSwipeInertia(endClientX, endClientY);
        });
        mainStage.addEventListener('pointercancel', () => {
            if (pendingSwipeShot) {
                swipeStartPoint = null;
                resetSwipeDrag();
            }
        });
        clearButton.addEventListener('click', async () => {
            playUiSound('clearSketch');
            await clearRemoteSession();
        });
        document.body.addEventListener('dblclick', (event) => {
            event.preventDefault();
            void clearRemoteSession();
        });
        window.addEventListener('resize', drawCentroidOverlay);
        resetCanvasVisuals();
        clearPreview();
        updateCropOverlay(null);
        updateVariantToggleButton();
        updateBananaPostprocessToggleButton();
        updateLowPixelSkipToggleButton();
        updateKeepLargestToggleButton();
        updateAlphaKeepLargestToggleButton();
        updateAppleOnlyControls();
        updateNonAlphaModeToggleButton();
        updateCentroidDisplayToggleButton();
        renderFruitCards();
        if (DRAW2_MODE) {
            nonAlphaModeEnabled = false;
            enterProductionMode();
        } else {
            updateJudgeProbDisplay();
        }
        setFireButtonDisabled(true);
        drawCentroidOverlay();
        void syncRemoteConfig();
        void syncGameResults();
        void syncGameFlow();
        void syncTutorialProgress();
        window.setInterval(() => {
            const now = Date.now();
            if (drawing && canvasDirty && !predictInFlight && now - lastRealtimePredictAt >= realtimeIntervalMs) {
                lastRealtimePredictAt = now;
                void runPrediction(false);
            }
        }, 50);
        window.setInterval(() => {
            void syncRemoteConfig();
        }, 1200);
        window.setInterval(() => {
            void syncGameResults();
        }, 1000);
        window.setInterval(() => {
            void syncGameFlow();
            void syncTutorialProgress();
        }, 500);
    </script>
</body>
</html>`

const sendPauseStateToRenderer = () => {
    appendControlLog(`sendPauseStateToRenderer paused=${gameControlState.paused}`)
    win?.webContents.send('game:set-paused', gameControlState.paused)
}

const applyGameControlAction = (action: string) => {
    appendControlLog(`applyGameControlAction action=${action}`)
    if (action === 'pause') {
        gameControlState.paused = true
    } else if (action === 'resume') {
        gameControlState.paused = false
    } else {
        throw new Error(`Unsupported control action: ${action}`)
    }

    sendPauseStateToRenderer()
}

const writeJson = (res: ServerResponse, statusCode: number, payload: unknown) => {
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    res.end(JSON.stringify(payload))
}

const readRequestBody = async (req: IncomingMessage): Promise<string> => {
    return await new Promise((resolvePromise, rejectPromise) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        req.on('end', () => {
            resolvePromise(Buffer.concat(chunks).toString('utf-8'))
        })
        req.on('error', (error) => {
            rejectPromise(error)
        })
    })
}

const resolveExistingPathFlexible = (baseDir: string, relativePath: string) => {
    const segments = relativePath.split('/').filter(Boolean)
    let current = baseDir
    for (const segment of segments) {
        if (segment === '..') return null
        if (!existsSync(current)) return null
        const normalizedSegment = segment.normalize('NFC')
        const match = readdirSync(current).find((entry) => entry.normalize('NFC') === normalizedSegment)
        if (!match) return null
        current = resolve(current, match)
    }
    return existsSync(current) ? current : null
}

const contentTypeForPath = (filePath: string) => {
    const ext = extname(filePath).toLowerCase()
    if (ext === '.mp3') return 'audio/mpeg'
    if (ext === '.wav') return 'audio/wav'
    if (ext === '.ogg') return 'audio/ogg'
    if (ext === '.m4a') return 'audio/mp4'
    return 'image/png'
}

const startControlServer = () => {
    if (controlServer) {
        return
    }

    controlServer = createServer(async (req, res) => {
        const method = req.method ?? 'GET'
        const rawUrl = req.url ?? '/'
        const url = new URL(rawUrl, 'http://localhost').pathname
        if (!rawUrl.startsWith('/api/remote-shot') && !rawUrl.startsWith('/api/status?source=renderer') && !rawUrl.startsWith('/api/game-flow')) {
            appendControlLog(`http ${method} ${rawUrl}`)
        }

        if (method === 'OPTIONS') {
            res.statusCode = 204
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
            res.end()
            return
        }

        if (method === 'GET' && url === '/') {
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(renderControlPage())
            return
        }

        if (method === 'GET' && url === '/draw') {
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(renderRemoteDrawPage())
            return
        }

        if (method === 'GET' && url === '/draw2') {
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(renderRemoteDrawPage(true))
            return
        }

        if (method === 'GET' && url === '/gameControl') {
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(renderGameControlPage())
            return
        }

        if (method === 'GET' && url === '/boss') {
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(renderBossPage())
            return
        }

        if (method === 'GET' && url === '/api/space-config') {
            writeJson(res, 200, getActiveSpaceGameConfig())
            return
        }

        if (method === 'POST' && url === '/api/space-config') {
            try {
                const rawBody = await readRequestBody(req)
                spaceGameConfigs = normalizeSpaceGameConfigSet(JSON.parse(rawBody))
                writeSpaceConfigToDisk(spaceGameConfigs)
                appendControlLog(`space-config updated easy=${spaceGameConfigs.easy.enemies.length} normal=${spaceGameConfigs.normal.enemies.length} hard=${spaceGameConfigs.hard.enemies.length} challenge=${spaceGameConfigs.challenge.enemies.length}`)
                writeJson(res, 200, { ok: true, configs: spaceGameConfigs })
            } catch (error) {
                writeJson(res, 400, { error: error instanceof Error ? error.message : 'Could not update space config' })
            }
            return
        }

        if (method === 'GET' && url === '/api/space-config-presets') {
            writeJson(res, 200, { presets: readSpaceConfigPresets().map(({ id, name, createdAt }) => ({ id, name, createdAt })) })
            return
        }

        if (method === 'POST' && url === '/api/space-config-presets') {
            try {
                const rawBody = await readRequestBody(req)
                const incoming = JSON.parse(rawBody) as { name?: string; config?: unknown }
                const name = incoming.name?.trim()
                if (!name) {
                    writeJson(res, 400, { error: 'Missing preset name' })
                    return
                }
                const presets = readSpaceConfigPresets()
                const preset: SpaceConfigPreset = {
                    id: `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                    name: name.slice(0, 80),
                    createdAt: new Date().toISOString(),
                    config: normalizeSpaceGameConfig(incoming.config ?? getActiveSpaceGameConfig()),
                }
                presets.push(preset)
                writeSpaceConfigPresets(presets)
                writeJson(res, 200, { ok: true, preset, presets: presets.map(({ id, name: presetName, createdAt }) => ({ id, name: presetName, createdAt })) })
            } catch (error) {
                writeJson(res, 400, { error: error instanceof Error ? error.message : 'Could not save preset' })
            }
            return
        }

        if (url.startsWith('/api/space-config-presets/')) {
            const presetId = decodeURIComponent(url.slice('/api/space-config-presets/'.length))
            const presets = readSpaceConfigPresets()
            const preset = presets.find((entry) => entry.id === presetId)
            if (method === 'GET') {
                if (!preset) {
                    writeJson(res, 404, { error: 'Preset not found' })
                    return
                }
                writeJson(res, 200, preset)
                return
            }
            if (method === 'DELETE') {
                const nextPresets = presets.filter((entry) => entry.id !== presetId)
                writeSpaceConfigPresets(nextPresets)
                writeJson(res, 200, { ok: true, presets: nextPresets.map(({ id, name, createdAt }) => ({ id, name, createdAt })) })
                return
            }
        }


        if (method === 'GET' && url === '/api/space-control') {
            writeJson(res, 200, { restartSignal: spaceRestartSignal })
            return
        }

        if (method === 'GET' && url === '/api/game-flow') {
            writeJson(res, 200, gameFlowState)
            return
        }

        if (method === 'GET' && url === '/api/tutorial-state') {
            writeJson(res, 200, {
                ...tutorialState,
                difficulty: gameFlowState.difficulty,
            })
            return
        }

        if (method === 'POST' && url === '/api/tutorial-state') {
            try {
                const rawBody = await readRequestBody(req)
                const incoming = JSON.parse(rawBody) as { index?: number }
                tutorialState = {
                    index: Math.max(0, Math.min(2, Math.round(Number(incoming.index ?? 0)))),
                    token: Date.now(),
                }
                writeJson(res, 200, { ok: true, ...tutorialState })
            } catch (error) {
                writeJson(res, 400, { error: error instanceof Error ? error.message : 'Bad tutorial state' })
            }
            return
        }

        if (method === 'GET' && url === '/api/boss-defeats') {
            writeJson(res, 200, { counts: bossDefeatCounts })
            return
        }

        if (method === 'GET' && url === '/api/boss-mirror') {
            writeJson(res, 200, bossMirrorState)
            return
        }

        if (method === 'POST' && (url === '/api/boss-mirror/draw' || url === '/api/boss-mirror/game')) {
            try {
                const rawBody = await readRequestBody(req)
                const incoming = JSON.parse(rawBody) as { image?: unknown }
                if (typeof incoming.image !== 'string' || !incoming.image.startsWith('data:image/')) {
                    writeJson(res, 400, { error: 'Invalid mirror image' })
                    return
                }
                if (url.endsWith('/draw')) {
                    bossMirrorState.drawImage = incoming.image
                    bossMirrorState.drawUpdatedAt = Date.now()
                } else {
                    bossMirrorState.gameImage = incoming.image
                    bossMirrorState.gameUpdatedAt = Date.now()
                }
                writeJson(res, 200, { ok: true })
            } catch (error) {
                writeJson(res, 400, { error: error instanceof Error ? error.message : 'Could not update boss mirror' })
            }
            return
        }

        if (method === 'POST' && url === '/api/boss-defeats') {
            try {
                const rawBody = await readRequestBody(req)
                writeBossDefeatCountsToDisk(normalizeBossDefeatCounts(JSON.parse(rawBody)))
                writeJson(res, 200, { ok: true, counts: bossDefeatCounts })
            } catch (error) {
                writeJson(res, 400, { error: error instanceof Error ? error.message : 'Could not update boss defeat counts' })
            }
            return
        }

        if (method === 'POST' && url === '/api/boss-defeats/increment') {
            try {
                const rawBody = await readRequestBody(req)
                const incoming = JSON.parse(rawBody) as { difficulty?: GameDifficulty; delta?: number }
                const difficulty = incoming.difficulty
                if (!difficulty || !GAME_DIFFICULTIES.includes(difficulty)) {
                    writeJson(res, 400, { error: 'Invalid difficulty' })
                    return
                }
                const delta = clampFinite(incoming.delta ?? 1, 1, -999999, 999999)
                writeBossDefeatCountsToDisk({
                    ...bossDefeatCounts,
                    [difficulty]: Math.max(0, Math.round((bossDefeatCounts[difficulty] ?? 0) + delta)),
                })
                writeJson(res, 200, { ok: true, counts: bossDefeatCounts })
            } catch (error) {
                writeJson(res, 400, { error: error instanceof Error ? error.message : 'Could not increment boss defeat count' })
            }
            return
        }

        if (method === 'GET' && url === '/api/ui-sound-events') {
            const events = uiSoundEvents.splice(0, uiSoundEvents.length)
            writeJson(res, 200, { events })
            return
        }

        if (method === 'POST' && url === '/api/ui-sound-events') {
            try {
                const rawBody = await readRequestBody(req)
                const incoming = JSON.parse(rawBody) as { key?: string }
                const key = typeof incoming.key === 'string' && incoming.key.trim() ? incoming.key.trim() : 'uiButton'
                uiSoundEvents.push({ id: ++nextUiSoundEventId, key })
                if (uiSoundEvents.length > 32) uiSoundEvents.splice(0, uiSoundEvents.length - 32)
                writeJson(res, 200, { ok: true })
            } catch (error) {
                writeJson(res, 400, { error: error instanceof Error ? error.message : 'Could not queue sound event' })
            }
            return
        }

        if (method === 'POST' && url === '/api/game-flow') {
            try {
                const rawBody = await readRequestBody(req)
                const incoming = JSON.parse(rawBody) as {
                    phase?: GameFlowPhase
                    result?: 'clear' | 'over' | null
                    difficulty?: GameDifficulty
                    play_seconds?: number
                }
                const nextPhase = incoming.phase
                if (!nextPhase || !['playing', 'ended', 'handoff', 'difficulty', 'tutorial', 'tutorial_done'].includes(nextPhase)) {
                    writeJson(res, 400, { error: 'Invalid phase' })
                    return
                }
                const nextDifficulty = incoming.difficulty ?? gameFlowState.difficulty
                if (!['easy', 'normal', 'hard', 'challenge'].includes(nextDifficulty)) {
                    writeJson(res, 400, { error: 'Invalid difficulty' })
                    return
                }
                const endedAttempt = nextPhase === 'ended'
                const addedPlaySeconds = endedAttempt ? Math.max(0, Math.min(3600, Number(incoming.play_seconds ?? 0) || 0)) : 0
                const previousTotalPlaySeconds = gameFlowState.totalPlaySeconds ?? 0
                const previousAttemptCount = gameFlowState.attemptCount ?? 0
                let nextTotalPlaySeconds = previousTotalPlaySeconds + addedPlaySeconds
                let nextAttemptCount = previousAttemptCount + (endedAttempt ? 1 : 0)
                let nextShouldHandoff = gameFlowState.shouldHandoff ?? false
                if (endedAttempt) {
                    nextShouldHandoff = nextTotalPlaySeconds >= 80 || (incoming.result === 'over' && nextAttemptCount >= 3)
                }
                if (gameFlowState.phase === 'handoff' && nextPhase === 'difficulty') {
                    nextTotalPlaySeconds = 0
                    nextAttemptCount = 0
                    nextShouldHandoff = false
                }
                gameFlowState = {
                    phase: nextPhase,
                    result: nextPhase === 'ended' ? incoming.result ?? gameFlowState.result ?? 'over' : null,
                    difficulty: nextDifficulty,
                    signal: Date.now(),
                    totalPlaySeconds: nextTotalPlaySeconds,
                    attemptCount: nextAttemptCount,
                    shouldHandoff: nextShouldHandoff,
                }
                if (nextPhase === 'playing' || nextPhase === 'tutorial') {
                    spaceRestartSignal = Date.now()
                    remoteShotQueue.length = 0
                    feverUntil = 0
                }
                if (nextPhase === 'tutorial') {
                    tutorialState = { index: 0, token: Date.now() }
                }
                appendControlLog(`game-flow phase=${gameFlowState.phase} result=${gameFlowState.result ?? '-'} difficulty=${gameFlowState.difficulty}`)
                writeJson(res, 200, { ok: true, ...gameFlowState })
            } catch (error) {
                writeJson(res, 400, { error: error instanceof Error ? error.message : 'Bad request' })
            }
            return
        }

        if (method === 'POST' && url === '/api/space-control') {
            try {
                const rawBody = await readRequestBody(req)
                const incoming = JSON.parse(rawBody) as { action?: string }
                if (incoming.action === 'restart') {
                    spaceRestartSignal = Date.now()
                    gameFlowState = {
                        phase: 'playing',
                        result: null,
                        difficulty: gameFlowState.difficulty,
                        signal: spaceRestartSignal,
                        totalPlaySeconds: 0,
                        attemptCount: 0,
                        shouldHandoff: false,
                    }
                    remoteShotQueue.length = 0
                    feverUntil = 0
                    appendControlLog(`space-control restart signal=${spaceRestartSignal}`)
                    writeJson(res, 200, { ok: true, restartSignal: spaceRestartSignal })
                } else {
                    writeJson(res, 400, { error: 'Unknown action' })
                }
            } catch (error) {
                writeJson(res, 400, { error: error instanceof Error ? error.message : 'Bad request' })
            }
            return
        }

        if (method === 'GET' && url.startsWith('/api/status')) {
            const rankings = readRankings()
            writeJson(res, 200, {
                paused: gameControlState.paused,
                gameResult: {
                    ...gameResultState,
                    rankings,
                },
            })
            return
        }

        if (method === 'GET' && url === '/api/game-results') {
            const rankings = readRankings()
            appendControlLog(`game-results status=${gameResultState.status} totalRankings=${rankings.length}`)
            writeJson(res, 200, {
                ...gameResultState,
                rankings,
            })
            return
        }

        if (method === 'POST' && url === '/api/game-results') {
            try {
                const rawBody = await readRequestBody(req)
                const state = JSON.parse(rawBody) as GameResultStateRequest
                if (state.persistRanking && state.status === 'ended' && state.counts && !state.currentEntryId) {
                    const entry = createRankingEntry(state.counts)
                    const entries = readRankings()
                    entries.push(entry)
                    writeRankings(entries)
                    state.currentEntryId = entry.id
                }
                setGameResultState(state)
                writeJson(res, 200, {
                    ...gameResultState,
                    rankings: readRankings(),
                })
            } catch (error) {
                writeJson(res, 400, {
                    error: error instanceof Error ? error.message : 'Could not update game results',
                })
            }
            return
        }

        if (method === 'POST' && url === '/api/ranking-name') {
            try {
                const rawBody = await readRequestBody(req)
                const payload = JSON.parse(rawBody) as { entryId?: unknown; name?: unknown }
                if (typeof payload.entryId !== 'string') {
                    writeJson(res, 400, { error: 'entryId is required' })
                    return
                }
                const result = updateRankingNameIfTotalTopThree(payload.entryId, sanitizeRankingName(payload.name))
                if (!result.ok) {
                    writeJson(res, 403, {
                        error: result.error,
                        rankings: result.entries,
                    })
                    return
                }
                writeJson(res, 200, {
                    ...gameResultState,
                    rankings: result.entries,
                })
            } catch (error) {
                writeJson(res, 400, {
                    error: error instanceof Error ? error.message : 'Could not update ranking name',
                })
            }
            return
        }

        if (method === 'POST' && url === '/api/rankings/reset') {
            const rankings = resetRankings()
            writeJson(res, 200, {
                ...gameResultState,
                rankings,
            })
            return
        }

        if (method === 'GET' && url.startsWith('/api/space-data/')) {
            const relative = url.slice('/api/space-data/'.length).replace(/[?#].*$/, '')
            if (relative && !relative.includes('..')) {
                const filePath = resolve(__dirname, '../../space_data', relative)
                if (existsSync(filePath)) {
                    res.statusCode = 200
                    res.setHeader('Content-Type', contentTypeForPath(filePath))
                    res.setHeader('Access-Control-Allow-Origin', '*')
                    res.end(readFileSync(filePath))
                    return
                }
            }
            writeJson(res, 404, { error: 'Space data file not found' })
            return
        }

        if ((method === 'GET' || method === 'HEAD') && url.startsWith('/api/voice/')) {
            const relative = decodeURIComponent(url.slice('/api/voice/'.length).replace(/[?#].*$/, ''))
            const filePath = resolveExistingPathFlexible(resolve(__dirname, '../../voice'), relative)
            if (filePath) {
                res.statusCode = 200
                res.setHeader('Content-Type', contentTypeForPath(filePath))
                res.setHeader('Access-Control-Allow-Origin', '*')
                res.end(method === 'HEAD' ? undefined : readFileSync(filePath))
                return
            }
            writeJson(res, 404, { error: 'Voice file not found' })
            return
        }

        const fruitIconMatch = url.match(/^\/api\/fruit-icon\/(apple|banana|grape)$/)
        if (method === 'GET' && fruitIconMatch) {
            const fruitType = fruitIconMatch[1]
            const iconPath = resolve(__dirname, '../../back/me2', fruitType, `${fruitType}1.png`)
            if (!existsSync(iconPath)) {
                writeJson(res, 404, { error: 'Icon not found' })
                return
            }
            res.statusCode = 200
            res.setHeader('Content-Type', 'image/png')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(readFileSync(iconPath))
            return
        }

        if (method === 'GET' && url === '/api/remote-draw/config') {
            writeJson(res, 200, {
                realtime_interval_ms: remoteDrawConfig.realtimeIntervalMs,
                generated_border_threshold: remoteDrawConfig.generatedBorderThreshold,
                generated_alpha_threshold: remoteDrawConfig.generatedAlphaThreshold,
            })
            return
        }

        if (method === 'GET' && url === '/api/remote-draw/stats') {
            writeJson(res, 200, buildRemoteDrawStats())
            return
        }

        if (method === 'GET' && url === '/api/remote-shot') {
            writeJson(res, 200, { shot: remoteShotQueue.shift() ?? null })
            return
        }

        if (method === 'POST' && url === '/api/remote-shot/enqueue') {
            try {
                const rawBody = await readRequestBody(req)
                const incoming = JSON.parse(rawBody) as { shot?: QueuedRemoteShot }
                if (!incoming.shot?.bullet_assets?.length) {
                    writeJson(res, 400, { error: 'Missing shot' })
                    return
                }
                const shot: QueuedRemoteShot = {
                    ...incoming.shot,
                    id: ++nextRemoteShotId,
                }
                remoteShotQueue.push(shot)
                writeJson(res, 200, { ok: true, shot })
            } catch (error) {
                writeJson(res, 400, { error: error instanceof Error ? error.message : 'Could not enqueue shot' })
            }
            return
        }

        if (method === 'GET' && url === '/api/fever-state') {
            writeJson(res, 200, { active: Date.now() < feverUntil, until: feverUntil })
            return
        }

        if (method === 'POST' && url === '/api/fever-state') {
            try {
                const rawBody = await readRequestBody(req)
                const incoming = JSON.parse(rawBody) as { active?: boolean; duration_ms?: number }
                feverUntil = incoming.active ? Date.now() + Math.max(0, Number(incoming.duration_ms ?? 8000)) : 0
                writeJson(res, 200, { ok: true, active: Date.now() < feverUntil, until: feverUntil })
            } catch (error) {
                writeJson(res, 400, { error: error instanceof Error ? error.message : 'Could not update fever state' })
            }
            return
        }

        if (method === 'GET' && url === '/api/logs') {
            writeJson(res, 200, { logs: controlLogs })
            return
        }

        if (method === 'POST' && url === '/api/control') {
            try {
                const rawBody = await readRequestBody(req)
                appendControlLog(`control body=${rawBody || '<empty>'}`)
                const body = rawBody ? JSON.parse(rawBody) as { action?: string } : {}
                if (!body.action) {
                    writeJson(res, 400, { error: 'Missing action' })
                    return
                }

                applyGameControlAction(body.action)
                writeJson(res, 200, { ok: true, paused: gameControlState.paused })
            } catch (error) {
                writeJson(res, 400, {
                    error: error instanceof Error ? error.message : 'Could not process request',
                })
            }
            return
        }

        if (method === 'POST' && url === '/api/remote-draw/predict') {
            try {
                const rawBody = await readRequestBody(req)
                const payload = JSON.parse(rawBody) as RemotePredictPayload
                if (!payload.session_id) {
                    writeJson(res, 400, { error: 'Missing session_id' })
                    return
                }
                const result = await buildRemotePredictResult(payload)
                writeJson(res, 200, result)
            } catch (error) {
                writeJson(res, 400, {
                    error: error instanceof Error ? error.message : 'Could not process remote prediction',
                })
            }
            return
        }

        if (method === 'POST' && url === '/api/remote-draw/config') {
            try {
                const rawBody = await readRequestBody(req)
                const payload = JSON.parse(rawBody) as {
                    realtime_interval_ms?: number
                    generated_border_threshold?: number
                    generated_alpha_threshold?: number
                }
                if (payload.realtime_interval_ms != null) {
                    const nextInterval = Number(payload.realtime_interval_ms)
                    if (!Number.isFinite(nextInterval)) {
                        writeJson(res, 400, { error: 'Invalid realtime_interval_ms' })
                        return
                    }
                    remoteDrawConfig.realtimeIntervalMs = Math.max(50, Math.min(1000, Math.round(nextInterval)))
                }
                if (payload.generated_border_threshold != null) {
                    const nextBorderThreshold = Number(payload.generated_border_threshold)
                    if (!Number.isFinite(nextBorderThreshold) || nextBorderThreshold < 0 || nextBorderThreshold > 1) {
                        writeJson(res, 400, { error: 'Invalid generated_border_threshold' })
                        return
                    }
                    remoteDrawConfig.generatedBorderThreshold = Number(nextBorderThreshold.toFixed(3))
                }
                if (payload.generated_alpha_threshold != null) {
                    const nextAlphaThreshold = Number(payload.generated_alpha_threshold)
                    if (!Number.isFinite(nextAlphaThreshold) || nextAlphaThreshold < 0 || nextAlphaThreshold > 1) {
                        writeJson(res, 400, { error: 'Invalid generated_alpha_threshold' })
                        return
                    }
                    remoteDrawConfig.generatedAlphaThreshold = Number(nextAlphaThreshold.toFixed(3))
                }
                appendControlLog(
                    `remote config interval=${remoteDrawConfig.realtimeIntervalMs} border=${remoteDrawConfig.generatedBorderThreshold} alpha=${remoteDrawConfig.generatedAlphaThreshold}`,
                )
                writeJson(res, 200, {
                    ok: true,
                    realtime_interval_ms: remoteDrawConfig.realtimeIntervalMs,
                    generated_border_threshold: remoteDrawConfig.generatedBorderThreshold,
                    generated_alpha_threshold: remoteDrawConfig.generatedAlphaThreshold,
                })
            } catch (error) {
                writeJson(res, 400, {
                    error: error instanceof Error ? error.message : 'Could not update remote config',
                })
            }
            return
        }

        if (method === 'POST' && url === '/api/remote-draw/commit') {
            try {
                const rawBody = await readRequestBody(req)
                const payload = JSON.parse(rawBody) as { session_id?: string; prediction_id?: number; enqueue?: boolean }
                if (!payload.session_id) {
                    writeJson(res, 400, { error: 'Missing session_id' })
                    return
                }
                const shot = commitRemoteShot(payload.session_id, payload.prediction_id, payload.enqueue !== false)
                writeJson(res, 200, { ok: true, shot_id: shot.id, shot })
            } catch (error) {
                writeJson(res, 400, {
                    error: error instanceof Error ? error.message : 'Could not commit remote shot',
                })
            }
            return
        }

        if (method === 'POST' && url === '/api/remote-draw/judge') {
            try {
                const rawBody = await readRequestBody(req)
                const body = JSON.parse(rawBody) as {
                    image?: string
                    bbox?: PredictRequest['bbox']
                    canvas_width?: number
                    canvas_height?: number
                }
                if (!body.image || !body.bbox) {
                    writeJson(res, 400, { error: 'Missing image or bbox' })
                    return
                }
                const result = await predictor.predict({
                    image: body.image,
                    sketch_overlay: '',
                    bbox: body.bbox,
                    image_id: 'judge',
                    fruit_name: 'banana',
                    judge_mode: 'judge',
                    predict_mode: 'judge',
                    canvas_width: body.canvas_width ?? REMOTE_DRAW_PROCESSING_WIDTH,
                    canvas_height: body.canvas_height ?? REMOTE_DRAW_PROCESSING_HEIGHT,
                })
                writeJson(res, 200, result)
            } catch (error) {
                writeJson(res, 400, {
                    error: error instanceof Error ? error.message : 'Judge failed',
                })
            }
            return
        }

        if (method === 'POST' && url === '/api/remote-draw/shape-match') {
            try {
                const rawBody = await readRequestBody(req)
                const body = JSON.parse(rawBody) as {
                    image?: string
                    bbox?: PredictRequest['bbox']
                    canvas_width?: number
                    canvas_height?: number
                }
                if (!body.image || !body.bbox) {
                    writeJson(res, 400, { error: 'Missing image or bbox' })
                    return
                }
                const result = await predictor.predict({
                    image: body.image,
                    sketch_overlay: '',
                    bbox: body.bbox,
                    image_id: 'shape-match',
                    fruit_name: 'banana',
                    judge_mode: 'shape_match',
                    predict_mode: 'shape_match',
                    canvas_width: body.canvas_width ?? REMOTE_DRAW_PROCESSING_WIDTH,
                    canvas_height: body.canvas_height ?? REMOTE_DRAW_PROCESSING_HEIGHT,
                })
                appendControlLog(`shape match best=${(result as { best?: string }).best ?? '-'}`)
                writeJson(res, 200, result)
            } catch (error) {
                writeJson(res, 400, {
                    error: error instanceof Error ? error.message : 'Shape match failed',
                })
            }
            return
        }

        if (method === 'POST' && url === '/api/remote-draw/clear') {
            try {
                const rawBody = await readRequestBody(req)
                const payload = rawBody ? JSON.parse(rawBody) as { session_id?: string } : {}
                if (payload.session_id) {
                    remotePredictSessions.delete(payload.session_id)
                    appendControlLog(`remote clear session=${payload.session_id}`)
                }
                writeJson(res, 200, { ok: true })
            } catch (error) {
                writeJson(res, 400, {
                    error: error instanceof Error ? error.message : 'Could not clear remote session',
                })
            }
            return
        }

        writeJson(res, 404, { error: 'Not found' })
    })

    controlServer.listen(GAME_CONTROL_PORT, '0.0.0.0', () => {
        appendControlLog(`listening on http://127.0.0.1:${GAME_CONTROL_PORT}`)

        const networks = networkInterfaces()
        for (const addresses of Object.values(networks)) {
            for (const address of addresses ?? []) {
                if (address.family !== 'IPv4' || address.internal) {
                    continue
                }
                appendControlLog(`iPad URL http://${address.address}:${GAME_CONTROL_PORT}`)
            }
        }
    })
}

const stopControlServer = () => {
    controlServer?.close()
    controlServer = null
}

const DORIAN_SIZE_THRESHOLD = 150
const DORIAN_VISIBLE_MAX_RATIO = 1
const SMALL_STATIC_FRUIT_TYPES: SmallStaticFruitType[] = ['berry', 'lemon', 'peach']
const STATIC_FRUIT_IMAGE_PATH: Record<StaticFruitType, string> = {
    berry: 'other_fruit/berry.png',
    lemon: 'other_fruit/Lemon.png',
    peach: 'other_fruit/peach.png',
    dorian: 'other_fruit/dorian.png',
}

const readPngDimensions = (filePath: string): { width: number; height: number } | null => {
    if (!existsSync(filePath)) {
        return null
    }
    const header = readFileSync(filePath).subarray(0, 24)
    const pngSignature = '89504e470d0a1a0a'
    if (header.length < 24 || header.subarray(0, 8).toString('hex') !== pngSignature) {
        return null
    }
    return {
        width: header.readUInt32BE(16),
        height: header.readUInt32BE(20),
    }
}

const buildStaticFruitResult = (
    payload: RemotePredictPayload,
    fruitType: StaticFruitType,
) => {
    const { bbox } = payload
    const size = Math.max(bbox.width, bbox.height)
    const cx = (bbox.left + bbox.right) / 2
    const cy = (bbox.top + bbox.bottom) / 2
    const imagePath = STATIC_FRUIT_IMAGE_PATH[fruitType]
    const filePath = resolve(__dirname, '../../space_data', imagePath)
    const dimensions = readPngDimensions(filePath)
    const visibleScale = fruitType === 'dorian' ? DORIAN_VISIBLE_MAX_RATIO : 1
    const imageScale = dimensions ? size / (Math.max(dimensions.width, dimensions.height) * visibleScale) : 1
    const assetWidth = dimensions ? Math.max(1, Math.round(dimensions.width * imageScale)) : Math.round(size)
    const assetHeight = dimensions ? Math.max(1, Math.round(dimensions.height * imageScale)) : Math.round(size)
    const imageDataUrl = existsSync(filePath)
        ? `data:image/png;base64,${readFileSync(filePath).toString('base64')}`
        : `http://127.0.0.1:${GAME_CONTROL_PORT}/api/space-data/${imagePath}`
    const result: PredictResponse = {
        bullet_assets: [{
            image: imageDataUrl,
            origin_x: Math.round(cx - assetWidth / 2),
            origin_y: Math.round(cy - assetHeight / 2),
            width: assetWidth,
            height: assetHeight,
            fruit_name: fruitType,
        }],
    }
    const predictionId = ++nextRemotePredictionId
    remotePredictSessions.set(payload.session_id, {
        predictionId,
        result,
        frameWidth: payload.frame_width,
        frameHeight: payload.frame_height,
        processingWidth: payload.canvas_width,
        processingHeight: payload.canvas_height,
        updatedAt: Date.now(),
    })
    appendControlLog(`static fruit type=${fruitType} size=${Math.round(size)} session=${payload.session_id}`)
    return { ...result, prediction_id: predictionId }
}

const buildRemotePredictResult = async (payload: RemotePredictPayload) => {
    const maxDim = Math.max(payload.bbox.width, payload.bbox.height)
    if (payload.static_fruit_name && SMALL_STATIC_FRUIT_TYPES.includes(payload.static_fruit_name as SmallStaticFruitType)) {
        return buildStaticFruitResult(payload, payload.static_fruit_name as SmallStaticFruitType)
    }
    if (payload.static_fruit_name === 'dorian' || maxDim >= DORIAN_SIZE_THRESHOLD) {
        return buildStaticFruitResult(payload, 'dorian')
    }

    const startedAt = performance.now()
    const result = await predictor.predict({
        ...payload,
        border_threshold: remoteDrawConfig.generatedBorderThreshold,
        alpha_threshold: remoteDrawConfig.generatedAlphaThreshold,
    })
    const totalMs = result.profiling?.main_total_ms ?? Number((performance.now() - startedAt).toFixed(1))
    pushRemotePredictDuration(totalMs)
    const predictionId = ++nextRemotePredictionId
    remotePredictSessions.set(payload.session_id, {
        predictionId,
        result,
        frameWidth: payload.frame_width,
        frameHeight: payload.frame_height,
        processingWidth: payload.canvas_width,
        processingHeight: payload.canvas_height,
        updatedAt: Date.now(),
    })
    appendControlLog(
        `remote predict session=${payload.session_id} prediction=${predictionId} mode=${payload.predict_mode ?? 'generated'} variant=${payload.generated_variant ?? '-'} nonAlpha=${payload.non_alpha_mode ? 'on' : 'off'} bananaFx=${payload.banana_postprocess ? 'on' : 'off'} total=${totalMs}ms avg=${buildRemoteDrawStats().average_total_ms ?? '-'}ms interval=${remoteDrawConfig.realtimeIntervalMs}ms border=${remoteDrawConfig.generatedBorderThreshold} alpha=${remoteDrawConfig.generatedAlphaThreshold}`,
    )
    return {
        ...result,
        prediction_id: predictionId,
    }
}

const commitRemoteShot = (sessionId: string, predictionId?: number, enqueue = true) => {
    const session = remotePredictSessions.get(sessionId)
    if (!session) {
        throw new Error('Remote session not found')
    }
    if (predictionId != null && predictionId !== session.predictionId) {
        throw new Error(`Prediction mismatch latest=${session.predictionId} requested=${predictionId}`)
    }
    if (!session.result.bullet_assets || session.result.bullet_assets.length === 0) {
        throw new Error('No bullet assets available for remote shot')
    }

    const shot: QueuedRemoteShot = {
        id: ++nextRemoteShotId,
        image_id: session.result.image_id,
        bullet_assets: session.result.bullet_assets,
        processing_width: session.processingWidth,
        processing_height: session.processingHeight,
        frame_width: session.frameWidth,
        frame_height: session.frameHeight,
    }
    if (enqueue) {
        remoteShotQueue.push(shot)
        appendControlLog(`remote shot queued id=${shot.id} prediction=${session.predictionId}`)
    } else {
        appendControlLog(`remote shot prepared id=${shot.id} prediction=${session.predictionId}`)
    }
    return shot
}

const createWindow = () => {
    win = new BrowserWindow({
        width: 1280,
        height: 760,
        resizable: true,
        useContentSize: true, // Keep the configured width/height applied to the content area
        webPreferences: {
            preload: join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    })

    win.maximize()

    // win.webContents.openDevTools() // Optional: helpful for debugging

    if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(process.env.VITE_DEV_SERVER_URL)
    } else {
        win.loadFile(join(distPath, 'index.html'))
    }

    win.webContents.on('did-finish-load', () => {
        sendPauseStateToRenderer()
    })
}

app.whenReady().then(() => {
    spaceGameConfigs = readSpaceConfigFromDisk()
    bossDefeatCounts = readBossDefeatCountsFromDisk()
    ipcMain.handle('fruit:predict', async (_event, payload: PredictRequest) => {
        return await predictor.predict(payload)
    })
    ipcMain.handle('game:get-paused', () => {
        appendControlLog(`ipc game:get-paused => ${gameControlState.paused}`)
        return gameControlState.paused
    })
    ipcMain.handle('ranking:get', () => {
        return readRankings()
    })
    ipcMain.handle('ranking:submit', (_event, counts: FruitCounts) => {
        const entry = createRankingEntry(counts)
        const entries = readRankings()
        entries.push(entry)
        writeRankings(entries)
        setGameResultState({
            status: 'ended',
            currentEntryId: entry.id,
            counts,
        })
        return {
            entry,
            entries,
        }
    })
    ipcMain.handle('ranking:update-name', (_event, entryId: string, name: string) => {
        const result = updateRankingNameIfTotalTopThree(entryId, name)
        if (!result.ok) {
            throw new Error(result.error ?? 'Could not update ranking name')
        }
        return result.entries
    })
    ipcMain.handle('ranking:reset', () => {
        return resetRankings()
    })
    ipcMain.handle('game-result:set-state', (_event, state: GameResultState) => {
        setGameResultState(state)
        return gameResultState
    })

    createWindow()
    startControlServer()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('before-quit', () => {
    predictor.dispose()
    stopControlServer()
})
