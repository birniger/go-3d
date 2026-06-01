# 3D Go — Cyberpunk Edition

A browser-based 3D Go game built with [Three.js](https://threejs.org/), Vite, and TypeScript. Play Go on a full N×N×N cube with a neon cyberpunk aesthetic — bloom post-processing, animated captures, particle bursts, and a full slice-mode interface for reading the 3D board.

**Play online → [birniger.github.io/go-3d](https://birniger.github.io/go-3d)**

---

## Features

- **3D boards** — 5³ · 9³ · 13³ · 19³ or custom 2–19
- **Slice mode** — press X / Y / Z to isolate a 2D cross-section of the cube for easier reading and placement
- **Keyboard cursor** — navigate the board with arrow keys + E/Q, place stones with Enter; or jump to any coordinate with `/`
- **Scoring** — Chinese (area) and Japanese (territory + prisoners) with configurable komi
- **Time controls** — None · Simple · Fischer · Byo-yomi
- **Move history** — full replay with prev/next stepping
- **Captures** — shrink + particle burst animations, sound effects
- **Go rules** — suicide prevention, positional superko, consecutive-pass game end, undo

---

## Getting Started

```bash
# Install dependencies
npm install

# Start development server (http://localhost:5173)
npm run dev

# Type-check without building
npm run typecheck

# Production build → dist/
npm run build
```

Requires [Node.js](https://nodejs.org/) 18+.

---

## Controls

### Placement

| Input | Action |
|-------|--------|
| **Click** a dot | Place stone (always works outside cursor mode) |
| **Arrow keys** | Activate keyboard cursor, move X/Z |
| **E / Q** | Move cursor up / down (Y axis) |
| **Enter** | Place stone at cursor (cursor mode, no slice) |
| **/** | Jump to coordinate (e.g. `E5c`) |

### Slice mode

| Key | Action |
|-----|--------|
| **X** | Toggle X-slice (step with ← →) |
| **Y** | Toggle Y-slice (step with E / Q) |
| **Z** | Toggle Z-slice (step with ↑ ↓) |
| **Mouse click** | Place stone on the highlighted plane |
| **Escape** | Exit slice / cursor mode |

### Board & game

| Key | Action |
|-----|--------|
| **P** | Pass |
| **U** | Undo |
| **T** | Show / hide territory scan |
| **N** | New game |
| **1 / 2 / 3 / 4** | Camera: top · front · side · isometric |
| **Drag** | Rotate camera |
| **Scroll** | Zoom |

### Coordinate notation

Coordinates are displayed as **X·col  Y·row  Z·depth** using colour-coded labels:
- **X** (cyan) — column letter A–S
- **Y** (pink) — layer number 1–19
- **Z** (mint) — depth letter a–s

---

## Scoring

Switch between scoring systems in the **SCORING RULES** panel. Komi is configurable (default 6.5).

| Mode | Formula |
|------|---------|
| **Chinese** | territory + stones on board + komi (white) |
| **Japanese** | territory + prisoners captured + komi (white) |

> **Note:** Japanese scoring conventionally requires dead-stone removal before counting. This implementation scores all on-board stones as alive — agree on dead stones with your opponent before triggering the scan.

---

## Project Structure

```
go-3d/
├── src/
│   ├── game.ts       # Core Go logic (placement, capture, superko, territory, undo)
│   ├── clock.ts      # Time controls (Simple / Fischer / Byo-yomi)
│   ├── renderer.ts   # Three.js scene, animations, slice mode, picking
│   └── main.ts       # UI wiring, keyboard/mouse input, game flow
├── index.html        # Entry point + side-panel UI
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## Contributing

Pull requests are welcome. Here's how to get set up:

```bash
git clone https://github.com/birniger/go-3d.git
cd go-3d
npm install
npm run dev
```

A few conventions:
- **TypeScript strict mode** is on — no implicit `any` outside of the dispose helper
- Run `npm run typecheck` before opening a PR
- Keep new Three.js objects out of the per-frame `animate()` path (allocate once, reuse)
- Renderer state changes (visibility, color) that depend only on mode switches should use dirty flags rather than per-frame recalculation

Open an issue first for anything larger than a bug fix so we can align on the design.

---

## Tech Stack

| | |
|---|---|
| **Three.js r165** | 3D rendering, InstancedMesh, OrbitControls, EffectComposer |
| **UnrealBloomPass** | Neon glow post-processing |
| **Vite 5** | Dev server + production bundler |
| **TypeScript 5** | Strict-mode throughout |
| **Web Audio API** | Procedural sound effects |

---

## License

[MIT](LICENSE)
