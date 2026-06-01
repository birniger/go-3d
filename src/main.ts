import { Go3D, TerritoryResult } from './game';
import { Renderer } from './renderer';
import { GameClock, ClockConfig, PlayerClockState, fmtTime } from './clock';

let game: Go3D;
let renderer: Renderer;
let clock: GameClock | null = null;
let currentClockCfg: ClockConfig = { mode: 'none', mainTime: 600, increment: 10, byoTime: 30, byoPeriods: 3, simpleTime: 30 };

let consecutivePasses = 0;
let territoryShowing  = false;
let cursorMode        = false;
let sliceMode: 'none' | 'x' | 'y' | 'z' = 'none';
let sliceIndex        = 0;
let gameOver          = false;
let rendererInited    = false;
let startClockTimerId: ReturnType<typeof setTimeout> | null = null;

// ── Move log & replay ────────────────────────────────────────────────────────
interface LogEntry { player: 1|2; type: 'place'|'pass'; x?: number; y?: number; z?: number }
let moveLog: LogEntry[] = [];
let replayStep = -1; // -1 = live

// ── DOM refs ─────────────────────────────────────────────────────────────────
const turnLabel    = document.getElementById('turn-label')!;
const stoneDot     = document.getElementById('stone-dot')!;
const captureLine  = document.getElementById('capture-line')!;
const sizeSelect   = document.getElementById('size-select') as HTMLSelectElement;
const customRow    = document.getElementById('custom-row')!;
const customInput  = document.getElementById('custom-size') as HTMLInputElement;
const passBtn      = document.getElementById('pass-btn')!;
const undoBtn      = document.getElementById('undo-btn')!;
const newBtn       = document.getElementById('new-btn')!;
const scoreBtn     = document.getElementById('score-btn')!;
const scorePanel   = document.getElementById('score-panel')!;
const p1ScoreLine  = document.getElementById('p1-score-line')!;
const p2ScoreLine  = document.getElementById('p2-score-line')!;
const winnerLine   = document.getElementById('winner-line')!;
const msgBox       = document.getElementById('message')!;
const msgTitle     = document.getElementById('msg-title')!;
const msgBody      = document.getElementById('msg-body')!;
const msgNewBtn    = document.getElementById('msg-new-btn')!;
// Clock
const clockDisplay  = document.getElementById('clock-display')!;
const p1ClockRow    = document.getElementById('p1-clock-row')!;
const p2ClockRow    = document.getElementById('p2-clock-row')!;
const p1TimeEl      = document.getElementById('p1-time')!;
const p2TimeEl      = document.getElementById('p2-time')!;
const p1ByoEl       = document.getElementById('p1-byo')!;
const p2ByoEl       = document.getElementById('p2-byo')!;
// Replay
const historyPanel  = document.getElementById('history-panel')!;
const moveListEl    = document.getElementById('move-list')!;
const replayBar     = document.getElementById('replay-bar')!;
const replayStepEl  = document.getElementById('replay-step')!;
// Coord jump
const coordJump     = document.getElementById('coord-jump')!;
const coordJumpInput = document.getElementById('coord-jump-input') as HTMLInputElement;
// Game-over backdrop
const msgBackdrop        = document.getElementById('msg-backdrop')!;
// Scoring
const scoringModeSelect  = document.getElementById('scoring-mode-select') as HTMLSelectElement;
const komiInput          = document.getElementById('komi-input') as HTMLInputElement;
const scorePanelLabel    = document.getElementById('score-panel-label')!;

// ── Clock ─────────────────────────────────────────────────────────────────────
function readClockConfig(): ClockConfig {
  const mode = (document.getElementById('clock-mode-select') as HTMLSelectElement).value as ClockConfig['mode'];
  const mainMins = parseInt((document.getElementById('clock-main-time') as HTMLInputElement).value) || 10;
  return {
    mode,
    mainTime:   mainMins * 60,
    increment:  parseInt((document.getElementById('clock-increment') as HTMLInputElement).value) || 10,
    byoTime:    parseInt((document.getElementById('clock-byo-time') as HTMLInputElement).value) || 30,
    byoPeriods: parseInt((document.getElementById('clock-byo-periods') as HTMLInputElement).value) || 3,
    simpleTime: parseInt((document.getElementById('clock-simple-time') as HTMLInputElement).value) || 30,
  };
}

