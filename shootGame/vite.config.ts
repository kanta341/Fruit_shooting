import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { spawnSync } from 'child_process'
import { createReadStream, existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import type { IncomingMessage, ServerResponse } from 'http'

function generateEnemyAnimationsPlugin() {
    let generated = false

    const generate = () => {
        if (generated) {
            return
        }
        generated = true

        const scriptPath = resolve(__dirname, '../scripts/generate_enemy_grow_animations.py')
        if (!existsSync(scriptPath)) {
            console.warn(`[enemy-animations] script not found: ${scriptPath}`)
            return
        }

        const pythonCommand = existsSync(resolve(__dirname, '../venv/bin/python'))
            ? resolve(__dirname, '../venv/bin/python')
            : (process.env.PYTHON_EXECUTABLE || 'python3')
        const result = spawnSync(pythonCommand, [scriptPath], {
            cwd: resolve(__dirname, '..'),
            encoding: 'utf-8',
        })

        if (result.status !== 0) {
            console.warn(`[enemy-animations] generation failed: ${result.stderr || result.stdout}`)
        }
    }

    return {
        name: 'generate-enemy-animations',
        buildStart() {
            generate()
        },
        configureServer() {
            generate()
        },
    }
}

function generateGrownPlantLayoutsPlugin() {
    let generated = false

    const generate = () => {
        if (generated) {
            return
        }
        generated = true

        const scriptPath = resolve(__dirname, '../scripts/generate_grown_plant_layouts.py')
        if (!existsSync(scriptPath)) {
            console.warn(`[grown-plant-layouts] script not found: ${scriptPath}`)
            return
        }

        const pythonCommand = existsSync(resolve(__dirname, '../venv/bin/python'))
            ? resolve(__dirname, '../venv/bin/python')
            : (process.env.PYTHON_EXECUTABLE || 'python3')
        const result = spawnSync(pythonCommand, [scriptPath], {
            cwd: resolve(__dirname, '..'),
            encoding: 'utf-8',
        })

        if (result.status !== 0) {
            console.warn(`[grown-plant-layouts] generation failed: ${result.stderr || result.stdout}`)
        }
    }

    return {
        name: 'generate-grown-plant-layouts',
        buildStart() {
            generate()
        },
        configureServer() {
            generate()
        },
    }
}

function generateSoilMaskPlugin() {
    let generated = false

    const generate = () => {
        if (generated) {
            return
        }
        generated = true

        const scriptPath = resolve(__dirname, '../scripts/generate_soil_mask.py')
        if (!existsSync(scriptPath)) {
            console.warn(`[soil-mask] script not found: ${scriptPath}`)
            return
        }

        const pythonCommand = existsSync(resolve(__dirname, '../venv/bin/python'))
            ? resolve(__dirname, '../venv/bin/python')
            : (process.env.PYTHON_EXECUTABLE || 'python3')
        const result = spawnSync(pythonCommand, [scriptPath], {
            cwd: resolve(__dirname, '..'),
            encoding: 'utf-8',
        })

        if (result.status !== 0) {
            console.warn(`[soil-mask] generation failed: ${result.stderr || result.stdout}`)
        }
    }

    return {
        name: 'generate-soil-mask',
        buildStart() {
            generate()
        },
        configureServer() {
            generate()
        },
    }
}

function serveBackgroundImagePlugin() {
    const backgroundPath = resolve(__dirname, '../back/backImag/hiroba2.png')

    return {
        name: 'serve-background-image',
        configureServer(server: {
            middlewares: {
                use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void
            }
        }) {
            server.middlewares.use((req, res, next) => {
                if ((req.url ?? '') !== '/local-background/hiroba2.png') {
                    next()
                    return
                }

                if (!existsSync(backgroundPath)) {
                    res.statusCode = 404
                    res.end('Not found')
                    return
                }

                res.setHeader('Content-Type', 'image/png')
                createReadStream(backgroundPath).pipe(res)
            })
        },
    }
}

function serveBoxImagePlugin() {
    const boxRoot = resolve(__dirname, '../back/box')

    return {
        name: 'serve-box-image',
        configureServer(server: {
            middlewares: {
                use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void
            }
        }) {
            server.middlewares.use((req, res, next) => {
                const requestPath = (req.url ?? '').split('?')[0]
                const match = requestPath.match(/^\/local-box\/([^/]+\.png)$/)
                if (!match) {
                    next()
                    return
                }

                const boxPath = resolve(boxRoot, match[1])
                if (!existsSync(boxPath)) {
                    res.statusCode = 404
                    res.end('Not found')
                    return
                }

                res.setHeader('Content-Type', 'image/png')
                createReadStream(boxPath).pipe(res)
            })
        },
    }
}

function servePlantImagePlugin() {
    const imageRoot = resolve(__dirname, '../back/me2')

    return {
        name: 'serve-plant-image',
        configureServer(server: {
            middlewares: {
                use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void
            }
        }) {
            server.middlewares.use((req, res, next) => {
                const match = (req.url ?? '').match(/^\/local-grown-plant\/(plant|banana|apple|grape)\/([^/]+\.png)$/)
                if (!match) {
                    next()
                    return
                }

                const plantPath = resolve(imageRoot, match[1], match[2])
                if (!existsSync(plantPath)) {
                    res.statusCode = 404
                    res.end('Not found')
                    return
                }

                res.setHeader('Content-Type', 'image/png')
                createReadStream(plantPath).pipe(res)
            })
        },
    }
}

function serveEnemyImagePlugin() {
    const enemyDir = resolve(__dirname, '../back/me')

    return {
        name: 'serve-enemy-image',
        configureServer(server: {
            middlewares: {
                use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void
            }
        }) {
            server.middlewares.use((req, res, next) => {
                const url = req.url ?? ''
                if (url === '/local-enemy/index.json') {
                    if (!existsSync(enemyDir)) {
                        res.setHeader('Content-Type', 'application/json')
                        res.end('[]')
                        return
                    }

                    const files = readdirSync(enemyDir)
                        .filter((name) => name.toLowerCase().endsWith('.png'))
                        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
                    res.setHeader('Content-Type', 'application/json')
                    res.end(JSON.stringify(files))
                    return
                }

                const match = url.match(/^\/local-enemy\/([^/]+\.png)$/)
                if (!match) {
                    next()
                    return
                }

                const enemyPath = resolve(enemyDir, match[1])
                if (!existsSync(enemyPath)) {
                    res.statusCode = 404
                    res.end('Not found')
                    return
                }

                res.setHeader('Content-Type', 'image/png')
                createReadStream(enemyPath).pipe(res)
            })
        },
    }
}

export default defineConfig({
    root: 'src/renderer',
    base: './',
    plugins: [
        generateEnemyAnimationsPlugin(),
        generateGrownPlantLayoutsPlugin(),
        generateSoilMaskPlugin(),
        serveBackgroundImagePlugin(),
        serveBoxImagePlugin(),
        servePlantImagePlugin(),
        serveEnemyImagePlugin(),
        electron([
            {
                // Main-Process entry file of the Electron App.
                entry: '../main/index.ts',
                onstart(options) {
                    options.startup()
                },
                vite: {
                    build: {
                        outDir: '../../dist-electron',
                        rollupOptions: {
                            output: {
                                entryFileNames: 'main.js',
                            },
                        },
                    },
                },
            },
            {
                entry: '../preload/index.ts',
                onstart(options) {
                    // Notify the Renderer-Process to reload the page when the Preload-Scripts build is complete, 
                    // instead of restarting the entire Electron App.
                    options.reload()
                },
                vite: {
                    build: {
                        outDir: '../../dist-electron',
                        rollupOptions: {
                            output: {
                                entryFileNames: 'preload.js',
                            },
                        },
                    },
                },
            },
        ]),
        renderer(),
    ],
})
