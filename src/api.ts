/**
 * Go3D API client.
 * Reads window.Go3DConfig (injected by the WordPress shortcode) or falls back
 * to a local dev base URL so the frontend also works standalone.
 */

declare global {
  interface Window {
    Go3DConfig?: {
      apiBase:       string;
      pusherKey:     string;
      pusherCluster: string;
      authEndpoint:  string;
      nonce:         string;
    };
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

export const Config = {
  get apiBase():       string { return window.Go3DConfig?.apiBase       ?? '/wp-json/go3d/v1'; },
  get pusherKey():     string { return window.Go3DConfig?.pusherKey     ?? ''; },
  get pusherCluster(): string { return window.Go3DConfig?.pusherCluster ?? 'eu'; },
  get authEndpoint():  string { return window.Go3DConfig?.authEndpoint  ?? '/wp-json/go3d/v1/pusher/auth'; },
  get nonce():         string { return window.Go3DConfig?.nonce         ?? ''; },
};

// ── Token store ───────────────────────────────────────────────────────────────

const TOKEN_KEY = 'go3d_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(Config.apiBase + path, init);
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`);
  }
  return json as T;
}

const get  = <T>(path: string)                          => request<T>('GET',   path);
const post = <T>(path: string, b: Record<string, unknown>) => request<T>('POST',  path, b);
const patch = <T>(path: string, b: Record<string, unknown>) => request<T>('PATCH', path, b);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface User {
  id:           number;
  username:     string;
  avatar_url:   string | null;
  bio:          string | null;
  elo:          number;
  games_played: number;
  wins:         number;
  losses:       number;
  draws:        number;
  created_at:   string;
  last_seen_at: string | null;
}

export interface GameSummary {
  id:              number;
  player1_id:      number;
  player2_id:      number | null;
  board_size:      number;
  scoring_mode:    string;
  komi:            number;
  time_control:    string;
  current_player:  number;
  status:          string;
  winner_id:       number | null;
  end_reason:      string | null;
  p1_score:        number | null;
  p2_score:        number | null;
  elo_change_p1:   number | null;
  elo_change_p2:   number | null;
  created_at:      string;
  last_move_at:    string | null;
  finished_at:     string | null;
  player1_name?:   string | null;
  player2_name?:   string | null;
}

export interface GameState extends GameSummary {
  time_settings:       Record<string, unknown> | null;
  p1_time_ms:          number | null;
  p2_time_ms:          number | null;
  consecutive_passes:  number;
  board:               number[][][];
  moves:               MoveRecord[];
}

export interface MoveRecord {
  move_number: number;
  player_id:   number;
  type:        'place' | 'pass' | 'resign';
  x?:          number;
  y?:          number;
  z?:          number;
  time_ms?:    number;
  created_at:  string;
}

export interface MovePayload {
  type:        string;
  move_number: number;
  player_slot: number;
  next_player: number;
  x?:          number;
  y?:          number;
  z?:          number;
  captured?:   [number, number, number][];
  p1_time_ms?: number | null;
  p2_time_ms?: number | null;
}

export interface GameOverPayload {
  status:        string;
  end_reason:    string;
  winner_id:     number | null;
  p1_score:      number | null;
  p2_score:      number | null;
  elo_change_p1: number | null;
  elo_change_p2: number | null;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const Auth = {
  register: (username: string, email: string, password: string) =>
    post<{ message: string; user_id: number }>('/auth/register', { username, email, password }),

  login: (email: string, password: string) =>
    post<{ token: string; user: User }>('/auth/login', { email, password }),

  requestReset: (email: string) =>
    post<{ message: string }>('/auth/request-reset', { email }),

  resetPassword: (token: string, new_password: string) =>
    post<{ message: string }>('/auth/reset-password', { token, new_password }),

  me: () => get<User>('/auth/me'),
};

// ── Games ─────────────────────────────────────────────────────────────────────

export const Games = {
  list: (status: 'open' | 'active' | 'finished' = 'active', limit = 20, offset = 0) =>
    get<{ games: GameSummary[] }>(`/games?status=${status}&limit=${limit}&offset=${offset}`),

  listOpen: (limit = 20) =>
    get<{ games: GameSummary[] }>(`/games/open?limit=${limit}`),

  get: (id: number) => get<GameState>(`/games/${id}`),

  create: (settings: {
    board_size?:    number;
    scoring_mode?:  string;
    komi?:          number;
    time_control?:  string;
    time_settings?: Record<string, unknown>;
  }) => post<{ game_id: number }>('/games', settings as Record<string, unknown>),

  join: (id: number) =>
    post<{ message: string; game_id: number }>(`/games/${id}/join`, {}),

  move: (id: number, move: { type: string; x?: number; y?: number; z?: number; time_ms?: number }) =>
    post<{ event: string; payload: MovePayload | GameOverPayload }>(`/games/${id}/move`, move as Record<string, unknown>),
};

// ── Users ─────────────────────────────────────────────────────────────────────

export const Users = {
  leaderboard: (limit = 50) =>
    get<{ players: User[] }>(`/users/leaderboard?limit=${limit}`),

  search: (q: string) =>
    get<{ users: User[] }>(`/users/search?q=${encodeURIComponent(q)}`),

  getProfile: (id: number) =>
    get<{ user: User; recent_games: GameSummary[] }>(`/users/${id}`),

  updateProfile: (data: { bio?: string; avatar_url?: string }) =>
    patch<User>('/users/me', data as Record<string, unknown>),

  updateNotifications: (data: { notify_idle_hours?: number; notify_timeout_mins?: number }) =>
    patch<{ message: string }>('/users/me/notifications', data as Record<string, unknown>),
};
