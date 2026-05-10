/// <reference types="vite/client" />

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
        fruit_name?: 'banana' | 'apple' | 'grape'
        image_id?: string
    }>
    components?: Array<{
        fruit_name?: 'banana' | 'apple' | 'grape'
        image_id?: string
    }>
    profiling?: Record<string, number>
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

interface ElectronBridge {
    predictFruit(payload: PredictRequest): Promise<PredictResponse>
    getPauseState(): Promise<boolean>
    getRankings(): Promise<RankingEntry[]>
    submitRanking(counts: FruitCounts): Promise<{ entry: RankingEntry, entries: RankingEntry[] }>
    resetRankings(): Promise<RankingEntry[]>
    updateRankingName(entryId: string, name: string): Promise<RankingEntry[]>
    onRankingsChanged(callback: (entries: RankingEntry[]) => void): () => void
    setGameResultState(state: GameResultState): Promise<GameResultState>
    getBackgroundImageUrl(): string
    getBoxImageAssets(): Record<'empty' | 'banana' | 'apple' | 'grape' | 'mixed' | 'full', string>
    getGrownPlantImageAssets(): {
        plants: Array<{ name: string, url: string }>
        fruits: Record<'banana' | 'apple' | 'grape', Array<{ name: string, url: string }>>
    }
    getEnemyImageAssets(): Array<{ name: string, url: string }>
    onPauseChanged(callback: (paused: boolean) => void): () => void
}

declare global {
    interface Window {
        electron: ElectronBridge
    }
}

export {}