function updateClockDisplay(s1: PlayerClockState, s2: PlayerClockState) {
  if (currentClockCfg.mode === 'none') return;
  p1TimeEl.textContent = fmtTime(s1.timeLeft);
  p2TimeEl.textContent = fmtTime(s2.timeLeft);
  if (currentClockCfg.mode === 'byoyomi') {
    p1ByoEl.textContent = s1.inByo ? `×${s1.periods}` : '';
    p2ByoEl.textContent = s2.inByo ? `×${s2.periods}` : '';
  } else {
    p1ByoEl.textContent = ''; p2ByoEl.textContent = '';
  }
  const live = replayStep < 0;
  p1ClockRow.classList.toggle('clock-active', live && game.currentPlayer === 1);
  p2ClockRow.classList.toggle('clock-active', live && game.currentPlayer === 2);
  p1TimeEl.style.color = s1.timeLeft <= 10 ? '#ff3300' : '';
  p2TimeEl.style.color = s2.timeLeft <= 10 ? '#ff3300' : '';
}

function updateClockFields() {
  const mode = (document.getElementById('clock-mode-select') as HTMLSelectElement).value;
  (document.getElementById('clock-fields-simple') as HTMLElement).style.display  = mode === 'simple'  ? 'block' : 'none';
  (document.getElementById('clock-fields-main')   as HTMLElement).style.display  = (mode === 'fischer' || mode === 'byoyomi') ? 'block' : 'none';
  (document.getElementById('clock-fields-fischer') as HTMLElement).style.display = mode === 'fischer' ? 'block' : 'none';
  (document.getElementById('clock-fields-byoyomi') as HTMLElement).style.display = mode === 'byoyomi' ? 'block' : 'none';
}

// ── Scoring helpers ───────────────────────────────────────────────────────────
function readScoringConfig(): { mode: 'chinese' | 'japanese'; komi: number } {
  const mode = scoringModeSelect.value as 'chinese' | 'japanese';
  const komi = parseFloat(komiInput.value) || 0;
  return { mode, komi };
}

function computeScores(r: TerritoryResult): { p1: number; p2: number } {
  const { mode, komi } = readScoringConfig();
  if (mode === 'japanese') {
    // Territory + prisoners (stones captured from opponent)
    return { p1: r.black + game.captured[0], p2: r.white + game.captured[1] + komi };
  }
  // Chinese: territory + stones on board
  return { p1: r.black + r.blackStones, p2: r.white + r.whiteStones + komi };
}

