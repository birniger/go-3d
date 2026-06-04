# 3D Go — Cyberpunk Edition

Go, played in three dimensions, with a neon cyberpunk aesthetic — bloom post-processing, animated captures, particle bursts, and slice-mode tools for reading a volumetric board. Built with [Three.js](https://threejs.org/), Vite, and TypeScript.

It ships in two forms from one codebase:

- **Standalone** — a single-device hot-seat cube game. Zero backend, runs entirely in the browser. **Play online → [birniger.github.io/go-3d](https://birniger.github.io/go-3d)**
- **WordPress plugin** (`wp-plugin/go3d`) — a full multiplayer build with accounts, ELO ratings, real-time play over Pusher, three board modes, and a built-in local hot-seat mode. Drop the `[go3d]` shortcode on any page.

---

## Board modes

| Mode | Board | Notes |
|------|-------|-------|
| **Cube** | N×N×N lattice (2–19) | Classic 3D Go; every interior point has up to 6 neighbours. |
| **Stack** | N×N×N, built layer by layer | Play fills one horizontal layer at a time; two passes advance the build to the next layer until the top is reached, then the whole cube is scored. |
| **Sphere** | Geodesic icosphere (frequency 2–8) | Go on a globe — `10·f² + 2` points connected by the geodesic graph, no edges or corners. |

Cube and Stack run on the `Go3D` lattice engine; Sphere runs on the `GraphGo` graph engine over a locally- or server-built geodesic adjacency. Both implement the full rule set: capture, suicide prevention, and positional superko.

---

## Game modes (WordPress plugin)

- **Online multiplayer** — create or join an open game, play move-by-move with server-authoritative rules, real-time delivery via Pusher (HTTP polling fallback when Pusher isn't configured), ELO updates on finish.
- **Local hot-seat** — *"Play locally (2 players, 1 screen)"*. Two players share one computer, no opponent or server round-trip. Works across **every** board mode and time control; rules, clocks and scoring all run client-side and stay identical to a server game.

---

## Scoring

Chinese (area) and Japanese (territory + prisoners), with configurable komi (default 6.5).

| Mode | Formula |
|------|---------|
| **Chinese** | territory + stones on board + komi (white) |
| **Japanese** | territory + prisoners captured + komi (white) |

> **Note:** Japanese scoring conventionally requires dead-stone removal before counting. This implementation scores all on-board stones as alive — agree on dead stones with your opponent before counting.

---

## Time controls

- **Standalone:** None · Simple · Fischer · Byo-yomi
- **Plugin:** None · Absolute · Fischer · Byo-yomi (with real period tracking)

Untimed ("None") games show ∞ and hide the clock bar.

---

## Controls (standalone & in-game)

### Placement

| Input | Action |
|-------|--------|
| **Click** a point | Place a stone |
| **Arrow keys** | Activate keyboard cursor, move X/Z |
| **E / Q** | Move cursor up / down (Y axis) |
| **Enter** | Place stone at cursor (cursor mode, no slice) |
| **/** | Jump to coordinate (e.g. `E5c`) — standalone |

### Slice mode (cube / stack)

| Key | Action |
|-----|--------|
| **X** | Toggle X-slice (step with ← →) |
| **Y** | Toggle Y-slice (step with E / Q) |
| **Z** | Toggle Z-slice (step with ↑ ↓) |
| **Escape** | Exit slice / cursor mode |

### Board & camera

| Key | Action |
|-----|--------|
| **P** | Pass |
| **T** | Show / hide territory scan |
| **Drag / Scroll** | Rotate / zoom camera |
| **Camera buttons** | Top · front · side · isometric |

Coordinates are shown as **X·col (cyan)  Y·layer (pink)  Z·depth (mint)**.

---

## Getting started (development)

```bash
# Install dependencies (Node.js 18+)
npm install

# Dev server → http://localhost:5173
npm run dev

# Type-check without building
npm run typecheck

# Production build → dist/
npm run build
```

`vite build` emits two entries from one bundle:
- `main` (`index.html` → `src/main.ts`) — the standalone GitHub Pages game.
- `app` (`src/app.ts`) — the multiplayer + local bundle the WordPress shortcode loads.

### Packaging the plugin

```bash
npm run build
rm -rf wp-plugin/go3d/assets/dist && mkdir -p wp-plugin/go3d/assets/dist
cp -R dist/. wp-plugin/go3d/assets/dist/
(cd wp-plugin && zip -rq ../go3d.zip go3d)
```

Upload `go3d.zip` under **Plugins → Add New → Upload Plugin**. The shortcode reads the Vite manifest to resolve the hashed asset filenames, so no paths are hard-coded.

> On some Apache/CGI shared hosts (e.g. Hetzner) the `Authorization` header is stripped before PHP sees it. If logins don't persist, apply the one-line `.htaccess` fix in [`wp-plugin/go3d/docs/htaccess-auth.txt`](wp-plugin/go3d/docs/htaccess-auth.txt).

---

## Project structure

```
go-3d/
├── src/                        # Shared TypeScript client
│   ├── game.ts                 # Cube/stack Go engine (capture, superko, territory, undo)
│   ├── graph-go.ts             # Sphere Go engine over a geodesic graph
│   ├── geodesic.ts             # Icosphere generator (client port of the PHP builder)
│   ├── clock.ts                # Time controls (Simple / Absolute / Fischer / Byo-yomi)
│   ├── renderer.ts             # Three.js scene for cube/stack — slice mode, picking, FX
│   ├── sphere-renderer.ts      # Three.js scene for sphere boards
│   ├── main.ts                 # Standalone (GitHub Pages) hot-seat UI
│   ├── app.ts                  # WordPress embed: lobby → game session wiring
│   ├── lobby.ts                # Auth / lobby / new-game / profile screens
│   ├── auth.ts                 # Client auth state
│   ├── api.ts                  # REST client + shared types
│   ├── multiplayer.ts          # Server-authoritative controller (Pusher + polling + clock)
│   └── local-controller.ts     # Local hot-seat controller (same surface, no server)
├── index.html                  # Standalone entry + side-panel UI
└── wp-plugin/go3d/             # WordPress plugin
    ├── go3d.php                # Bootstrap, version, constants
    ├── includes/               # REST routes, game logic, JWT, geodesic, shortcode
    ├── templates/embed.php     # Shortcode markup (lobby + game shell)
    ├── assets/                 # go3d.css + built dist/ (generated)
    ├── docs/htaccess-auth.txt  # Shared-host Authorization header fix
    └── tests/clock-test.php    # Byo-yomi / time-control parity tests
```

The local hot-seat controller (`local-controller.ts`) deliberately mirrors the multiplayer controller's surface (`GameController`), so the same session, renderer, replay and UI code drives both online and offline play.

---

## Contributing

```bash
git clone https://github.com/birniger/go-3d.git
cd go-3d && npm install && npm run dev
```

Conventions:
- **TypeScript strict mode** is on — run `npm run typecheck` before opening a PR.
- Keep new Three.js objects out of the per-frame `animate()` path (allocate once, reuse).
- Renderer state changes that depend only on mode switches should use dirty flags, not per-frame recalculation.
- For plugin changes, `php -l` every touched file and run `php wp-plugin/go3d/tests/clock-test.php`.

Open an issue first for anything larger than a bug fix.

---

## Tech stack

| | |
|---|---|
| **Three.js r165** | InstancedMesh, OrbitControls, EffectComposer |
| **UnrealBloomPass** | Neon glow post-processing |
| **Vite 5** | Multi-entry dev server + bundler |
| **TypeScript 5** | Strict-mode throughout |
| **Web Audio API** | Procedural sound effects |
| **WordPress + PHP** | REST API, custom HS256 JWT auth, Pusher real-time |

---

## License

[MIT](LICENSE)
