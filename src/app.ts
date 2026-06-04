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
import { SphereRenderer } from './sphere-renderer';
import {
  MultiplayerController,
  MultiplayerCallbacks,
  MultiplayerClockDisplay,
} from './multiplayer';

// ── Shared DOM helpers (used by both session types) ─────────────────────────

/** Show/hide an element by id (uses '' to restore the stylesheet default). */
function show(id: string, on: boolean): void {
  const el = document.getElementById(id);
  if (el) el.style.display = on ? '' : 'none';
}

/** Write the captured-stone counters into each player badge. */
function setCaptureCounts(p1: number, p2: number): void {
  const e1 = document.getElementById('go3d-p1-caps');
  const e2 = document.getElementById('go3d-p2-caps');
  if (e1) e1.textContent = p1 > 0 ? `+${p1}` : '';
  if (e2) e2.textContent = p2 > 0 ? `+${p2}` : '';
}

/** Glow the badge of whoever is to move (cleared once the game is finished). */
function setActiveGlow(turn: 1 | 2, finished: boolean): void {
  document.getElementById('go3d-p1-info')?.classList.toggle('go3d-badge-active', !finished && turn === 1);
  document.getElementById('go3d-p2-info')?.classList.toggle('go3d-badge-active', !finished && turn === 2);
}

/** Reset the shared view-control chrome so state never leaks between games. */
function resetViewControls(): void {
  show('go3d-view-controls', false);
  show('go3d-replay-bar', false);
  show('go3d-layer-banner', false);
  for (const id of ['go3d-slice-x', 'go3d-slice-y', 'go3d-slice-z', 'go3d-score-btn']) {
    document.getElementById(id)?.classList.remove('go3d-vc-on');
  }
  setCaptureCounts(0, 0);
  setActiveGlow(1, true);
}

