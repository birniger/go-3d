export type ClockMode = 'none' | 'simple' | 'fischer' | 'byoyomi';

export interface ClockConfig {
  mode: ClockMode;
  mainTime: number;
  increment: number;
  byoTime: number;
  byoPeriods: number;
  simpleTime: number;
}

export interface PlayerClockState {
  timeLeft: number;
  inByo: boolean;
  periods: number;
  lost: boolean;
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function makeState(cfg: ClockConfig): PlayerClockState {
  return { timeLeft: cfg.mainTime, inByo: false, periods: cfg.byoPeriods, lost: false };
}

export class GameClock {
  public onTick: (p1: PlayerClockState, p2: PlayerClockState) => void = () => {};
  public onFlag: (player: 1 | 2) => void = () => {};

  private cfg: ClockConfig;
  private states: [PlayerClockState, PlayerClockState];
  private active: 1 | 2 | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: ClockConfig) {
    this.cfg = cfg;
    this.states = [makeState(cfg), makeState(cfg)];
  }

  startTurn(player: 1 | 2): void {
    if (this.cfg.mode === 'none') return;
    this.active = player;
    const st = this.states[player - 1];

    if (this.cfg.mode === 'simple') {
      st.timeLeft = this.cfg.simpleTime;
    } else if (this.cfg.mode === 'byoyomi' && st.inByo) {
      st.timeLeft = this.cfg.byoTime;
    }

    if (!this.interval) {
      this.interval = setInterval(() => this._tick(), 100);
    }
  }

  confirmMove(): void {
    if (this.cfg.mode === 'none') return;
    this._stopInterval();
    if (this.active !== null) {
      const st = this.states[this.active - 1];
      if (this.cfg.mode === 'fischer' && !st.inByo) {
        st.timeLeft += this.cfg.increment;
      }
    }
    this.active = null;
    this.onTick(this.states[0], this.states[1]);
  }

  pause(): void {
    this._stopInterval();
  }

  getState(): [PlayerClockState, PlayerClockState] {
    return [{ ...this.states[0] }, { ...this.states[1] }];
  }

  destroy(): void {
    this._stopInterval();
  }

  private _stopInterval(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private _tick(): void {
    if (this.active === null) return;
    const st = this.states[this.active - 1];
    const player = this.active;

    st.timeLeft = Math.max(0, st.timeLeft - 0.1);

    if (st.timeLeft <= 0) {
      if (this.cfg.mode === 'byoyomi') {
        if (!st.inByo && st.periods > 0) {
          st.inByo = true;
          st.timeLeft = this.cfg.byoTime;
        } else if (st.inByo && st.periods > 1) {
          st.periods -= 1;
          st.timeLeft = this.cfg.byoTime;
        } else {
          st.lost = true;
          st.timeLeft = 0;
          this._stopInterval();
          this.onTick(this.states[0], this.states[1]);
          this.onFlag(player);
          return;
        }
      } else {
        st.lost = true;
        st.timeLeft = 0;
        this._stopInterval();
        this.onTick(this.states[0], this.states[1]);
        this.onFlag(player);
        return;
      }
    }

    this.onTick(this.states[0], this.states[1]);
  }
}
