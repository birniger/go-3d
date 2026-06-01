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
}

// ── Controller ────────────────────────────────────────────────────────────────

export class MultiplayerController {
  readonly gameState: GameState;
  readonly mySlot: 1 | 2;

  private pusher:   PusherInstance | null = null;
  private channel:  PusherChannel  | null = null;
  private clockInterval: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = Date.now();

  private p1Ms: number | null;
  private p2Ms: number | null;

  constructor(gameState: GameState, private callbacks: MultiplayerCallbacks) {
    this.gameState = gameState;
    const uid = AuthState.user!.id;
    this.mySlot = gameState.player1_id === uid ? 1 : 2;
    this.p1Ms = gameState.p1_time_ms;
    this.p2Ms = gameState.p2_time_ms;
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  connect(): void {
    const key = Config.pusherKey;
    if (!key) {
      console.warn('Go3D: Pusher key not configured — real-time disabled, using polling fallback.');
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

  async submitPlace(x: number, y: number, z: number): Promise<void> {
    const elapsed = this.gameState.time_control !== 'none' ? Date.now() - this.lastTickAt : undefined;
    try {
      await Games.move(this.gameState.id, { type: 'place', x, y, z, time_ms: elapsed });
      // The server's response is authoritative; Pusher will deliver the move
      // to the opponent. We update our own clock locally.
      this.advanceClock(this.mySlot, elapsed ?? 0);
    } catch (e) {
      this.callbacks.onError(e instanceof ApiError ? e.message : 'Move failed.');
      throw e;
    }
  }

  async submitPass(): Promise<void> {
    const elapsed = this.gameState.time_control !== 'none' ? Date.now() - this.lastTickAt : undefined;
    try {
      await Games.move(this.gameState.id, { type: 'pass', time_ms: elapsed });
      this.advanceClock(this.mySlot, elapsed ?? 0);
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
      const current = this.gameState.current_player;  // NOTE: stale after moves; caller updates

      if (current === 1 && this.p1Ms !== null) this.p1Ms = Math.max(0, this.p1Ms - elapsed);
      if (current === 2 && this.p2Ms !== null) this.p2Ms = Math.max(0, this.p2Ms - elapsed);
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