/** Show the first-run help overlay once; remembered in localStorage. */
function maybeShowOnboarding(): void {
  try { if (localStorage.getItem('go3d_onboarded')) return; } catch { /* private mode */ }
  const ov = document.getElementById('go3d-onboarding');
  if (!ov) return;
  ov.style.display = 'flex';
  const dismiss = document.getElementById('go3d-onboarding-dismiss');
  if (dismiss) (dismiss as HTMLButtonElement).onclick = () => {
    ov.style.display = 'none';
    try { localStorage.setItem('go3d_onboarded', '1'); } catch { /* ignore */ }
  };
}

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

  // ── View-control state (slice / keyboard cursor / score / replay) ──────────
  private sliceMode: 'none' | 'x' | 'y' | 'z' = 'none';
  private sliceIndex = 0;
  private cursorMode = false;
  private scoreShowing = false;
  private replayActive = false;
  private replayStep = 0;
  private readonly keyHandler   = (e: KeyboardEvent) => this.onKeydown(e);
  private readonly mouseHandler = () => { if (this.cursorMode) this.deactivateCursor(); };

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
    this.clockDisplay.init(state.time_control, this.currentTurn, state.p1_time_ms, state.p2_time_ms,
                           state.p1_periods ?? null, state.p2_periods ?? null);

    const callbacks: MultiplayerCallbacks = {
      onMove:         p  => this.applyMove(p),
      onGameOver:     p  => this.handleGameOver(p),
      onPlayerJoined: () => { showToast('Your opponent has joined!', 'success'); this.refreshTurnUI(); },
      onError:        m  => showToast(m, 'error'),
      onClockTick:    (p1, p2) => this.clockDisplay.update(this.currentTurn, p1, p2),
      onLayerChange:  l  => {
        this.activeLayer = l;
        this.renderer.setStackLayer(l);
        this.updateLayerBanner();
        showToast(`Layer complete — building up to layer ${l + 1}.`, 'info');
      },
    };
    this.controller = new MultiplayerController(state, callbacks);
    this.controller.connect();

    this.bindButtons();
    this.setupViewControls();
    this.fillPlayerBar();
    this.refreshTurnUI();
    this.updateCaptureCounts();
    setActiveGlow(this.currentTurn, this.finished);
    if (this.activeLayer !== null) this.updateLayerBanner();
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('mousemove', this.mouseHandler);
    maybeShowOnboarding();
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
        this.updateLayerBanner();
      }
      showToast(`Layer complete — building up to layer ${(p.active_layer ?? 0) + 1}.`, 'info');
    }

    this.currentTurn = p.next_player as 1 | 2;
    if (p.p1_time_ms !== undefined || p.p2_time_ms !== undefined) {
      this.clockDisplay.setPeriods(p.p1_periods, p.p2_periods);
      this.clockDisplay.update(this.currentTurn, p.p1_time_ms ?? null, p.p2_time_ms ?? null);
    }
    this.updateCaptureCounts();
    setActiveGlow(this.currentTurn, this.finished);
    if (this.scoreShowing) this.refreshScore();
    this.refreshTurnUI();
  }

  private handleGameOver(p: GameOverPayload): void {
    this.finished = true;
    setActiveGlow(this.currentTurn, true);
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
    this.scoreShowing = true;
    this.enableReplay();
  }

  // ── View controls: slice / camera / cursor / score / replay ─────────────────

  private setupViewControls(): void {
    const click = (id: string, fn: () => void) => {
      const el = document.getElementById(id);
      if (el) (el as HTMLButtonElement).onclick = fn;
    };
    click('go3d-slice-x', () => this.toggleSlice('x'));
    click('go3d-slice-y', () => this.toggleSlice('y'));
    click('go3d-slice-z', () => this.toggleSlice('z'));
    click('go3d-cam-top',   () => this.renderer.faceCam('top'));
    click('go3d-cam-front', () => this.renderer.faceCam('front'));
    click('go3d-cam-side',  () => this.renderer.faceCam('side'));
    click('go3d-cam-iso',   () => this.renderer.faceCam('iso'));
    click('go3d-score-btn', () => this.toggleScore());

    show('go3d-view-controls', true);
    show('go3d-slice-group',  true);
    show('go3d-camera-group', true);
    show('go3d-replay-bar',   false);
  }

  private toggleSlice(axis: 'x' | 'y' | 'z'): void {
    this.deactivateCursor();
    if (this.sliceMode === axis) {
      this.sliceMode = 'none';
      this.renderer.setSlice('none', 0);
    } else {
      this.sliceMode  = axis;
      this.sliceIndex = Math.floor(this.game.size / 2);
      this.renderer.setSlice(axis, this.sliceIndex);
    }
    this.markSliceButtons();
  }

  private markSliceButtons(): void {
    for (const a of ['x', 'y', 'z'] as const) {
      document.getElementById(`go3d-slice-${a}`)?.classList.toggle('go3d-vc-on', this.sliceMode === a);
    }
  }

  private activateCursor(): void {
    if (this.sliceMode !== 'none') { this.sliceMode = 'none'; this.renderer.setSlice('none', 0); this.markSliceButtons(); }
    if (!this.cursorMode) {
      this.cursorMode = true;
      const c = Math.floor(this.game.size / 2);
      const hover = this.renderer.getLastHover();
      const pos = hover ?? { x: c, y: c, z: c };
      this.renderer.setCursorPos(pos.x, pos.y, pos.z);
      this.renderer.setCursorActive(true);
    }
  }

  private deactivateCursor(): void {
    if (this.cursorMode) { this.cursorMode = false; this.renderer.setCursorActive(false); }
  }

  private toggleScore(): void {
    this.scoreShowing = !this.scoreShowing;
    if (this.scoreShowing) this.refreshScore();
    else this.renderer.showTerritory({});
    document.getElementById('go3d-score-btn')?.classList.toggle('go3d-vc-on', this.scoreShowing);
  }

  private refreshScore(): void {
    this.renderer.showTerritory(this.game.countTerritory().map);
  }

  private onKeydown(e: KeyboardEvent): void {
    if (document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement) return;

    // During replay, arrows step through history.
    if (this.replayActive) {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); this.gotoReplayStep(this.replayStep - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.gotoReplayStep(this.replayStep + 1); }
      return;
    }
    if (this.finished) return;

    const size = this.game.size;
    switch (e.key) {
      case 'x': case 'X': this.toggleSlice('x'); break;
      case 'y': case 'Y': this.toggleSlice('y'); break;
      case 'z': case 'Z': this.toggleSlice('z'); break;
      case 'ArrowLeft':
        e.preventDefault();
        if (this.sliceMode === 'x') { this.sliceIndex = Math.max(0, this.sliceIndex - 1); this.renderer.setSlice('x', this.sliceIndex); }
        else { this.activateCursor(); this.renderer.moveCursor(-1, 0, 0); }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (this.sliceMode === 'x') { this.sliceIndex = Math.min(size - 1, this.sliceIndex + 1); this.renderer.setSlice('x', this.sliceIndex); }
        else { this.activateCursor(); this.renderer.moveCursor(1, 0, 0); }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (this.sliceMode === 'z') { this.sliceIndex = Math.max(0, this.sliceIndex - 1); this.renderer.setSlice('z', this.sliceIndex); }
        else { this.activateCursor(); this.renderer.moveCursor(0, 0, -1); }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (this.sliceMode === 'z') { this.sliceIndex = Math.min(size - 1, this.sliceIndex + 1); this.renderer.setSlice('z', this.sliceIndex); }
        else { this.activateCursor(); this.renderer.moveCursor(0, 0, 1); }
        break;
      case 'e': case 'E':
        if (this.sliceMode === 'y') { this.sliceIndex = Math.min(size - 1, this.sliceIndex + 1); this.renderer.setSlice('y', this.sliceIndex); }
        else { this.activateCursor(); this.renderer.moveCursor(0, 1, 0); }
        break;
      case 'q': case 'Q':
        if (this.sliceMode === 'y') { this.sliceIndex = Math.max(0, this.sliceIndex - 1); this.renderer.setSlice('y', this.sliceIndex); }
        else { this.activateCursor(); this.renderer.moveCursor(0, -1, 0); }
        break;
      case 'Enter':
        if (this.cursorMode && this.sliceMode === 'none') {
          const pos = this.renderer.getCursorPos();
          void this.doLocalPlace(pos.x, pos.y, pos.z);
        }
        break;
      case 'p': case 'P': void this.doPass(); break;
    }
  }

  // ── Replay (finished games) ─────────────────────────────────────────────────

  private enableReplay(): void {
    const placeMoves = this.state.moves.filter(m => m.type === 'place' || m.type === 'pass');
    if (placeMoves.length === 0) return;
    show('go3d-replay-bar', true);
    const bind = (id: string, fn: () => void) => {
      const el = document.getElementById(id);
      if (el) (el as HTMLButtonElement).onclick = fn;
    };
    bind('go3d-replay-first', () => this.gotoReplayStep(0));
    bind('go3d-replay-prev',  () => this.gotoReplayStep(this.replayStep - 1));
    bind('go3d-replay-next',  () => this.gotoReplayStep(this.replayStep + 1));
    bind('go3d-replay-last',  () => this.gotoReplayStep(this.state.moves.length));
    this.replayActive = true;
    this.replayStep = this.state.moves.length;
    this.renderer.setReplayMode(true);
    this.updateReplayStatus();
  }

  /** Rebuild the board after the first `step` moves and show it. */
  private gotoReplayStep(step: number): void {
    const total = this.state.moves.length;
    this.replayStep = Math.max(0, Math.min(total, step));
    // Stepping back from the final position: drop the end-game territory shading
    // so the historical board reads cleanly.
    if (this.scoreShowing) { this.scoreShowing = false; this.renderer.showTerritory({}); document.getElementById('go3d-score-btn')?.classList.remove('go3d-vc-on'); }
    const tmp = new Go3D(this.state.board_size);
    let last: [number, number, number] | null = null;
    for (let i = 0; i < this.replayStep; i++) {
      const m = this.state.moves[i];
      if (m.type === 'place' && m.x !== undefined) { tmp.place(m.x, m.y!, m.z!); last = [m.x, m.y!, m.z!]; }
      else if (m.type === 'pass') { tmp.pass(); last = null; }
    }
    this.renderer.showBoardState(tmp.board, last);
    this.updateReplayStatus();
  }

  private updateReplayStatus(): void {
    const el = document.getElementById('go3d-replay-status');
    if (el) el.textContent = `${this.replayStep} / ${this.state.moves.length}`;
  }

  private updateCaptureCounts(): void {
    setCaptureCounts(this.game.captured[0], this.game.captured[1]);
  }

  private updateLayerBanner(): void {
    const el = document.getElementById('go3d-layer-banner');
    if (!el) return;
    if (this.state.mode !== 'stack' || this.activeLayer === null) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.textContent = `Building layer ${this.activeLayer + 1} of ${this.game.size}`;
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
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('mousemove', this.mouseHandler);
    resetViewControls();
    this.controller.disconnect();
    this.renderer.dispose();
  }
}

