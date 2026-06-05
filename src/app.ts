/**
 * Go³D multiplayer entry point (WordPress embed).
 *
 * This is the bundle the `[go3d]` shortcode loads. It boots the auth/lobby
 * flow and, when a game is opened, mounts the Three.js renderer and wires it to
 * the server-authoritative MultiplayerController.
 *
 * The session shells, controller factory, and hot-seat state builder live in
 * game-session.ts (shared with the standalone GitHub Pages entry). This file is
 * only the online bootstrap: auth → lobby → game/local screen routing.
 */

import { AuthState } from './auth';
import { Lobby, showToast, Screen } from './lobby';
import { Games } from './api';
import { LocalController, LocalGameConfig } from './local-controller';
import {
  GameSession,
  SphereGameSession,
  buildLocalState,
  ControllerFactory,
} from './game-session';

// ── App bootstrap ───────────────────────────────────────────────────────────

class App {
  private lobby: Lobby;
  private session: GameSession | SphereGameSession | null = null;

  constructor() {
    this.lobby = new Lobby((screen, data) => this.onScreenChange(screen, data));
  }

  async boot(): Promise<void> {
    const user = await AuthState.init();
    if (user) await this.lobby.showLobby();
    else this.lobby.showAuth();
  }

  private onScreenChange(screen: Screen, data?: unknown): void {
    // Stop background polling when leaving the lobby.
    if (screen !== 'lobby') this.lobby.cleanup();

    // Entering a game (server or local) keeps no prior session; any other screen
    // change tears one down.
    if (screen !== 'game' && screen !== 'local' && this.session) {
      this.session.dispose();
      this.session = null;
    }
    if (screen === 'game')  void this.enterGame(Number(data));
    if (screen === 'local') this.enterLocalGame(data as LocalGameConfig);
  }

  /**
   * Start a two-players-one-computer (hot-seat) game. No server round-trip: we
   * synthesise a GameState (Black = player 1, White = player 2) and drive the
   * existing session shell with a LocalController instead of the multiplayer one.
   */
  private enterLocalGame(config: LocalGameConfig): void {
    this.enterLocalState(buildLocalState(config));
  }

  private enterLocalState(state: ReturnType<typeof buildLocalState>): void {
    document.querySelectorAll<HTMLElement>('.go3d-screen').forEach(el => {
      el.style.display = el.id === 'go3d-game-screen' ? '' : 'none';
    });

    if (this.session) { this.session.dispose(); this.session = null; }

    try {
      const onExit = () => { this.session = null; void this.lobby.showLobby(); };
      const makeLocal: ControllerFactory = (s, c) => new LocalController(s, c);
      const onReload = (next?: typeof state) => { if (next) this.enterLocalState(next); };
      this.session = state.mode === 'sphere'
        ? new SphereGameSession(state, onExit, makeLocal, onReload)
        : new GameSession(state, onExit, makeLocal, onReload);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not start local game.', 'error');
      void this.lobby.showLobby();
    }
  }

  private async enterGame(gameId: number, preloaded?: Awaited<ReturnType<typeof Games.get>>): Promise<void> {
    // Switch to the game screen immediately so the canvas has somewhere to live.
    document.querySelectorAll<HTMLElement>('.go3d-screen').forEach(el => {
      el.style.display = el.id === 'go3d-game-screen' ? '' : 'none';
    });
    if (this.session) { this.session.dispose(); this.session = null; }
    try {
      const state = preloaded ?? await Games.get(gameId);
      const onExit = () => { this.session = null; void this.lobby.showLobby(); };
      const onReload = (next?: typeof state) => { void this.enterGame(gameId, next); };
      this.session = state.mode === 'sphere'
        ? new SphereGameSession(state, onExit, undefined, onReload)
        : new GameSession(state, onExit, undefined, onReload);
    } catch {
      showToast('Could not load that game.', 'error');
      void this.lobby.showLobby();
    }
  }
}

// ── Go ──────────────────────────────────────────────────────────────────────

function start(): void {
  // Only boot if the embed shell is present on the page.
  if (!document.getElementById('go3d-root')) return;
  void new App().boot();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
