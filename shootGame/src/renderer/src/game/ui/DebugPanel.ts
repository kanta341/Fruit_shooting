import { CoreFruitType } from '../interfaces/BulletSource'

type RankingEntry = {
    id: string
    playedAt: string
    counts: Record<CoreFruitType, number>
    total: number
    name?: string
}

type DebugPanelOptions = {
    onRestartGame: () => void
    getGameDuration: () => number
    onGameDurationChange: (seconds: number) => void
    getSpawnDebugVisible: () => boolean
    onSpawnDebugVisibilityChange: (visible: boolean) => void
}

const RANKING_STORAGE_KEY = 'fruit-rankings'

export class DebugPanel {
    private container: HTMLDivElement
    private toggleButton: HTMLButtonElement
    private isOpen = false
    private rankings: RankingEntry[] = []
    private options: DebugPanelOptions

    constructor(options: DebugPanelOptions) {
        this.options = options
        this.toggleButton = document.createElement('button')
        this.toggleButton.innerText = 'Settings'
        this.toggleButton.style.position = 'absolute'
        this.toggleButton.style.right = '14px'
        this.toggleButton.style.bottom = '14px'
        this.toggleButton.style.zIndex = '1001'
        this.toggleButton.style.padding = '8px 12px'
        this.toggleButton.style.borderRadius = '999px'
        this.toggleButton.style.border = '1px solid rgba(255, 255, 255, 0.65)'
        this.toggleButton.style.background = 'rgba(0, 0, 0, 0.72)'
        this.toggleButton.style.color = '#fff'
        this.toggleButton.style.fontFamily = '"Comic Sans MS", "Chalkboard SE", sans-serif'
        this.toggleButton.style.fontSize = '12px'
        this.toggleButton.style.cursor = 'pointer'
        this.toggleButton.onclick = () => this.toggle()
        document.body.appendChild(this.toggleButton)

        this.container = document.createElement('div')
        this.container.style.position = 'absolute'
        this.container.style.right = '14px'
        this.container.style.bottom = '56px'
        this.container.style.backgroundColor = 'rgba(39, 27, 17, 0.88)'
        this.container.style.padding = '14px'
        this.container.style.color = 'white'
        this.container.style.fontFamily = '"Comic Sans MS", "Chalkboard SE", sans-serif'
        this.container.style.border = '2px solid rgba(255, 236, 167, 0.85)'
        this.container.style.borderRadius = '18px'
        this.container.style.zIndex = '1000'
        this.container.style.maxHeight = '78vh'
        this.container.style.overflowY = 'auto'
        this.container.style.width = '360px'
        this.container.style.display = 'none'
        document.body.appendChild(this.container)

        void this.loadRankings()
    }

    private toggle() {
        this.isOpen = !this.isOpen
        this.container.style.display = this.isOpen ? 'block' : 'none'
        this.toggleButton.innerText = this.isOpen ? '設定を閉じる' : 'Settings'
        if (this.isOpen) {
            void this.loadRankings()
        }
    }

    private async loadRankings() {
        try {
            this.rankings = typeof window !== 'undefined' && typeof window.electron?.getRankings === 'function'
                ? await window.electron.getRankings()
                : []
        } catch (error) {
            console.error('Could not load rankings.', error)
        }
        if (this.rankings.length === 0) {
            this.rankings = this.readLocalStorageRankings()
        }
        this.render()
    }

    private async resetRankings() {
        const confirmed = window.confirm('ランキングデータを完全に削除しますか？')
        if (!confirmed) {
            return
        }

        try {
            this.rankings = typeof window !== 'undefined' && typeof window.electron?.resetRankings === 'function'
                ? await window.electron.resetRankings()
                : []
        } catch (error) {
            console.error('Could not reset rankings.', error)
        }
        window.localStorage.removeItem(RANKING_STORAGE_KEY)
        this.rankings = []
        this.render()
    }

    private render() {
        this.container.innerHTML = ''

        const title = document.createElement('div')
        title.innerText = '設定'
        title.style.fontWeight = '900'
        title.style.marginBottom = '12px'
        title.style.textAlign = 'center'
        title.style.color = '#fff0a8'
        title.style.fontSize = '22px'
        this.container.appendChild(title)

        this.appendGameControls()
        this.appendRankingSection('合計獲得数 上位5位', this.getTopRankings('total', 5), 'total')
        this.appendRankingSection('りんご 上位3位', this.getTopRankings('apple', 3), 'apple')
        this.appendRankingSection('バナナ 上位3位', this.getTopRankings('banana', 3), 'banana')
        this.appendRankingSection('ぶどう 上位3位', this.getTopRankings('grape', 3), 'grape')

        const resetButton = document.createElement('button')
        resetButton.innerText = 'ランキングデータをリセット'
        resetButton.style.width = '100%'
        resetButton.style.marginTop = '14px'
        resetButton.style.padding = '10px'
        resetButton.style.border = '0'
        resetButton.style.borderRadius = '999px'
        resetButton.style.background = '#ff6b6b'
        resetButton.style.color = '#fff'
        resetButton.style.fontWeight = '900'
        resetButton.style.cursor = 'pointer'
        resetButton.onclick = () => {
            void this.resetRankings()
        }
        this.container.appendChild(resetButton)
    }

