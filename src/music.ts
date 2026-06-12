/**
 * Procedural cyberpunk ambient music bed.
 *
 * Generates an evolving synthwave / Blade-Runner-ish soundscape entirely in
 * WebAudio — no audio files to ship, no licensing, works identically in the
 * standalone GitHub Pages build and the WordPress embed. A drone pad, a slow
 * sub-bass pulse and a sparse echoing pentatonic arp are scheduled on a
 * look-ahead clock and routed through a feedback-delay "space".
 *
 * The system is a singleton (`music`) and owns its own floating toggle button,
 * so any screen can call enterGame()/leaveGame() without touching the DOM. The
 * on/off preference persists in localStorage.
 */

// A2 minor pentatonic, two octaves — cold, filmic, never resolves too happily.
const ROOT = 55; // A1
const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22]; // semitones across 2 octaves
const semi = (n: number) => ROOT * Math.pow(2, n / 12);

type Voice = { osc: OscillatorNode; gain: GainNode };

/**
 * Beat bus: the procedural scheduler KNOWS when every note will sound, so the
 * renderer can sync visuals to the music with zero audio analysis. Events carry
 * a performance.now()-comparable timestamp; the renderer consumes those that
 * have come due each frame. `cityMix` flows the other way: the renderer writes
 * the void-reveal amount (0..1) and the music fades a rain/city-hum noise bed
 * in as you dolly out into the void.
 */
export const musicBus = {
  events: [] as { at: number; kind: 'bar' | 'bass' | 'arp' }[],
  cityMix: 0,
};

