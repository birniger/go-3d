/**
 * Multiplayer game controller.
 *
 * Wraps the local Game instance with:
 *  – Server-authoritative move submission
 *  – Pusher real-time sync for the opponent's moves
 *  – Clock management
 *  – Game-over handling
 *
 * The controller fires typed callbacks so the UI layer (main.ts) doesn't need
 * to know about Pusher or the API directly.
 */

import { Games, GameState, MovePayload, GameOverPayload, ApiError, Config } from './api';
import { AuthState } from './auth';

// Pusher is loaded via a CDN <script> tag injected by the shortcode.
// Declare the global shape we need.
declare const Pusher: {
  new (key: string, options: { cluster: string; authEndpoint: string; auth?: { headers?: Record<string, string> } }): PusherInstance;
};
interface PusherInstance {
  subscribe(channel: string): PusherChannel;
  disconnect(): void;
}
interface PusherChannel {
  bind(event: string, callback: (data: unknown) => void): void;
  unbind_all(): void;
}

// ── Callbacks ─────────────────────────────────────────────────────────────────

export interface MultiplayerCallbacks {
  onMove:      (payload: MovePayload) => void;
  onGameOver:  (payload: GameOverPayload) => void;
  onPlayerJoined: (player2_id: number) => void;
  onError:     (msg: string) => void;
  onClockTick: (p1Ms: number | null, p2Ms: number | null) => void;
  /** Stack mode: fired by the polling fallback when the active layer advances. */
  onLayerChange?: (layer: number) => void;
}

// ── Controller ────────────────────────────────────────────────────────────────

export class MultiplayerController {
  readonly gameState: GameState;
  readonly mySlot: 1 | 2;

  /** Which player's turn it currently is (1 or 2). Updated on every move. */
  currentPlayer: 1 | 2;

  private pusher:   PusherInstance | null = null;
  private channel:  PusherChannel  | null = null;
  private clockInterval: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = Date.now();

  private p1Ms: number | null;
  private p2Ms: number | null;

  /** Stack mode: last known active layer (used to detect advances when polling). */
  private activeLayer: number;

