/**
 * Shared local/online game-session machinery.
 *
 * This module is SIDE-EFFECT FREE (no bootstrap). It holds the Three.js-backed
 * session shells (GameSession for cube/stack, SphereGameSession for sphere), the
 * controller factory type, and the synthetic-state builder for hot-seat games.
 *
 * Both entry points import from here:
 *   - app.ts        → WordPress embed (auth/lobby + online + local)
 *   - standalone.ts → GitHub Pages (local hot-seat only)
 */

import { AuthState } from './auth';
import { Users, GameState, MovePayload, GameOverPayload, PlayerJoinedPayload, SphereGeometry, UndoRequestPayload } from './api';
import { Go3D } from './game';
import { Renderer } from './renderer';
import { SphereRenderer } from './sphere-renderer';
import {
  MultiplayerController,
  MultiplayerCallbacks,
  MultiplayerClockDisplay,
  ConnectionStatus,
} from './multiplayer';
import { GameController, LocalController, LocalGameConfig } from './local-controller';
import { buildGeodesic } from './geodesic';
import { showToast } from './lobby';
import { music } from './music';
import { confirmModal } from './modal';

// ── Controller factory ──────────────────────────────────────────────────────

/**
 * Builds the controller that drives a session. The default is the server-backed
 * MultiplayerController; local hot-seat games inject a LocalController instead.
 * Both structurally satisfy GameController, so the sessions are agnostic.
 */
export type ControllerFactory = (state: GameState, callbacks: MultiplayerCallbacks) => GameController;
const serverController: ControllerFactory = (s, c) => new MultiplayerController(s, c);

/** Player colour label, used for hot-seat wording where there are no usernames. */
function colourName(slot: 1 | 2): string {
  return slot === 1 ? 'Black' : 'White';
}

/**
 * Synthesise the GameState a hot-seat session runs on. There is no server, so
 * Black is "player 1", White is "player 2", the game starts active, and (for
 * sphere) the geodesic graph is generated locally exactly as the server would.
 */
export function buildLocalState(config: LocalGameConfig): GameState {
  const now = new Date().toISOString();
  const ts  = config.time_settings ?? null;
  const timed = config.time_control !== 'none';
  const mainMs = timed ? (ts?.main_time_s ?? 0) * 1000 : null;
  const periods = config.time_control === 'byoyomi' ? (ts?.byoyomi_periods ?? null) : null;

  let geometry: SphereGeometry | null = null;
  let board: number[][][] | number[];
  if (config.mode === 'sphere') {
    const g = buildGeodesic(config.board_size);
    geometry = { vertices: g.vertices, edges: g.edges, count: g.count };
    board = new Array<number>(g.count).fill(0);
  } else {
    const n = config.board_size;
    board = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => new Array<number>(n).fill(0)));
  }

  return {
    id:             -1,
    player1_id:     1,
    player2_id:     2,
    player1_name:   config.p1_name || 'Black',
    player2_name:   config.p2_name || 'White',
    board_size:     config.board_size,
    mode:           config.mode,
    scoring_mode:   config.scoring_mode,
    komi:           config.komi,
    time_control:   config.time_control,
    current_player: 1,
    status:         'active',
    winner_id:      null,
    end_reason:     null,
    p1_score:       null,
    p2_score:       null,
    elo_change_p1:  null,
    elo_change_p2:  null,
    created_at:     now,
    last_move_at:   null,
    finished_at:    null,
    time_settings:  ts,
    p1_time_ms:     mainMs,
    p2_time_ms:     mainMs,
    p1_periods:     periods,
    p2_periods:     periods,
    consecutive_passes: 0,
    active_layer:   0,
    board,
    geometry,
    moves:          [],
  };
}

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
  show('go3d-move-history-drawer', false);
  show('go3d-mobile-controls', false);
  for (const id of ['go3d-slice-x', 'go3d-slice-y', 'go3d-slice-z', 'go3d-score-btn']) {
    document.getElementById(id)?.classList.remove('go3d-vc-on');
  }
  document.getElementById('go3d-game-screen')?.removeAttribute('data-go3d-mode');
  document.getElementById('go3d-history-list')?.replaceChildren();
  setConnectionStatus('local');
  setCaptureCounts(0, 0);
  setActiveGlow(1, true);
}

function setConnectionStatus(status: ConnectionStatus): void {
  const el = document.getElementById('go3d-connection-chip');
  if (!el) return;
  const labels: Record<ConnectionStatus, string> = {
    live: 'Live',
    polling: 'Polling fallback',
    reconnecting: 'Reconnecting',
    local: 'Local',
  };
  el.textContent = labels[status];
  el.className = `go3d-connection-chip go3d-connection-${status}`;
}

/** Open the help / keyboard-shortcuts overlay. */
function openHelpOverlay(): void {
  const ov = document.getElementById('go3d-onboarding');
  if (!ov) return;
  ov.style.display = 'flex';
  const dismiss = document.getElementById('go3d-onboarding-dismiss');
  if (dismiss) (dismiss as HTMLButtonElement).onclick = () => {
    ov.style.display = 'none';
    try { localStorage.setItem('go3d_onboarded', '1'); } catch { /* ignore */ }
  };
}

