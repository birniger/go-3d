/**
 * Go³D multiplayer entry point (WordPress embed).
 *
 * This is the bundle the `[go3d]` shortcode loads. It boots the auth/lobby
 * flow and, when a game is opened, mounts the Three.js renderer and wires it to
 * the server-authoritative MultiplayerController.
 *
 * NOTE: this is a SEPARATE entry from main.ts. main.ts is the standalone,
 * single-device hot-seat game (index.html / GitHub Pages). They share the
 * Go3D engine and Renderer but have completely different UI shells.
 */

import { AuthState } from './auth';
import { Lobby, showToast, Screen } from './lobby';
import { Games, Users, GameState, MovePayload, GameOverPayload } from './api';
import { Go3D } from './game';
import { Renderer } from './renderer';
import {
  MultiplayerController,
  MultiplayerCallbacks,
  MultiplayerClockDisplay,
} from './multiplayer';

// ── Active game session ─────────────────────────────────────────────────────

/**
 * Holds everything tied to one open game. Created on enterGame(), torn down on
 * leaveGame(). Keeping it in one object makes cleanup foolproof.
 */
class GameSession {
  private game: Go3D;
  private renderer: Renderer;
  private controller: MultiplayerController;
  private clockDisplay: MultiplayerClockDisplay;

  /** Highest move_number already applied to the local board (dedupe guard). */
  private appliedMoves = 0;
  /** Whose turn it is now (1 = Black/player1, 2 = White/player2). */
  private currentTurn: 1 | 2;
  private finished = false;

  /** Stack mode: the active (vertical y) build layer, or null in other modes. */
  private activeLayer: number | null = null;

  constructor(private state: GameState, private onExit: () => void) {
    this.game = new Go3D(state.board_size);

    // Replay the move history so the local board, capture counts and
    // currentPlayer all match the server. Moves are stored in order and
    // player1 is always Black, so the engine's internal alternation is correct.
    for (const m of state.moves) {
      if (m.type === 'place' && m.x !== undefined) this.game.place(m.x, m.y!, m.z!);
      else if (m.type === 'pass') this.game.pass();
    }
    this.appliedMoves = state.moves.length;
    this.currentTurn  = state.current_player as 1 | 2;
    if (state.mode === 'stack') this.activeLayer = state.active_layer ?? 0;

    // Mount the renderer. doLocalPlace is the click handler the renderer calls
    // with board coordinates.
    this.renderer = new Renderer(this.game, (x, y, z) => void this.doLocalPlace(x, y, z));
    if (this.activeLayer !== null) this.renderer.setStackLayer(this.activeLayer);
    this.renderer.updateStones();

    this.clockDisplay = new MultiplayerClockDisplay();
    this.clockDisplay.init(state.time_control, this.currentTurn, state.p1_time_ms, state.p2_time_ms);

    const callbacks: MultiplayerCallbacks = {
      onMove:         p  => this.applyMove(p),
      onGameOver:     p  => this.handleGameOver(p),
      onPlayerJoined: () => { showToast('Your opponent has joined!', 'success'); this.refreshTurnUI(); },
      onError:        m  => showToast(m, 'error'),
      onClockTick:    (p1, p2) => this.clockDisplay.update(this.currentTurn, p1, p2),
      onLayerChange:  l  => {
        this.activeLayer = l;
        this.renderer.setStackLayer(l);
        showToast(`Layer complete — building up to layer ${l + 1}.`, 'info');
      },
    };
    this.controller = new MultiplayerController(state, callbacks);
    this.controller.connect();

    this.bindButtons();
    this.fillPlayerBar();
    this.refreshTurnUI();
  }

  // ── Local actions ─────────────────────────────────────────────────────────

  private get mySlot(): 1 | 2 { return this.controller.mySlot; }

  private async doLocalPlace(x: number, y: number, z: number): Promise<void> {
    if (this.finished) return;
    if (this.state.status !== 'active') { showToast('Waiting for an opponent to join.', 'info'); return; }
    if (this.currentTurn !== this.mySlot) { this.renderer.forbiddenFlash(x, y, z); return; }

    try {
      const payload = await this.controller.submitPlace(x, y, z);
      if (payload) this.applyMove(payload);
    } catch {
      // submitPlace already surfaced the error via onError; flash the cell.
      this.renderer.forbiddenFlash(x, y, z);
    }
  }

  private async doPass(): Promise<void> {
    if (this.finished || this.currentTurn !== this.mySlot) return;
    try {
      const payload = await this.controller.submitPass();
      if (payload) this.applyMove(payload);
    } catch { /* surfaced via onError */ }
  }

  private async doResign(): Promise<void> {
    if (this.finished) return;
    if (!confirm('Resign this game?')) return;
    try { await this.controller.submitResign(); } catch { /* surfaced via onError */ }
  }

  // ── Applying moves (single source of truth) ─────────────────────────────────