    private appendGameControls() {
        const section = document.createElement('section')
        section.style.borderTop = '1px solid rgba(255, 236, 167, 0.32)'
        section.style.paddingTop = '10px'
        section.style.marginTop = '10px'

        const title = document.createElement('div')
        title.innerText = 'ゲーム操作'
        title.style.color = '#ffe9a6'
        title.style.fontWeight = '900'
        title.style.marginBottom = '8px'
        section.appendChild(title)

        const restartButton = document.createElement('button')
        restartButton.innerText = 'もう一度ゲームを始める'
        restartButton.style.width = '100%'
        restartButton.style.padding = '10px'
        restartButton.style.border = '0'
        restartButton.style.borderRadius = '999px'
        restartButton.style.background = '#ffe36c'
        restartButton.style.color = '#4a2b12'
        restartButton.style.fontWeight = '900'
        restartButton.style.cursor = 'pointer'
        restartButton.onclick = () => {
            this.options.onRestartGame()
        }
        section.appendChild(restartButton)

        const durationRow = document.createElement('div')
        durationRow.style.display = 'flex'
        durationRow.style.alignItems = 'center'
        durationRow.style.gap = '8px'
        durationRow.style.marginTop = '10px'

        const durationLabel = document.createElement('label')
        durationLabel.innerText = 'ゲーム時間（秒）'
        durationLabel.style.flex = '1'
        durationLabel.style.color = '#fff8d7'
        durationLabel.style.fontSize = '14px'

        const durationInput = document.createElement('input')
        durationInput.type = 'number'
        durationInput.min = '10'
        durationInput.max = '600'
        durationInput.step = '10'
        durationInput.value = String(this.options.getGameDuration())
        durationInput.style.width = '76px'
        durationInput.style.padding = '6px'
        durationInput.style.borderRadius = '8px'
        durationInput.style.border = '1px solid rgba(255, 236, 167, 0.85)'

        durationInput.addEventListener('change', () => {
            const seconds = Number.parseInt(durationInput.value, 10)
            if (!Number.isFinite(seconds)) {
                durationInput.value = String(this.options.getGameDuration())
                return
            }
            this.options.onGameDurationChange(seconds)
            durationInput.value = String(this.options.getGameDuration())
        })

        durationRow.appendChild(durationLabel)
        durationRow.appendChild(durationInput)
        section.appendChild(durationRow)

        const spawnDebugRow = document.createElement('div')
        spawnDebugRow.style.display = 'flex'
        spawnDebugRow.style.alignItems = 'center'
        spawnDebugRow.style.gap = '8px'
        spawnDebugRow.style.marginTop = '10px'

        const spawnDebugLabel = document.createElement('div')
        spawnDebugLabel.innerText = '右上の倍率表示'
        spawnDebugLabel.style.flex = '1'
        spawnDebugLabel.style.color = '#fff8d7'
        spawnDebugLabel.style.fontSize = '14px'

        const spawnDebugToggle = document.createElement('button')
        const updateSpawnDebugToggle = () => {
            const visible = this.options.getSpawnDebugVisible()
            spawnDebugToggle.innerText = visible ? '表示中' : '非表示'
            spawnDebugToggle.style.background = visible ? 'rgba(34, 80, 56, 0.92)' : 'rgba(80, 34, 34, 0.92)'
        }
        spawnDebugToggle.style.padding = '6px 14px'
        spawnDebugToggle.style.border = '0'
        spawnDebugToggle.style.borderRadius = '999px'
        spawnDebugToggle.style.color = '#fff'
        spawnDebugToggle.style.fontWeight = '900'
        spawnDebugToggle.style.cursor = 'pointer'
        spawnDebugToggle.style.fontSize = '13px'
        spawnDebugToggle.onclick = () => {
            this.options.onSpawnDebugVisibilityChange(!this.options.getSpawnDebugVisible())
            updateSpawnDebugToggle()
        }
        updateSpawnDebugToggle()

        spawnDebugRow.appendChild(spawnDebugLabel)
        spawnDebugRow.appendChild(spawnDebugToggle)
        section.appendChild(spawnDebugRow)

        this.container.appendChild(section)
    }

    private appendRankingSection(titleText: string, entries: RankingEntry[], metric: CoreFruitType | 'total') {
        const section = document.createElement('section')
        section.style.borderTop = '1px solid rgba(255, 236, 167, 0.32)'
        section.style.paddingTop = '10px'
        section.style.marginTop = '10px'

        const title = document.createElement('div')
        title.innerText = titleText
        title.style.color = '#ffe9a6'
        title.style.fontWeight = '900'
        title.style.marginBottom = '6px'
        section.appendChild(title)

        if (entries.length === 0) {
            const empty = document.createElement('div')
            empty.innerText = 'まだデータがありません'
            empty.style.color = '#fff8d7'
            empty.style.opacity = '0.78'
            section.appendChild(empty)
            this.container.appendChild(section)
            return
        }

        entries.forEach((entry, index) => {
            const row = document.createElement('div')
            const value = metric === 'total' ? entry.total : entry.counts[metric]
            const name = metric === 'total' ? `${entry.name?.trim() || 'なまえなし'} ` : ''
            row.innerText = `${index + 1}位 ${name}${value}個`
            row.style.color = '#fff8d7'
            row.style.fontSize = '14px'
            row.style.lineHeight = '1.55'
            section.appendChild(row)
        })

        this.container.appendChild(section)
    }

    private getTopRankings(metric: CoreFruitType | 'total', limit: number) {
        return [...this.rankings]
            .sort((left, right) => {
                const leftValue = metric === 'total' ? left.total : left.counts[metric]
                const rightValue = metric === 'total' ? right.total : right.counts[metric]
                if (rightValue !== leftValue) {
                    return rightValue - leftValue
                }
                return left.playedAt.localeCompare(right.playedAt)
            })
            .slice(0, limit)
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

    destroy() {
        this.toggleButton.remove()
        this.container.remove()
    }
}
