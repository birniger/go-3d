/**
 * Lobby UI controller.
 * Manages the screen flow: Auth → Lobby → Game.
 * Renders open games, active games, new-game form, and user profile.
 */

import { AuthState, apiErrorMessage } from './auth';
import { Games, Users, GameSummary, User, ApiError } from './api';
import { formatClock } from './multiplayer';

// ── Screen management ─────────────────────────────────────────────────────────

export type Screen = 'auth' | 'lobby' | 'game' | 'profile' | 'local' | 'local-setup';

type ScreenChangeCallback = (screen: Screen, data?: unknown) => void;

// Normalised new-game settings, shared by the lobby form (server create +
// post-login local) and the pre-login local-setup form.
interface GameFormSettings {
  board_size:    number;
  mode:          'cube' | 'stack' | 'sphere';
  scoring_mode:  'chinese' | 'japanese';
  komi:          number;
  time_control:  string;
  time_settings: Record<string, number> | null;
}

// Element IDs for one game-config form. Two instances exist with different
// prefixes (lobby `go3d-*`, pre-login `go3d-ls-*`) but identical behaviour.
interface GameFormIds {
  form:              string;
  timeControlSelect: string;
  timeSettings:      string;
  byoyomiExtra:      string;
  fischerExtra:      string;
  modeSelect:        string;
  cubeWrap:          string;
  sphereWrap:        string;
  sphereSize:        string;
  sphereFreq:        string;
  cubeSize:          string;
  cubeCustom:        string;
}

const LOBBY_FORM_IDS: GameFormIds = {
  form:              'go3d-new-game-form',
  timeControlSelect: 'go3d-time-control-select',
  timeSettings:      'go3d-time-settings',
  byoyomiExtra:      'go3d-byoyomi-extra',
  fischerExtra:      'go3d-fischer-extra',
  modeSelect:        'go3d-mode-select',
  cubeWrap:          'go3d-cube-size-wrap',
  sphereWrap:        'go3d-sphere-size-wrap',
  sphereSize:        'go3d-sphere-size',
  sphereFreq:        'go3d-sphere-freq',
  cubeSize:          'go3d-cube-size',
  cubeCustom:        'go3d-cube-custom',
};

const LOCAL_SETUP_FORM_IDS: GameFormIds = {
  form:              'go3d-ls-form',
  timeControlSelect: 'go3d-ls-time-control-select',
  timeSettings:      'go3d-ls-time-settings',
  byoyomiExtra:      'go3d-ls-byoyomi-extra',
  fischerExtra:      'go3d-ls-fischer-extra',
  modeSelect:        'go3d-ls-mode-select',
  cubeWrap:          'go3d-ls-cube-size-wrap',
  sphereWrap:        'go3d-ls-sphere-size-wrap',
  sphereSize:        'go3d-ls-sphere-size',
  sphereFreq:        'go3d-ls-sphere-freq',
  cubeSize:          'go3d-ls-cube-size',
  cubeCustom:        'go3d-ls-cube-custom',
};

// ── Lobby class ───────────────────────────────────────────────────────────────

export class Lobby {
  private onScreenChange: ScreenChangeCallback;
  private presenceCleanup: (() => void) | null = null;

  constructor(onScreenChange: ScreenChangeCallback) {
    this.onScreenChange = onScreenChange;
    this.bindAuthUI();
    this.bindLobbyUI();
  }

  // ── Auth UI ───────────────────────────────────────────────────────────────

