/**
 * Local (hot-seat) game controller.
 *
 * Implements the same surface as MultiplayerController (see GameController) so
 * the existing GameSession / SphereGameSession render+UI shells can drive a
 * two-players-one-computer game with no server. All Go rules, scoring and clocks
 * run client-side:
 *   – cube / stack: the Go3D lattice engine (capture / suicide / superko).
 *   – sphere:       the GraphGo engine over a locally-built geodesic adjacency.
 *
 * It mirrors the server's move/pass/scoring semantics (class-game.php): two
 * passes score the game (or, in stack mode, advance the build layer until the
 * top layer is reached), resignation ends immediately, and a flagged clock is a
 * loss on time.
 */

import { GameState, MovePayload, GameOverPayload, MoveRecord } from './api';
import { MultiplayerCallbacks } from './multiplayer';
import { Go3D } from './game';
import { GraphGo } from './graph-go';
import { GameClock, ClockConfig, ClockMode } from './clock';

/** The shared controller surface consumed by GameSession / SphereGameSession. */
export interface GameController {
  readonly mySlot: 1 | 2;
  readonly isLocal: boolean;
  connect(): void;
  disconnect(): void;
  submitPlace(x: number, y?: number, z?: number): Promise<MovePayload | null>;
  submitPass(): Promise<MovePayload | null>;
  submitResign(): Promise<void>;
}

/** Settings for a new local game (gathered from the lobby new-game form). */
export interface LocalGameConfig {
  mode:          'cube' | 'stack' | 'sphere';
  board_size:    number;
  scoring_mode:  'chinese' | 'japanese';
  komi:          number;
  time_control:  string;
  time_settings: Record<string, number> | null;
  p1_name?:      string;
  p2_name?:      string;
}

// ── ClockConfig mapping ───────────────────────────────────────────────────────

/**
 * Map a saved game's time control to a GameClock config.
 *  – absolute → fischer with 0 increment (main time that just counts down).
 *  – fischer  → fischer with the configured increment.
 *  – byoyomi  → byoyomi (main time, then reserve periods).
 *  – none     → off.
 */
function clockConfigFor(timeControl: string, ts: Record<string, number> | null): ClockConfig {
  const main = (ts?.main_time_s ?? 0);
  let mode: ClockMode = 'none';
  let increment = 0;
  let byoTime = 0;
  let byoPeriods = 0;
  if (timeControl === 'absolute')      { mode = 'fischer'; increment = 0; }
  else if (timeControl === 'fischer')  { mode = 'fischer'; increment = ts?.fischer_increment_s ?? 0; }
  else if (timeControl === 'byoyomi')  { mode = 'byoyomi'; byoTime = ts?.byoyomi_time_s ?? 0; byoPeriods = ts?.byoyomi_periods ?? 0; }
  return { mode, mainTime: main, increment, byoTime, byoPeriods, simpleTime: 0 };
}

// ── Controller ────────────────────────────────────────────────────────────────

export class LocalController implements GameController {
  readonly isLocal = true;

  private mode: 'cube' | 'stack' | 'sphere';
  private size: number;
  private komi: number;
  private scoring: 'chinese' | 'japanese';
  private timed: boolean;

  private currentPlayer: 1 | 2;
  private moveNumber: number;
  private consecutivePasses = 0;
  private activeLayer = 0;
  private finished = false;

  // Engines (one is used depending on mode).
  private cube?: Go3D;
  private graph?: GraphGo;
  private board: number[] = [];          // sphere flat board
  private historyHashes: string[] = [];  // sphere superko
  private p1Caps = 0;                     // sphere prisoner tally (japanese)
  private p2Caps = 0;

  private clock: GameClock | null = null;