  constructor(gameState: GameState, private callbacks: MultiplayerCallbacks) {
    this.gameState    = gameState;
    const uid         = AuthState.user!.id;
    this.mySlot       = gameState.player1_id === uid ? 1 : 2;
    this.currentPlayer = gameState.current_player as 1 | 2;
    this.p1Ms         = gameState.p1_time_ms;
    this.p2Ms         = gameState.p2_time_ms;
    this.activeLayer  = gameState.active_layer ?? 0;
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  connect(): void {
    const key = Config.pusherKey;
    if (!key || typeof Pusher === 'undefined') {
      console.warn('Go3D: Pusher unavailable (no key or script not loaded) — using polling fallback.');
      this.startPolling();
      return;
    }

    const token = localStorage.getItem('go3d_token') ?? '';
    this.pusher = new Pusher(key, {
      cluster:      Config.pusherCluster,
      authEndpoint: Config.authEndpoint,
      auth: { headers: { Authorization: `Bearer ${token}` } },
    });

    this.channel = this.pusher.subscribe(`private-game-${this.gameState.id}`);
    this.channel.bind('move',          (d: unknown) => this.handleMove(d as MovePayload));
    this.channel.bind('game-over',     (d: unknown) => this.handleGameOver(d as GameOverPayload));
    this.channel.bind('player-joined', (d: unknown) => {
      const payload = d as { player2_id: number };
      this.callbacks.onPlayerJoined(payload.player2_id);
    });

    if (this.gameState.time_control !== 'none') this.startClock();
  }

  disconnect(): void {
    this.stopClock();
    if (this.channel)  { this.channel.unbind_all(); this.channel = null; }
    if (this.pusher)   { this.pusher.disconnect();  this.pusher  = null; }
    this.stopPolling();
  }

  // ── Move submission ───────────────────────────────────────────────────────

  async submitPlace(x: number, y: number, z: number): Promise<MovePayload | null> {
    const elapsed = this.gameState.time_control !== 'none' ? Date.now() - this.lastTickAt : undefined;
    try {
      const res = await Games.move(this.gameState.id, { type: 'place', x, y, z, time_ms: elapsed });
      // The server's response is authoritative; Pusher delivers the move to the
      // opponent. We update our own clock locally and return the payload so the
      // caller can apply our own move immediately (some Pusher setups don't
      // echo events back to the originating socket).
      this.advanceClock(this.mySlot, elapsed ?? 0);
      return res.event === 'move' ? (res.payload as MovePayload) : null;
    } catch (e) {
      this.callbacks.onError(e instanceof ApiError ? e.message : 'Move failed.');
      throw e;
    }
  }

  async submitPass(): Promise<MovePayload | null> {
    const elapsed = this.gameState.time_control !== 'none' ? Date.now() - this.lastTickAt : undefined;
    try {
      const res = await Games.move(this.gameState.id, { type: 'pass', time_ms: elapsed });
      this.advanceClock(this.mySlot, elapsed ?? 0);
      return res.event === 'move' ? (res.payload as MovePayload) : null;
    } catch (e) {
      this.callbacks.onError(e instanceof ApiError ? e.message : 'Pass failed.');
      throw e;
    }
  }

  async submitResign(): Promise<void> {
    try {
      await Games.move(this.gameState.id, { type: 'resign' });
    } catch (e) {
      this.callbacks.onError(e instanceof ApiError ? e.message : 'Resign failed.');
      throw e;
    }
  }

  // ── Pusher event handlers ─────────────────────────────────────────────────

  private handleMove(payload: MovePayload): void {
    // Advance whose turn it is
    this.currentPlayer = payload.next_player as 1 | 2;
    // Sync clocks with server-authoritative values
    if (payload.p1_time_ms !== undefined) this.p1Ms = payload.p1_time_ms;
    if (payload.p2_time_ms !== undefined) this.p2Ms = payload.p2_time_ms;
    this.lastTickAt = Date.now();
    this.callbacks.onMove(payload);
    this.callbacks.onClockTick(this.p1Ms, this.p2Ms);
  }

  private handleGameOver(payload: GameOverPayload): void {
    this.stopClock();
    this.callbacks.onGameOver(payload);
  }

  // ── Clock ─────────────────────────────────────────────────────────────────

  private startClock(): void {
    this.lastTickAt = Date.now();
    this.clockInterval = setInterval(() => {
      const now     = Date.now();
      const elapsed = now - this.lastTickAt;

      // currentPlayer is kept in sync by handleMove — always correct
      if (this.currentPlayer === 1 && this.p1Ms !== null) this.p1Ms = Math.max(0, this.p1Ms - elapsed);
      if (this.currentPlayer === 2 && this.p2Ms !== null) this.p2Ms = Math.max(0, this.p2Ms - elapsed);
      this.lastTickAt = now;

      this.callbacks.onClockTick(this.p1Ms, this.p2Ms);
    }, 250);
  }

  private stopClock(): void {
    if (this.clockInterval !== null) {
      clearInterval(this.clockInterval);
      this.clockInterval = null;
    }
  }

  private advanceClock(slot: 1 | 2, elapsedMs: number): void {
    if (slot === 1 && this.p1Ms !== null) this.p1Ms = Math.max(0, this.p1Ms - elapsedMs);
    if (slot === 2 && this.p2Ms !== null) this.p2Ms = Math.max(0, this.p2Ms - elapsedMs);
    this.lastTickAt = Date.now();
  }

  // ── Polling fallback (when Pusher is unconfigured) ─────────────────────────

  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pollMoveNumber = 0;

  private startPolling(): void {
    this.pollMoveNumber = this.gameState.moves.length;
    this.pollInterval = setInterval(() => void this.poll(), 3000);
    if (this.gameState.time_control !== 'none') this.startClock();
  }

  private stopPolling(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const state = await Games.get(this.gameState.id);
      const newMoves = state.moves.slice(this.pollMoveNumber);
      for (const m of newMoves) {
        if (m.type === 'place' || m.type === 'pass') {
          const playerSlot = state.player1_id === m.player_id ? 1 : 2;
          const syntheticPayload: MovePayload = {
            type:        m.type,
            move_number: m.move_number,
            player_slot: playerSlot,
            next_player: 3 - playerSlot,
            x: m.x, y: m.y, z: m.z,
            captured: [],
            p1_time_ms: state.p1_time_ms,
            p2_time_ms: state.p2_time_ms,
          };
          this.handleMove(syntheticPayload);
        }
      }
      this.pollMoveNumber = state.moves.length;

      // Stack mode: the advancing pass is stored as a plain 'pass', so detect
      // an active-layer change here and notify the UI to move the build surface.
      if (state.active_layer !== undefined && state.active_layer !== this.activeLayer) {
        this.activeLayer = state.active_layer;
        this.callbacks.onLayerChange?.(state.active_layer);
      }

      if (state.status === 'finished') {
        this.stopPolling();
        const payload: GameOverPayload = {
          status:        state.status,
          end_reason:    state.end_reason ?? 'unknown',
          winner_id:     state.winner_id,
          p1_score:      state.p1_score,
          p2_score:      state.p2_score,
          elo_change_p1: state.elo_change_p1,
          elo_change_p2: state.elo_change_p2,
        };
        this.handleGameOver(payload);
      }
    } catch {
      // Ignore transient poll errors
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format milliseconds as mm:ss or h:mm:ss */
export function formatClock(ms: number | null): string {
  if (ms === null) return '∞';
  const s   = Math.max(0, Math.floor(ms / 1000));
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/**
 * Drives the in-game clock display in embed.php.
 *
 * How it works end-to-end:
 *
 *  1. When a game is loaded, the server sends the current p1_time_ms / p2_time_ms
 *     (how many milliseconds each player has left on their main clock).
 *
 *  2. MultiplayerController starts a 250 ms setInterval that subtracts real
 *     elapsed time from whichever player is currently to move.
 *     → fires onClockTick(p1Ms, p2Ms) every 250 ms
 *
 *  3. When a move comes in via Pusher, the server sends back its authoritative
 *     clock values — those overwrite the locally-counted ones, correcting any
 *     drift. The interval keeps running for the next player.
 *
 *  4. MultiplayerClockDisplay.update() converts milliseconds → mm:ss and writes
 *     them to #go3d-p1-clock and #go3d-p2-clock. When ≤ 30 s remain, the
 *     element gets a CSS class "go3d-clock-urgent" (turns red).
 *
 *  5. The active player's clock element gets "go3d-clock-active" so you can
 *     visually highlight whose clock is running.
 *
 *  No time runs in a correspondence game (time_control = 'none') — both clocks
 *  simply show "∞" and the display is hidden.
 */
export class MultiplayerClockDisplay {
  private el1: HTMLElement | null;
  private el2: HTMLElement | null;
  private bar: HTMLElement | null;

  constructor() {
    this.el1 = document.getElementById('go3d-p1-clock');
    this.el2 = document.getElementById('go3d-p2-clock');
    this.bar = document.getElementById('go3d-clock-bar');
  }

  /** Call once when the game loads. Hides the bar for correspondence games. */
  init(timeControl: string, currentPlayer: 1 | 2, p1Ms: number | null, p2Ms: number | null): void {
    if (!this.bar) return;
    if (timeControl === 'none') {
      this.bar.style.display = 'none';
      return;
    }
    this.bar.style.display = '';
    this.update(currentPlayer, p1Ms, p2Ms);
  }

  /** Called on every onClockTick from MultiplayerController. */
  update(currentPlayer: 1 | 2, p1Ms: number | null, p2Ms: number | null): void {
    this._render(this.el1, p1Ms, currentPlayer === 1);
    this._render(this.el2, p2Ms, currentPlayer === 2);
  }

  private _render(el: HTMLElement | null, ms: number | null, active: boolean): void {
    if (!el) return;
    el.textContent = formatClock(ms);
    el.classList.toggle('go3d-clock-active',  active);
    el.classList.toggle('go3d-clock-urgent',  ms !== null && ms <= 30_000);
    el.classList.toggle('go3d-clock-flagged', ms !== null && ms <= 0);
  }
}
