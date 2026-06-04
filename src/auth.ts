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

  /** Try to restore session from localStorage JWT. */
  async init(): Promise<User | null> {
    const token = getToken();
    if (!token) return null;
    try {
      _user = await AuthAPI.me();
      notify();
      return _user;
    } catch {
      clearToken();
      return null;
    }
  },

  async login(email: string, password: string): Promise<User> {
    const res = await AuthAPI.login(email, password);
    setToken(res.token);
    _user = res.user;
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
    _user = res.user;
    notify();
    return _user;
  },

  async requestReset(email: string): Promise<void> {
    await AuthAPI.requestReset(email);
  },

  async resetPassword(token: string, newPassword: string): Promise<void> {
    await AuthAPI.resetPassword(token, newPassword);
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
