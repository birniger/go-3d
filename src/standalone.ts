/**
 * Standalone GitHub Pages entry point.
 *
 * Zero backend: this is the same hot-seat experience you reach via the WordPress
 * plugin's "Play locally" button — every board mode (cube / stack / sphere) and
 * every time control — but with no auth, lobby, or server. It reuses the exact
 * session shells (GameSession / SphereGameSession) and the LocalController, so
 * rules, rendering, clocks and scoring are identical to an online game.
 */

import '../wp-plugin/go3d/assets/go3d.css';
import { bindGameForm, LOCAL_SETUP_FORM_IDS, GameFormSettings } from './game-form';
import {
  GameSession,
  SphereGameSession,
  buildLocalState,
  ControllerFactory,
} from './game-session';
import { LocalController, LocalGameConfig } from './local-controller';
import { showToast } from './lobby';

let session: GameSession | SphereGameSession | null = null;

/** Toggle which `.go3d-screen` is visible (setup ⇄ game). */
function showScreen(id: 'go3d-local-setup' | 'go3d-game-screen'): void {
  document.querySelectorAll<HTMLElement>('.go3d-screen').forEach(el => {
    el.style.display = el.id === id ? '' : 'none';
  });
}

/** Launch a hot-seat game from the setup form's normalised settings. */
function startLocal(s: GameFormSettings): void {
  const config: LocalGameConfig = {
    mode:          s.mode,
    board_size:    s.board_size,
    scoring_mode:  s.scoring_mode,
    komi:          s.komi,
    time_control:  s.time_control,
    time_settings: s.time_settings,
  };
  startLocalState(buildLocalState(config));
}

function startLocalState(state: ReturnType<typeof buildLocalState>): void {
  showScreen('go3d-game-screen');
  if (session) { session.dispose(); session = null; }
  try {
    const onExit   = () => { session = null; showScreen('go3d-local-setup'); };
    const makeLocal: ControllerFactory = (st, c) => new LocalController(st, c);
    const onReload = (next?: typeof state) => { if (next) startLocalState(next); };
    session = state.mode === 'sphere'
      ? new SphereGameSession(state, onExit, makeLocal, onReload)
      : new GameSession(state, onExit, makeLocal, onReload);
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Could not start game.', 'error');
    showScreen('go3d-local-setup');
  }
}

function boot(): void {
  if (!document.getElementById('go3d-root')) return;
  const read = bindGameForm(LOCAL_SETUP_FORM_IDS);
  document.getElementById('go3d-ls-form')?.addEventListener('submit', e => {
    e.preventDefault();
    startLocal(read());
  });
  showScreen('go3d-local-setup');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