function setOnboardingMode(mode: GameState['mode']): void {
  const title = document.getElementById('go3d-onboarding-title');
  const body = document.getElementById('go3d-onboarding-list');
  if (!body) return;
  if (title) title.textContent = mode === 'sphere' ? 'Sphere mode controls' : mode === 'stack' ? 'Stack mode controls' : 'Cube mode controls';
  const items = mode === 'sphere'
    ? [
        ['Place a stone', 'Tap or click an empty node on the visible side of the globe.'],
        ['Read the surface', 'Rotate the sphere to inspect groups, liberties, and threats from every angle.'],
        ['Forbidden moves', 'Illegal attempts play a sound and pulse the rejected node red.'],
        ['Score', 'The Score button shades estimated territory when you want a quick read.'],
      ]
    : [
        ['Place a stone', 'Click an empty point, or use the mobile precision controls to move a cursor and confirm.'],
        ['See inside', 'Use X/Y/Z slice buttons, then step the active slice with arrows, Q/E, or the mobile slice controls.'],
        ['Keyboard cursor', 'With no slice active, arrows move horizontally, Q/E move vertically, and Enter places.'],
        mode === 'stack' ? ['Stack layers', 'Only the current build layer accepts stones; two passes advance to the next layer.'] : ['Camera', 'Snap to Top, Front, Side, or Iso whenever the 3D view gets busy.'],
        ['Score', 'The Score button shades estimated territory.'],
      ];
  body.innerHTML = items.map(([head, text]) => `<li><strong>${head}:</strong> ${text}</li>`).join('');
}

/** Show the help overlay once on first run; remembered in localStorage. */
function maybeShowOnboarding(): void {
  try { if (localStorage.getItem('go3d_onboarded')) return; } catch { /* private mode */ }
  openHelpOverlay();
}

function playerNameForMove(state: GameState, slot: 1 | 2): string {
  return slot === 1 ? (state.player1_name || 'Black') : (state.player2_name || 'White');
}

function slotForPlayerId(state: GameState, playerId: number): 1 | 2 {
  return state.player1_id === playerId ? 1 : 2;
}

function appendMoveRecord(state: GameState, p: MovePayload): void {
  if (state.moves.some(m => m.move_number === p.move_number)) return;
  const slot = p.player_slot as 1 | 2;
  const record = {
    move_number: p.move_number,
    player_id: slot === 1 ? state.player1_id : (state.player2_id ?? state.player1_id),
    type: (p.type === 'place' ? 'place' : 'pass') as 'place' | 'pass',
    x: p.x,
    y: p.y,
    z: p.z,
    created_at: new Date().toISOString(),
  };
  state.moves.push(record);
}

