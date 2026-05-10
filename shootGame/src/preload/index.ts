import { contextBridge, ipcRenderer } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

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

contextBridge.exposeInMainWorld('electron', {
    predictFruit(payload: PredictRequest): Promise<PredictResponse> {
        return ipcRenderer.invoke('fruit:predict', payload)
    },
    getPauseState(): Promise<boolean> {
        return ipcRenderer.invoke('game:get-paused') as Promise<boolean>
    },
    getRankings(): Promise<RankingEntry[]> {
        return ipcRenderer.invoke('ranking:get') as Promise<RankingEntry[]>
    },
    submitRanking(counts: FruitCounts): Promise<{ entry: RankingEntry, entries: RankingEntry[] }> {
        return ipcRenderer.invoke('ranking:submit', counts) as Promise<{ entry: RankingEntry, entries: RankingEntry[] }>
    },
    resetRankings(): Promise<RankingEntry[]> {
        return ipcRenderer.invoke('ranking:reset') as Promise<RankingEntry[]>
    },
    updateRankingName(entryId: string, name: string): Promise<RankingEntry[]> {
        return ipcRenderer.invoke('ranking:update-name', entryId, name) as Promise<RankingEntry[]>
    },
    onRankingsChanged(callback: (entries: RankingEntry[]) => void): () => void {
        const listener = (_event: Electron.IpcRendererEvent, entries: RankingEntry[]) => callback(entries)
        ipcRenderer.on('ranking:changed', listener)
        return () => ipcRenderer.off('ranking:changed', listener)
    },
    setGameResultState(state: GameResultState): Promise<GameResultState> {
        return ipcRenderer.invoke('game-result:set-state', state) as Promise<GameResultState>
    },
    getBackgroundImageUrl(): string {
        return getImageDataUrl('backImag', 'hiroba2.png')
    },
    getBoxImageAssets(): Record<'empty' | 'banana' | 'apple' | 'grape' | 'mixed' | 'full', string> {
        return {
            empty: getImageDataUrl('box', 'box1.png'),
            banana: getImageDataUrl('box', '2banana.png'),
            apple: getImageDataUrl('box', '2apple.png'),
            grape: getImageDataUrl('box', '2grape.png'),
            mixed: getImageDataUrl('box', 'box2.png'),
            full: getImageDataUrl('box', 'box3.png'),
        }
    },
    getGrownPlantImageAssets(): {
        plants: Array<{ name: string, url: string }>
        fruits: Record<'banana' | 'apple' | 'grape', Array<{ name: string, url: string }>>
    } {
        return {
            plants: getImageDataUrlEntries('me2/plant'),
            fruits: {
                banana: getImageDataUrlEntries('me2/banana'),
                apple: getImageDataUrlEntries('me2/apple'),
                grape: getImageDataUrlEntries('me2/grape'),
            },
        }
    },
    getEnemyImageAssets(): Array<{ name: string, url: string }> {
        return getImageDataUrlEntries('me')
    },
    onPauseChanged(callback: (paused: boolean) => void): () => void {
        const listener = (_event: Electron.IpcRendererEvent, paused: boolean) => {
            console.log(`[preload] game:set-paused paused=${paused}`)
            callback(paused)
        }
        ipcRenderer.on('game:set-paused', listener)
        return () => {
            ipcRenderer.removeListener('game:set-paused', listener)
        }
    },
})

function getImageDataUrl(directoryName: string, fileName: string): string {
    const projectRoot = resolve(__dirname, '../../..')
    const filePath = resolve(projectRoot, 'back', directoryName, fileName)
    if (!existsSync(filePath)) {
        return ''
    }

    const imageBuffer = readFileSync(filePath)
    return `data:image/png;base64,${imageBuffer.toString('base64')}`
}

function getImageDataUrlEntries(directoryName: string): Array<{ name: string, url: string }> {
    const projectRoot = resolve(__dirname, '../../..')
    const imageDir = resolve(projectRoot, 'back', directoryName)
    if (!existsSync(imageDir)) {
        return []
    }

    return readdirSync(imageDir)
        .filter((name) => name.toLowerCase().endsWith('.png'))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .map((fileName) => ({
            name: fileName,
            url: getImageDataUrl(directoryName, fileName),
        }))
}