  /**
   * Apply a move to the local board. Called both for our own moves (from the
   * submit response) and the opponent's (via Pusher / polling). De-duplicated
   * by move_number so an echoed event is a no-op.
   */
  private applyMove(p: MovePayload): void {
    if (p.move_number <= this.appliedMoves) return;
    this.appliedMoves = p.move_number;

    if (p.type === 'place' && p.x !== undefined) {
      const placed = this.game.place(p.x, p.y!, p.z!);
      if (placed) {
        this.renderer.playPlaceSound();
        if (this.game.lastCaptured.length > 0) {
          const capturedBy = (3 - this.game.currentPlayer) as 1 | 2; // mover's colour
          this.renderer.triggerCaptures(this.game.lastCaptured, capturedBy);
          this.renderer.playCaptureSound(this.game.lastCaptured.length);
        }
        this.renderer.updateStones();
      }
    } else if (p.type === 'pass') {
      this.game.pass();
      this.renderer.playPassSound();
      showToast(p.player_slot === this.mySlot ? 'You passed.' : 'Opponent passed.', 'info');
    } else if (p.type === 'layer-advance') {
      // Stack mode: the second consecutive pass both passed and advanced the
      // build to the next layer. Apply the pass to keep engine turn in sync,
      // then move the active layer up.
      this.game.pass();
      this.renderer.playPassSound();
      if (p.active_layer !== undefined) {
        this.activeLayer = p.active_layer;
        this.renderer.setStackLayer(p.active_layer);
      }
      showToast(`Layer complete — building up to layer ${(p.active_layer ?? 0) + 1}.`, 'info');
    }

    this.currentTurn = p.next_player as 1 | 2;
    if (p.p1_time_ms !== undefined || p.p2_time_ms !== undefined) {
      this.clockDisplay.update(this.currentTurn, p.p1_time_ms ?? null, p.p2_time_ms ?? null);
    }
    this.refreshTurnUI();
  }

  private handleGameOver(p: GameOverPayload): void {
    this.finished = true;
    const myId = AuthState.user?.id ?? -1;
    let msg: string;
    if (p.winner_id === null)      msg = 'Game over — draw.';
    else if (p.winner_id === myId) msg = 'You won! 🎉';
    else                           msg = 'You lost.';

    const reason = p.end_reason ? ` (${p.end_reason.replace(/_/g, ' ')})` : '';
    if (p.p1_score !== null && p.p2_score !== null) {
      msg += `  Score — Black ${p.p1_score} : White ${p.p2_score}.`;
    }
    showToast(msg + reason, p.winner_id === myId ? 'success' : 'info');

    const ind = document.getElementById('go3d-turn-indicator');
    if (ind) ind.textContent = 'Game over';
    const overlay = document.getElementById('go3d-waiting-overlay');
    if (overlay) overlay.style.display = 'none';

    // Show territory so players can see the final position.
    const terr = this.game.countTerritory();
    this.renderer.showTerritory(terr.map);
  }

  // ── UI ──────────────────────────────────────────────────────────────────────

  private refreshTurnUI(): void {
    if (this.finished) return;
    const myTurn  = this.currentTurn === this.mySlot;
    const waiting = this.state.status !== 'active';

    const ind = document.getElementById('go3d-turn-indicator');
    if (ind) ind.textContent = waiting ? 'Waiting for opponent…' : (myTurn ? 'Your move' : "Opponent's move");

    const overlay = document.getElementById('go3d-waiting-overlay');
    if (overlay) overlay.style.display = (!waiting && !myTurn) ? '' : (waiting ? '' : 'none');

    const pass   = document.getElementById('go3d-pass-btn')   as HTMLButtonElement | null;
    const resign = document.getElementById('go3d-resign-btn') as HTMLButtonElement | null;
    if (pass)   pass.disabled   = !myTurn || waiting;
    if (resign) resign.disabled = waiting;
  }

  private bindButtons(): void {
    document.getElementById('go3d-pass-btn')!.onclick   = () => void this.doPass();
    document.getElementById('go3d-resign-btn')!.onclick = () => void this.doResign();
    document.getElementById('go3d-back-to-lobby-game')!.onclick = () => this.exit();
  }

  /** Fill the top player bar with usernames + ELO (best-effort, non-blocking). */
  private fillPlayerBar(): void {
    const set = (slot: 1 | 2, name: string, elo?: number) => {
      const n = document.getElementById(`go3d-p${slot}-name`);
      const e = document.getElementById(`go3d-p${slot}-elo`);
      if (n) n.textContent = name;
      if (e) e.textContent = elo !== undefined ? String(elo) : '';
    };
    set(1, `Player ${this.state.player1_id}`);
    set(2, this.state.player2_id ? `Player ${this.state.player2_id}` : '(waiting)');

    void Users.getProfile(this.state.player1_id)
      .then(r => set(1, r.user.username, r.user.elo)).catch(() => {});
    if (this.state.player2_id) {
      void Users.getProfile(this.state.player2_id)
        .then(r => set(2, r.user.username, r.user.elo)).catch(() => {});
    }
  }

  private exit(): void {
    this.dispose();
    this.onExit();
  }

  dispose(): void {
    this.controller.disconnect();
    this.renderer.dispose();
  }
}

// ── App bootstrap ───────────────────────────────────────────────────────────

class App {
  private lobby: Lobby;
  private session: GameSession | null = null;

  constructor() {
    this.lobby = new Lobby((screen, data) => this.onScreenChange(screen, data));
  }

  async boot(): Promise<void> {
    const user = await AuthState.init();
    if (user) await this.lobby.showLobby();
    else this.lobby.showAuth();
  }

  private onScreenChange(screen: Screen, data?: unknown): void {
    // Any screen change other than entering a game tears down a live session.
    if (screen !== 'game' && this.session) {
      this.session.dispose();
      this.session = null;
    }
    if (screen === 'game') void this.enterGame(Number(data));
  }

  private async enterGame(gameId: number): Promise<void> {
    // Switch to the game screen immediately so the canvas has somewhere to live.
    document.querySelectorAll<HTMLElement>('.go3d-screen').forEach(el => {
      el.style.display = el.id === 'go3d-game-screen' ? '' : 'none';
    });
    try {
      const state = await Games.get(gameId);
      this.session = new GameSession(state, () => {
        this.session = null;
        void this.lobby.showLobby();
      });
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