  constructor(private state: GameState, private callbacks: MultiplayerCallbacks) {
    this.mode    = (state.mode ?? 'cube') as 'cube' | 'stack' | 'sphere';
    this.size    = state.board_size;
    this.komi    = state.komi;
    this.scoring = (state.scoring_mode === 'japanese' ? 'japanese' : 'chinese');
    this.currentPlayer = state.current_player as 1 | 2;
    this.moveNumber = state.moves.length;
    this.timed = state.time_control !== 'none';

    if (this.mode === 'sphere') {
      if (!state.geometry) throw new Error('Local sphere game has no geometry.');
      const adjacency = this.adjacencyFromEdges(state.geometry.count, state.geometry.edges);
      this.graph = new GraphGo(adjacency);
      this.board = this.graph.getBoard();
      this.historyHashes = [this.graph.hash()];
    } else {
      this.cube = new Go3D(this.size);
    }

    if (this.timed) {
      const ts = (state.time_settings ?? null) as Record<string, number> | null;
      this.clock = new GameClock(clockConfigFor(state.time_control, ts));
      this.clock.onTick = (p1, p2) =>
        this.callbacks.onClockTick(Math.round(p1.timeLeft * 1000), Math.round(p2.timeLeft * 1000));
      this.clock.onFlag = (player) => this.timeoutLoss(player);
    }
  }

  get mySlot(): 1 | 2 { return this.currentPlayer; }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  connect(): void {
    if (this.clock) this.clock.startTurn(this.currentPlayer);
  }

  disconnect(): void {
    if (this.clock) this.clock.destroy();
  }

  // ── Move submission ───────────────────────────────────────────────────────

  async submitPlace(x: number, y?: number, z?: number): Promise<MovePayload | null> {
    if (this.finished) throw new Error('Game finished.');

    if (this.mode === 'sphere') {
      const node = x;
      const r = this.graph!.place(node, this.currentPlayer, this.historyHashes);
      if (!r.ok) { this.callbacks.onError(this.reasonMessage(r.reason)); throw new Error(r.reason); }
      this.historyHashes.push(r.hash);
      this.board = r.board;
      if (this.currentPlayer === 1) this.p1Caps += r.captured.length;
      else                          this.p2Caps += r.captured.length;

      const mover = this.currentPlayer;
      this.recordMove('place', mover, node);
      this.consecutivePasses = 0;
      const next = this.advanceTurn();
      return this.movePayload('place', mover, next, { x: node, captured: r.captured, board: this.board.slice() });
    }

    // cube / stack
    if (this.mode === 'stack' && y !== this.activeLayer) {
      this.callbacks.onError('In stack mode you can only play on the active layer.');
      throw new Error('wrong_layer');
    }

    const ok = this.cube!.place(x, y!, z!);
    if (!ok) { this.callbacks.onError('Illegal move.'); throw new Error('illegal'); }

    const mover = this.currentPlayer;
    this.recordMove('place', mover, x, y, z);
    this.consecutivePasses = 0;
    const next = this.advanceTurn();
    return this.movePayload('place', mover, next, { x, y, z });
  }

  async submitPass(): Promise<MovePayload | null> {
    if (this.finished) throw new Error('Game finished.');

    const mover = this.currentPlayer;
    if (this.mode !== 'sphere') this.cube!.pass();
    this.recordMove('pass', mover);
    this.consecutivePasses++;

    if (this.consecutivePasses >= 2) {
      // Stack mode: two passes advance the build to the next layer until the top
      // layer is reached, where the whole cube is scored.
      if (this.mode === 'stack' && this.activeLayer < this.size - 1) {
        this.activeLayer++;
        this.consecutivePasses = 0;
        const next = this.advanceTurn();
        return this.movePayload('layer-advance', mover, next, { active_layer: this.activeLayer });
      }
      // Otherwise: score and end.
      this.stopClockForMover();
      this.scoreAndEnd();
      return null;
    }

    const next = this.advanceTurn();
    return this.movePayload('pass', mover, next, {});
  }

  async submitResign(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.stopClockForMover();
    const winner = (3 - this.currentPlayer) as 1 | 2;
    this.callbacks.onGameOver(this.gameOver(winner, 'resign', null, null));
  }

  // ── Turn / clock plumbing ────────────────────────────────────────────────────

  /** Stop the mover's clock (applying fischer increment) and start the next. */
  private advanceTurn(): 1 | 2 {
    this.stopClockForMover();
    const next = (3 - this.currentPlayer) as 1 | 2;
    this.currentPlayer = next;
    if (this.clock && !this.finished) this.clock.startTurn(next);
    return next;
  }

  private stopClockForMover(): void {
    if (this.clock) this.clock.confirmMove();
  }

