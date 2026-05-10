# Simple Electron Shooter

A simple 2D top-down shooting game built with Electron, TypeScript, and Vite.

## Requirements
- Node.js (v18+)
- npm or pnpm

## Installation

```bash
npm install
# or
pnpm install
```

## Development
Run the game in development mode:

```bash
npm run dev
# or
pnpm dev
```

## Controls
- **Arrow Left/Right**: Move Player
- **Space**: Shoot
- **R**: Restart Game (when Game Over)

## Game Rules
- Destroy enemies to gain score.
- If an enemy reaches the bottom, you lose a life.
- Game Over when lives reach 0.

## Architecture
- **Renderer**: Canvas 2D
- **State Management**: Simple Game Loop with Delta Time
- **Input Abstraction**: `BulletSource` interface used for shooting mechanism.