export class MusicSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private space: DelayNode | null = null;        // feedback delay (echo/space)
  private padFilter: BiquadFilterNode | null = null;
  private lfo: OscillatorNode | null = null;
  private pad: Voice[] = [];
  private running = false;
  private enabled: boolean;

  // Look-ahead scheduler state.
  private schedulerId: number | null = null;
  /** Pending graph-teardown timeout from stop(), cleared if start() re-enters
   *  within the fade window so it can't tear down the freshly-started graph. */
  private teardownId: number | null = null;
  private nextStepTime = 0;
  private step = 0;
  private readonly bpm = 82;

  private toggleEl: HTMLButtonElement | null = null;
  // Rain/city-hum bed, mixed by musicBus.cityMix (renderer-driven).
  private citySrc:  AudioBufferSourceNode | null = null;
  private cityGain: GainNode | null = null;

  constructor() {
    this.enabled = localStorage.getItem('go3d_music') !== 'off'; // default on
    this.installGestureUnlock();
    // Pause playback while the tab is hidden (the renderer already pauses):
    // suspending the context freezes currentTime, so the look-ahead scheduler
    // — which browsers throttle in background tabs — can't fall behind and
    // burst-schedule past-due notes on return. Resume picks up cleanly.
    document.addEventListener('visibilitychange', () => {
      const c = this.ctx;
      if (!c || !this.running) return;
      if (document.hidden) void c.suspend();
      else { void c.resume(); this.nextStepTime = c.currentTime + 0.15; }
    });
  }

  /**
   * iOS/Safari only unlock WebAudio when the context is created/resumed inside a
   * user gesture. Music starts on game entry, which for online games happens
   * after an async game-state fetch — i.e. outside the gesture — so on iPhone it
   * would stay silent. Create + resume the context on the very first user
   * interaction (login click, board tap, …); once unlocked it survives across
   * awaits, so the later start() plays normally.
   */
  private installGestureUnlock(): void {
    const events = [ 'pointerdown', 'touchend', 'mousedown', 'keydown' ];
    const unlock = () => {
      try {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (Ctor) {
          if (!this.ctx) this.ctx = new Ctor();
          if (this.ctx.state === 'suspended') void this.ctx.resume();
        }
      } catch { /* ignore — best effort */ }
      events.forEach(e => window.removeEventListener(e, unlock));
    };
    events.forEach(e => window.addEventListener(e, unlock, { passive: true }));
  }

  // ── Public lifecycle ───────────────────────────────────────────────────────

  /** Call when a game screen is shown: mount the control and start if enabled. */
  enterGame(): void {
    this.mountToggle();
    if (this.toggleEl) this.toggleEl.style.display = '';
    if (this.sfxEl) this.sfxEl.style.display = '';
    if (this.enabled) this.start();
  }

  /** Call when leaving a game screen: stop playback and hide the control. */
  leaveGame(): void {
    this.stop();
    if (this.toggleEl) this.toggleEl.style.display = 'none';
    if (this.sfxEl) this.sfxEl.style.display = 'none';
  }

  // ── Audio graph ────────────────────────────────────────────────────────────

  private start(): void {
    if (this.running) return;
    // Cancel any pending teardown from a recent stop() so it can't stop the
    // graph we're about to build.
    if (this.teardownId !== null) { clearTimeout(this.teardownId); this.teardownId = null; }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!this.ctx) this.ctx = new Ctor();
    const c = this.ctx;
    // Autoplay policy: a context created outside a gesture starts suspended.
    // Entering a game always follows a click, so this resume() resolves.
    if (c.state === 'suspended') void c.resume();

    this.running = true;

    // Master with a gentle fade-in.
    const master = c.createGain();
    master.gain.setValueAtTime(0.0001, c.currentTime);
    master.gain.exponentialRampToValueAtTime(0.16, c.currentTime + 2.5);
    master.connect(c.destination);
    this.master = master;

    // "Space": a feedback delay the arp and bass are sent through for echoes.
    const space = c.createDelay(1.0);
    space.delayTime.value = 60 / this.bpm * 0.75; // dotted-eighth echo
    const fb = c.createGain(); fb.gain.value = 0.34;
    const wet = c.createGain(); wet.gain.value = 0.5;
    space.connect(fb); fb.connect(space);
    space.connect(wet); wet.connect(master);
    this.space = space;

    // Drone pad: detuned saw stack through a slowly sweeping lowpass.
    const padFilter = c.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 520;
    padFilter.Q.value = 6;
    padFilter.connect(master);
    this.padFilter = padFilter;

    const lfo = c.createOscillator();
    lfo.frequency.value = 0.05; // ~20s sweep
    const lfoGain = c.createGain(); lfoGain.gain.value = 280;
    lfo.connect(lfoGain); lfoGain.connect(padFilter.frequency);
    lfo.start();
    this.lfo = lfo;

    const padGain = c.createGain(); padGain.gain.value = 0.22;
    padGain.connect(padFilter);
    [semi(0), semi(7), semi(12), semi(15)].forEach((f, i) => {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.detune.value = (i - 1.5) * 7; // a few cents apart → chorus shimmer
      const g = c.createGain(); g.gain.value = i === 0 ? 0.5 : 0.28;
      osc.connect(g); g.connect(padGain);
      osc.start();
      this.pad.push({ osc, gain: g });
    });

    // Rain/city hum: looping filtered noise, silent until the renderer raises
    // musicBus.cityMix (i.e. you zoom out into the void).
    {
      const len = 2 * c.sampleRate;
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource();
      src.buffer = buf; src.loop = true;
      const hiss = c.createBiquadFilter(); hiss.type = 'bandpass'; hiss.frequency.value = 3200; hiss.Q.value = 0.4;
      const hum  = c.createBiquadFilter(); hum.type  = 'lowpass';  hum.frequency.value = 240;
      const g = c.createGain(); g.gain.value = 0.0001;
      src.connect(hiss); hiss.connect(g);
      src.connect(hum);  hum.connect(g);
      g.connect(master);
      src.start();
      this.citySrc = src; this.cityGain = g;
    }

    // Kick off the note scheduler.
    this.nextStepTime = c.currentTime + 0.15;
    this.step = 0;
    this.schedulerId = window.setInterval(() => this.scheduler(), 25);

    this.syncToggle();
  }

  private stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.schedulerId !== null) { clearInterval(this.schedulerId); this.schedulerId = null; }
    const c = this.ctx;
    const master = this.master;
    if (c && master) {
      const t = c.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    }
    // Tear the graph down after the fade so we don't leak oscillators.
    const pad = this.pad, lfo = this.lfo, city = this.citySrc;
    this.citySrc = null; this.cityGain = null;
    this.teardownId = window.setTimeout(() => {
      this.teardownId = null;
      try { pad.forEach(v => v.osc.stop()); lfo?.stop(); city?.stop(); } catch { /* already stopped */ }
      master?.disconnect();
    }, 900);
    this.pad = [];
    this.lfo = null;
    this.master = null;
    this.space = null;
    this.padFilter = null;
    this.syncToggle();
  }

  // ── Note scheduling ────────────────────────────────────────────────────────

  private scheduler(): void {
    const c = this.ctx;
    if (!c || !this.running) return;
    const stepDur = 60 / this.bpm / 2; // eighth notes
    // If the interval was throttled (background tab, heavy main thread) the
    // step clock can fall behind the audio clock; scheduling those past-due
    // notes would smear them all at once "now". Skip ahead instead.
    if (this.nextStepTime < c.currentTime) this.nextStepTime = c.currentTime + 0.05;
    // Follow the renderer's void reveal with the rain/city bed.
    if (this.cityGain) {
      const target = Math.max(0.0001, musicBus.cityMix * 0.075);
      this.cityGain.gain.linearRampToValueAtTime(target, c.currentTime + 0.12);
    }
    while (this.nextStepTime < c.currentTime + 0.12) {
      this.scheduleStep(this.step, this.nextStepTime);
      this.nextStepTime += stepDur;
      this.step = (this.step + 1) % 32;
    }
  }

  private scheduleStep(step: number, when: number): void {
    const c = this.ctx, master = this.master, space = this.space;
    if (!c || !master || !space) return;

    // Tell the renderer (audio-time mapped to performance.now()-time).
    const emit = (kind: 'bar' | 'bass' | 'arp') => {
      musicBus.events.push({ at: performance.now() + Math.max(0, (when - c.currentTime)) * 1000, kind });
      if (musicBus.events.length > 48) musicBus.events.splice(0, musicBus.events.length - 48);
    };
    if (step % 32 === 0) emit('bar');

    // Sub-bass pulse on the downbeat of each 4-beat bar (every 8 eighths).
    if (step % 8 === 0) {
      emit('bass');
      const o = c.createOscillator(); o.type = 'sine';
      // Alternate the bar root for a slow two-bar harmonic rock (i → ♭III).
      const root = step % 16 === 0 ? semi(0) : semi(3);
      o.frequency.setValueAtTime(root, when);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.5, when + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.6);
      o.connect(g); g.connect(master);
      o.start(when); o.stop(when + 0.65);
    }

    // Sparse arp: probabilistic so it breathes rather than loops mechanically.
    const density = step % 2 === 0 ? 0.55 : 0.28;
    if (Math.random() < density) {
      emit('arp');
      const note = PENTA[Math.floor(Math.random() * PENTA.length)] + 12; // up an octave
      const f = semi(note);
      const o = c.createOscillator();
      o.type = Math.random() < 0.5 ? 'triangle' : 'square';
      o.frequency.setValueAtTime(f, when);
      const g = c.createGain();
      const peak = o.type === 'square' ? 0.05 : 0.09;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(peak, when + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.32);
      o.connect(g);
      g.connect(master);
      g.connect(space); // feed the echo
      o.start(when); o.stop(when + 0.36);
    }
  }

  // ── Toggle button (inline-styled, build-agnostic) ──────────────────────────

  toggle(): void {
    this.enabled = !this.enabled;
    localStorage.setItem('go3d_music', this.enabled ? 'on' : 'off');
    if (this.enabled) this.start(); else this.stop();
    this.syncToggle();
  }

  private mountToggle(): void {
    if (this.toggleEl) return;
    const b = document.createElement('button');
    b.id = 'go3d-music-toggle';
    b.type = 'button';
    b.title = 'Toggle music';
    b.setAttribute('aria-label', 'Toggle background music');
    Object.assign(b.style, {
      position: 'fixed', left: '16px', bottom: '16px', zIndex: '9999',
      width: '40px', height: '40px', padding: '0', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      font: '18px/1 ui-monospace, "SF Mono", Menlo, monospace',
      color: '#00e5ff', background: 'rgba(5,8,14,0.72)',
      border: '1px solid rgba(0,229,255,0.55)', borderRadius: '8px',
      backdropFilter: 'blur(4px)', transition: 'all .15s ease',
      boxShadow: '0 0 12px rgba(0,229,255,0.25)',
    } as Partial<CSSStyleDeclaration>);
    b.addEventListener('click', () => this.toggle());
    b.addEventListener('mouseenter', () => { b.style.boxShadow = '0 0 18px rgba(0,229,255,0.55)'; });
    b.addEventListener('mouseleave', () => { this.syncToggle(); });
    document.body.appendChild(b);
    this.toggleEl = b;
    this.syncToggle();
    this.mountSfxToggle();
  }

  /** Companion button: mutes the gameplay SOUND EFFECTS (placement, captures)
   *  independently of the music. SoundSystem reads the same localStorage key. */
  private sfxEl: HTMLButtonElement | null = null;
  private mountSfxToggle(): void {
    if (this.sfxEl) return;
    const b = document.createElement('button');
    b.id = 'go3d-sfx-toggle';
    b.type = 'button';
    b.setAttribute('aria-label', 'Toggle sound effects');
    Object.assign(b.style, {
      position: 'fixed', left: '62px', bottom: '16px', zIndex: '9999',
      width: '40px', height: '40px', padding: '0', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      font: '15px/1 ui-monospace, "SF Mono", Menlo, monospace',
      background: 'rgba(5,8,14,0.72)', borderRadius: '8px',
      backdropFilter: 'blur(4px)', transition: 'all .15s ease',
    } as Partial<CSSStyleDeclaration>);
    const sync = () => {
      const on = localStorage.getItem('go3d_sfx') !== 'off';
      b.textContent = on ? 'fx' : 'fx̸';
      b.style.color = on ? '#00e5ff' : '#56606f';
      b.style.border = `1px solid ${on ? 'rgba(0,229,255,0.55)' : 'rgba(120,130,150,0.45)'}`;
      b.style.boxShadow = on ? '0 0 12px rgba(0,229,255,0.25)' : 'none';
      b.title = on ? 'Sound effects on — click to mute' : 'Sound effects off — click to enable';
    };
    b.addEventListener('click', () => {
      const on = localStorage.getItem('go3d_sfx') !== 'off';
      try { localStorage.setItem('go3d_sfx', on ? 'off' : 'on'); } catch { /* ignore */ }
      sync();
    });
    document.body.appendChild(b);
    this.sfxEl = b;
    sync();
  }

  private syncToggle(): void {
    const b = this.toggleEl;
    if (!b) return;
    const on = this.enabled;
    b.textContent = on ? '♪' : '♪̸';
    b.style.color = on ? '#00e5ff' : '#56606f';
    b.style.borderColor = on ? 'rgba(0,229,255,0.55)' : 'rgba(120,130,150,0.45)';
    b.style.boxShadow = on ? '0 0 12px rgba(0,229,255,0.25)' : 'none';
    b.title = on ? 'Music on — click to mute' : 'Music off — click to play';
  }
}

/** Shared singleton — import and call enterGame()/leaveGame() from sessions. */
export const music = new MusicSystem();
