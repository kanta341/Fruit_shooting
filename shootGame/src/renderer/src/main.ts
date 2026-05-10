import './style.css'
import { SpaceGame } from './SpaceGame'
import { RemoteDrawClient } from './RemoteDrawClient'

const init = () => {
    const app = document.getElementById('app')
    if (!app) return

    const isCapacitor = Boolean((window as typeof window & { Capacitor?: unknown }).Capacitor)
    if (isCapacitor) {
        new RemoteDrawClient().mount(app)
        return
    }

    const canvas = document.createElement('canvas')
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
    app.appendChild(canvas)

    let currentGame: SpaceGame | null = null

    const startSpaceGame = () => {
        const game = new SpaceGame(canvas)
        game.start()
        currentGame = game
    }

    const resizeCanvas = () => {
        canvas.width = window.innerWidth
        canvas.height = window.innerHeight
        currentGame?.resize(canvas.width, canvas.height)
    }
    window.addEventListener('resize', resizeCanvas)

    if (typeof window !== 'undefined' && typeof window.electron?.onPauseChanged === 'function') {
        window.electron.onPauseChanged((paused) => {
            console.log(`[renderer-main] onPauseChanged paused=${paused}`)
            void paused
        })
    }
    if (typeof window !== 'undefined' && typeof window.electron?.getPauseState === 'function') {
        const syncPauseState = async () => {
            const paused = await window.electron.getPauseState()
            console.log(`[renderer-main] syncPauseState paused=${paused}`)
        }
        void syncPauseState()
        window.setInterval(() => {
            void syncPauseState()
        }, 250)
    }
    const syncPauseStateViaHttp = async () => {
        try {
            const response = await fetch('http://127.0.0.1:8030/api/status?source=renderer')
            if (!response.ok) return
            const data = await response.json() as { paused?: boolean }
            if (typeof data.paused === 'boolean') {
                void data.paused
            }
        } catch (error) {
            console.warn('[renderer-main] syncPauseStateViaHttp failed', error)
        }
    }
    void syncPauseStateViaHttp()
    window.setInterval(() => {
        void syncPauseStateViaHttp()
    }, 250)

    startSpaceGame()
}

init()