  private timeoutLoss(loser: 1 | 2): void {
    if (this.finished) return;
    this.finished = true;
    const winner = (3 - loser) as 1 | 2;
    this.callbacks.onGameOver(this.gameOver(winner, 'timeout', null, null));
  }

  // ── Scoring ───────────────────────────────────────────────────────────────

  private scoreAndEnd(): void {
    if (this.finished) return;
    this.finished = true;

    let p1 = 0, p2 = 0;
    if (this.mode === 'sphere') {
      const t = this.graph!.countTerritory();
      if (this.scoring === 'japanese') {
        p1 = t.black + this.p1Caps;
        p2 = t.white + this.p2Caps + this.komi;
      } else {
        p1 = t.black + t.blackStones;
        p2 = t.white + t.whiteStones + this.komi;
      }
    } else {
      const t = this.cube!.countTerritory();
      if (this.scoring === 'japanese') {
        p1 = t.black + this.cube!.captured[0];
        p2 = t.white + this.cube!.captured[1] + this.komi;
      } else {
        p1 = t.black + t.blackStones;
        p2 = t.white + t.whiteStones + this.komi;
      }
    }

    let winner: 1 | 2 | null;
    let reason: string;
    if (Math.abs(p1 - p2) < 0.001) { winner = null; reason = 'score_draw'; }
    else if (p1 > p2)              { winner = 1;    reason = 'score'; }
    else                          { winner = 2;    reason = 'score'; }

    this.callbacks.onGameOver(this.gameOver(winner, reason, p1, p2));
  }

  // ── Payload builders ────────────────────────────────────────────────────────

  private movePayload(
    type: string, mover: 1 | 2, next: 1 | 2,
    extra: Partial<MovePayload>,
  ): MovePayload {
    const t = this.clockTimes();
    return {
      type,
      move_number: this.moveNumber,
      player_slot: mover,
      next_player: next,
      p1_time_ms: t.p1, p2_time_ms: t.p2,
      p1_periods: t.p1p, p2_periods: t.p2p,
      ...extra,
    };
  }

  private gameOver(winner: 1 | 2 | null, reason: string, p1: number | null, p2: number | null): GameOverPayload {
    if (this.clock) this.clock.pause();
    return {
      status: 'finished',
      end_reason: reason,
      winner_id: winner,            // local: slot number (1|2) or null, read by the session
      p1_score: p1, p2_score: p2,
      elo_change_p1: null, elo_change_p2: null,
    };
  }

  /** Current clock values as ms + byōyomi periods (nulls for untimed games). */
  private clockTimes(): { p1: number | null; p2: number | null; p1p: number | null; p2p: number | null } {
    if (!this.clock) return { p1: null, p2: null, p1p: null, p2p: null };
    const [a, b] = this.clock.getState();
    const isByo = this.state.time_control === 'byoyomi';
    return {
      p1: Math.round(a.timeLeft * 1000),
      p2: Math.round(b.timeLeft * 1000),
      p1p: isByo ? a.periods : null,
      p2p: isByo ? b.periods : null,
    };
  }

  // ── Bookkeeping ─────────────────────────────────────────────────────────────

  private recordMove(type: MoveRecord['type'], mover: 1 | 2, x?: number, y?: number, z?: number): void {
    this.moveNumber++;
    const rec: MoveRecord = {
      move_number: this.moveNumber,
      player_id:   mover,            // local: slot number doubles as the "player id"
      type,
      created_at:  new Date().toISOString(),
    };
    if (x !== undefined) rec.x = x;
    if (y !== undefined) rec.y = y;
    if (z !== undefined) rec.z = z;
    this.state.moves.push(rec);
  }

  private adjacencyFromEdges(count: number, edges: [number, number][]): number[][] {
    const adj: number[][] = Array.from({ length: count }, () => []);
    for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
    return adj;
  }

  private reasonMessage(reason: string): string {
    switch (reason) {
      case 'occupied':      return 'That point is taken.';
      case 'suicide':       return 'That move is suicide.';
      case 'superko':       return 'That repeats a previous position (superko).';
      case 'out_of_bounds': return 'Off the board.';
      default:              return 'Illegal move.';
    }
  }
}