function fmtN(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function updateUI() {
  const isP1 = game.currentPlayer === 1;
  turnLabel.textContent = isP1 ? 'PLAYER 1' : 'PLAYER 2';
  stoneDot.style.background = isP1 ? '#0077ff' : '#ff0077';
  stoneDot.style.color      = isP1 ? '#0077ff' : '#ff0077';
  captureLine.textContent   = `CAPTURES  P1:${game.captured[0]}  P2:${game.captured[1]}`;
  if (clock) {
    const [s1, s2] = clock.getState();
    updateClockDisplay(s1, s2);
  }
}

function showScorePanel() {
  const r = game.countTerritory();
  renderer.showTerritory(r.map);
  territoryShowing = true;
  const { mode, komi } = readScoringConfig();
  const scores = computeScores(r);
  const komiStr = komi ? `  +K:${fmtN(komi)}` : '';
  scorePanelLabel.textContent = mode === 'japanese' ? 'JAPANESE SCORING' : 'CHINESE SCORING';
  if (mode === 'japanese') {
    p1ScoreLine.textContent = `P1 · T:${r.black}  +P:${game.captured[0]}  =  ${fmtN(scores.p1)}`;
    p2ScoreLine.textContent = `P2 · T:${r.white}  +P:${game.captured[1]}${komiStr}  =  ${fmtN(scores.p2)}`;
  } else {
    p1ScoreLine.textContent = `P1 · T:${r.black}  +S:${r.blackStones}  =  ${fmtN(scores.p1)}`;
    p2ScoreLine.textContent = `P2 · T:${r.white}  +S:${r.whiteStones}${komiStr}  =  ${fmtN(scores.p2)}`;
  }
  if (scores.p1 === scores.p2) {
    winnerLine.textContent = 'TIE GAME'; winnerLine.style.color = '#00e5ff';
  } else {
    const winner = scores.p1 > scores.p2 ? 'PLAYER 1' : 'PLAYER 2';
    winnerLine.textContent = `▶ ${winner}  +${fmtN(Math.abs(scores.p1 - scores.p2))}`;
    winnerLine.style.color = scores.p1 > scores.p2 ? '#00e5ff' : '#ff0077';
  }
  scorePanel.style.display = 'block';
  scoreBtn.textContent = '[ HIDE TERRITORY ]';
}

function hideScorePanel() {
  renderer.hideTerritory();
  territoryShowing = false;
  scorePanel.style.display = 'none';
  scoreBtn.textContent = '[ SCAN TERRITORY ]';
}

function showGameOver(reason?: string) {
  clock?.pause();
  gameOver = true;
  msgBackdrop.style.display = 'block';
  const r = game.countTerritory();
  const { mode, komi } = readScoringConfig();
  const scores = computeScores(r);
  const win = scores.p1 > scores.p2 ? 'PLAYER 1' : scores.p2 > scores.p1 ? 'PLAYER 2' : 'DRAW';
  msgTitle.textContent = win === 'DRAW' ? 'TIE GAME' : `${win} WINS`;
  if (reason) {
    msgBody.textContent = reason;
  } else {
    const komiStr = komi ? `  +  ${fmtN(komi)} komi` : '';
    if (mode === 'japanese') {
      msgBody.textContent =
        `P1 ▸ ${r.black} territory  +  ${game.captured[0]} prisoners  =  ${fmtN(scores.p1)}\n` +
        `P2 ▸ ${r.white} territory  +  ${game.captured[1]} prisoners${komiStr}  =  ${fmtN(scores.p2)}\n` +
        `Neutral: ${r.neutral} intersections`;
    } else {
      msgBody.textContent =
        `P1 ▸ ${r.black} territory  +  ${r.blackStones} stones  =  ${fmtN(scores.p1)}\n` +
        `P2 ▸ ${r.white} territory  +  ${r.whiteStones} stones${komiStr}  =  ${fmtN(scores.p2)}\n` +
        `Neutral: ${r.neutral} intersections`;
    }
  }
  renderer.showTerritory(r.map);
  msgBox.style.display = 'block';
}

function resolveSize(): number {
  if (sizeSelect.value === 'custom') {
    const v = parseInt(customInput.value, 10);
    return Math.min(19, Math.max(2, isNaN(v) ? 7 : v));
  }
  return parseInt(sizeSelect.value, 10);
}

// ── Move log ──────────────────────────────────────────────────────────────────
function coordStr(e: LogEntry) {
  if (e.type === 'pass') return 'PASS';
  return `${String.fromCharCode(65+e.x!)}${e.y!+1}·${String.fromCharCode(97+e.z!)}`;
}

function addToLog(entry: LogEntry) {
  moveLog.push(entry);
  const div = document.createElement('div');
  div.className = `move-entry move-p${entry.player}`;
  div.dataset.idx = String(moveLog.length - 1);
  div.textContent = `${moveLog.length}. P${entry.player} ${coordStr(entry)}`;
  div.addEventListener('click', () => enterReplay(parseInt(div.dataset.idx!)));
  moveListEl.appendChild(div);
  moveListEl.scrollTop = moveListEl.scrollHeight;
  historyPanel.style.display = 'block';
}

// ── Replay ────────────────────────────────────────────────────────────────────
function buildReplayState(upTo: number): Go3D {
  const g = new Go3D(game.size);
  for (let i = 0; i <= upTo && i < moveLog.length; i++) {
    const e = moveLog[i];
    if (e.type === 'place') g.place(e.x!, e.y!, e.z!);
    else g.pass();
  }
  return g;
}

function highlightMoveEntry(idx: number) {
  document.querySelectorAll<HTMLElement>('.move-entry').forEach((el) => {
    const i = parseInt(el.dataset.idx!);
    el.classList.toggle('active', i === idx);
    if (i === idx) el.scrollIntoView({ block: 'nearest' });
  });
}

function gotoReplayStep(step: number) {
  replayStep = Math.max(0, Math.min(moveLog.length - 1, step));
  const g = buildReplayState(replayStep);
  renderer.showBoardState(g.board, g.lastMove);
  replayStepEl.textContent = `${replayStep + 1} / ${moveLog.length}`;
  highlightMoveEntry(replayStep);
}

function enterReplay(step: number) {
  if (moveLog.length === 0) return;
  msgBackdrop.style.display = 'none';
  renderer.setReplayMode(true);
  renderer.hideTerritory();
  replayBar.style.display = 'flex';
  historyPanel.style.display = 'block';
  gotoReplayStep(step);
}

function exitReplay() {
  replayStep = -1;
  renderer.setReplayMode(false);
  renderer.updateStones();
  if (territoryShowing) showScorePanel();
  replayBar.style.display = 'none';
  highlightMoveEntry(-1);
}

// ── Core game actions ─────────────────────────────────────────────────────────
function doPlace(x: number, y: number, z: number) {
  if (replayStep >= 0) return;
  if (gameOver) return;
  const placingPlayer = game.currentPlayer;
  if (game.place(x, y, z)) {
    consecutivePasses = 0;
    addToLog({ player: placingPlayer, type: 'place', x, y, z });
    clock?.confirmMove();
    renderer.playPlaceSound();
    if (game.lastCaptured.length > 0) {
      const capturedBy = game.currentPlayer === 1 ? 2 : 1;
      renderer.triggerCaptures(game.lastCaptured, capturedBy as 1|2);
      renderer.playCaptureSound(game.lastCaptured.length);
    }
    renderer.updateStones();
    if (territoryShowing) showScorePanel();
    updateUI();
    clock?.startTurn(game.currentPlayer);
  } else {
    renderer.forbiddenFlash(x, y, z);
  }
}

function doPass() {
  if (replayStep >= 0) return;
  if (gameOver) return;
  const passingPlayer = game.currentPlayer;
  consecutivePasses++;
  game.pass();
  addToLog({ player: passingPlayer, type: 'pass' });
  clock?.confirmMove();
  renderer.playPassSound();
  updateUI();
  if (consecutivePasses >= 2) { showGameOver(); return; }
  clock?.startTurn(game.currentPlayer);
}

function doUndo() {
  if (replayStep >= 0) { exitReplay(); return; }
  if (game.undo()) {
    moveLog.pop();
    // Recount trailing passes so double-pass detection stays accurate after undo
    consecutivePasses = 0;
    for (let i = moveLog.length - 1; i >= 0; i--) {
      if (moveLog[i].type === 'pass') consecutivePasses++;
      else break;
    }
    // Remove last entry from DOM list
    const last = moveListEl.lastElementChild;
    if (last) last.remove();
    if (moveLog.length === 0) historyPanel.style.display = 'none';
    clock?.pause();
    renderer.clearAnimations();
    renderer.updateStones();
    renderer.playUndoSound();
    if (territoryShowing) showScorePanel();
    updateUI();
    if (clock) clock.startTurn(game.currentPlayer);
  }
}

// ── Keyboard cursor ───────────────────────────────────────────────────────────
function activateCursor() {
  // Exit slice mode when switching to keyboard cursor
  if (sliceMode !== 'none') { sliceMode = 'none'; renderer.setSlice('none', 0); }
  if (!cursorMode) {
    cursorMode = true;
    const hover = renderer.getLastHover();
    const c = Math.floor(game.size / 2);
    const pos = hover ?? { x: c, y: c, z: c };
    renderer.setCursorPos(pos.x, pos.y, pos.z);
    renderer.setCursorActive(true);
  }
}

function deactivateCursor() {
  if (cursorMode) {
    cursorMode = false;
    renderer.setCursorActive(false);
  }
}

function toggleSlice(axis: 'x' | 'y' | 'z') {
  deactivateCursor();
  if (sliceMode === axis) {
    // Toggle off
    sliceMode = 'none';
    renderer.setSlice('none', 0);
  } else {
    // Enter slice mode at middle of cube
    sliceMode  = axis;
    sliceIndex = Math.floor(game.size / 2);
    renderer.setSlice(axis, sliceIndex);
  }
}

// ── Coord jump ────────────────────────────────────────────────────────────────
function parseCoord(s: string): [number, number, number] | null {
  const m = s.match(/^([A-Sa-s])(\d{1,2})([a-s])$/);
  if (!m) return null;
  const x = m[1].toUpperCase().charCodeAt(0) - 65;
  const y = parseInt(m[2]) - 1;
  const z = m[3].charCodeAt(0) - 97;
  if (x < 0 || x >= game.size || y < 0 || y >= game.size || z < 0 || z >= game.size) return null;
  return [x, y, z];
}

function showCoordJump() {
  coordJump.style.display = 'flex';
  coordJumpInput.value = '';
  coordJumpInput.focus();
  activateCursor();
}

function hideCoordJump() {
  coordJump.style.display = 'none';
}

coordJumpInput.addEventListener('input', () => {
  const parsed = parseCoord(coordJumpInput.value);
  if (parsed) {
    // Ensure slice mode is cleared and cursor is active
    if (sliceMode !== 'none') { sliceMode = 'none'; renderer.setSlice('none', 0); }
    if (!cursorMode) { cursorMode = true; renderer.setCursorActive(true); }
    renderer.setCursorPos(parsed[0], parsed[1], parsed[2]);
  }
});

coordJumpInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const parsed = parseCoord(coordJumpInput.value);
    if (parsed) doPlace(parsed[0], parsed[1], parsed[2]);
    hideCoordJump();
    e.stopPropagation();
  }
  if (e.key === 'Escape') { hideCoordJump(); deactivateCursor(); e.stopPropagation(); }
});

