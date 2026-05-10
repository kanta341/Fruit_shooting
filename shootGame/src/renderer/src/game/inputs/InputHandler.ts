export class InputHandler {
    keys: Set<string> = new Set()

    constructor() {
        window.addEventListener('keydown', (e) => {
            this.keys.add(e.code)
        })
        window.addEventListener('keyup', (e) => {
            this.keys.delete(e.code)
        })
    }

    isDown(code: string): boolean {
        return this.keys.has(code)
    }
}