  private bindAuthUI(): void {
    // Tab switching
    document.querySelectorAll<HTMLButtonElement>('.go3d-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab!;
        document.querySelectorAll<HTMLButtonElement>('.go3d-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        document.querySelectorAll<HTMLElement>('.go3d-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
        document.getElementById('go3d-forgot-form')!.style.display = 'none';
      });
    });

    // Login form
    document.getElementById('go3d-login-form')!.addEventListener('submit', async e => {
      e.preventDefault();
      const form  = e.currentTarget as HTMLFormElement;
      const email = (form.elements.namedItem('email') as HTMLInputElement).value;
      const pass  = (form.elements.namedItem('password') as HTMLInputElement).value;
      const errEl = form.querySelector<HTMLElement>('.go3d-form-error')!;
      errEl.textContent = '';
      try {
        await AuthState.login(email, pass);
        this.showLobby();
      } catch (err) {
        errEl.textContent = apiErrorMessage(err);
      }
    });

    // Register form
    document.getElementById('go3d-register-form')!.addEventListener('submit', async e => {
      e.preventDefault();
      const form     = e.currentTarget as HTMLFormElement;
      const username = (form.elements.namedItem('username') as HTMLInputElement).value;
      const email    = (form.elements.namedItem('email')    as HTMLInputElement).value;
      const pass     = (form.elements.namedItem('password') as HTMLInputElement).value;
      const errEl    = form.querySelector<HTMLElement>('.go3d-form-error')!;
      errEl.textContent = '';
      try {
        await AuthState.register(username, email, pass);
        errEl.style.color = '#0f0';
        errEl.textContent = '✓ Account created! Check your email to verify, then log in.';
        document.querySelector<HTMLButtonElement>('[data-tab="login"]')!.click();
      } catch (err) {
        errEl.textContent = apiErrorMessage(err);
      }
    });

    // Forgot password
    document.getElementById('go3d-forgot-link')!.addEventListener('click', e => {
      e.preventDefault();
      document.getElementById('go3d-login-form')!.style.display = 'none';
      document.getElementById('go3d-forgot-form')!.style.display = '';
    });
    document.getElementById('go3d-back-to-login')!.addEventListener('click', e => {
      e.preventDefault();
      document.getElementById('go3d-forgot-form')!.style.display = 'none';
      document.getElementById('go3d-login-form')!.style.display = '';
    });

    document.getElementById('go3d-forgot-form')!.addEventListener('submit', async e => {
      e.preventDefault();
      const form  = e.currentTarget as HTMLFormElement;
      const email = (form.elements.namedItem('email') as HTMLInputElement).value;
      const errEl = form.querySelector<HTMLElement>('.go3d-form-error')!;
      try {
        await AuthState.requestReset(email);
        errEl.style.color = '#0f0';
        errEl.textContent = '✓ If that email exists, a reset link has been sent.';
      } catch {
        errEl.textContent = 'Something went wrong. Please try again.';
      }
    });

    // Handle ?go3d_reset_token= in URL (redirect from WP)
    const url   = new URL(window.location.href);
    const rTok  = url.searchParams.get('go3d_reset_token');
    if (rTok) {
      this.showResetForm(rTok);
    }
    const verified = url.searchParams.get('go3d_verified');
    if (verified === '1') {
      showToast('Email verified! You can now log in.', 'success');
    }
  }

  private showResetForm(token: string): void {
    const authEl = document.getElementById('go3d-auth')!;
    authEl.style.display = '';

    // Build a mini reset form
    const wrap = document.createElement('div');
    wrap.className = 'go3d-form';
    wrap.innerHTML = `
      <h2>Set new password</h2>
      <label>New password<input type="password" name="new_password" minlength="8" required autocomplete="new-password"></label>
      <div class="go3d-form-error"></div>
      <button type="button" class="go3d-btn-primary" id="go3d-do-reset">Set password</button>
    `;
    authEl.appendChild(wrap);

    wrap.querySelector<HTMLButtonElement>('#go3d-do-reset')!.addEventListener('click', async () => {
      const pw    = (wrap.querySelector<HTMLInputElement>('[name=new_password]'))!.value;
      const errEl = wrap.querySelector<HTMLElement>('.go3d-form-error')!;
      try {
        await AuthState.resetPassword(token, pw);
        errEl.style.color = '#0f0';
        errEl.textContent = '✓ Password changed! You can now log in.';
        wrap.remove();
      } catch (err) {
        errEl.textContent = apiErrorMessage(err);
      }
    });
  }

  // ── Lobby UI ──────────────────────────────────────────────────────────────

  private bindLobbyUI(): void {
    document.getElementById('go3d-logout-btn')!.addEventListener('click', () => {
      AuthState.logout();
      this.showAuth();
    });

    document.getElementById('go3d-profile-link')!.addEventListener('click', e => {
      e.preventDefault();
      this.showProfile(AuthState.user!.id);
    });

    document.getElementById('go3d-refresh-open')!.addEventListener('click', () => void this.loadOpenGames());
    document.getElementById('go3d-refresh-leaderboard')?.addEventListener('click', () => void this.loadLeaderboard());

    // Lobby new-game form: server "Create open game" + post-login "Play locally".
    const readLobby = this.bindGameForm(LOBBY_FORM_IDS);
    document.getElementById('go3d-new-game-form')!.addEventListener('submit', async e => {
      e.preventDefault();
      const s        = readLobby();
      const settings: Record<string, unknown> = {
        board_size:   s.board_size,
        mode:         s.mode,
        scoring_mode: s.scoring_mode,
        komi:         s.komi,
        time_control: s.time_control,
      };
      if (s.time_settings) settings.time_settings = s.time_settings;
      try {
        const res = await Games.create(settings as Parameters<typeof Games.create>[0]);
        showToast('Game created! Waiting for an opponent…', 'info');
        void this.loadOpenGames();
        void this.loadActiveGames();
        this.onScreenChange('game', res.game_id);
      } catch (err) {
        showToast(apiErrorMessage(err), 'error');
      }
    });
    document.getElementById('go3d-play-local-btn')?.addEventListener('click', () => {
      this.startLocal(readLobby());
    });

    // Pre-login local-setup form, reachable from the auth screen so two players
    // can share one screen with no account — same modes/time controls as online.
    const readLocalSetup = this.bindGameForm(LOCAL_SETUP_FORM_IDS);
    document.getElementById('go3d-auth-local-btn')?.addEventListener('click', () => {
      setScreen('local-setup');
    });
    document.getElementById('go3d-ls-form')?.addEventListener('submit', e => {
      e.preventDefault();
      this.startLocal(readLocalSetup());
    });
    document.getElementById('go3d-ls-back')?.addEventListener('click', () => {
      if (AuthState.user) void this.showLobby();
      else this.showAuth();
    });
  }

  // Wire one game-config form's show/hide toggles + size clamps, and return a
  // reader that normalises its current values into GameFormSettings. The lobby
  // and pre-login local-setup forms share this so the two paths never drift.
  private bindGameForm(ids: GameFormIds): () => GameFormSettings {
    const tcSel = document.getElementById(ids.timeControlSelect) as HTMLSelectElement;
    const tsDiv = document.getElementById(ids.timeSettings)!;
    const bDiv  = document.getElementById(ids.byoyomiExtra)!;
    const fDiv  = document.getElementById(ids.fischerExtra)!;
    tcSel.addEventListener('change', () => {
      tsDiv.style.display = tcSel.value === 'none' ? 'none' : '';
      bDiv.style.display  = tcSel.value === 'byoyomi'  ? '' : 'none';
      fDiv.style.display  = tcSel.value === 'fischer'  ? '' : 'none';
    });

    // Mode selector: cube/stack use the cube size dropdown; sphere swaps in the
    // geodesic size selector (presets + a custom frequency input).
    const modeSel    = document.getElementById(ids.modeSelect) as HTMLSelectElement;
    const cubeWrap   = document.getElementById(ids.cubeWrap)!;
    const sphereWrap = document.getElementById(ids.sphereWrap)!;
    const sphereSel  = document.getElementById(ids.sphereSize) as HTMLSelectElement;
    const sphereFreq = document.getElementById(ids.sphereFreq) as HTMLInputElement;
    const cubeSel    = document.getElementById(ids.cubeSize)   as HTMLSelectElement;
    const cubeCustom = document.getElementById(ids.cubeCustom) as HTMLInputElement;
    modeSel.addEventListener('change', () => {
      const isSphere = modeSel.value === 'sphere';
      cubeWrap.style.display   = isSphere ? 'none' : '';
      sphereWrap.style.display = isSphere ? '' : 'none';
    });
    sphereSel.addEventListener('change', () => {
      sphereFreq.style.display = sphereSel.value === 'custom' ? '' : 'none';
    });
    cubeSel.addEventListener('change', () => {
      cubeCustom.style.display = cubeSel.value === 'custom' ? '' : 'none';
    });
    // Live-clamp the custom size inputs to their valid range so a typed value
    // can never exceed the max (cube 2–19, sphere frequency 2–8).
    const clampInput = (el: HTMLInputElement, lo: number, hi: number) => () => {
      const v = Number(el.value);
      if (Number.isFinite(v) && v > hi) el.value = String(hi);
      else if (Number.isFinite(v) && v < lo && el.value !== '') el.value = String(lo);
    };
    cubeCustom.addEventListener('change', clampInput(cubeCustom, 2, 19));
    sphereFreq.addEventListener('change', clampInput(sphereFreq, 2, 8));

    return (): GameFormSettings => {
      const form = document.getElementById(ids.form) as HTMLFormElement;
      const fd   = new FormData(form);
      const tc   = fd.get('time_control') as string;
      const mode = fd.get('mode') as string;
      // Sphere games store the geodesic frequency in board_size; cube/stack use
      // the lattice edge length. Both size selectors live outside the form (no
      // name attr) so we read them directly, resolving the "custom" preset.
      let boardSize: number;
      if (mode === 'sphere') {
        boardSize = sphereSel.value === 'custom'
          ? Math.max(2, Math.min(8, Number(sphereFreq.value)))
          : Number(sphereSel.value);
      } else {
        boardSize = cubeSel.value === 'custom'
          ? Math.max(2, Math.min(19, Number(cubeCustom.value)))
          : Number(cubeSel.value);
      }
      let timeSettings: Record<string, number> | null = null;
      if (tc !== 'none') {
        timeSettings = { main_time_s: Number(fd.get('main_time_s')) };
        if (tc === 'byoyomi') {
          timeSettings.byoyomi_periods = Number(fd.get('byoyomi_periods'));
          timeSettings.byoyomi_time_s  = Number(fd.get('byoyomi_time_s'));
        }
        if (tc === 'fischer') {
          timeSettings.fischer_increment_s = Number(fd.get('fischer_increment_s'));
        }
      }
      return {
        board_size:   boardSize,
        mode:         mode as 'cube' | 'stack' | 'sphere',
        scoring_mode: (fd.get('scoring_mode') as string) === 'japanese' ? 'japanese' : 'chinese',
        komi:         Number(fd.get('komi')),
        time_control: tc,
        time_settings: timeSettings,
      };
    };
  }

  // Start a hot-seat game from normalised form settings (same surface whether
  // launched from the lobby or pre-login). app.ts wires up the LocalController.
  private startLocal(s: GameFormSettings): void {
    this.onScreenChange('local', {
      mode:          s.mode,
      board_size:    s.board_size,
      scoring_mode:  s.scoring_mode,
      komi:          s.komi,
      time_control:  s.time_control,
      time_settings: s.time_settings,
    });
  }

  // ── Show screens ──────────────────────────────────────────────────────────

  showAuth(): void {
    setScreen('auth');
  }

  async showLobby(): Promise<void> {
    const user = AuthState.user;
    if (!user) { this.showAuth(); return; }

    document.getElementById('go3d-lobby-username')!.textContent = user.username;
    document.getElementById('go3d-lobby-elo')!.textContent      = String(user.elo);

    setScreen('lobby');
    await Promise.all([this.loadOpenGames(), this.loadActiveGames(), this.loadLeaderboard()]);
  }

  private async loadLeaderboard(): Promise<void> {
    const tbody = document.querySelector<HTMLTableSectionElement>('#go3d-leaderboard-table tbody');
    const empty = document.getElementById('go3d-no-leaderboard');
    if (!tbody || !empty) return;
    try {
      const { players } = await Users.leaderboard(20);
      tbody.innerHTML = '';
      if (players.length === 0) {
        empty.style.display = '';
        empty.textContent = 'No ranked players yet.';
        return;
      }
      empty.style.display = 'none';
      const myId = AuthState.user?.id;
      players.forEach((p, i) => {
        const tr = document.createElement('tr');
        if (p.id === myId) tr.className = 'go3d-row-me';
        tr.innerHTML = `
          <td>${i + 1}</td>
          <td><a href="#" class="go3d-lb-name" data-id="${p.id}">${escHtml(p.username)}</a></td>
          <td>${p.elo}</td>
          <td>${p.wins}</td>
          <td>${p.losses}</td>
          <td>${p.draws}</td>`;
        tbody.appendChild(tr);
      });
      tbody.querySelectorAll<HTMLAnchorElement>('.go3d-lb-name').forEach(a => {
        a.addEventListener('click', e => { e.preventDefault(); this.showProfile(Number(a.dataset.id)); });
      });
    } catch {
      empty.style.display = '';
      empty.textContent = 'Could not load the leaderboard.';
    }
  }

  showProfile(userId: number): void {
    setScreen('profile');
    void this.loadProfile(userId);
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  private async loadOpenGames(): Promise<void> {
    const tbody = document.querySelector<HTMLTableSectionElement>('#go3d-open-games-table tbody')!;
    const empty = document.getElementById('go3d-no-open-games')!;
    try {
      const { games } = await Games.listOpen();
      const myId = AuthState.user?.id;
      tbody.innerHTML = '';
      if (games.length === 0) {
        empty.style.display = '';
      } else {
        empty.style.display = 'none';
        for (const g of games) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${escHtml(g.player1_name ?? `Player ${g.player1_id}`)}</td>
            <td>${boardLabel(g)}</td>
            <td>${escHtml(g.scoring_mode)}</td>
            <td>${g.komi}</td>
            <td>${escHtml(g.time_control)}</td>
            <td>${g.player1_id === myId
              ? '<span class="go3d-chip">Your game</span>'
              : `<button class="go3d-btn-primary go3d-btn-sm go3d-join-btn" data-id="${g.id}">Join</button>`
            }</td>`;
          tbody.appendChild(tr);
        }
        tbody.querySelectorAll<HTMLButtonElement>('.go3d-join-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const id = Number(btn.dataset.id);
            try {
              await Games.join(id);
              this.onScreenChange('game', id);
            } catch (err) {
              showToast(apiErrorMessage(err), 'error');
            }
          });
        });
      }
    } catch {
      empty.style.display = '';
      empty.textContent = 'Could not load open games.';
    }
  }

  private async loadActiveGames(): Promise<void> {
    const tbody = document.querySelector<HTMLTableSectionElement>('#go3d-active-games-table tbody')!;
    const empty = document.getElementById('go3d-no-active-games')!;
    try {
      const myId     = AuthState.user!.id;
      const [active] = await Promise.all([Games.list('active')]);
      const games    = active.games;

      tbody.innerHTML = '';
      if (games.length === 0) {
        empty.style.display = '';
      } else {
        empty.style.display = 'none';
        for (const g of games) {
          const iAmP1     = g.player1_id === myId;
          const oppName   = iAmP1 ? g.player2_name : g.player1_name;
          const oppId     = iAmP1 ? g.player2_id : g.player1_id;
          const oppLabel  = oppName ?? (oppId ? `Player ${oppId}` : '(waiting)');
          const myTurn    = g.current_player === (iAmP1 ? 1 : 2);
          const lastMove  = g.last_move_at ? new Date(g.last_move_at).toLocaleDateString() : '—';
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${escHtml(oppLabel)}</td>
            <td>${boardLabel(g)}</td>
            <td>${myTurn ? '<span class="go3d-chip go3d-chip-green">Your turn</span>' : '—'}</td>
            <td>${escHtml(lastMove)}</td>
            <td><button class="go3d-btn-primary go3d-btn-sm go3d-open-game-btn" data-id="${g.id}">Play</button></td>`;
          tbody.appendChild(tr);
        }
        tbody.querySelectorAll<HTMLButtonElement>('.go3d-open-game-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            this.onScreenChange('game', Number(btn.dataset.id));
          });
        });
      }
    } catch {
      empty.style.display = '';
      empty.textContent = 'Could not load your games.';
    }
  }

  private async loadProfile(userId: number): Promise<void> {
    const content = document.getElementById('go3d-profile-content')!;
    content.textContent = 'Loading…';
    document.getElementById('go3d-back-to-lobby')!.onclick = () => void this.showLobby();

    try {
      const { user, recent_games } = await Users.getProfile(userId);
      const isMe = user.id === AuthState.user?.id;
      document.getElementById('go3d-profile-heading')!.textContent = user.username;

      const gamesHtml = recent_games.map(g => {
        const won  = g.winner_id === userId;
        const lost = g.winner_id !== null && g.winner_id !== userId;
        const badge = won ? '✓ Win' : lost ? '✗ Loss' : '— Draw';
        // Show the ELO delta from THIS profile's perspective: pick p1's or p2's
        // change depending on which slot this user occupied in that game.
        const delta = g.player1_id === userId ? g.elo_change_p1 : g.elo_change_p2;
        const deltaStr = delta === null || delta === undefined
          ? ''
          : (delta > 0 ? `+${delta}` : String(delta));
        return `<tr><td>${boardLabel(g)}</td><td>${escHtml(g.scoring_mode)}</td><td>${badge}</td><td>${escHtml(deltaStr)}</td></tr>`;
      }).join('');

      content.innerHTML = `
        <div class="go3d-profile-hero">
          ${user.avatar_url ? `<img class="go3d-avatar" src="${escHtml(user.avatar_url)}" alt="">` : `<div class="go3d-avatar-placeholder">${escHtml(user.username[0].toUpperCase())}</div>`}
          <div>
            <h3>${escHtml(user.username)}</h3>
            <p class="go3d-elo-badge">${user.elo} ELO</p>
            <p>${user.wins}W / ${user.losses}L / ${user.draws}D</p>
            ${user.bio ? `<p class="go3d-bio">${escHtml(user.bio)}</p>` : ''}
          </div>
        </div>
        ${isMe ? `
          <details class="go3d-panel">
            <summary>Edit profile</summary>
            <form id="go3d-edit-profile-form" class="go3d-form">
              <label>Bio (max 500 chars)<textarea name="bio" maxlength="500">${escHtml(user.bio ?? '')}</textarea></label>
              <label>Avatar URL<input type="url" name="avatar_url" value="${escHtml(user.avatar_url ?? '')}"></label>
              <div class="go3d-form-error"></div>
              <button type="submit" class="go3d-btn-primary">Save</button>
            </form>
          </details>
          <details class="go3d-panel">
            <summary>Notification settings</summary>
            <form id="go3d-notif-form" class="go3d-form">
              <label>Idle reminder after
                <input type="number" name="notify_idle_hours" value="24" min="0" max="168"> hours (0 = off)
              </label>
              <label>Timeout warning when less than
                <input type="number" name="notify_timeout_mins" value="60" min="0" max="1440"> minutes remain (0 = off)
              </label>
              <div class="go3d-form-error"></div>
              <button type="submit" class="go3d-btn-primary">Save</button>
            </form>
          </details>
        ` : ''}
        <div class="go3d-panel">
          <h3>Recent games</h3>
          ${recent_games.length === 0 ? '<p>No finished games yet.</p>' : `
            <table class="go3d-table">
              <thead><tr><th>Size</th><th>Scoring</th><th>Result</th><th>ELO Δ</th></tr></thead>
              <tbody>${gamesHtml}</tbody>
            </table>
          `}
        </div>`;

      if (isMe) {
        document.getElementById('go3d-edit-profile-form')!.addEventListener('submit', async e => {
          e.preventDefault();
          const form  = e.currentTarget as HTMLFormElement;
          const bio   = (form.elements.namedItem('bio')        as HTMLTextAreaElement).value;
          const avUrl = (form.elements.namedItem('avatar_url') as HTMLInputElement).value;
          const errEl = form.querySelector<HTMLElement>('.go3d-form-error')!;
          try {
            await Users.updateProfile({ bio, avatar_url: avUrl || undefined });
            errEl.style.color = '#0f0';
            errEl.textContent = '✓ Saved.';
          } catch (err) {
            errEl.textContent = apiErrorMessage(err);
          }
        });

        document.getElementById('go3d-notif-form')!.addEventListener('submit', async e => {
          e.preventDefault();
          const form      = e.currentTarget as HTMLFormElement;
          const idleHours = Number((form.elements.namedItem('notify_idle_hours') as HTMLInputElement).value);
          const toMins    = Number((form.elements.namedItem('notify_timeout_mins') as HTMLInputElement).value);
          const errEl     = form.querySelector<HTMLElement>('.go3d-form-error')!;
          try {
            await Users.updateNotifications({ notify_idle_hours: idleHours, notify_timeout_mins: toMins });
            errEl.style.color = '#0f0';
            errEl.textContent = '✓ Saved.';
          } catch (err) {
            errEl.textContent = apiErrorMessage(err);
          }
        });
      }
    } catch {
      content.textContent = 'Could not load profile.';
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setScreen(id: Screen): void {
  document.querySelectorAll<HTMLElement>('.go3d-screen').forEach(el => {
    el.style.display = el.id === `go3d-${id}` ? '' : 'none';
  });
}

export function showToast(msg: string, type: 'info' | 'success' | 'error' = 'info'): void {
  const el = document.getElementById('go3d-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `go3d-toast go3d-toast-${type} go3d-toast-visible`;
  setTimeout(() => el.classList.remove('go3d-toast-visible'), 4000);
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Compact board descriptor combining mode + size, e.g. "9³", "9³ stack", "Sphere 92". */
function boardLabel(g: GameSummary): string {
  const mode = g.mode ?? 'cube';
  // Sphere board_size is the geodesic frequency f; point count is 10·f² + 2.
  if (mode === 'sphere') return `Sphere ${10 * g.board_size * g.board_size + 2} <span class="go3d-chip">sphere</span>`;
  if (mode === 'stack')  return `${g.board_size}³ <span class="go3d-chip">stack</span>`;
  return `${g.board_size}³`;
}
