export type Player = 1 | 2;
export type Cell = 0 | Player;

export interface TerritoryResult {
  black:       number;
  white:       number;
  neutral:     number;
  blackStones: number;
  whiteStones: number;
  map:         Record<string, 0 | Player>;
}

interface Snapshot {
  board:    Cell[][][];
  captured: [number, number];
  history:  Set<string>;
  lastMove: [number, number, number] | null;
}

export class Go3D {
  readonly size: number;
  board: Cell[][][];
  currentPlayer: Player;
  captured: [number, number];
  lastMove: [number, number, number] | null = null;
  lastCaptured: [number, number, number][] = [];
  private history: Set<string>;
  private snapshots: Snapshot[] = [];

  constructor(size = 9) {
    this.size          = size;
    this.board         = this.emptyBoard();
    this.currentPlayer = 1;
    this.captured      = [0, 0];
    this.history       = new Set([this.boardHash()]);
  }

  private emptyBoard(): Cell[][][] {
    return Array.from({ length: this.size }, () =>
      Array.from({ length: this.size }, () => new Array<Cell>(this.size).fill(0))
    );
  }

  neighbors(x: number, y: number, z: number): [number, number, number][] {
    return ([ [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1] ] as [number,number,number][])
      .map(([dx, dy, dz]) => [x+dx, y+dy, z+dz] as [number,number,number])
      .filter(([nx,ny,nz]) =>
        nx >= 0 && nx < this.size &&
        ny >= 0 && ny < this.size &&
        nz >= 0 && nz < this.size
      );
  }

  private getGroup(x: number, y: number, z: number): [number, number, number][] {
    const color = this.board[x][y][z];
    if (color === 0) return [];
    const visited = new Set<string>();
    const group: [number,number,number][] = [];
    const stack: [number,number,number][] = [[x, y, z]];
    while (stack.length) {
      const [cx, cy, cz] = stack.pop()!;
      const key = `${cx},${cy},${cz}`;
      if (visited.has(key)) continue;
      visited.add(key);
      group.push([cx, cy, cz]);
      for (const [nx,ny,nz] of this.neighbors(cx, cy, cz)) {
        if (this.board[nx][ny][nz] === color && !visited.has(`${nx},${ny},${nz}`))
          stack.push([nx, ny, nz]);
      }
    }
    return group;
  }

  private getLiberties(group: [number,number,number][]): number {
    const libs = new Set<string>();
    for (const [x,y,z] of group)
      for (const [nx,ny,nz] of this.neighbors(x,y,z))
        if (this.board[nx][ny][nz] === 0) libs.add(`${nx},${ny},${nz}`);
    return libs.size;
  }

  private boardHash(): string { return this.board.flat(2).join(''); }

  private cloneBoard(): Cell[][][] {
    return this.board.map(layer => layer.map(row => [...row]));
  }

  place(x: number, y: number, z: number): boolean {
    if (this.board[x][y][z] !== 0) return false;

    this.snapshots.push({
      board:    this.cloneBoard(),
      captured: [this.captured[0], this.captured[1]],
      history:  new Set(this.history),
      lastMove: this.lastMove,
    });

    const savedBoard:    Cell[][][]     = this.cloneBoard();
    const savedCaptured: [number,number] = [this.captured[0], this.captured[1]];
    const opponent: Player = this.currentPlayer === 1 ? 2 : 1;

    this.board[x][y][z] = this.currentPlayer;
    this.lastCaptured = [];

    let captureCount = 0;
    const checked = new Set<string>();
    for (const [nx,ny,nz] of this.neighbors(x,y,z)) {
      if (this.board[nx][ny][nz] !== opponent) continue;
      const rk = `${nx},${ny},${nz}`;
      if (checked.has(rk)) continue;
      const group = this.getGroup(nx, ny, nz);
      group.forEach(([gx,gy,gz]) => checked.add(`${gx},${gy},${gz}`));
      if (this.getLiberties(group) === 0) {
        for (const [gx,gy,gz] of group) {
          this.board[gx][gy][gz] = 0;
          this.lastCaptured.push([gx, gy, gz]);
          captureCount++;
        }
      }
    }

    if (this.getLiberties(this.getGroup(x,y,z)) === 0) {
      this.board = savedBoard; this.captured = savedCaptured;
      this.lastCaptured = []; this.snapshots.pop();
      return false;
    }
    const hash = this.boardHash();
    if (this.history.has(hash)) {
      this.board = savedBoard; this.captured = savedCaptured;
      this.lastCaptured = []; this.snapshots.pop();
      return false;
    }

    this.captured[this.currentPlayer - 1] += captureCount;
    this.history.add(hash);
    this.lastMove = [x, y, z];
    this.currentPlayer = opponent;
    return true;
  }

  undo(): boolean {
    if (this.snapshots.length === 0) return false;
    const snap = this.snapshots.pop()!;
    this.board         = snap.board;
    this.captured      = snap.captured;
    this.history       = snap.history;
    this.lastMove      = snap.lastMove;
    this.lastCaptured  = [];
    this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
    return true;
  }

  pass(): void {
    this.snapshots.push({
      board:    this.cloneBoard(),
      captured: [this.captured[0], this.captured[1]],
      history:  new Set(this.history),
      lastMove: this.lastMove,
    });
    this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
  }

  countTerritory(): TerritoryResult {
    const s = this.size;
    const emptyVisited = new Set<string>();
    const map: Record<string, 0 | Player> = {};
    let black = 0, white = 0, neutral = 0, blackStones = 0, whiteStones = 0;

    for (let x = 0; x < s; x++)
      for (let y = 0; y < s; y++)
        for (let z = 0; z < s; z++) {
          if (this.board[x][y][z] === 1) blackStones++;
          else if (this.board[x][y][z] === 2) whiteStones++;
        }

    for (let x = 0; x < s; x++) {
      for (let y = 0; y < s; y++) {
        for (let z = 0; z < s; z++) {
          if (this.board[x][y][z] !== 0) continue;
          const startKey = `${x},${y},${z}`;
          if (emptyVisited.has(startKey)) continue;

          const region: [number,number,number][] = [];
          const borders = new Set<Player>();
          const stack: [number,number,number][] = [[x, y, z]];

          while (stack.length) {
            const [cx,cy,cz] = stack.pop()!;
            const k = `${cx},${cy},${cz}`;
            if (emptyVisited.has(k)) continue;
            emptyVisited.add(k);
            region.push([cx, cy, cz]);
            for (const [nx,ny,nz] of this.neighbors(cx, cy, cz)) {
              const cell = this.board[nx][ny][nz];
              if (cell === 0) {
                if (!emptyVisited.has(`${nx},${ny},${nz}`)) stack.push([nx, ny, nz]);
              } else {
                borders.add(cell);
              }
            }
          }

          let owner: 0 | Player = 0;
          if (borders.size === 1) {
            owner = [...borders][0];
            if (owner === 1) black += region.length;
            else             white += region.length;
          } else {
            neutral += region.length;
          }
          for (const [rx,ry,rz] of region) map[`${rx},${ry},${rz}`] = owner;
        }
      }
    }

    return { black, white, neutral, blackStones, whiteStones, map };
  }
}