function renderMoveHistory(state: GameState): void {
  const list = document.getElementById('go3d-history-list');
  const empty = document.getElementById('go3d-history-empty');
  if (!list || !empty) return;
  list.replaceChildren();
  empty.style.display = state.moves.length ? 'none' : '';
  for (const m of state.moves) {
    const slot = slotForPlayerId(state, m.player_id);
    const row = document.createElement('li');
    const num = document.createElement('span');
    const player = document.createElement('span');
    const detailEl = document.createElement('span');
    const mode = state.mode ?? 'cube';
    let detail = '';
    if (m.type === 'place') {
      detail = mode === 'sphere'
        ? `Node ${m.x ?? '—'}`
        : `(${m.x ?? '—'}, ${m.y ?? '—'}, ${m.z ?? '—'})`;
    } else {
      detail = m.type === 'resign' ? 'Resigned' : 'Passed';
    }
    num.className = 'go3d-history-num';
    num.textContent = String(m.move_number);
    player.className = `go3d-history-player go3d-history-p${slot}`;
    player.textContent = playerNameForMove(state, slot);
    detailEl.className = 'go3d-history-detail';
    detailEl.textContent = detail;
    row.append(num, player, detailEl);
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}

// ── Active game session ─────────────────────────────────────────────────────

/**
 * Holds everything tied to one open game. Created on enterGame(), torn down on
 * leaveGame(). Keeping it in one object makes cleanup foolproof.
 */
export class GameSession {
  private game: Go3D;
  private renderer: Renderer;
  private controller: GameController;
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
  private undoReloading = false;
  private readonly keyHandler   = (e: KeyboardEvent) => this.onKeydown(e);
  // Switching to the physical mouse drops keyboard/precision-cursor mode. This
  // must only fire for a REAL mouse: on touch devices every tap synthesises a
  // mousemove, which previously deactivated the cursor between a precision
  // button press and the "Place" tap — so the cursor reset to centre and the
  // mobile controls appeared not to work. Filtering on pointerType fixes that.
  private readonly pointerHandler = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && this.cursorMode) this.deactivateCursor();
  };

  constructor(
    private state: GameState,
    private onExit: () => void,
    makeController: ControllerFactory = serverController,
    private onReload?: (state?: GameState) => void,
  ) {
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
      onPlayerJoined: p  => this.handlePlayerJoined(p),
      onError:        m  => showToast(m, 'error'),
      onClockTick:    (p1, p2) => this.clockDisplay.update(this.currentTurn, p1, p2),
      onConnectionStatus: s => setConnectionStatus(s),
      onUndoRequest:  p  => void this.handleUndoRequest(p),
      onUndoApplied:  s  => this.reloadFromUndo(s),
      onUndoDeclined: () => showToast('Undo request declined.', 'info'),
      onLayerChange:  l  => {
        this.activeLayer = l;
        this.renderer.setStackLayer(l);
        this.updateLayerBanner();
        showToast(`Layer complete — building up to layer ${l + 1}.`, 'info');
      },
    };
    this.controller = makeController(state, callbacks);
    this.controller.connect();

    this.bindButtons();
    this.setupViewControls();
    this.setupSessionChrome();
    this.fillPlayerBar();
    this.refreshTurnUI();
    this.updateCaptureCounts();
    setActiveGlow(this.currentTurn, this.finished);
    renderMoveHistory(this.state);
    if (this.activeLayer !== null) this.updateLayerBanner();
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('pointermove', this.pointerHandler);
    maybeShowOnboarding();
    music.enterGame();
  }

  // ── Local actions ─────────────────────────────────────────────────────────

  private get mySlot(): 1 | 2 { return this.controller.mySlot; }
  private get isLocal(): boolean { return this.controller.isLocal; }

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
    if (!(await confirmModal('Pass your turn? Two passes in a row end the game and trigger scoring.', { title: 'Pass', confirm: 'Pass', cancel: 'Cancel', danger: false }))) return;
    if (this.finished || this.currentTurn !== this.mySlot) return; // re-check after async prompt
    try {
      const payload = await this.controller.submitPass();
      if (payload) this.applyMove(payload);
    } catch { /* surfaced via onError */ }
  }

  private async doResign(): Promise<void> {
    if (this.finished) return;
    if (!(await confirmModal('Resign this game? This counts as a loss.', { title: 'Resign', confirm: 'Resign', cancel: 'Keep playing', danger: true }))) return;
    try { await this.controller.submitResign(); } catch { /* surfaced via onError */ }
  }

  private async doUndo(): Promise<void> {
    if (this.finished || this.state.moves.length === 0) return;
    const msg = this.isLocal
      ? 'Undo the latest local move?'
      : 'Ask your opponent to undo your latest move?';
    if (!(await confirmModal(msg, { title: 'Undo', confirm: this.isLocal ? 'Undo move' : 'Request undo', cancel: 'Cancel', danger: false }))) return;
    try {
      const state = await this.controller.requestUndo();
      if (state) this.reloadFromUndo(state);
      else showToast('Undo request sent.', 'info');
    } catch { /* surfaced via onError */ }
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
    appendMoveRecord(this.state, p);

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
      showToast(
        this.isLocal ? `${colourName(p.player_slot as 1 | 2)} passed.`
                     : (p.player_slot === this.mySlot ? 'You passed.' : 'Opponent passed.'),
        'info');
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
    renderMoveHistory(this.state);
    this.refreshTurnUI();
  }

  private handleGameOver(p: GameOverPayload): void {
    this.finished = true;
    setActiveGlow(this.currentTurn, true);
    // Local games carry a slot number (1|2) in winner_id; server games a user id.
    const myId = AuthState.user?.id ?? -1;
    const iWon = this.isLocal ? false : p.winner_id === myId;
    let msg: string;
    if (p.winner_id === null)   msg = 'Game over — draw.';
    else if (this.isLocal)      msg = `${colourName(p.winner_id as 1 | 2)} wins!`;
    else if (iWon)              msg = 'You won!';
    else                        msg = 'You lost.';

    const reason = p.end_reason ? ` (${p.end_reason.replace(/_/g, ' ')})` : '';
    if (p.p1_score !== null && p.p2_score !== null) {
      msg += `  Score — Black ${p.p1_score} : White ${p.p2_score}.`;
    }
    showToast(msg + reason, (this.isLocal || iWon) ? 'success' : 'info');

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

  private handlePlayerJoined(p: PlayerJoinedPayload): void {
    this.state.status = 'active';
    this.state.player2_id = p.player2_id;
    this.state.player2_name = p.player2_name ?? this.state.player2_name;
    this.state.player2_elo = p.player2_elo ?? this.state.player2_elo;
    this.fillPlayerBar();
    this.refreshTurnUI();
    showToast('Your opponent has joined!', 'success');
  }

  private async handleUndoRequest(p: UndoRequestPayload): Promise<void> {
    if (this.isLocal || p.requester_id === AuthState.user?.id) return;
    const ok = await confirmModal(`${p.requester_name} wants to undo move ${p.move_number}. Accept?`, {
      title: 'Undo request',
      confirm: 'Accept undo',
      cancel: 'Decline',
      danger: false,
    });
    try {
      const state = await this.controller.respondUndo(ok);
      if (state) this.reloadFromUndo(state);
      else if (!ok) showToast('Undo declined.', 'info');
    } catch { /* surfaced via onError */ }
  }

  private reloadFromUndo(state?: GameState): void {
    if (this.undoReloading) return;
    this.undoReloading = true;
    showToast('Undo applied.', 'success');
    if (this.onReload) this.onReload(state);
    else this.dispose();
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
    click('go3d-help-btn',  () => openHelpOverlay());

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
    this.updateMobileStatus();
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
    document.getElementById('go3d-mobile-score')?.classList.toggle('go3d-vc-on', this.scoreShowing);
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
    this.updateMobileStatus();
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
    bind('go3d-mobile-replay-prev', () => this.gotoReplayStep(this.replayStep - 1));
    bind('go3d-mobile-replay-next', () => this.gotoReplayStep(this.replayStep + 1));
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
    const mobile = document.getElementById('go3d-mobile-status');
    if (mobile && this.replayActive) mobile.textContent = `Replay ${this.replayStep} / ${this.state.moves.length}`;
  }

  private updateCaptureCounts(): void {
    setCaptureCounts(this.game.captured[0], this.game.captured[1]);
  }

  private updateLayerBanner(): void {
    const el = document.getElementById('go3d-layer-banner');
    if (!el) return;
    if (this.state.mode !== 'stack' || this.activeLayer === null) { el.style.display = 'none'; return; }
    const activeLayer = this.activeLayer;
    el.style.display = '';
    const blocks = Array.from({ length: this.game.size }, (_, i) =>
      `<span class="go3d-stack-block${i <= activeLayer ? ' active' : ''}" aria-hidden="true"></span>`).join('');
    el.innerHTML = `
      <span class="go3d-stack-label">Layer ${activeLayer + 1} / ${this.game.size}</span>
      <span class="go3d-stack-blocks">${blocks}</span>`;
    this.updateMobileStatus();
  }

  private setupSessionChrome(): void {
    document.getElementById('go3d-game-screen')?.setAttribute('data-go3d-mode', this.state.mode ?? 'cube');
    setOnboardingMode(this.state.mode ?? 'cube');
    show('go3d-mobile-controls', true);
    const historyToggle = document.getElementById('go3d-history-toggle') as HTMLButtonElement | null;
    const historyClose = document.getElementById('go3d-history-close') as HTMLButtonElement | null;
    const drawer = document.getElementById('go3d-move-history-drawer');
    const toggleHistory = () => {
      if (!drawer) return;
      const open = drawer.style.display === 'none' || drawer.style.display === '';
      drawer.style.display = open ? 'block' : 'none';
      historyToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    if (historyToggle) historyToggle.onclick = toggleHistory;
    if (historyClose) historyClose.onclick = () => {
      if (drawer) drawer.style.display = 'none';
      historyToggle?.setAttribute('aria-expanded', 'false');
    };

    const mobileToggle = document.getElementById('go3d-mobile-toggle') as HTMLButtonElement | null;
    const mobilePanel = document.getElementById('go3d-mobile-panel');
    if (mobileToggle && mobilePanel) {
      mobileToggle.onclick = () => {
        const open = mobilePanel.classList.toggle('go3d-mobile-panel-open');
        mobileToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
    }
    const bind = (id: string, fn: () => void) => {
      const el = document.getElementById(id) as HTMLButtonElement | null;
      if (el) el.onclick = fn;
    };
    bind('go3d-mobile-slice-x', () => this.toggleSlice('x'));
    bind('go3d-mobile-slice-y', () => this.toggleSlice('y'));
    bind('go3d-mobile-slice-z', () => this.toggleSlice('z'));
    bind('go3d-mobile-slice-prev', () => this.stepSlice(-1));
    bind('go3d-mobile-slice-next', () => this.stepSlice(1));
    bind('go3d-mobile-place', () => this.placeCursor());
    // "More" row — these mirror the desktop floating controls, which are hidden
    // on mobile to free up the canvas (see go3d.css). They reuse the exact same
    // handlers so behaviour stays in one place.
    bind('go3d-mobile-score', () => this.toggleScore());
    bind('go3d-mobile-moves', toggleHistory);
    bind('go3d-mobile-undo',  () => void this.doUndo());
    bind('go3d-mobile-help',  () => openHelpOverlay());
    document.querySelectorAll<HTMLButtonElement>('[data-go3d-cursor]').forEach(btn => {
      btn.onclick = () => {
        const [dx, dy, dz] = (btn.dataset.go3dCursor ?? '0,0,0').split(',').map(Number);
        this.activateCursor();
        this.renderer.moveCursor(dx, dy, dz);
        this.updateMobileStatus();
      };
    });
    this.updateMobileStatus();
  }

  private stepSlice(delta: number): void {
    if (this.sliceMode === 'none') this.toggleSlice('z');
    const axis = this.sliceMode;
    if (axis === 'none') return;
    this.sliceIndex = Math.max(0, Math.min(this.game.size - 1, this.sliceIndex + delta));
    this.renderer.setSlice(axis, this.sliceIndex);
    this.updateMobileStatus();
  }

  private placeCursor(): void {
    this.activateCursor();
    const pos = this.renderer.getCursorPos();
    void this.doLocalPlace(pos.x, pos.y, pos.z);
  }

  private updateMobileStatus(): void {
    const el = document.getElementById('go3d-mobile-status');
    if (!el) return;
    if (this.replayActive) {
      el.textContent = `Replay ${this.replayStep} / ${this.state.moves.length}`;
      return;
    }
    const layer = this.activeLayer !== null ? ` · Layer ${this.activeLayer + 1} / ${this.game.size}` : '';
    const slice = this.sliceMode === 'none' ? 'No slice' : `${this.sliceMode.toUpperCase()} slice ${this.sliceIndex + 1} / ${this.game.size}`;
    el.textContent = `${slice}${layer}`;
  }

  // ── UI ──────────────────────────────────────────────────────────────────────

  private refreshTurnUI(): void {
    if (this.finished) return;

    // Hot-seat: both players share the screen, so there's no "waiting" or
    // "opponent" — just announce whose colour is to move and keep controls live.
    if (this.isLocal) {
      const ind = document.getElementById('go3d-turn-indicator');
      if (ind) ind.textContent = `${colourName(this.currentTurn)} to move`;
      const overlay = document.getElementById('go3d-waiting-overlay');
      if (overlay) overlay.style.display = 'none';
      const pass   = document.getElementById('go3d-pass-btn')   as HTMLButtonElement | null;
      const resign = document.getElementById('go3d-resign-btn') as HTMLButtonElement | null;
      if (pass)   pass.disabled   = false;
      if (resign) resign.disabled = false;
      return;
    }

    const myTurn  = this.currentTurn === this.mySlot;
    const waiting = this.state.status !== 'active';

    const ind = document.getElementById('go3d-turn-indicator');
    if (ind) ind.textContent = waiting ? 'Waiting for opponent…' : (myTurn ? 'Your move' : "Opponent's move");

    const overlay = document.getElementById('go3d-waiting-overlay');
    // The "Waiting for opponent…" cover is only for the pre-join state (no
    // opponent yet). During an active game it must stay hidden even when it's
    // the opponent's turn — otherwise it blocks the board and shows misleading
    // text. Whose move it is is already conveyed by the turn indicator.
    if (overlay) overlay.style.display = waiting ? '' : 'none';

    const pass   = document.getElementById('go3d-pass-btn')   as HTMLButtonElement | null;
    const resign = document.getElementById('go3d-resign-btn') as HTMLButtonElement | null;
    if (pass)   pass.disabled   = !myTurn || waiting;
    if (resign) resign.disabled = waiting;
  }

  private bindButtons(): void {
    document.getElementById('go3d-undo-btn')!.onclick   = () => void this.doUndo();
    document.getElementById('go3d-pass-btn')!.onclick   = () => void this.doPass();
    document.getElementById('go3d-resign-btn')!.onclick = () => void this.doResign();
    document.getElementById('go3d-back-to-lobby-game')!.onclick = () => void this.exit();
  }

  /** Fill the top player bar with usernames + ELO (best-effort, non-blocking). */
  private fillPlayerBar(): void {
    const set = (slot: 1 | 2, name: string, elo?: number) => {
      const n = document.getElementById(`go3d-p${slot}-name`);
      const e = document.getElementById(`go3d-p${slot}-elo`);
      if (n) n.textContent = name;
      if (e) e.textContent = elo !== undefined ? String(elo) : '';
    };
    if (this.isLocal) {
      set(1, this.state.player1_name || 'Black');
      set(2, this.state.player2_name || 'White');
      return;
    }
    // Names + ELO now arrive with the game state, so label the board straight
    // away. Only fall back to a /users/{id} fetch if the server didn't supply
    // a name (e.g. an older cached payload).
    const p1Name = this.state.player1_name;
    const p2Name = this.state.player2_name;
    set(1, p1Name || `Player ${this.state.player1_id}`, this.state.player1_elo ?? undefined);
    set(2, this.state.player2_id ? (p2Name || `Player ${this.state.player2_id}`) : '(waiting)', this.state.player2_elo ?? undefined);
    if (!p1Name) {
      void Users.getProfile(this.state.player1_id)
        .then(r => set(1, r.user.username, r.user.elo)).catch(() => {});
    }
    if (this.state.player2_id && !p2Name) {
      void Users.getProfile(this.state.player2_id)
        .then(r => set(2, r.user.username, r.user.elo)).catch(() => {});
    }
  }

  private async exit(): Promise<void> {
    // Leaving a live timed game forfeits it (your clock keeps running on the
    // server), so confirm and resign on the way out. Correspondence games have
    // no clock — you can come and go freely — and finished/local games never
    // need a forfeit.
    if (!this.finished && !this.isLocal && this.state.status === 'active' && this.state.time_control !== 'none') {
      const ok = await confirmModal('This is a timed game — leaving forfeits it. Resign and leave?', {
        title: 'Leave game', confirm: 'Resign & leave', cancel: 'Keep playing', danger: true,
      });
      if (!ok) return;
      try { await this.controller.submitResign(); } catch { /* surfaced via onError */ }
    }
    this.dispose();
    this.onExit();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('pointermove', this.pointerHandler);
    resetViewControls();
    this.controller.disconnect();
    this.renderer.dispose();
    music.leaveGame();
  }
}

// ── Sphere game session ─────────────────────────────────────────────────────

/**
 * Sphere-mode session. Mirrors GameSession but owns NO Go engine: the server is
 * authoritative for the geodesic graph and the board. Each move payload carries
 * the full flat board, which we hand straight to the SphereRenderer.
 */
export class SphereGameSession {
  private renderer: SphereRenderer;
  private controller: GameController;
  private clockDisplay: MultiplayerClockDisplay;

  private board: number[];
  private appliedMoves = 0;
  private currentTurn: 1 | 2;
  private finished = false;

  /** Running capture tallies (sphere has no client engine to read them from). */
  private p1Caps = 0;
  private p2Caps = 0;
  private scoreShowing = false;
  private undoReloading = false;

  /** Node adjacency derived from edges — used only for the end-game territory overlay. */
  private adjacency: number[][];

  constructor(
    private state: GameState,
    private onExit: () => void,
    makeController: ControllerFactory = serverController,
    private onReload?: (state?: GameState) => void,
  ) {
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
      onPlayerJoined: p  => this.handlePlayerJoined(p),
      onError:        m  => showToast(m, 'error'),
      onClockTick:    (p1, p2) => this.clockDisplay.update(this.currentTurn, p1, p2),
      onConnectionStatus: s => setConnectionStatus(s),
      onUndoRequest:  p  => void this.handleUndoRequest(p),
      onUndoApplied:  s  => this.reloadFromUndo(s),
      onUndoDeclined: () => showToast('Undo request declined.', 'info'),
    };
    this.controller = makeController(state, callbacks);
    this.controller.connect();

    this.bindButtons();
    this.setupViewControls();
    this.setupSessionChrome();
    this.fillPlayerBar();
    this.refreshTurnUI();
    setActiveGlow(this.currentTurn, this.finished);
    renderMoveHistory(this.state);
    maybeShowOnboarding();
    music.enterGame();
  }

  private get mySlot(): 1 | 2 { return this.controller.mySlot; }
  private get isLocal(): boolean { return this.controller.isLocal; }

  /** Sphere has no slice/camera/replay — only the territory-score toggle applies. */
  private setupViewControls(): void {
    show('go3d-view-controls', true);
    show('go3d-slice-group',  false);
    show('go3d-camera-group', false);
    show('go3d-replay-bar',   false);
    const btn = document.getElementById('go3d-score-btn');
    if (btn) (btn as HTMLButtonElement).onclick = () => this.toggleScore();
    const help = document.getElementById('go3d-help-btn');
    if (help) (help as HTMLButtonElement).onclick = () => openHelpOverlay();
  }

  private toggleScore(): void {
    this.scoreShowing = !this.scoreShowing;
    this.renderer.showTerritory(this.scoreShowing ? this.computeTerritory() : {});
    document.getElementById('go3d-score-btn')?.classList.toggle('go3d-vc-on', this.scoreShowing);
    document.getElementById('go3d-mobile-score')?.classList.toggle('go3d-vc-on', this.scoreShowing);
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
    if (!(await confirmModal('Pass your turn? Two passes in a row end the game and trigger scoring.', { title: 'Pass', confirm: 'Pass', cancel: 'Cancel', danger: false }))) return;
    if (this.finished || this.currentTurn !== this.mySlot) return; // re-check after async prompt
    try {
      const payload = await this.controller.submitPass();
      if (payload) this.applyMove(payload);
    } catch { /* surfaced via onError */ }
  }

  private async doResign(): Promise<void> {
    if (this.finished) return;
    if (!(await confirmModal('Resign this game? This counts as a loss.', { title: 'Resign', confirm: 'Resign', cancel: 'Keep playing', danger: true }))) return;
    try { await this.controller.submitResign(); } catch { /* surfaced via onError */ }
  }

  private async doUndo(): Promise<void> {
    if (this.finished || this.state.moves.length === 0) return;
    const msg = this.isLocal
      ? 'Undo the latest local move?'
      : 'Ask your opponent to undo your latest move?';
    if (!(await confirmModal(msg, { title: 'Undo', confirm: this.isLocal ? 'Undo move' : 'Request undo', cancel: 'Cancel', danger: false }))) return;
    try {
      const state = await this.controller.requestUndo();
      if (state) this.reloadFromUndo(state);
      else showToast('Undo request sent.', 'info');
    } catch { /* surfaced via onError */ }
  }

  private applyMove(p: MovePayload): void {
    if (p.move_number <= this.appliedMoves) return;
    this.appliedMoves = p.move_number;
    appendMoveRecord(this.state, p);

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
      showToast(
        this.isLocal ? `${colourName(p.player_slot as 1 | 2)} passed.`
                     : (p.player_slot === this.mySlot ? 'You passed.' : 'Opponent passed.'),
        'info');
    }

    this.currentTurn = p.next_player as 1 | 2;
    this.renderer.setCurrentPlayer(this.currentTurn);
    if (p.p1_time_ms !== undefined || p.p2_time_ms !== undefined) {
      this.clockDisplay.update(this.currentTurn, p.p1_time_ms ?? null, p.p2_time_ms ?? null);
    }
    setActiveGlow(this.currentTurn, this.finished);
    if (this.scoreShowing) this.renderer.showTerritory(this.computeTerritory());
    renderMoveHistory(this.state);
    this.refreshTurnUI();
  }

  private handleGameOver(p: GameOverPayload): void {
    this.finished = true;
    this.scoreShowing = true;
    setActiveGlow(this.currentTurn, true);
    this.renderer.setInteractive(false);
    // Local games carry a slot number (1|2) in winner_id; server games a user id.
    const myId = AuthState.user?.id ?? -1;
    const iWon = this.isLocal ? false : p.winner_id === myId;
    let msg: string;
    if (p.winner_id === null)   msg = 'Game over — draw.';
    else if (this.isLocal)      msg = `${colourName(p.winner_id as 1 | 2)} wins!`;
    else if (iWon)              msg = 'You won!';
    else                        msg = 'You lost.';

    const reason = p.end_reason ? ` (${p.end_reason.replace(/_/g, ' ')})` : '';
    if (p.p1_score !== null && p.p2_score !== null) {
      msg += `  Score — Black ${p.p1_score} : White ${p.p2_score}.`;
    }
    showToast(msg + reason, (this.isLocal || iWon) ? 'success' : 'info');

    const ind = document.getElementById('go3d-turn-indicator');
    if (ind) ind.textContent = 'Game over';
    const overlay = document.getElementById('go3d-waiting-overlay');
    if (overlay) overlay.style.display = 'none';

    this.renderer.showTerritory(this.computeTerritory());
  }

  private handlePlayerJoined(p: PlayerJoinedPayload): void {
    this.state.status = 'active';
    this.state.player2_id = p.player2_id;
    this.state.player2_name = p.player2_name ?? this.state.player2_name;
    this.state.player2_elo = p.player2_elo ?? this.state.player2_elo;
    this.fillPlayerBar();
    this.refreshTurnUI();
    showToast('Your opponent has joined!', 'success');
  }

  private async handleUndoRequest(p: UndoRequestPayload): Promise<void> {
    if (this.isLocal || p.requester_id === AuthState.user?.id) return;
    const ok = await confirmModal(`${p.requester_name} wants to undo move ${p.move_number}. Accept?`, {
      title: 'Undo request',
      confirm: 'Accept undo',
      cancel: 'Decline',
      danger: false,
    });
    try {
      const state = await this.controller.respondUndo(ok);
      if (state) this.reloadFromUndo(state);
      else if (!ok) showToast('Undo declined.', 'info');
    } catch { /* surfaced via onError */ }
  }

  private reloadFromUndo(state?: GameState): void {
    if (this.undoReloading) return;
    this.undoReloading = true;
    showToast('Undo applied.', 'success');
    if (this.onReload) this.onReload(state);
    else this.dispose();
  }

  private setupSessionChrome(): void {
    document.getElementById('go3d-game-screen')?.setAttribute('data-go3d-mode', 'sphere');
    setOnboardingMode('sphere');
    show('go3d-mobile-controls', true);
    const historyToggle = document.getElementById('go3d-history-toggle') as HTMLButtonElement | null;
    const historyClose = document.getElementById('go3d-history-close') as HTMLButtonElement | null;
    const drawer = document.getElementById('go3d-move-history-drawer');
    const toggleHistory = () => {
      if (!drawer) return;
      const open = drawer.style.display === 'none' || drawer.style.display === '';
      drawer.style.display = open ? 'block' : 'none';
      historyToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    if (historyToggle) historyToggle.onclick = toggleHistory;
    if (historyClose) historyClose.onclick = () => {
      if (drawer) drawer.style.display = 'none';
      historyToggle?.setAttribute('aria-expanded', 'false');
    };
    const mobileToggle = document.getElementById('go3d-mobile-toggle') as HTMLButtonElement | null;
    const mobilePanel = document.getElementById('go3d-mobile-panel');
    if (mobileToggle && mobilePanel) {
      mobileToggle.onclick = () => {
        const open = mobilePanel.classList.toggle('go3d-mobile-panel-open');
        mobileToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
    }
    // "More" row — mirror the desktop floating controls (hidden on mobile).
    const mbind = (id: string, fn: () => void) => {
      const el = document.getElementById(id) as HTMLButtonElement | null;
      if (el) el.onclick = fn;
    };
    mbind('go3d-mobile-score', () => this.toggleScore());
    mbind('go3d-mobile-moves', toggleHistory);
    mbind('go3d-mobile-undo',  () => void this.doUndo());
    mbind('go3d-mobile-help',  () => openHelpOverlay());
    const mobileStatus = document.getElementById('go3d-mobile-status');
    if (mobileStatus) mobileStatus.textContent = 'Rotate the globe, then tap a visible empty node';
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

    if (this.isLocal) {
      const ind = document.getElementById('go3d-turn-indicator');
      if (ind) ind.textContent = `${colourName(this.currentTurn)} to move`;
      const overlay = document.getElementById('go3d-waiting-overlay');
      if (overlay) overlay.style.display = 'none';
      const pass   = document.getElementById('go3d-pass-btn')   as HTMLButtonElement | null;
      const resign = document.getElementById('go3d-resign-btn') as HTMLButtonElement | null;
      if (pass)   pass.disabled   = false;
      if (resign) resign.disabled = false;
      return;
    }

    const myTurn  = this.currentTurn === this.mySlot;
    const waiting = this.state.status !== 'active';
    const ind = document.getElementById('go3d-turn-indicator');
    if (ind) ind.textContent = waiting ? 'Waiting for opponent…' : (myTurn ? 'Your move' : "Opponent's move");
    const overlay = document.getElementById('go3d-waiting-overlay');
    // The "Waiting for opponent…" cover is only for the pre-join state (no
    // opponent yet). During an active game it must stay hidden even when it's
    // the opponent's turn — otherwise it blocks the board and shows misleading
    // text. Whose move it is is already conveyed by the turn indicator.
    if (overlay) overlay.style.display = waiting ? '' : 'none';
    const pass   = document.getElementById('go3d-pass-btn')   as HTMLButtonElement | null;
    const resign = document.getElementById('go3d-resign-btn') as HTMLButtonElement | null;
    if (pass)   pass.disabled   = !myTurn || waiting;
    if (resign) resign.disabled = waiting;
  }

  private bindButtons(): void {
    document.getElementById('go3d-undo-btn')!.onclick   = () => void this.doUndo();
    document.getElementById('go3d-pass-btn')!.onclick   = () => void this.doPass();
    document.getElementById('go3d-resign-btn')!.onclick = () => void this.doResign();
    document.getElementById('go3d-back-to-lobby-game')!.onclick = () => void this.exit();
  }

  private fillPlayerBar(): void {
    const set = (slot: 1 | 2, name: string, elo?: number) => {
      const n = document.getElementById(`go3d-p${slot}-name`);
      const e = document.getElementById(`go3d-p${slot}-elo`);
      if (n) n.textContent = name;
      if (e) e.textContent = elo !== undefined ? String(elo) : '';
    };
    if (this.isLocal) {
      set(1, this.state.player1_name || 'Black');
      set(2, this.state.player2_name || 'White');
      return;
    }
    // Names + ELO now arrive with the game state, so label the board straight
    // away. Only fall back to a /users/{id} fetch if the server didn't supply
    // a name (e.g. an older cached payload).
    const p1Name = this.state.player1_name;
    const p2Name = this.state.player2_name;
    set(1, p1Name || `Player ${this.state.player1_id}`, this.state.player1_elo ?? undefined);
    set(2, this.state.player2_id ? (p2Name || `Player ${this.state.player2_id}`) : '(waiting)', this.state.player2_elo ?? undefined);
    if (!p1Name) {
      void Users.getProfile(this.state.player1_id)
        .then(r => set(1, r.user.username, r.user.elo)).catch(() => {});
    }
    if (this.state.player2_id && !p2Name) {
      void Users.getProfile(this.state.player2_id)
        .then(r => set(2, r.user.username, r.user.elo)).catch(() => {});
    }
  }

  private async exit(): Promise<void> {
    // See GameSession.exit — leaving a live timed game forfeits it.
    if (!this.finished && !this.isLocal && this.state.status === 'active' && this.state.time_control !== 'none') {
      const ok = await confirmModal('This is a timed game — leaving forfeits it. Resign and leave?', {
        title: 'Leave game', confirm: 'Resign & leave', cancel: 'Keep playing', danger: true,
      });
      if (!ok) return;
      try { await this.controller.submitResign(); } catch { /* surfaced via onError */ }
    }
    this.dispose();
    this.onExit();
  }

  dispose(): void {
    resetViewControls();
    this.controller.disconnect();
    this.renderer.dispose();
    music.leaveGame();
  }
}
