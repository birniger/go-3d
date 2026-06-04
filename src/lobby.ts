/**
 * Lobby UI controller.
 * Manages the screen flow: Auth → Lobby → Game.
 * Renders open games, active games, new-game form, and user profile.
 */

import { AuthState, apiErrorMessage } from './auth';
import { Games, Users, GameSummary, User, ApiError } from './api';
import { formatClock } from './multiplayer';

// ── Screen management ─────────────────────────────────────────────────────────

export type Screen = 'auth' | 'lobby' | 'game' | 'profile';

type ScreenChangeCallback = (screen: Screen, data?: unknown) => void;

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

    // New game form: show/hide time settings
    const tcSel = document.getElementById('go3d-time-control-select') as HTMLSelectElement;
    const tsDiv = document.getElementById('go3d-time-settings')!;
    const bDiv  = document.getElementById('go3d-byoyomi-extra')!;
    const fDiv  = document.getElementById('go3d-fischer-extra')!;
    tcSel.addEventListener('change', () => {
      tsDiv.style.display = tcSel.value === 'none' ? 'none' : '';
      bDiv.style.display  = tcSel.value === 'byoyomi'  ? '' : 'none';
      fDiv.style.display  = tcSel.value === 'fischer'  ? '' : 'none';
    });

    document.getElementById('go3d-new-game-form')!.addEventListener('submit', async e => {
      e.preventDefault();
      const form      = e.currentTarget as HTMLFormElement;
      const fd        = new FormData(form);
      const tc        = fd.get('time_control') as string;
      const settings: Record<string, unknown> = {
        board_size:   Number(fd.get('board_size')),
        mode:         fd.get('mode'),
        scoring_mode: fd.get('scoring_mode'),
        komi:         Number(fd.get('komi')),
        time_control: tc,
      };
      if (tc !== 'none') {
        const ts: Record<string, number> = { main_time_s: Number(fd.get('main_time_s')) };
        if (tc === 'byoyomi') {
          ts.byoyomi_periods = Number(fd.get('byoyomi_periods'));
          ts.byoyomi_time_s  = Number(fd.get('byoyomi_time_s'));
        }
        if (tc === 'fischer') {
          ts.fischer_increment_s = Number(fd.get('fischer_increment_s'));
        }
        settings.time_settings = ts;
      }
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
    await Promise.all([this.loadOpenGames(), this.loadActiveGames()]);
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
        return `<tr><td>${boardLabel(g)}</td><td>${escHtml(g.scoring_mode)}</td><td>${badge}</td><td>${escHtml(String(g.elo_change_p1 ?? g.elo_change_p2 ?? ''))}</td></tr>`;
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
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Compact board descriptor combining mode + size, e.g. "9³", "9³ stack", "Sphere 5". */
function boardLabel(g: GameSummary): string {
  const mode = g.mode ?? 'cube';
  if (mode === 'sphere') return `Sphere ${g.board_size}`;
  if (mode === 'stack')  return `${g.board_size}³ <span class="go3d-chip">stack</span>`;
  return `${g.board_size}³`;
}