// ── New game ──────────────────────────────────────────────────────────────────
function startGame() {
  // Cancel stale clock start timer from previous game
  if (startClockTimerId !== null) { clearTimeout(startClockTimerId); startClockTimerId = null; }
  // Dispose the previous renderer (stops its RAF loop and frees GPU resources)
  if (rendererInited) renderer.dispose();

  msgBox.style.display       = 'none';
  msgBackdrop.style.display  = 'none';
  gameOver                   = false;
  consecutivePasses          = 0;
  territoryShowing           = false;
  cursorMode                 = false;
  sliceMode                  = 'none';
  sliceIndex                 = 0;
  moveLog                    = [];
  replayStep                 = -1;
  scorePanel.style.display   = 'none';
  scoreBtn.textContent       = '[ SCAN TERRITORY ]';
  replayBar.style.display    = 'none';
  historyPanel.style.display = 'none';
  moveListEl.innerHTML       = '';
  hideCoordJump();

  clock?.destroy();
  clock = null;

  game = new Go3D(resolveSize());
  currentClockCfg = readClockConfig();

  renderer = new Renderer(game, doPlace);
  rendererInited = true;

  if (currentClockCfg.mode !== 'none') {
    clockDisplay.style.display = 'block';
    clock = new GameClock(currentClockCfg);
    clock.onTick = (s1, s2) => updateClockDisplay(s1, s2);
    clock.onFlag = (player) => {
      const winner = player === 1 ? 'PLAYER 2' : 'PLAYER 1';
      showGameOver(`${winner} WINS — Player ${player} ran out of time.`);
    };
    // Brief delay so intro orbit can start before clock pressure; store id to allow cancellation
    startClockTimerId = setTimeout(() => { startClockTimerId = null; clock?.startTurn(1); }, 2000);
    const [s1, s2] = clock.getState();
    updateClockDisplay(s1, s2);
  } else {
    clockDisplay.style.display = 'none';
  }

  updateUI();
}

