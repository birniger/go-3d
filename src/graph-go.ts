/**
 * Graph Go rule engine — client port of Go3D_Graph_Logic (PHP).
 *
 * Plays Go on an arbitrary graph (flat node array + explicit adjacency) rather
 * than a 3D lattice. This drives LOCAL sphere games, where there is no server to
 * be authoritative. Captures, suicide and superko match the lattice engine in
 * spirit — only "neighbours of a point" changes to adjacency[node].
 *
 * Superko: the PHP engine md5-hashes the board; locally we only ever compare
 * keys for equality, so the raw joined-board string is an equivalent (and
 * cheaper) key — no hashing dependency needed.
 *
 * Black = slot 1, White = slot 2.
 */

export interface GraphPlaceOk {
  ok: true;
  captured: number[];
  hash: string;
  board: number[];
}
export interface GraphPlaceErr {
  ok: false;
  reason: 'out_of_bounds' | 'occupied' | 'suicide' | 'superko';
}
export type GraphPlaceResult = GraphPlaceOk | GraphPlaceErr;

export interface GraphTerritory {
  black: number;
  white: number;
  neutral: number;
  blackStones: number;
  whiteStones: number;
  map: Record<number, number>;
}

export class GraphGo {
  private board: number[];
  private adjacency: number[][];
  private n: number;

  constructor(adjacency: number[][], board?: number[]) {
    this.adjacency = adjacency;
    this.n = adjacency.length;
    this.board = board ? board.slice() : new Array<number>(this.n).fill(0);
  }

  getBoard(): number[] { return this.board.slice(); }

  neighbours(node: number): number[] { return this.adjacency[node] ?? []; }

  /** Board fingerprint for superko comparison (joined cell string). */
  hash(): string { return this.board.join(''); }

  // ── Group / liberties ──────────────────────────────────────────────────────

  private getGroup(node: number): number[] {
    const color = this.board[node];
    if (color === 0) return [];
    const visited = new Set<number>();
    const group: number[] = [];
    const stack = [node];
    while (stack.length) {
      const c = stack.pop()!;
      if (visited.has(c)) continue;
      visited.add(c);
      group.push(c);
      for (const nb of this.neighbours(c)) {
        if (this.board[nb] === color && !visited.has(nb)) stack.push(nb);
      }
    }
    return group;
  }

  private getLiberties(group: number[]): number {
    const libs = new Set<number>();
    for (const node of group) {
      for (const nb of this.neighbours(node)) {
        if (this.board[nb] === 0) libs.add(nb);
      }
    }
    return libs.size;
  }

  // ── Place ────────────────────────────────────────────────────────────────

  /**
   * Attempt to place a stone on `node` for `player` (1|2).
   * `historyHashes` are prior board hashes for the superko check.
   */
  place(node: number, player: 1 | 2, historyHashes: string[] = []): GraphPlaceResult {
    if (node < 0 || node >= this.n) return { ok: false, reason: 'out_of_bounds' };
    if (this.board[node] !== 0)     return { ok: false, reason: 'occupied' };

    const saved = this.board.slice();
    const opponent = (3 - player) as 1 | 2;
    this.board[node] = player;
    const captured: number[] = [];
    const checked = new Set<number>();

    for (const nb of this.neighbours(node)) {
      if (this.board[nb] !== opponent) continue;
      if (checked.has(nb)) continue;
      const group = this.getGroup(nb);
      for (const g of group) checked.add(g);
      if (this.getLiberties(group) === 0) {
        for (const g of group) { this.board[g] = 0; captured.push(g); }
      }
    }

    // Suicide
    if (this.getLiberties(this.getGroup(node)) === 0) {
      this.board = saved;
      return { ok: false, reason: 'suicide' };
    }

    // Superko
    const hash = this.hash();
    if (historyHashes.includes(hash)) {
      this.board = saved;
      return { ok: false, reason: 'superko' };
    }

    return { ok: true, captured, hash, board: this.board.slice() };
  }

  // ── Territory counting ─────────────────────────────────────────────────────

  /**
   * Flood-fill empty regions; a region bordered by exactly one colour is that
   * colour's territory. Also tallies stones on the board for area scoring.
   */
  countTerritory(): GraphTerritory {
    const seen = new Set<number>();
    let black = 0, white = 0, neutral = 0;
    let blackStones = 0, whiteStones = 0;
    const map: Record<number, number> = {};

    for (const cell of this.board) {
      if (cell === 1) blackStones++;
      else if (cell === 2) whiteStones++;
    }

    for (let node = 0; node < this.n; node++) {
      if (this.board[node] !== 0 || seen.has(node)) continue;

      const region: number[] = [];
      const borders = new Set<number>();
      const stack = [node];
      while (stack.length) {
        const c = stack.pop()!;
        if (seen.has(c)) continue;
        seen.add(c);
        region.push(c);
        for (const nb of this.neighbours(c)) {
          const cell = this.board[nb];
          if (cell === 0) { if (!seen.has(nb)) stack.push(nb); }
          else borders.add(cell);
        }
      }

      const owner = borders.size === 1 ? [...borders][0] : 0;
      for (const r of region) map[r] = owner;
      if (owner === 1) black += region.length;
      else if (owner === 2) white += region.length;
      else neutral += region.length;
    }

    return { black, white, neutral, blackStones, whiteStones, map };
  }
}
