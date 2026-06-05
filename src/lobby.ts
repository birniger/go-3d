/**
 * Lobby UI controller.
 * Manages the screen flow: Auth → Lobby → Game.
 * Renders open games, active games, new-game form, and user profile.
 */

import { AuthState, apiErrorMessage } from './auth';
import { Games, Users, GameSummary, User, FriendUser, Challenge, ApiError } from './api';
import { formatClock } from './multiplayer';
import { confirmModal } from './modal';
import {
  GameFormSettings,
  bindGameForm,
  LOBBY_FORM_IDS,
  LOCAL_SETUP_FORM_IDS,
} from './game-form';

// ── Screen management ─────────────────────────────────────────────────────────

export type Screen = 'auth' | 'lobby' | 'game' | 'profile' | 'local' | 'local-setup';

type ScreenChangeCallback = (screen: Screen, data?: unknown) => void;

// ── Lobby class ───────────────────────────────────────────────────────────────

export class Lobby {
  private onScreenChange: ScreenChangeCallback;
  private presenceCleanup: (() => void) | null = null;
  private pendingVerifyEmail: string | null = null;
  private readLobbySettings: (() => GameFormSettings) | null = null;
  /** A game id from a `?go3d_game=` deep link (e.g. a "your turn" email), routed
   *  into on the first lobby entry after auth, then consumed. */
  private pendingGameId: number | null = null;
  /** When the user creates an open game, the bar polls for a join instead of
   *  immediately entering the game screen. */
  private openGameId: number | null = null;
  private openGamePollInterval: ReturnType<typeof setInterval> | null = null;
  private challengePollInterval: ReturnType<typeof setInterval> | null = null;

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
        // An unverified account returns 403 — route them to the code form
        // (prefilled) instead of a dead-end error, and re-send a fresh code.
        if (err instanceof ApiError && err.status === 403) {
          void AuthState.resendCode(email);
          this.showVerifyForm(email);
          return;
        }
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
      errEl.style.color = '';
      errEl.textContent = '';
      try {
        await AuthState.register(username, email, pass);
        this.showVerifyForm(email);
      } catch (err) {
        errEl.textContent = apiErrorMessage(err);
      }
    });

    // Email-verification code form (shown after registering)
    document.getElementById('go3d-verify-form')!.addEventListener('submit', async e => {
      e.preventDefault();
      const form  = e.currentTarget as HTMLFormElement;
      const code  = (form.elements.namedItem('code') as HTMLInputElement).value.trim();
      const email = this.pendingVerifyEmail
        ?? (document.getElementById('go3d-login-form')!
              .querySelector<HTMLInputElement>('[name=email]')!.value);
      const errEl = form.querySelector<HTMLElement>('.go3d-form-error')!;
      errEl.style.color = '';
      errEl.textContent = '';
      try {
        await AuthState.verifyCode(email, code);
        this.hideVerifyForm();
        await this.showLobby();
      } catch (err) {
        errEl.textContent = apiErrorMessage(err);
      }
    });
    document.getElementById('go3d-verify-resend')!.addEventListener('click', async e => {
      e.preventDefault();
      const form  = document.getElementById('go3d-verify-form')!;
      const errEl = form.querySelector<HTMLElement>('.go3d-form-error')!;
      const email = this.pendingVerifyEmail
        ?? (document.getElementById('go3d-login-form')!
              .querySelector<HTMLInputElement>('[name=email]')!.value);
      await AuthState.resendCode(email);
      errEl.style.color = '#0f0';
      errEl.textContent = '✓ A new code is on its way. Check your inbox.';
    });
    document.getElementById('go3d-verify-back')!.addEventListener('click', e => {
      e.preventDefault();
      this.hideVerifyForm();
      document.querySelector<HTMLButtonElement>('[data-tab="login"]')!.click();
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
    // Deep link from a "your turn" / result email: /?go3d_game=ID. Stashed now,
    // routed into on the first showLobby() after auth (see showLobby).
    const gid = Number(url.searchParams.get('go3d_game'));
    if (Number.isInteger(gid) && gid > 0) this.pendingGameId = gid;
  }

  /** Swap the auth panel from the register tab to the email-code entry form. */
  private showVerifyForm(email: string): void {
    this.pendingVerifyEmail = email;
    document.querySelectorAll<HTMLElement>('.go3d-tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelector<HTMLElement>('.go3d-auth-tabs')!.style.display = 'none';
    document.getElementById('go3d-forgot-form')!.style.display = 'none';
    const emailEl = document.getElementById('go3d-verify-email');
    if (emailEl) emailEl.textContent = email;
    const form = document.getElementById('go3d-verify-form')!;
    form.style.display = '';
    form.querySelector<HTMLInputElement>('[name=code]')?.focus();
  }

  private hideVerifyForm(): void {
    this.pendingVerifyEmail = null;
    document.getElementById('go3d-verify-form')!.style.display = 'none';
    document.querySelector<HTMLElement>('.go3d-auth-tabs')!.style.display = '';
    document.querySelector<HTMLElement>('.go3d-tab-panel[data-tab="login"]')!.classList.add('active');
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
    document.getElementById('go3d-refresh-social')?.addEventListener('click', () => void this.loadSocial());

    // Lobby new-game form: server "Create open game" + post-login "Play locally".
    const readLobby = bindGameForm(LOBBY_FORM_IDS);
    this.readLobbySettings = readLobby;
    // Lobby new-game form: creates an open game and shows a status bar instead
    // of immediately entering the game screen. The bar polls for a join.
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
        this.showOpenGameBar(res.game_id, boardLabel({
          id: res.game_id, board_size: s.board_size, mode: s.mode,
          scoring_mode: s.scoring_mode, komi: s.komi, time_control: s.time_control,
        } as GameSummary));
      } catch (err) {
        showToast(apiErrorMessage(err), 'error');
      }
    });
    document.getElementById('go3d-play-local-btn')?.addEventListener('click', () => {
      this.startLocal(readLobby());
    });

    // Pre-login local-setup form, reachable from the auth screen so two players
    // can share one screen with no account — same modes/time controls as online.
    const readLocalSetup = bindGameForm(LOCAL_SETUP_FORM_IDS);
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

    document.getElementById('go3d-user-search-form')?.addEventListener('submit', e => {
      e.preventDefault();
      void this.searchUsers();
    });
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
    this.cleanup();
    setScreen('auth');
  }

  /** Stop all background intervals. Called by app.ts when leaving the lobby. */
  cleanup(): void {
    this.closeOpenGameBar();
    this.stopChallengePolling();
  }

  async showLobby(): Promise<void> {
    const user = AuthState.user;
    if (!user) { this.showAuth(); return; }

    // Honour a pending deep link exactly once: jump straight into the game the
    // email pointed at instead of showing the lobby.
    if (this.pendingGameId !== null) {
      const id = this.pendingGameId;
      this.pendingGameId = null;
      // Drop the param so "← Lobby" then refresh doesn't re-enter the game.
      const u = new URL(window.location.href);
      u.searchParams.delete('go3d_game');
      window.history.replaceState({}, '', u.toString());
      this.onScreenChange('game', id);
      return;
    }

    document.getElementById('go3d-lobby-username')!.textContent = user.username;
    document.getElementById('go3d-lobby-elo')!.textContent      = String(user.elo);

    setScreen('lobby');
    this.startChallengePolling();
    await Promise.all([this.loadOpenGames(), this.loadActiveGames(), this.loadLeaderboard(), this.loadSocial()]);
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
              ? `<span class="go3d-chip">Your game</span> <button class="go3d-btn-ghost go3d-btn-sm go3d-cancel-btn" data-id="${g.id}">Cancel</button>`
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
        tbody.querySelectorAll<HTMLButtonElement>('.go3d-cancel-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const id = Number(btn.dataset.id);
            if (!(await confirmModal('Cancel this open game? It will be removed from the lobby.', { title: 'Cancel game', confirm: 'Cancel game', cancel: 'Keep it', danger: true }))) return;
            try {
              await Games.cancel(id);
              showToast('Game cancelled.', 'success');
              await this.loadOpenGames();
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

  private async loadSocial(): Promise<void> {
    const friendsEl = document.getElementById('go3d-friends-list');
    const requestsEl = document.getElementById('go3d-friend-requests');
    const challengesEl = document.getElementById('go3d-challenges-list');
    if (!friendsEl || !requestsEl || !challengesEl || !AuthState.user) return;

    try {
      const [friends, challenges] = await Promise.all([Users.friends(), Games.challenges()]);
      friendsEl.innerHTML = friends.friends.length
        ? friends.friends.map(u => this.socialUserRow(u, true)).join('')
        : '<p class="go3d-empty-msg">No friends yet. Search above to add one.</p>';

      const incoming = friends.incoming.map(u => `
        <div class="go3d-social-row">
          <span>${escHtml(u.username)} <span class="go3d-elo-badge">${u.elo}</span></span>
          <span>
            <button class="go3d-btn-primary go3d-btn-sm go3d-accept-friend" data-id="${u.friendship_id}">Accept</button>
            <button class="go3d-btn-ghost go3d-btn-sm go3d-remove-friend" data-id="${u.friendship_id}">Decline</button>
          </span>
        </div>`).join('');
      const outgoing = friends.outgoing.map(u => `
        <div class="go3d-social-row">
          <span>${escHtml(u.username)} <span class="go3d-chip">pending</span></span>
          <button class="go3d-btn-ghost go3d-btn-sm go3d-remove-friend" data-id="${u.friendship_id}">Cancel</button>
        </div>`).join('');
      requestsEl.innerHTML = incoming || outgoing
        ? incoming + outgoing
        : '<p class="go3d-empty-msg">No pending friend requests.</p>';

      const challengeRows = [
        ...challenges.incoming.map(c => this.challengeRow(c, true)),
        ...challenges.outgoing.map(c => this.challengeRow(c, false)),
      ].join('');
      challengesEl.innerHTML = challengeRows || '<p class="go3d-empty-msg">No pending challenges.</p>';

      friendsEl.querySelectorAll<HTMLButtonElement>('.go3d-challenge-user').forEach(btn => {
        btn.addEventListener('click', () => void this.challengeUser(Number(btn.dataset.id)));
      });
      requestsEl.querySelectorAll<HTMLButtonElement>('.go3d-accept-friend').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await Users.acceptFriend(Number(btn.dataset.id)); showToast('Friend added.', 'success'); await this.loadSocial(); }
          catch (err) { showToast(apiErrorMessage(err), 'error'); }
        });
      });
      requestsEl.querySelectorAll<HTMLButtonElement>('.go3d-remove-friend').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await Users.removeFriend(Number(btn.dataset.id)); showToast('Request removed.', 'success'); await this.loadSocial(); }
          catch (err) { showToast(apiErrorMessage(err), 'error'); }
        });
      });
      challengesEl.querySelectorAll<HTMLButtonElement>('.go3d-accept-challenge').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const res = await Games.acceptChallenge(Number(btn.dataset.id));
            showToast('Challenge accepted.', 'success');
            this.onScreenChange('game', res.game_id);
          } catch (err) { showToast(apiErrorMessage(err), 'error'); }
        });
      });
      challengesEl.querySelectorAll<HTMLButtonElement>('.go3d-decline-challenge').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await Games.declineChallenge(Number(btn.dataset.id)); showToast('Challenge declined.', 'success'); await this.loadSocial(); }
          catch (err) { showToast(apiErrorMessage(err), 'error'); }
        });
      });
    } catch {
      friendsEl.innerHTML = '<p class="go3d-empty-msg">Could not load friends.</p>';
      requestsEl.innerHTML = '';
      challengesEl.innerHTML = '';
    }
  }

  // ── Open-game status bar ──────────────────────────────────────────────────

  /** Show the floating bar in the lobby while waiting for an opponent. */
  private showOpenGameBar(gameId: number, description: string): void {
    this.closeOpenGameBar();
    this.openGameId = gameId;
    const bar = document.getElementById('go3d-open-game-bar')!;
    const label = document.getElementById('go3d-open-game-bar-label')!;
    const enter = document.getElementById('go3d-open-game-enter') as HTMLButtonElement | null;
    const cancel = document.getElementById('go3d-open-game-cancel') as HTMLButtonElement | null;

    label.textContent = `🟡 Waiting for opponent — ${description}`;
    if (enter) enter.style.display = 'none';
    if (cancel) cancel.onclick = async () => {
      if (!(await confirmModal('Cancel this open game? It will be removed from the lobby.', { title: 'Cancel game', confirm: 'Cancel game', cancel: 'Keep it', danger: true }))) return;
      try {
        await Games.cancel(gameId);
        showToast('Game cancelled.', 'success');
        void this.loadOpenGames();
      } catch (err) { showToast(apiErrorMessage(err), 'error'); }
      this.closeOpenGameBar();
    };
    bar.style.display = '';

    // Poll every 3 s until someone joins.
    this.openGamePollInterval = setInterval(() => void this.pollOpenGame(gameId), 3000);
  }

  private async pollOpenGame(gameId: number): Promise<void> {
    try {
      const state = await Games.get(gameId);
      if (state.status === 'active' && state.player2_id) {
        const oppName = state.player2_name ?? `Player ${state.player2_id}`;
        const oppElo = state.player2_elo ? ` (${state.player2_elo})` : '';
        const label = document.getElementById('go3d-open-game-bar-label');
        if (label) label.textContent = `🟢 ${oppName}${oppElo} joined!`;
        const enter = document.getElementById('go3d-open-game-enter') as HTMLButtonElement | null;
        if (enter) {
          enter.style.display = '';
          enter.onclick = () => { this.closeOpenGameBar(); this.onScreenChange('game', gameId); };
        }
        // Auto-navigate after 2 s.
        const id = this.openGameId;
        setTimeout(() => { if (this.openGameId === id) { this.closeOpenGameBar(); this.onScreenChange('game', id); } }, 2000);
        this.stopOpenGamePoll();
      }
    } catch { /* retry next poll */ }
  }

  private closeOpenGameBar(): void {
    this.stopOpenGamePoll();
    this.openGameId = null;
    const bar = document.getElementById('go3d-open-game-bar');
    if (bar) bar.style.display = 'none';
  }

  private stopOpenGamePoll(): void {
    if (this.openGamePollInterval !== null) {
      clearInterval(this.openGamePollInterval);
      this.openGamePollInterval = null;
    }
  }

  // ── Challenge auto-polling ────────────────────────────────────────────────

  /** Start polling challenges every 5 s so the challenger sees when a challenge
   *  is accepted. Rescheduled every time showLobby() runs. */
  private startChallengePolling(): void {
    this.stopChallengePolling();
    this.challengePollInterval = setInterval(() => void this.checkChallengeUpdates(), 5000);
  }

  private stopChallengePolling(): void {
    if (this.challengePollInterval !== null) {
      clearInterval(this.challengePollInterval);
      this.challengePollInterval = null;
    }
  }

  private async checkChallengeUpdates(): Promise<void> {
    // Only poll while on the lobby screen.
    if (document.getElementById('go3d-lobby')?.style.display === 'none') return;
    try {
      const challenges = await Games.challenges();
      const accepted = challenges.outgoing.find(c => c.status === 'accepted' && c.game_id);
      if (accepted && accepted.game_id) {
        const name = accepted.challenged_name ?? 'Opponent';
        showToast(`${name} accepted your challenge!`, 'success');
        this.stopChallengePolling();
        this.onScreenChange('game', accepted.game_id);
      }
    } catch { /* retry next poll */ }
  }

  private async searchUsers(): Promise<void> {
    const input = document.getElementById('go3d-user-search-input') as HTMLInputElement | null;
    const results = document.getElementById('go3d-user-search-results');
    if (!input || !results) return;
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = '<p class="go3d-empty-msg">Type at least 2 characters.</p>'; return; }
    try {
      const { users } = await Users.search(q);
      const mine = AuthState.user?.id;
      results.innerHTML = users.filter(u => u.id !== mine).length
        ? users.filter(u => u.id !== mine).map(u => this.searchUserRow(u)).join('')
        : '<p class="go3d-empty-msg">No players found.</p>';
      results.querySelectorAll<HTMLButtonElement>('.go3d-add-friend').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await Users.requestFriend(Number(btn.dataset.id)); showToast('Friend request sent.', 'success'); await this.loadSocial(); }
          catch (err) { showToast(apiErrorMessage(err), 'error'); }
        });
      });
      results.querySelectorAll<HTMLButtonElement>('.go3d-challenge-user').forEach(btn => {
        btn.addEventListener('click', () => void this.challengeUser(Number(btn.dataset.id)));
      });
    } catch (err) {
      results.innerHTML = `<p class="go3d-empty-msg">${escHtml(apiErrorMessage(err))}</p>`;
    }
  }

  private async challengeUser(userId: number): Promise<void> {
    if (!this.readLobbySettings) return;
    const s = this.readLobbySettings();
    const settings: Parameters<typeof Games.challenge>[1] = {
      board_size: s.board_size,
      mode: s.mode,
      scoring_mode: s.scoring_mode,
      komi: s.komi,
      time_control: s.time_control,
    };
    if (s.time_settings) settings.time_settings = s.time_settings;
    try {
      await Games.challenge(userId, settings);
      showToast('Challenge sent.', 'success');
      await this.loadSocial();
    } catch (err) {
      showToast(apiErrorMessage(err), 'error');
    }
  }

  private socialUserRow(u: FriendUser, challenge: boolean): string {
    return `
      <div class="go3d-social-row">
        <span>${escHtml(u.username)} <span class="go3d-elo-badge">${u.elo}</span></span>
        ${challenge ? `<button class="go3d-btn-primary go3d-btn-sm go3d-challenge-user" data-id="${u.id}">Challenge</button>` : ''}
      </div>`;
  }

  private searchUserRow(u: User): string {
    return `
      <div class="go3d-social-row">
        <span>${escHtml(u.username)} <span class="go3d-elo-badge">${u.elo}</span></span>
        <span>
          <button class="go3d-btn-ghost go3d-btn-sm go3d-add-friend" data-id="${u.id}">Add friend</button>
          <button class="go3d-btn-primary go3d-btn-sm go3d-challenge-user" data-id="${u.id}">Challenge</button>
        </span>
      </div>`;
  }

  private challengeRow(c: Challenge, incoming: boolean): string {
    const name = incoming ? (c.challenger_name ?? 'Opponent') : (c.challenged_name ?? 'Opponent');
    const elo = incoming ? c.challenger_elo : c.challenged_elo;
    return `
      <div class="go3d-social-row">
        <span>${incoming ? 'From' : 'To'} ${escHtml(name)} ${elo ? `<span class="go3d-elo-badge">${elo}</span>` : ''}<br>
          <span class="go3d-form-hint">${challengeLabel(c)}</span>
        </span>
        ${incoming
          ? `<span><button class="go3d-btn-primary go3d-btn-sm go3d-accept-challenge" data-id="${c.id}">Accept</button>
             <button class="go3d-btn-ghost go3d-btn-sm go3d-decline-challenge" data-id="${c.id}">Decline</button></span>`
          : '<span class="go3d-chip">pending</span>'}
      </div>`;
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
              <label class="go3d-notif-card">
                <span>
                  <span class="go3d-notif-title">24h correspondence reminder</span>
                  <span class="go3d-notif-copy">Optional email only when it is your turn and no move has been played for 24 hours.</span>
                </span>
                <span class="go3d-toggle">
                  <input type="checkbox" name="idle_reminder" ${(user.notify_idle_hours ?? 24) > 0 ? 'checked' : ''}>
                  <span class="go3d-toggle-slider" aria-hidden="true"></span>
                </span>
              </label>
              <p class="go3d-form-hint">Game-result and clock-warning emails are off. Verification and password reset emails still work.</p>
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
          const idleOn    = (form.elements.namedItem('idle_reminder') as HTMLInputElement).checked;
          const errEl     = form.querySelector<HTMLElement>('.go3d-form-error')!;
          try {
            await Users.updateNotifications({ notify_idle_hours: idleOn ? 24 : 0, notify_timeout_mins: 0 });
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

function challengeLabel(c: Challenge): string {
  if (c.mode === 'sphere') return `Sphere ${10 * c.board_size * c.board_size + 2} · ${c.time_control}`;
  const mode = c.mode === 'stack' ? ' stack' : '';
  return `${c.board_size}³${mode} · ${c.time_control}`;
}