// ── Buttons ───────────────────────────────────────────────────────────────────
passBtn.addEventListener('click', doPass);
undoBtn.addEventListener('click', doUndo);
newBtn.addEventListener('click', startGame);
msgNewBtn.addEventListener('click', startGame);

scoreBtn.addEventListener('click', () => {
  if (territoryShowing) hideScorePanel(); else showScorePanel();
});

document.getElementById('replay-prev')!.addEventListener('click', () => {
  if (replayStep > 0) gotoReplayStep(replayStep - 1);
});
document.getElementById('replay-next')!.addEventListener('click', () => {
  if (replayStep < moveLog.length - 1) gotoReplayStep(replayStep + 1);
});
document.getElementById('replay-exit')!.addEventListener('click', exitReplay);

// Size selector
sizeSelect.addEventListener('change', () => {
  const isCustom = sizeSelect.value === 'custom';
  customRow.style.display = isCustom ? 'block' : 'none';
  if (!isCustom) startGame();
});
function applyCustomSize() {
  const v = parseInt(customInput.value, 10);
  if (isNaN(v) || v < 2) customInput.value = '2';
  if (v > 19)            customInput.value = '19';
  startGame();
}
customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCustomSize(); });
customInput.addEventListener('blur', applyCustomSize);

// Clock settings
document.getElementById('clock-mode-select')!.addEventListener('change', updateClockFields);

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
window.addEventListener('mousemove', () => { if (cursorMode) deactivateCursor(); });

