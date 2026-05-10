import { BulletSource, ShotBatch } from '../interfaces/BulletSource'

export class KeyboardBulletSource implements BulletSource {
    private onShootCallback: ((data?: ShotBatch) => void) | null = null
    private shotRequested = false

    constructor() {
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space') {
                this.shotRequested = true
            }
        })
    }

    onShoot(callback: (data?: any) => void): void {
        this.onShootCallback = callback
    }

    update(dt: number): void {
        // In this simple implementation, we fire immediately on next update if key was pressed.
        // For auto-fire while holding, we would check 'keydown' state instead.
        // Requirement says "Spaceで弾を発射", implying single shot per press or auto?
        // "Space押下で弾生成イベントを出す" -> usually means on press.
        // Let's implement simple trigger: if pressed, fire. To avoid machine gun speed, we might add cooldown in Game or here.
        // For now, let's treat it as "trigger once per frame if flag set" and reset flag.
        // To make it distinct presses, we should probably listen to 'keydown' and fire once. 
        // But 'update' pattern suggests polling or state management.

        if (this.shotRequested) {
            if (this.onShootCallback) {
                this.onShootCallback()
            }
            this.shotRequested = false // Reset after firing
        }
    }
}