// ── Sphere game session ─────────────────────────────────────────────────────

/**
 * Sphere-mode session. Mirrors GameSession but owns NO Go engine: the server is
 * authoritative for the geodesic graph and the board. Each move payload carries
 * the full flat board, which we hand straight to the SphereRenderer.
 */
class SphereGameSession {
  private renderer: SphereRenderer;
  private controller: MultiplayerController;
  private clockDisplay: MultiplayerClockDisplay;

  private board: number[];
  private appliedMoves = 0;
  private currentTurn: 1 | 2;
  private finished = false;

  /** Running capture tallies (sphere has no client engine to read them from). */
  private p1Caps = 0;
  private p2Caps = 0;
  private scoreShowing = false;

  /** Node adjacency derived from edges — used only for the end-game territory overlay. */
  private adjacency: number[][];

  constructor(private state: GameState, private onExit: () => void) {
    if (!state.geometry) throw new Error('Sphere game has no geometry.');
    this.board       = (state.board as number[]).slice();
    this.currentTurn = state.current_player as 1 | 2;
    this.adjacency   = this.buildAdjacency(state.geometry.count, state.geometry.edges);

    this.renderer = new SphereRenderer(state.geometry, this.board, (node) => void this.doLocalPlace(node));
    this.renderer.setCurrentPlayer(this.currentTurn);

    this.clockDisplay = new MultiplayerClockDisplay();
    this.clockDisplay.init(state.time_control, this.currentTurn, state.p1_time_ms, state.p2_time_ms,
                           state.p1_periods ?? null, state.p2_periods ?? null);

    const callbacks: MultiplayerCallbacks = {
      onMove:         p  => this.applyMove(p),
      onGameOver:     p  => this.handleGameOver(p),
      onPlayerJoined: () => { showToast('Your opponent has joined!', 'success'); this.refreshTurnUI(); },
      onError:        m  => showToast(m, 'error'),
      onClockTick:    (p1, p2) => this.clockDisplay.update(this.currentTurn, p1, p2),
    };
    this.controller = new MultiplayerController(state, callbacks);
    this.controller.connect();

    this.bindButtons();
    this.setupViewControls();
    this.fillPlayerBar();
    this.refreshTurnUI();
    setActiveGlow(this.currentTurn, this.finished);
    maybeShowOnboarding();
  }

