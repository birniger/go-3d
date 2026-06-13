/**
 * Auth state management.
 * Exposes a reactive singleton — call onChange() to subscribe.
 */

import { Auth as AuthAPI, User, setToken, clearToken, getToken, ApiError } from './api';

type Listener = (user: User | null) => void;

// ── State ─────────────────────────────────────────────────────────────────────

let _user: User | null = null;
const _listeners = new Set<Listener>();

function notify() {
  _listeners.forEach(l => l(_user));
}

/**
 * Coerce numeric user fields to real numbers. WPDB serialises ids/stats as
 * strings, but the rest of the app compares `user.id` against numeric ids from
 * the game endpoints with strict equality (===). A string id silently fails
 * those checks — most visibly mis-assigning the player's colour so the board
 * thinks it's never your turn. Normalising here makes every comparison safe
 * regardless of which endpoint (or cached payload) produced the user.
 */
function normalizeUser(u: User): User {
  return { ...u, id: Number(u.id), elo: Number(u.elo) };
}

// ── Public API ────────────────────────────────────────────────────────────────

export const AuthState = {
  /** Current user or null. */
  get user(): User | null { return _user; },
  get isLoggedIn(): boolean { return _user !== null; },

  /** Subscribe to auth changes. Returns an unsubscribe function. */
  onChange(listener: Listener): () => void {
    _listeners.add(listener);
    return () => _listeners.delete(listener);
  },

  /** Try to restore session from localStorage JWT. Only clears the token on
   *  a definite auth failure (401/403); network errors and server outages leave
   *  the stored token alone so the user isn't randomly logged out. */
  async init(): Promise<User | null> {
    const token = getToken();
    if (!token) return null;
    try {
      _user = normalizeUser(await AuthAPI.me());
      notify();
      return _user;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearToken();
      }
      // Network / 5xx errors: keep the token; the next API call will retry.
      return null;
    }
  },

  async login(email: string, password: string): Promise<User> {
    const res = await AuthAPI.login(email, password);
    setToken(res.token);
    _user = normalizeUser(res.user);
    notify();
    return _user;
  },

  async register(username: string, email: string, password: string): Promise<{ user_id: number }> {
    return AuthAPI.register(username, email, password);
  },

  /** Verify a sign-up with the emailed 6-digit code; logs the user in on success. */
  async verifyCode(email: string, code: string): Promise<User> {
    const res = await AuthAPI.verifyCode(email, code);
    setToken(res.token);
    _user = normalizeUser(res.user);
    notify();
    return _user;
  },

  /** Re-send the verification code for an unverified account. Always resolves. */
  async resendCode(email: string): Promise<void> {
    await AuthAPI.resendCode(email);
  },

  async requestReset(email: string): Promise<void> {
    await AuthAPI.requestReset(email);
  },

  /** @returns the account email, so the caller can save the new credential. */
  async resetPassword(token: string, newPassword: string): Promise<string> {
    const r = await AuthAPI.resetPassword(token, newPassword);
    return r.email;
  },

  logout(): void {
    clearToken();
    _user = null;
    notify();
  },
};

/** Format ApiError messages for display. */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error)    return err.message;
  return 'An unexpected error occurred.';
}