window.addEventListener('keydown', (e) => {
  // Skip if typing in any input (except coord-jump which is handled separately)
  if (document.activeElement instanceof HTMLInputElement &&
      document.activeElement !== coordJumpInput) return;
  if (document.activeElement === coordJumpInput) return;

  switch (e.key) {
    // ── Slice mode: X / Y / Z toggle ────────────────────────────────────────
    case 'x': case 'X': toggleSlice('x'); break;
    case 'y': case 'Y': toggleSlice('y'); break;
    case 'z': case 'Z': toggleSlice('z'); break;

    // ── Arrow keys: navigate slice OR move cursor ────────────────────────────
    case 'ArrowLeft':
      e.preventDefault();
      if (sliceMode === 'x') {
        sliceIndex = Math.max(0, sliceIndex - 1);
        renderer.setSlice(sliceMode, sliceIndex);
      } else {
        activateCursor(); renderer.moveCursor(-1, 0, 0);
      }
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (sliceMode === 'x') {
        sliceIndex = Math.min(game.size - 1, sliceIndex + 1);
        renderer.setSlice(sliceMode, sliceIndex);
      } else {
        activateCursor(); renderer.moveCursor(1, 0, 0);
      }
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (sliceMode === 'z') {
        sliceIndex = Math.max(0, sliceIndex - 1);
        renderer.setSlice(sliceMode, sliceIndex);
      } else {
        activateCursor(); renderer.moveCursor(0, 0, -1);
      }
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (sliceMode === 'z') {
        sliceIndex = Math.min(game.size - 1, sliceIndex + 1);
        renderer.setSlice(sliceMode, sliceIndex);
      } else {
        activateCursor(); renderer.moveCursor(0, 0, 1);
      }
      break;
    case 'e': case 'E':
      if (sliceMode === 'y') {
        sliceIndex = Math.min(game.size - 1, sliceIndex + 1);
        renderer.setSlice('y', sliceIndex);
      } else {
        activateCursor(); renderer.moveCursor(0, 1, 0);
      }
      break;
    case 'q': case 'Q':
      if (sliceMode === 'y') {
        sliceIndex = Math.max(0, sliceIndex - 1);
        renderer.setSlice('y', sliceIndex);
      } else {
        activateCursor(); renderer.moveCursor(0, -1, 0);
      }
      break;

    case 'Enter': {
      if (cursorMode && sliceMode === 'none') {
        const pos = renderer.getCursorPos();
        doPlace(pos.x, pos.y, pos.z);
      }
      break;
    }
    case 'p': case 'P': doPass(); break;
    case 'u': case 'U': doUndo(); break;
    case 'n': case 'N': startGame(); break;
    case 't': case 'T':
      if (territoryShowing) hideScorePanel(); else showScorePanel(); break;
    case '/': { e.preventDefault(); showCoordJump(); break; }
    case 'Escape': {
      if (replayStep >= 0) { exitReplay(); break; }
      if (sliceMode !== 'none') { sliceMode = 'none'; renderer.setSlice('none', 0); break; }
      deactivateCursor();
      break;
    }
    // Face-cam shortcuts
    case '1': renderer.faceCam('top');   break;
    case '2': renderer.faceCam('front'); break;
    case '3': renderer.faceCam('side');  break;
    case '4': renderer.faceCam('iso');   break;
  }
});

// Expose enterReplay for the modal "Review Game" button
(window as unknown as Record<string, unknown>).__enterReplay =
  (step: number) => enterReplay(step ?? 0);

// Initial clock field visibility
updateClockFields();
startGame();
