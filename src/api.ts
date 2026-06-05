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
    // Expired/invalid token: clear it so AuthState.init() picks up the change
    // on next navigation and routes the user back to login with a clear error.
    if (res.status === 401 && getToken()) {
      clearToken();
      throw new ApiError(401, 'Session expired. Please log in again.');
    }
    throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`);
  }
  return json as T;
}

const get  = <T>(path: string)                          => request<T>('GET',   path);
const post = <T>(path: string, b: Record<string, unknown>) => request<T>('POST',  path, b);
const patch = <T>(path: string, b: Record<string, unknown>) => request<T>('PATCH', path, b);
const del  = <T>(path: string)                          => request<T>('DELETE', path);

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
  notify_idle_hours?:   number;
  notify_timeout_mins?: number;
  created_at:   string;
  last_seen_at: string | null;
}

export interface FriendUser {
  friendship_id: number;
  id:            number;
  username:      string;
  avatar_url:    string | null;
  elo:           number;
  games_played:  number;
}

export type GameMode = 'cube' | 'stack' | 'sphere';

export interface GameSummary {
  id:              number;
  player1_id:      number;
  player2_id:      number | null;
  board_size:      number;
  mode:            GameMode;
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

/** Time control settings. */
export interface TimeSettings {
  main_time_s: number;
  byoyomi_periods?: number;
  byoyomi_time_s?: number;
  fischer_increment_s?: number;
}

/** Geodesic globe geometry for sphere games (server-generated, see Go3D_Geodesic). */
export interface SphereGeometry {
  vertices: [number, number, number][];
  edges:    [number, number][];
  count:    number;
}

export interface GameState extends GameSummary {
  // Server-resolved labels so the board can show usernames/ELO immediately.
  player1_elo?:        number | null;
  player2_elo?:        number | null;
  time_settings:       Record<string, unknown> | null;
  p1_time_ms:          number | null;
  p2_time_ms:          number | null;
  // Byōyomi: reserve periods remaining per player (null for non-byōyomi games).
  p1_periods?:         number | null;
  p2_periods?:         number | null;
  p1_in_byoyomi?:      boolean;
  p2_in_byoyomi?:      boolean;
  consecutive_passes:  number;
  active_layer:        number;
  // Cube/stack: 3D lattice. Sphere: a flat node array (index = geodesic node).
  board:               number[][][] | number[];
  // Present only for sphere games.
  geometry:            SphereGeometry | null;
  moves:               MoveRecord[];
  pending_undo?:       UndoRequestPayload | null;
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
  type:          string;   // 'place' | 'pass' | 'layer-advance'
  move_number:   number;
  player_slot:   number;
  next_player:   number;
  x?:            number;
  y?:            number;
  z?:            number;
  // Cube/stack: [x,y,z] triples. Sphere: flat node indices.
  captured?:     [number, number, number][] | number[];
  // Sphere only: the authoritative flat board after this move (client has no engine).
  board?:        number[];
  active_layer?: number;   // stack mode: present on 'layer-advance'
  p1_time_ms?:   number | null;
  p2_time_ms?:   number | null;
  p1_periods?:   number | null;   // byōyomi: reserve periods remaining
  p2_periods?:   number | null;
  p1_in_byoyomi?: boolean;
  p2_in_byoyomi?: boolean;
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

export interface PlayerJoinedPayload {
  player2_id:   number;
  player2_name?: string | null;
  player2_elo?:  number | null;
}

export interface UndoRequestPayload {
  requester_id:   number;
  requester_name: string;
  move_number:    number;
}

export interface UndoAppliedPayload {
  move_number: number;
  state:       GameState;
}

export interface UndoDeclinedPayload {
  move_number: number;
}

export interface Challenge {
  id:              number;
  challenger_id:   number;
  challenged_id:   number | null;
  challenger_name?: string | null;
  challenger_elo?:  number | null;
  challenged_name?: string | null;
  challenged_elo?:  number | null;
  board_size:      number;
  mode:            GameMode;
  scoring_mode:    string;
  komi:            number;
  time_control:    string;
  time_settings:   Record<string, unknown> | null;
  status:          string;
  game_id:         number | null;
  created_at:      string;
  expires_at:      string;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const Auth = {
  register: (username: string, email: string, password: string) =>
    post<{ message: string; user_id: number }>('/auth/register', { username, email, password }),

  login: (email: string, password: string) =>
    post<{ token: string; user: User }>('/auth/login', { email, password }),

  verifyCode: (email: string, code: string) =>
    post<{ token: string; user: User }>('/auth/verify-code', { email, code }),

  resendCode: (email: string) =>
    post<{ message: string }>('/auth/resend-code', { email }),

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
    mode?:          GameMode;
    scoring_mode?:  string;
    komi?:          number;
    time_control?:  string;
    time_settings?: Record<string, unknown>;
  }) => post<{ game_id: number }>('/games', settings as Record<string, unknown>),

  join: (id: number) =>
    post<{ message: string; game_id: number }>(`/games/${id}/join`, {}),

  cancel: (id: number) =>
    del<{ message: string; game_id: number }>(`/games/${id}`),

  move: (id: number, move: { type: string; x?: number; y?: number; z?: number; time_ms?: number }) =>
    post<{ event: string; payload: MovePayload | GameOverPayload }>(`/games/${id}/move`, move as Record<string, unknown>),

  requestUndo: (id: number) =>
    post<{ message: string }>(`/games/${id}/undo-request`, {}),

  respondUndo: (id: number, accept: boolean) =>
    post<{ message: string; state: GameState | null }>(`/games/${id}/undo-respond`, { accept }),

  challenges: () =>
    get<{ incoming: Challenge[]; outgoing: Challenge[] }>('/challenges'),

  challenge: (challenged_id: number, settings: {
    board_size?:    number;
    mode?:          GameMode;
    scoring_mode?:  string;
    komi?:          number;
    time_control?:  string;
    time_settings?: Record<string, unknown>;
  }) => post<{ message: string; challenge_id: number }>('/challenges', { challenged_id, ...settings } as Record<string, unknown>),

  acceptChallenge: (id: number) =>
    post<{ message: string; game_id: number }>(`/challenges/${id}/accept`, {}),

  declineChallenge: (id: number) =>
    post<{ message: string }>(`/challenges/${id}/decline`, {}),
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

  friends: () =>
    get<{ friends: FriendUser[]; incoming: FriendUser[]; outgoing: FriendUser[] }>('/users/friends'),

  requestFriend: (user_id: number) =>
    post<{ message: string }>('/users/friends', { user_id }),

  acceptFriend: (friendship_id: number) =>
    post<{ message: string }>(`/users/friends/${friendship_id}/accept`, {}),

  removeFriend: (friendship_id: number) =>
    del<{ message: string }>(`/users/friends/${friendship_id}`),
};

export const BugReports = {
  create: (message: string, type = 'bug', context = '') =>
    post<{ message: string }>('/bug-report', { message, type, context }),
};