  private get mySlot(): 1 | 2 { return this.controller.mySlot; }

  /** Sphere has no slice/camera/replay — only the territory-score toggle applies. */
  private setupViewControls(): void {
    show('go3d-view-controls', true);
    show('go3d-slice-group',  false);
    show('go3d-camera-group', false);
    show('go3d-replay-bar',   false);
    const btn = document.getElementById('go3d-score-btn');
    if (btn) (btn as HTMLButtonElement).onclick = () => this.toggleScore();
  }

  private toggleScore(): void {
    this.scoreShowing = !this.scoreShowing;
    this.renderer.showTerritory(this.scoreShowing ? this.computeTerritory() : {});
    document.getElementById('go3d-score-btn')?.classList.toggle('go3d-vc-on', this.scoreShowing);
  }

  private buildAdjacency(count: number, edges: [number, number][]): number[][] {
    const adj: number[][] = Array.from({ length: count }, () => []);
    for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
    return adj;
  }

  private async doLocalPlace(node: number): Promise<void> {
    if (this.finished) return;
    if (this.state.status !== 'active') { showToast('Waiting for an opponent to join.', 'info'); return; }
    if (this.currentTurn !== this.mySlot) { this.renderer.forbiddenFlash(node); return; }
    try {
      const payload = await this.controller.submitPlace(node);
      if (payload) this.applyMove(payload);
    } catch {
      this.renderer.forbiddenFlash(node);
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

  private applyMove(p: MovePayload): void {
    if (p.move_number <= this.appliedMoves) return;
    this.appliedMoves = p.move_number;

    if (p.type === 'place' && p.x !== undefined) {
      const captured = (p.captured as number[] | undefined) ?? [];
      if (p.board) { this.board = p.board.slice(); this.renderer.setBoard(this.board); }
      this.renderer.playPlaceSound();
      if (captured.length > 0) {
        this.renderer.triggerCaptures(captured, p.player_slot as 1 | 2);
        this.renderer.playCaptureSound(captured.length);
        if (p.player_slot === 1) this.p1Caps += captured.length; else this.p2Caps += captured.length;
        setCaptureCounts(this.p1Caps, this.p2Caps);
      }
      this.renderer.markLastMove(p.x);
    } else if (p.type === 'pass') {
      this.renderer.playPassSound();
      showToast(p.player_slot === this.mySlot ? 'You passed.' : 'Opponent passed.', 'info');
    }

    this.currentTurn = p.next_player as 1 | 2;
    this.renderer.setCurrentPlayer(this.currentTurn);
    if (p.p1_time_ms !== undefined || p.p2_time_ms !== undefined) {
      this.clockDisplay.update(this.currentTurn, p.p1_time_ms ?? null, p.p2_time_ms ?? null);
    }
    setActiveGlow(this.currentTurn, this.finished);
    if (this.scoreShowing) this.renderer.showTerritory(this.computeTerritory());
    this.refreshTurnUI();
  }

  private handleGameOver(p: GameOverPayload): void {
    this.finished = true;
    this.scoreShowing = true;
    setActiveGlow(this.currentTurn, true);
    this.renderer.setInteractive(false);
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

    this.renderer.showTerritory(this.computeTerritory());
  }

  /** Flood-fill empty regions on the graph; region bordered by one colour = its territory. */
  private computeTerritory(): Record<number, number> {
    const map: Record<number, number> = {};
    const seen = new Set<number>();
    for (let n = 0; n < this.board.length; n++) {
      if (this.board[n] !== 0 || seen.has(n)) continue;
      const region: number[] = [];
      const borders = new Set<number>();
      const stack = [n];
      while (stack.length) {
        const c = stack.pop()!;
        if (seen.has(c)) continue;
        seen.add(c); region.push(c);
        for (const nb of this.adjacency[c]) {
          if (this.board[nb] === 0) { if (!seen.has(nb)) stack.push(nb); }
          else borders.add(this.board[nb]);
        }
      }
      const owner = borders.size === 1 ? [...borders][0] : 0;
      if (owner) for (const r of region) map[r] = owner;
    }
    return map;
  }

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

  private exit(): void { this.dispose(); this.onExit(); }

  dispose(): void {
    resetViewControls();
    this.controller.disconnect();
    this.renderer.dispose();
  }
}

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
      const onExit = () => { this.session = null; void this.lobby.showLobby(); };
      this.session = state.mode === 'sphere'
        ? new SphereGameSession(state, onExit)
        : new GameSession(state, onExit);
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
