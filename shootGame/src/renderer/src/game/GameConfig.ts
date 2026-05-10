export type EnemyConfig = {
    name: string
    hp: number
    speed: number
    size: number
    color: string
    spawnInterval: number      // Base interval
    spawnStart: number         // Seconds from game start
    spawnEnd: number           // Seconds from game start (or 0 for never)
    spawnRateChange: number    // Change per 10 seconds of active time
}

export const GameConfig = {
    // Global spawn interval removed in favor of per-type
    enemyTypes: [
        {
            name: 'Normal', hp: 100, speed: 100, size: 30, color: '#ff0000',
            spawnInterval: 2.0, spawnStart: 0, spawnEnd: 0, spawnRateChange: -0.1
        },
        {
            name: 'Fast', hp: 50, speed: 200, size: 20, color: '#ff8888',
            spawnInterval: 1.0, spawnStart: 10, spawnEnd: 0, spawnRateChange: -0.05
        },
        {
            name: 'Tank', hp: 300, speed: 50, size: 50, color: '#880000',
            spawnInterval: 4.0, spawnStart: 20, spawnEnd: 0, spawnRateChange: -0.2
        },
    ] as EnemyConfig[],
    gameDuration: 120,
}
