import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Go3D, Player, Cell, TerritoryResult } from './game';
import { musicBus } from './music';

// Touch devices (phones/tablets) get a lower render resolution and a capped
// frame rate: the bloom post-processing pipeline is fragment-bound, so on a
// high-DPI phone running it at full devicePixelRatio and 60fps pegs the GPU and
// overheats the device. These caps cut that load dramatically with little
// visible difference at phone screen sizes.
const IS_TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

// Respect the OS-level reduced-motion preference in the WebGL scene too (the
// CSS layer already honours it): no intro orbit, no void rig, no dust drift,
// no grid breathing, instant stone placement.
const REDUCED_MOTION = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** easeOutBack — stones land with a slight overshoot and settle. */
function backOut(t: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// ── Palette ───────────────────────────────────────────────────────────────────
const CYAN   = 0x00e5ff;
const PINK   = 0xff0077;
const BG     = 0x020408;
const GRID_I = 0x0a2535;
const GRID_O = 0x00c8e8;
const DOT_C  = 0x009ab0;

const STONE_R     = 0.22;
const TERRITORY_R = 0.11;

// ── Sounds ────────────────────────────────────────────────────────────────────
export class SoundSystem {
  private ctx: AudioContext | null = null;
  /** Sound effects can be muted independently of the music (toggle in music.ts). */
  private get muted(): boolean {
    try { return localStorage.getItem('go3d_sfx') === 'off'; } catch { return false; }
  }
  private get ac(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  place() {
    if (this.muted) return;
    const c = this.ac, o = c.createOscillator(), g = c.createGain();
    o.connect(g); g.connect(c.destination);
    o.frequency.value = 700 + Math.random() * 150; o.type = 'sine';
    g.gain.setValueAtTime(0.12, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.09);
    o.start(c.currentTime); o.stop(c.currentTime + 0.09);
  }
  capture(n: number) {
    if (this.muted) return;
    const c = this.ac, len = c.sampleRate * 0.12;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.25;
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain();
    g.gain.setValueAtTime(Math.min(0.8, 0.15 * n), c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.18);
    src.connect(g); g.connect(c.destination); src.start(); src.stop(c.currentTime + 0.18);
  }
  pass() {
    if (this.muted) return;
    const c = this.ac;
    [440, 550, 660].forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain();
      o.connect(g); g.connect(c.destination); o.frequency.value = f; o.type = 'sine';
      const t = c.currentTime + i * 0.06;
      g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.start(t); o.stop(t + 0.35);
    });
  }
  forbidden() {
    if (this.muted) return;
    const c = this.ac, o = c.createOscillator(), g = c.createGain();
    o.connect(g); g.connect(c.destination); o.frequency.value = 180; o.type = 'sawtooth';
    g.gain.setValueAtTime(0.1, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.14);
    o.start(c.currentTime); o.stop(c.currentTime + 0.14);
  }
  undo() {
    const c = this.ac;
    [660, 440].forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain();
      o.connect(g); g.connect(c.destination); o.frequency.value = f; o.type = 'sine';
      const t = c.currentTime + i * 0.07;
      g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      o.start(t); o.stop(t + 0.2);
    });
  }
}

function hoshiIndices(size: number): number[] {
  if (size >= 13) return [3, Math.floor(size / 2), size - 4];
  if (size >= 9)  return [2, Math.floor(size / 2), size - 3];
  if (size >= 7)  return [2, Math.floor(size / 2)];
  if (size >= 5)  return [Math.floor(size / 2)];
  return [];
}

interface StoneEntry { x: number; y: number; z: number; player: Player }
interface ParticleBurst {
  geo: THREE.BufferGeometry; pts: THREE.Points;
  vel: Float32Array; life: number;
}

// ── Renderer ──────────────────────────────────────────────────────────────────
export class Renderer {
  private scene     = new THREE.Scene();
  private camera!:   THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private controls!: OrbitControls;
  private sound     = new SoundSystem();

  private raycaster = new THREE.Raycaster();
  private mouse     = new THREE.Vector2(-9999, -9999);

  private blackStones!:    THREE.InstancedMesh;
  private whiteStones!:    THREE.InstancedMesh;
  private blackTerritory!: THREE.InstancedMesh;
  private whiteTerritory!: THREE.InstancedMesh;

  private stoneGeo!:      THREE.SphereGeometry;
  private blackGeo!:      THREE.SphereGeometry;
  private whiteGeo!:      THREE.SphereGeometry;
  private blackAlpha!:    THREE.InstancedBufferAttribute;
  private whiteAlpha!:    THREE.InstancedBufferAttribute;
  private blackMat!:      THREE.MeshPhysicalMaterial;
  private whiteMat!:      THREE.MeshPhysicalMaterial;
  private blackHoverMat!: THREE.MeshPhysicalMaterial;
  private whiteHoverMat!: THREE.MeshPhysicalMaterial;
  private hoverMesh!:     THREE.Mesh;
  private hoverPhase = 0;

  // Stone state cache for depth cueing
  private stoneEntries: StoneEntry[] = [];

  // Pop-in animation: key → scale (0→1)
  private popInMap = new Map<string, number>();

  // Capture pool
  private captureMat1!: THREE.MeshPhysicalMaterial;
  private captureMat2!: THREE.MeshPhysicalMaterial;
  private capturePool1: THREE.Mesh[] = [];
  private capturePool2: THREE.Mesh[] = [];
  private captureAnims: { mesh: THREE.Mesh; life: number; delay: number; burstColor: number; pool: THREE.Mesh[] }[] = [];

  // Particle bursts
  private bursts: ParticleBurst[] = [];

  // Effects
  private lastMoveMesh!: THREE.Mesh;
  private flashMesh!:    THREE.Mesh;
  private flashTimer = 0;

  // Axis targeting lines (3D crosshair)
  private axisLinePositions!: Float32Array;
  private axisLines!:         THREE.LineSegments;

  // Slice mode
  private sliceAxis:   'none' | 'x' | 'y' | 'z' = 'none';
  private sliceIndex   = 0;
  private slicePanel!: THREE.Mesh;
  private sliceBorder!: THREE.LineSegments;

  // Stack mode: when set, placement is restricted to this vertical (y) layer
  // and a highlight plane marks the current build surface. null = disabled.
  private stackLayer: number | null = null;
  private stackPlane!: THREE.Mesh;

  // Cursor (keyboard navigation)
  private cursorActive  = false;
  private cursorPos     = { x: 0, y: 0, z: 0 };
  private lastHover:      { x: number; y: number; z: number } | null = null;
  private rippleTimer   = 0;
  private layerGlyph!:   HTMLElement;

  // Camera control
  private tweenTarget: THREE.Vector3 | null = null;
  private introPhase = -1;   // -1 = inactive

  // Replay mode
  private replayMode = false;

  // Grid + particles for animation
  private innerGrid!: THREE.LineSegments;
  private boundingBox!: THREE.LineSegments;
  private particles!: THREE.Points;

  // ── Void FX: an exterior "containment rig" of motion that ORBITS the board.
  // A hard keep-out sphere (this.keepR) guards the play volume — every animated
  // element stays strictly outside it, so nothing ever clutters the field of
  // play. Everything is preallocated; only buffers/transforms mutate per frame.
  private keepR = 0;                  // radius of the no-fly sphere around play volume
  private fxReveal = 0;               // 0 when the cube fills the view, ramps to 1 as you zoom out
  private _camDir = new THREE.Vector3();
  private _tmpV  = new THREE.Vector3();
  private _tmpV2 = new THREE.Vector3();
  // Reusable scratch objects for per-frame work, so the animate loop doesn't
  // allocate (and churn the GC) every frame.
  private _labelV  = new THREE.Vector3();
  private _pulseMat = new THREE.Matrix4();
  private _pulseW  = new THREE.Vector3();
  // Viewport size cached on resize, to avoid layout-reads (innerWidth/Height)
  // in the per-frame label/cursor projection paths.
  private _vw = window.innerWidth;
  private _vh = window.innerHeight;
  private ringPalette = [0x00e5ff, 0xff0077, 0x1affa0];

  // ── The Datascape: an infinite computational plane the construct hovers
  //    over — grid + light carpet + data rivers + monoliths + aurora. ────────
  private city: THREE.Group | null = null;
  private floorY = 0;
  private RAIN_N = 760;
  private rainVel!:  Float32Array;
  private rainPos!:  THREE.BufferAttribute;
  private rainMat:   THREE.LineBasicMaterial | null = null;
  private rain:      THREE.LineSegments | null = null;
  private adboards:  { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; flick: number; speed: number }[] = [];
  private gridMat:   THREE.LineBasicMaterial | null = null;
  private glowMat:   THREE.MeshBasicMaterial | null = null;
  private blockLayers: { mat: THREE.PointsMaterial; phase: number }[] = [];
  private monoliths: { grp: THREE.Group; bodyMat: THREE.MeshBasicMaterial; edge: THREE.LineSegments; spin: number; phase: number; baseY: number; dockFlash: number }[] = [];
  // Live status boards (whose turn, stones, prisoners) — the void reports the game.
  private signs: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; kind: 'turn' | 'stones' | 'prisoners' | 'id'; flick: number; speed: number }[] = [];
  private capByBlack = 0;
  private capByWhite = 0;
  private dockFx: { ring: THREE.LineLoop; rMat: THREE.LineBasicMaterial; spr: THREE.Sprite; sMat: THREE.SpriteMaterial; life: number; on: boolean }[] = [];
  private _signDirty = true;
  private signPostMat: THREE.MeshBasicMaterial | null = null;
  private auroraMat: THREE.MeshBasicMaterial | null = null;
  private auroraTex: THREE.CanvasTexture | null = null;
  private droneAttr: THREE.BufferAttribute | null = null;
  private droneMat:  THREE.PointsMaterial | null = null;
  private droneParams: { ax: number; ay: number; az: number; fx: number; fy: number; fz: number; px: number; py: number; pz: number }[] = [];
  private droneCenter = new THREE.Vector3();
  private meteor:    THREE.LineSegments | null = null;
  private meteorMat: THREE.LineBasicMaterial | null = null;
  private meteorState = { active: false, life: 0, max: 240, p: new THREE.Vector3(), v: new THREE.Vector3() };
  private riverFlash = 0;
  // Mid-air layers: rising data embers + light pillars climbing from the carpet.
  private emberAttr: THREE.BufferAttribute | null = null;
  private emberVel!: Float32Array;
  private emberMat:  THREE.PointsMaterial | null = null;
  private pillars:   { mat: THREE.MeshBasicMaterial; phase: number; speed: number }[] = [];
  // Airships: small craft wandering the void; occasionally dock into a monolith.
  private ships: { p: THREE.Vector3; v: THREE.Vector3; mode: 'cruise' | 'dock'; dock: THREE.Vector3; targetMono: number;
    cooldown: number; theta: number; w1: number; p1: number; w2: number; p2: number;
    speed: number; hue: [number, number, number] }[] = [];
  private shipTrailPos!: Float32Array;
  private shipTrailCol!: Float32Array;
  private shipTrails: THREE.LineSegments | null = null;
  private shipGroups: { grp: THREE.Group; navA: THREE.Mesh; navB: THREE.Mesh }[] = [];
  private shipMats: THREE.Material[] = [];   // shared, opacity driven by reveal
  // Music-synced glow (beat bus) + connection-loss dimming.
  private _beatGlow   = 0;
  private _signalLost = false;
  private _bloomPass: UnrealBloomPass | null = null;

  // Line meshes whose vertices are faded per-frame against the view-aligned
  // exclusion tunnel, so no segment ever draws over the cube's footprint —
  // from ANY camera angle. Each entry carries the mesh, its local vertex
  // positions, a colour buffer to drive, a base RGB, and a brightness getter.
  private fadeLines: { mesh: THREE.Object3D; local: Float32Array; colorAttr: THREE.BufferAttribute; base: [number, number, number]; intensity: () => number }[] = [];

  // Comet-streaks: ride great-circle arcs on shells well outside the cube.
  private readonly STREAK_N = 30;
  private streaks!: THREE.LineSegments;
  private streakPos!: Float32Array;   // STREAK_N * 2 verts * 3
  private streakCol!: Float32Array;
  private streakState: { p: THREE.Vector3; axis: THREE.Vector3; omega: number; life: number; max: number; r: number; g: number; b: number }[] = [];
  private _streakTail = new THREE.Vector3();

  // Containment rings — tilted neon loops orbiting outside, each carrying a
  // bright runner node that races around it.
  private rings: { mesh: THREE.LineLoop; axis: THREE.Vector3; spin: number; phase: number; baseOp: number; mat: THREE.LineBasicMaterial; node: THREE.Mesh; nodeAng: number; nodeSpd: number; radius: number }[] = [];

  // Sonar pulse-rings that bloom outward from the keep-out sphere and fade.
  private readonly PULSE_N = 4;
  private pulses: { mesh: THREE.LineLoop; mat: THREE.LineBasicMaterial; life: number; max: number; bright: number; str: number; base: [number, number, number] }[] = [];
  private pulseCooldown = 40;

  // Outer cage + Tron "edge-runner" packets that race along the cage's edges.
  private readonly RUNNER_N = 14;
  private runners!: THREE.LineSegments;
  private runnerPos!: Float32Array;
  private runnerCol!: Float32Array;
  private runnerHeads!: THREE.Points;
  private runnerHeadPos!: Float32Array;
  private runnerHeadCol!: Float32Array;
  private runnerState: { edge: number; t: number; speed: number; r: number; g: number; b: number }[] = [];
  private cageCorners: THREE.Vector3[] = [];
  private cageEdges: [number, number][] = [];

  // Glyph satellites on a far shell — true circular orbits, never dipping in.
  private readonly GLYPH_N = 10;
  private glyphs: { spr: THREE.Sprite; r: number; speed: number; ang: number; u: THREE.Vector3; v: THREE.Vector3; flick: number; baseSc: number }[] = [];
  private glyphTextures: THREE.Texture[] = [];

  // DOM
  private coordTip!: HTMLElement;

  // Axis labels
  private axisLabels: { el: HTMLElement; wx: number; wy: number; wz: number }[] = [];

  // Intersection dots (need per-instance color for slice visibility)
  private dotInst!:   THREE.InstancedMesh;
  // Hoshi star points
  private hoshiInst:  THREE.InstancedMesh | null = null;
  private hoshiCoords: { x: number; y: number; z: number }[] = [];
  private hoshiIdx:    number[] = []; // the per-axis star indices (for stack-mode 2D pattern)

  private pointerDownAt = new THREE.Vector2();
  private pointerMoved  = false;

  // RAF id (for dispose) and dirty flags (dot/hoshi only update on slice change)
  private _rafId       = 0;
  private _dotsDirty   = true;
  private _hoshiDirty  = true;
  // Stone depth-cueing colours only need recomputing when the camera moves or
  // the board/slice/cursor changes — not every frame. Saves an O(stones) loop
  // plus two instanced-buffer GPU uploads on every idle frame.
  private _stonesColorDirty = true;
  private _lastCamPos  = new THREE.Vector3(Infinity, Infinity, Infinity);
  private _lastCamQuat = new THREE.Quaternion();
  // Frame-rate cap (ms between frames; 0 = uncapped) and the last frame stamp.
  private _frameInterval = IS_TOUCH ? 1000 / 40 : 0;
  private _lastFrameAt   = 0;
  // Timestamp of the last RENDERED frame, for delta-time animation scaling.
  private _lastT         = 0;
  private _disposed      = false;
  // Pause the render loop while the tab/page is hidden so it doesn't burn the
  // battery/GPU in the background; resume on return.
  private _onVisibility = () => {
    if (document.hidden) {
      if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
    } else if (this._rafId === 0 && !this._disposed) {
      this._lastFrameAt = 0;
      this.animate();
    }
  };
  private _onResize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    this._vw = w; this._vh = h;
    this.camera.aspect = w/h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h); this.composer.setSize(w, h);
  };

  private game:    Go3D;
  private onPlace: (x: number, y: number, z: number) => void;

  constructor(game: Go3D, onPlace: (x: number, y: number, z: number) => void,
              opts: { skipIntro?: boolean } = {}) {
    this.game    = game;
    this.onPlace = onPlace;
    this.initRenderer();
    this.initBloom();
    this.initLights();
    this.buildBoard();
    this.initParticles();
    this.initVoidFX();
    this.initDatascape();
    this.initStones();
    this.initTerritory();
    this.initEffects();
    this.setupEvents();
    // The reveal sweep only plays on a fresh game entry: undo reloads rebuild
    // the session, and replaying the 1.3s orbit every accepted undo was noise.
    if (opts.skipIntro || REDUCED_MOTION) { this.introPhase = -1; }
    else this.startIntroOrbit();
    if (REDUCED_MOTION) this.setVoidVisible(false);
    document.addEventListener('visibilitychange', this._onVisibility);
    this.animate();
  }

  private coord(i: number): number { return i - (this.game.size - 1) / 2; }

  // ── Renderer & camera ─────────────────────────────────────────────────────
  private initRenderer() {
    this.scene.background = new THREE.Color(BG);
    this.scene.fog = new THREE.FogExp2(BG, 0.012);

    const w = window.innerWidth, h = window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 1500);
    const d = this.game.size * 1.4;
    this.camera.position.set(d, d * 0.75, d);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2));
    this.renderer.toneMapping = THREE.ReinhardToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    document.body.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = this.game.size * 0.5;
    this.controls.maxDistance = this.game.size * 8;
    // NB: do NOT enable zoomToCursor — it drags controls.target toward the
    // pointer on every dolly, so after a zoom the orbit pivot is no longer the
    // cube centre and rotation swings off-axis. Keep the target pinned at the
    // origin so the board always rotates about its own centre.
    this.controls.target.set(0, 0, 0);

    this.coordTip = document.getElementById('coord-tip') ?? (() => {
      const el = document.createElement('div'); el.id = 'coord-tip';
      document.body.appendChild(el); return el;
    })();
  }

  private initBloom() {
    const w = window.innerWidth, h = window.innerHeight;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this._bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 1.1, 0.55, 0.28);
    this.composer.addPass(this._bloomPass);
  }

  private initLights() {
    this.scene.add(new THREE.AmbientLight(0x080820, 0.9));
    const top = new THREE.PointLight(CYAN, 3, this.game.size * 6);
    top.position.set(0, this.game.size * 2.5, 0); this.scene.add(top);
    const bot = new THREE.PointLight(PINK, 2, this.game.size * 6);
    bot.position.set(0, -this.game.size * 2.5, 0); this.scene.add(bot);
    const side = new THREE.PointLight(0x3300aa, 1.5, this.game.size * 5);
    side.position.set(this.game.size * 2, 0, -this.game.size * 2); this.scene.add(side);
  }

  // ── Board ─────────────────────────────────────────────────────────────────
  private buildBoard() {
    const s = this.game.size;
    const lo = this.coord(0), hi = this.coord(s - 1);
    const ext = (s - 1) / 2;

    // Inner grid
    const pts: number[] = [];
    for (let a = 0; a < s; a++)
      for (let b = 0; b < s; b++) {
        const ca = this.coord(a), cb = this.coord(b);
        pts.push(lo,ca,cb, hi,ca,cb, ca,lo,cb, ca,hi,cb, ca,cb,lo, ca,cb,hi);
      }
    const lGeo = new THREE.BufferGeometry();
    lGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.innerGrid = new THREE.LineSegments(lGeo,
      new THREE.LineBasicMaterial({ color: GRID_I, transparent: true, opacity: 0.9 }));
    this.scene.add(this.innerGrid);

    // Bounding box
    const c: [number,number,number][] = [
      [lo,lo,lo],[hi,lo,lo],[lo,hi,lo],[hi,hi,lo],
      [lo,lo,hi],[hi,lo,hi],[lo,hi,hi],[hi,hi,hi],
    ];
    const ei = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];
    const bp: number[] = [];
    for (const [a,b] of ei) bp.push(...c[a], ...c[b]);
    const bGeo = new THREE.BufferGeometry();
    bGeo.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    this.boundingBox = new THREE.LineSegments(bGeo,
      new THREE.LineBasicMaterial({ color: GRID_O, transparent: true, opacity: 1 }));
    this.scene.add(this.boundingBox);

    // Floor grid
    const fs = (s - 1) + 10;
    const floor = new THREE.GridHelper(fs, Math.min(s + 6, 30), 0x002233, 0x001525);
    floor.position.y = lo - 1.5;
    [floor.material].flat().forEach(m => {
      (m as THREE.LineBasicMaterial).transparent = true; (m as THREE.LineBasicMaterial).opacity = 0.5;
    });
    this.scene.add(floor);

    // Glass shell (Fresnel-like interior glow)
    const shellExt = ext + 0.1;
    this.scene.add(new THREE.Mesh(
      new THREE.BoxGeometry(shellExt*2, shellExt*2, shellExt*2),
      new THREE.MeshBasicMaterial({ color: 0x001122, transparent: true, opacity: 0.035, side: THREE.BackSide, depthWrite: false })
    ));

    // Intersection dots (white material; instance color drives actual colour)
    const total = s * s * s;
    this.dotInst = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.04, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff }), total);
    const dummy = new THREE.Object3D();
    const dotDefault = new THREE.Color(DOT_C);
    let di = 0;
    for (let x = 0; x < s; x++)
      for (let y = 0; y < s; y++)
        for (let z = 0; z < s; z++) {
          dummy.position.set(this.coord(x), this.coord(y), this.coord(z));
          dummy.updateMatrix(); this.dotInst.setMatrixAt(di, dummy.matrix);
          this.dotInst.setColorAt(di, dotDefault);
          di++;
        }
    this.dotInst.instanceMatrix.needsUpdate = true;
    if (this.dotInst.instanceColor) this.dotInst.instanceColor.needsUpdate = true;
    this.scene.add(this.dotInst);

    // Hoshi (star points) — white material, per-instance colour controls brightness
    const hi_arr = hoshiIndices(s);
    this.hoshiIdx = hi_arr;
    this.hoshiCoords = [];
    if (hi_arr.length > 0) {
      for (const ix of hi_arr) for (const iy of hi_arr) for (const iz of hi_arr)
        this.hoshiCoords.push({ x: ix, y: iy, z: iz });
      const hc = this.hoshiCoords.length;
      this.hoshiInst = new THREE.InstancedMesh(
        new THREE.OctahedronGeometry(0.06, 0),
        new THREE.MeshBasicMaterial({ color: 0xffffff }), hc);
      const hoshiDefault = new THREE.Color(0xffaa33); // visible but not blinding
      for (let i = 0; i < hc; i++) {
        const { x, y, z } = this.hoshiCoords[i];
        dummy.position.set(this.coord(x), this.coord(y), this.coord(z));
        dummy.updateMatrix();
        this.hoshiInst.setMatrixAt(i, dummy.matrix);
        this.hoshiInst.setColorAt(i, hoshiDefault);
      }
      this.hoshiInst.instanceMatrix.needsUpdate = true;
      if (this.hoshiInst.instanceColor) this.hoshiInst.instanceColor.needsUpdate = true;
      this.scene.add(this.hoshiInst);
    }

    // Axis labels
    this.axisLabels = this._buildAxisLabels(s, ext);
  }

  private _buildAxisLabels(s: number, ext: number) {
    document.getElementById('axis-labels')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'axis-labels';
    wrap.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:15;';
    document.body.appendChild(wrap);

    // Show every label for small boards, every other for large ones
    const step = s > 9 ? 2 : 1;
    const off  = 0.55;                        // tight to board edge
    const lo   = this.coord(0), hi = this.coord(s - 1);

    const CLRS = { x: '#00e5ff', y: '#ff0077', z: '#00ffaa' };

    const mkEl = (text: string, color: string, axis: string) => {
      const el = document.createElement('div');
      el.textContent = text;
      el.style.cssText =
        `position:absolute;font:bold 11px 'Share Tech Mono',monospace;` +
        `color:${color};transform:translate(-50%,-50%);` +
        `background:rgba(2,4,8,0.82);padding:1px 4px;border-radius:2px;` +
        `border:1px solid ${color}22;letter-spacing:0.04em;` +
        `text-shadow:0 0 6px ${color};`;
      el.dataset.axis = axis;
      wrap.appendChild(el);
      return el;
    };

    const items: { el: HTMLElement; wx: number; wy: number; wz: number }[] = [];

    // X labels — along bottom-front edge (Y=lo-off, Z=hi+off)
    for (let i = 0; i < s; i += step)
      items.push({ el: mkEl(String.fromCharCode(65 + i), CLRS.x, 'x'),
                   wx: this.coord(i), wy: lo - off, wz: hi + off });

    // Y labels — along left-front edge (X=lo-off, Z=hi+off)
    for (let i = 0; i < s; i += step)
      items.push({ el: mkEl(String(i + 1), CLRS.y, 'y'),
                   wx: lo - off, wy: this.coord(i), wz: hi + off });

    // Z labels — along bottom-right edge (X=hi+off, Y=lo-off)
    for (let i = 0; i < s; i += step)
      items.push({ el: mkEl(String.fromCharCode(97 + i), CLRS.z, 'z'),
                   wx: hi + off, wy: lo - off, wz: this.coord(i) });

    return items;
  }

  private _updateAxisLabels() {
    const w = this._vw, h = this._vh;
    const v = this._labelV;
    for (const { el, wx, wy, wz } of this.axisLabels) {
      v.set(wx, wy, wz).project(this.camera);
      if (v.z > 1) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.style.left = ((v.x * 0.5 + 0.5) * w) + 'px';
      el.style.top  = ((v.y * -0.5 + 0.5) * h) + 'px';
    }
  }

  // ── Particles ─────────────────────────────────────────────────────────────
  private initParticles() {
    // Rain as MOTION STREAKS: each drop is a short wind-slanted line segment
    // (head bright, tail dim) falling fast — reads as weather, not noise. The
    // whole layer is reveal-gated: clean board at play framing, rain in the
    // city view. Drops live in an annulus outside the play volume.
    const n = this.RAIN_N, r = this.game.size * 6;
    const guard = ((this.game.size - 1) / 2) * 2.4;
    const pos = new Float32Array(n * 6);
    const col = new Float32Array(n * 6);
    this.rainVel = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = guard + Math.random() * r;
      const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
      const y = (Math.random() - 0.5) * 2 * r;
      const v = 0.34 + Math.random() * 0.30;          // fast — rain, not snow
      const len = v * 5.5;
      this.rainVel[i] = v;
      // Shared wind slant (0.18, -1, 0.10): tail sits up-wind of the head.
      pos[i*6]   = x;               pos[i*6+1] = y;        pos[i*6+2] = z;
      pos[i*6+3] = x + 0.18 * len;  pos[i*6+4] = y + len;  pos[i*6+5] = z + 0.10 * len;
      col[i*6]   = 0.62; col[i*6+1] = 0.85; col[i*6+2] = 0.95;   // head
      col[i*6+3] = 0.06; col[i*6+4] = 0.10; col[i*6+5] = 0.12;   // tail
    }
    const geo = new THREE.BufferGeometry();
    this.rainPos = new THREE.Float32BufferAttribute(pos, 3) as THREE.BufferAttribute;
    this.rainPos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.rainPos);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.rainMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.rain = new THREE.LineSegments(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
    // Keep the legacy field pointing at something harmless.
    this.particles = this.rain as unknown as THREE.Points;
  }

  /** Redraw the status boards from current game state (called each move). */
  private refreshSignage(): void {
    let b = 0, w = 0;
    for (const e of this.stoneEntries) (e.player === 1 ? b++ : w++);
    const turnBlack = this.game.currentPlayer === 1;
    for (const sg of this.signs) {
      const ctx = sg.ctx;
      ctx.clearRect(0, 0, 256, 128);
      ctx.fillStyle = 'rgba(4,8,14,0.92)'; ctx.fillRect(0, 0, 256, 128);
      const accent = sg.kind === 'turn' ? (turnBlack ? '#00e5ff' : '#ff2d8a')
                   : sg.kind === 'prisoners' ? '#ff7a3c' : '#19f5a0';
      ctx.strokeStyle = accent; ctx.lineWidth = 3; ctx.strokeRect(4, 4, 248, 120);
      ctx.fillStyle = 'rgba(120,135,160,0.85)'; ctx.font = '13px monospace'; ctx.textAlign = 'left';
      const drawDual = (label: string, lhs: string, rhs: string) => {
        ctx.fillStyle = 'rgba(120,135,160,0.8)'; ctx.font = '13px monospace'; ctx.textAlign = 'center';
        ctx.fillText(label, 128, 32);
        ctx.font = 'bold 30px monospace';
        ctx.fillStyle = '#7af0ff'; ctx.textAlign = 'left';  ctx.fillText('\u25CF ' + lhs, 22, 86);
        ctx.fillStyle = '#ff8fb6'; ctx.textAlign = 'right'; ctx.fillText(rhs + ' \u25CB', 234, 86);
      };
      if (sg.kind === 'turn') {
        ctx.fillStyle = accent; ctx.font = 'bold 26px monospace'; ctx.textAlign = 'center';
        ctx.fillText(turnBlack ? '\u25CF BLACK' : '\u25CB WHITE', 128, 58);
        ctx.fillStyle = 'rgba(180,195,215,0.85)'; ctx.font = '16px monospace';
        ctx.fillText('TO MOVE', 128, 92);
      } else if (sg.kind === 'stones') {
        drawDual('STONES ON BOARD', String(b), String(w));
      } else if (sg.kind === 'prisoners') {
        drawDual('PRISONERS', String(this.capByBlack), String(this.capByWhite));
      } else {
        ctx.fillStyle = '#19f5a0'; ctx.font = 'bold 30px monospace'; ctx.textAlign = 'center';
        ctx.fillText('GO\u00B73D', 128, 56);
        ctx.fillStyle = 'rgba(180,195,215,0.8)'; ctx.font = '15px monospace';
        ctx.fillText(this.game.size + '\u00B3 \u00B7 NET', 128, 90);
      }
      sg.tex.needsUpdate = true;
    }
  }

  /** Fire the local dock burst (flash + shock ring) at a world point. */
  private spawnDockFx(p: THREE.Vector3): void {
    const fx = this.dockFx.find(q => !q.on);
    if (!fx) return;
    fx.on = true; fx.life = 0;
    fx.ring.position.copy(p); fx.spr.position.copy(p);
    fx.ring.visible = true; fx.spr.visible = true;
    fx.ring.lookAt(this.camera.position);
  }

  /** THE DATASCAPE — an infinite computational plane the construct hovers
   *  over. Built from what this engine renders beautifully: thousands of small
   *  glowing things. Grid + light carpet (city blocks from altitude) + glow
   *  pool under the construct + colossal drifting monoliths + aurora + drone
   *  flock + a rare meteor. Everything lives in one group, reveal-gated and
   *  hard-culled at play framing. */
  private initDatascape() {
    const size = this.game.size;
    this.floorY = -size * 2.6;
    const floorY = this.floorY;
    const G = size * 20;
    const city = new THREE.Group();
    this.city = city;

    // — Circuit grid: lines fading toward the horizon (4 verts each so the
    //   centre is bright and the ends die out) —
    {
      const sp = size * 1.6, K = 12;
      const pos: number[] = [], col: number[] = [];
      const push = (x1: number, z1: number, x2: number, z2: number, b1: number, b2: number) => {
        pos.push(x1, floorY, z1, x2, floorY, z2);
        col.push(0.0 * b1, 0.55 * b1, 0.62 * b1, 0.0 * b2, 0.55 * b2, 0.62 * b2);
      };
      for (let k = -K; k <= K; k++) {
        const o = k * sp, fade = 1 - Math.abs(k) / (K + 2);
        push(-G, o, 0, o, 0, fade); push(0, o, G, o, fade, 0);     // along X
        push(o, -G, o, 0, 0, fade); push(o, 0, o, G, fade, 0);     // along Z
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      this.gridMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const grid = new THREE.LineSegments(geo, this.gridMat);
      grid.frustumCulled = false;
      city.add(grid);
    }

    // — Light carpet: ~6000 clustered points = city blocks seen from altitude.
    //   Three layers with phase-offset twinkle so the whole floor shimmers. —
    for (let layer = 0; layer < 3; layer++) {
      const N = 2000;
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      let i = 0;
      while (i < N) {
        // cluster centre
        const ca = Math.random() * Math.PI * 2;
        const cr = size * (3 + Math.pow(Math.random(), 0.7) * 16);
        const cx = Math.cos(ca) * cr, cz = Math.sin(ca) * cr;
        const cn = Math.min(N - i, 30 + (Math.random() * 120 | 0));
        for (let j = 0; j < cn; j++, i++) {
          const a = Math.random() * Math.PI * 2, rr = Math.pow(Math.random(), 1.6) * size * 1.4;
          pos[i*3]   = cx + Math.cos(a) * rr;
          pos[i*3+1] = floorY + Math.random() * 0.25;
          pos[i*3+2] = cz + Math.sin(a) * rr;
          const roll = Math.random(), b = 0.3 + Math.random() * 0.7;
          if (roll < 0.5)      { col[i*3] = 1.0 * b; col[i*3+1] = 0.82 * b; col[i*3+2] = 0.55 * b; }
          else if (roll < 0.85){ col[i*3] = 0.35 * b; col[i*3+1] = 0.85 * b; col[i*3+2] = 1.0 * b; }
          else                 { col[i*3] = 1.0 * b; col[i*3+1] = 0.25 * b; col[i*3+2] = 0.55 * b; }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const mat = new THREE.PointsMaterial({
        size: size * 0.07, vertexColors: true, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      city.add(pts);
      this.blockLayers.push({ mat, phase: (layer / 3) * Math.PI * 2 });
    }

    // — Glow pool: the construct's light falling on the city directly below.
    //   This anchors the board to the plane (no beam — it reads as cast light). —
    {
      const gc = document.createElement('canvas'); gc.width = 128; gc.height = 128;
      const gg = gc.getContext('2d')!;
      const grad = gg.createRadialGradient(64, 64, 4, 64, 64, 64);
      grad.addColorStop(0, 'rgba(0,229,255,0.55)');
      grad.addColorStop(0.35, 'rgba(0,160,210,0.22)');
      grad.addColorStop(1, 'rgba(0,80,120,0)');
      gg.fillStyle = grad; gg.fillRect(0, 0, 128, 128);
      this.glowMat = new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(gc), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const pool = new THREE.Mesh(new THREE.CircleGeometry(size * 3.2, 40), this.glowMat);
      pool.rotation.x = -Math.PI / 2;
      pool.position.y = floorY + 0.04;
      city.add(pool);
    }

    // — Monoliths: five colossal dark slabs with neon-traced edges, floating
    //   and slowly drifting in the deep void. Scale is the point. —
    const edgeHues = [0x00e5ff, 0xff0077, 0x00e5ff, 0x19f5a0, 0xff0077];
    for (let i = 0; i < 5; i++) {
      const w = size * (2.5 + Math.random() * 2.0);
      const h = size * (7 + Math.random() * 7);
      const d = size * (0.8 + Math.random() * 0.8);
      const ang = (i / 5) * Math.PI * 2 + Math.random() * 0.5;
      const rad = size * (6.5 + Math.random() * 5);
      const baseY = floorY + h / 2 + size * (0.5 + Math.random() * 2.5);
      const grp = new THREE.Group();
      grp.position.set(Math.cos(ang) * rad, baseY, Math.sin(ang) * rad);
      grp.rotation.y = Math.random() * Math.PI;
      // Self-lit slabs: a generated circuit-trace texture makes the monoliths
      // read at any distance — 1px edge lines alone vanish (lesson learned).
      const tc = document.createElement('canvas'); tc.width = 128; tc.height = 256;
      const tg = tc.getContext('2d')!;
      tg.fillStyle = '#05070e'; tg.fillRect(0, 0, 128, 256);
      for (let col = 6; col < 122; col += 9 + (Math.random() * 6 | 0)) {
        const hue = Math.random() < 0.82 ? '0,229,255' : '255,0,119';
        let y = Math.random() * 40;
        while (y < 250) {
          const seg = 12 + Math.random() * 50;
          if (Math.random() < 0.72) {
            tg.fillStyle = `rgba(${hue},${0.25 + Math.random() * 0.6})`;
            tg.fillRect(col, y, 2, seg);
            if (Math.random() < 0.4) { tg.fillStyle = `rgba(${hue},0.95)`; tg.fillRect(col - 1, y + seg - 3, 4, 3); }
          }
          y += seg + 4 + Math.random() * 26;
        }
      }
      const bodyMat = new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(tc), transparent: true, opacity: 0, depthWrite: false,
      });
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMat);
      grp.add(body);
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(body.geometry),
        new THREE.LineBasicMaterial({
          color: edgeHues[i], transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
      grp.add(edge);
      city.add(grp);
      this.monoliths.push({ grp, bodyMat, edge, spin: (Math.random() - 0.5) * 0.0012, phase: Math.random() * 6.28, baseY, dockFlash: 0 });
    }

    // — Status boards: free-standing HUD signs reporting the live game, raised
    // on glowing posts in a ring around the play volume (facing the board), so
    // they're clearly readable from the zoomed-out framing. Redrawn each move. —
    const signKinds: ('turn' | 'stones' | 'prisoners' | 'id')[] = ['turn', 'stones', 'prisoners', 'id', 'turn'];
    const postMat = new THREE.MeshBasicMaterial({ color: 0x0a5a6e, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.signPostMat = postMat;
    signKinds.forEach((kind, i) => {
      const ac = document.createElement('canvas'); ac.width = 256; ac.height = 128;
      const ctx = ac.getContext('2d')!;
      const tex = new THREE.CanvasTexture(ac);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(size * 3.4, size * 1.7), mat);
      const ang = (i / signKinds.length) * Math.PI * 2 + 0.5;
      const rad = size * 4.6;
      const y = size * (0.6 + (i % 2) * 1.2);
      const grp = new THREE.Group();
      grp.position.set(Math.cos(ang) * rad, 0, Math.sin(ang) * rad);
      board.position.y = y;
      grp.add(board);
      // glowing post from the floor up to the board
      const postH = y - floorY;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.06, size * 0.06, postH, 6), postMat);
      post.position.y = floorY + postH / 2;
      grp.add(post);
      grp.lookAt(0, y, 0);
      city.add(grp);
      this.signs.push({ mesh: board, mat, ctx, tex, kind, flick: Math.random() * 10, speed: 0.04 + Math.random() * 0.05 });
    });
    this.refreshSignage();

    // — Aurora: a slow-scrolling colour band that fills the upper void —
    {
      const ac = document.createElement('canvas'); ac.width = 512; ac.height = 128;
      const ag = ac.getContext('2d')!;
      for (let b = 0; b < 5; b++) {
        const y = 14 + b * 22 + Math.random() * 8, hh = 7 + Math.random() * 12;
        const grad = ag.createLinearGradient(0, y, 0, y + hh);
        const hue = b % 2 ? 'rgba(0,229,255,' : 'rgba(255,0,119,';
        grad.addColorStop(0, hue + '0)');
        grad.addColorStop(0.5, hue + (0.22 + Math.random() * 0.16) + ')');
        grad.addColorStop(1, hue + '0)');
        ag.fillStyle = grad; ag.fillRect(0, y, 512, hh);
      }
      this.auroraTex = new THREE.CanvasTexture(ac);
      this.auroraTex.wrapS = THREE.RepeatWrapping;
      this.auroraMat = new THREE.MeshBasicMaterial({
        map: this.auroraTex, transparent: true, opacity: 0, side: THREE.BackSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const sky = new THREE.Mesh(
        new THREE.CylinderGeometry(size * 18, size * 18, size * 9, 36, 1, true), this.auroraMat);
      sky.position.y = size * 6;
      city.add(sky);
    }

    // — Drone flock: organic lissajous weave against the geometric city —
    {
      const N = 16;
      this.droneCenter.set(size * 5.5, size * 2.5, -size * 4.5);
      const pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        this.droneParams.push({
          ax: size * (1.5 + Math.random() * 2.5), ay: size * (0.8 + Math.random() * 1.4), az: size * (1.5 + Math.random() * 2.5),
          fx: 0.6 + Math.random() * 1.1, fy: 0.8 + Math.random() * 1.2, fz: 0.6 + Math.random() * 1.1,
          px: Math.random() * 6.28, py: Math.random() * 6.28, pz: Math.random() * 6.28,
        });
      }
      const geo = new THREE.BufferGeometry();
      this.droneAttr = new THREE.Float32BufferAttribute(pos, 3) as THREE.BufferAttribute;
      this.droneAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', this.droneAttr);
      this.droneMat = new THREE.PointsMaterial({
        color: 0xbfeaff, size: size * 0.1, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const pts = new THREE.Points(geo, this.droneMat);
      pts.frustumCulled = false;
      city.add(pts);
    }

    // — Rising data embers: the air itself is alive. A sparse field of motes
    //   drifting up through the whole void volume, wrapping at the top. —
    {
      const N = 400;
      const pos = new Float32Array(N * 3);
      this.emberVel = new Float32Array(N);
      const guard = ((size - 1) / 2) * 2.4;
      for (let i = 0; i < N; i++) {
        const a = Math.random() * Math.PI * 2;
        const rr = guard + Math.random() * size * 14;
        pos[i*3]   = Math.cos(a) * rr;
        pos[i*3+1] = floorY + Math.random() * size * 8;
        pos[i*3+2] = Math.sin(a) * rr;
        this.emberVel[i] = 0.015 + Math.random() * 0.04;
      }
      const geo = new THREE.BufferGeometry();
      this.emberAttr = new THREE.Float32BufferAttribute(pos, 3) as THREE.BufferAttribute;
      this.emberAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', this.emberAttr);
      this.emberMat = new THREE.PointsMaterial({
        color: 0x66d8ee, size: size * 0.05, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const pts = new THREE.Points(geo, this.emberMat);
      pts.frustumCulled = false;
      city.add(pts);
    }

    // — Light pillars: shafts climbing from the brightest carpet clusters into
    //   the sky, bridging floor and aurora so the middle is never empty. —
    {
      const pc = document.createElement('canvas'); pc.width = 32; pc.height = 128;
      const pg = pc.getContext('2d')!;
      const pgrad = pg.createLinearGradient(0, 128, 0, 0);
      pgrad.addColorStop(0, 'rgba(0,229,255,0.5)');
      pgrad.addColorStop(0.4, 'rgba(0,229,255,0.16)');
      pgrad.addColorStop(1, 'rgba(0,229,255,0)');
      pg.fillStyle = pgrad; pg.fillRect(0, 0, 32, 128);
      const ptex = new THREE.CanvasTexture(pc);
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * Math.PI * 2;
        const rr = size * (4 + Math.random() * 12);
        const h = size * (3 + Math.random() * 5);
        const mat = new THREE.MeshBasicMaterial({
          map: ptex, transparent: true, opacity: 0, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const grp = new THREE.Group();
        const p1 = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.4, h), mat);
        const p2 = p1.clone(); p2.rotation.y = Math.PI / 2;
        grp.add(p1, p2);
        grp.position.set(Math.cos(a) * rr, floorY + h / 2, Math.sin(a) * rr);
        city.add(grp);
        this.pillars.push({ mat, phase: Math.random() * 6.28, speed: 0.012 + Math.random() * 0.02 });
      }
    }

    // — Airships: proper little vessels, not dots. Each is a dark hull whose
    //   LIGHT SIGNATURE does the work at distance: glowing side strips, a
    //   bright engine block trailing a long wake, and blinking nav tips.
    //   They wander on curving paths and occasionally dock INTO a monolith. —
    {
      const N = 7;
      this.shipTrailPos = new Float32Array(N * 6);
      this.shipTrailCol = new Float32Array(N * 6);
      const tgeo = new THREE.BufferGeometry();
      const tp = new THREE.BufferAttribute(this.shipTrailPos, 3); tp.setUsage(THREE.DynamicDrawUsage);
      const tcl = new THREE.BufferAttribute(this.shipTrailCol, 3); tcl.setUsage(THREE.DynamicDrawUsage);
      tgeo.setAttribute('position', tp); tgeo.setAttribute('color', tcl);
      this.shipTrails = new THREE.LineSegments(tgeo, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false }));
      this.shipTrails.frustumCulled = false;
      city.add(this.shipTrails);

      // Shared materials (opacity driven each frame by reveal). A dark hull
      // body + a glowing EdgesGeometry trace over it = real 3D craft whose
      // wireframe reads at any distance. Pooled geometries are reused per type.
      const L = size * 0.85;
      const hullMat  = new THREE.MeshBasicMaterial({ color: 0x0a1320, transparent: true, opacity: 0 });
      const edgeCyan = new THREE.LineBasicMaterial({ color: 0x4fd8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const edgeAmber= new THREE.LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const engCyan  = new THREE.MeshBasicMaterial({ color: 0x9ff4ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const engAmber = new THREE.MeshBasicMaterial({ color: 0xffc266, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const navCyanM = new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const navPinkM = new THREE.MeshBasicMaterial({ color: 0xff2d8a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      this.shipMats = [hullMat, edgeCyan, edgeAmber, engCyan, engAmber, navCyanM, navPinkM];

      // A swept wing as a thin extruded prism (genuine 3D volume, not a plane).
      const wingGeom = (span: number, chord: number, sweep: number): THREE.BufferGeometry => {
        const t = L * 0.045;
        const shape = new THREE.Shape();
        shape.moveTo(0, chord * 0.5);
        shape.lineTo(span, chord * 0.5 - sweep);
        shape.lineTo(span, -chord * 0.5 + sweep * 0.55);
        shape.lineTo(0, -chord * 0.5);
        shape.closePath();
        const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
        g.translate(0, 0, -t / 2);
        g.rotateX(Math.PI / 2);              // lie flat in XZ
        return g;
      };
      const addPart = (grp: THREE.Group, geo: THREE.BufferGeometry, edge: THREE.LineBasicMaterial,
                       x: number, y: number, z: number, ry = 0) => {
        const mesh = new THREE.Mesh(geo, hullMat);
        mesh.position.set(x, y, z); mesh.rotation.y = ry; grp.add(mesh);
        const ln = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edge);
        ln.position.copy(mesh.position); ln.rotation.copy(mesh.rotation); grp.add(ln);
      };

      const buildShip = (type: number, cyan: boolean): { grp: THREE.Group; navA: THREE.Mesh; navB: THREE.Mesh } => {
        const edge = cyan ? edgeCyan : edgeAmber;
        const eng  = cyan ? engCyan : engAmber;
        const grp  = new THREE.Group();
        const fus = new THREE.CylinderGeometry(L * 0.045, L * 0.07, L * 0.7, 6);
        fus.rotateX(Math.PI / 2);
        addPart(grp, fus, edge, 0, 0, L * 0.05);
        const navGeo = new THREE.SphereGeometry(L * 0.035, 6, 6);
        let wA = L * 0.5, wB = L * 0.5;
        if (type === 0) {
          const w = wingGeom(L * 0.55, L * 0.34, L * 0.24);
          addPart(grp, w, edge,  L * 0.05, 0,  L * 0.06);
          addPart(grp, w, edge, -L * 0.05, 0,  L * 0.06, Math.PI);
          const r = wingGeom(L * 0.32, L * 0.2, L * 0.12);
          addPart(grp, r, edge,  L * 0.05, 0, -L * 0.18);
          addPart(grp, r, edge, -L * 0.05, 0, -L * 0.18, Math.PI);
          wA = wB = L * 0.6;
        } else if (type === 1) {
          const boom = new THREE.BoxGeometry(L * 0.05, L * 0.05, L * 0.6);
          addPart(grp, boom, edge,  L * 0.14, 0, 0);
          addPart(grp, boom, edge, -L * 0.14, 0, 0);
          const w = wingGeom(L * 0.44, L * 0.3, L * 0.22);
          addPart(grp, w, edge,  L * 0.16, L * 0.02,  L * 0.02);
          addPart(grp, w, edge, -L * 0.16, L * 0.02,  L * 0.02, Math.PI);
          const pod = new THREE.SphereGeometry(L * 0.08, 8, 6); pod.scale(1, 0.8, 1.7);
          addPart(grp, pod, edge, 0, 0, L * 0.12);
          wA = wB = L * 0.62;
        } else {
          const w = wingGeom(L * 0.6, L * 0.52, L * 0.36);
          addPart(grp, w, edge, 0, 0, 0);
          addPart(grp, w, edge, 0, 0, 0, Math.PI);
          wA = wB = L * 0.6;
        }
        const bell = new THREE.Mesh(new THREE.SphereGeometry(L * 0.07, 8, 6), eng);
        bell.scale.set(1, 1, 0.55); bell.position.set(0, 0, -L * 0.36); grp.add(bell);
        const navA = new THREE.Mesh(navGeo, navCyanM); navA.position.set(-wA, 0, L * 0.05); grp.add(navA);
        const navB = new THREE.Mesh(navGeo, navPinkM); navB.position.set( wB, 0, L * 0.05); grp.add(navB);
        return { grp, navA, navB };
      };

      for (let i = 0; i < N; i++) {
        const cyan = Math.random() < 0.6;
        const built = buildShip((Math.random() * 3) | 0, cyan);   // random fleet mix
        city.add(built.grp);
        this.shipGroups.push(built);

        const a = Math.random() * Math.PI * 2;
        this.ships.push({
          p: new THREE.Vector3(Math.cos(a) * size * 8, floorY + size * (2 + Math.random() * 4), Math.sin(a) * size * 8),
          v: new THREE.Vector3(), mode: 'cruise', dock: new THREE.Vector3(), targetMono: -1,
          cooldown: 300 + Math.random() * 900,
          theta: Math.random() * Math.PI * 2,
          w1: 0.005 + Math.random() * 0.01, p1: Math.random() * 6.28,
          w2: 0.003 + Math.random() * 0.008, p2: Math.random() * 6.28,
          speed: size * (0.018 + Math.random() * 0.02),
          hue: cyan ? [0.6, 0.95, 1.0] : [1.0, 0.7, 0.25],
        });
      }
    }

    // — Meteor: a rare bright streak across the deep sky —
    {
      const geo = new THREE.BufferGeometry();
      const attr = new THREE.Float32BufferAttribute(new Float32Array(6), 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', attr);
      this.meteorMat = new THREE.LineBasicMaterial({
        color: 0xeaffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      this.meteor = new THREE.LineSegments(geo, this.meteorMat);
      this.meteor.frustumCulled = false;
      city.add(this.meteor);
    }

    // — Dock-burst pool: flash + shock ring at a ship's hull-entry point —
    {
      const fc = document.createElement('canvas'); fc.width = 64; fc.height = 64;
      const fg = fc.getContext('2d')!;
      const fgrad = fg.createRadialGradient(32, 32, 0, 32, 32, 32);
      fgrad.addColorStop(0, 'rgba(200,245,255,1)'); fgrad.addColorStop(0.4, 'rgba(120,220,255,0.6)'); fgrad.addColorStop(1, 'rgba(80,180,255,0)');
      fg.fillStyle = fgrad; fg.fillRect(0, 0, 64, 64);
      const ftex = new THREE.CanvasTexture(fc);
      const SEG = 40;
      const local = new Float32Array(SEG * 3);
      for (let i = 0; i < SEG; i++) { const a = (i / SEG) * Math.PI * 2; local[i*3] = Math.cos(a); local[i*3+1] = Math.sin(a); local[i*3+2] = 0; }
      for (let k = 0; k < 4; k++) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(local.slice(), 3));
        const rMat = new THREE.LineBasicMaterial({ color: 0x9ff4ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
        const ring = new THREE.LineLoop(g, rMat); ring.frustumCulled = false; ring.visible = false; city.add(ring);
        const sMat = new THREE.SpriteMaterial({ map: ftex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
        const spr = new THREE.Sprite(sMat); spr.visible = false; city.add(spr);
        this.dockFx.push({ ring, rMat, spr, sMat, life: 0, on: false });
      }
    }

    city.visible = false;
    this.scene.add(city);
  }

  // An exterior "containment rig" orbiting the play volume. A keep-out sphere
  // (this.keepR) guards the board: every animated element lives strictly
  // outside it, so the field of play is never cluttered.
  private initVoidFX() {
    const ext = (this.game.size - 1) / 2;
    this.keepR = ext * 3.6;           // far beyond corner distance (ext·√3 ≈ 1.73·ext)

    // — Comet-streaks (great-circle arcs on outer shells) —
    this.streakPos = new Float32Array(this.STREAK_N * 2 * 3);
    this.streakCol = new Float32Array(this.STREAK_N * 2 * 3);
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.streakPos, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(this.streakCol, 3); colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', colAttr);
    this.streaks = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.streaks.frustumCulled = false;
    this.scene.add(this.streaks);
    for (let i = 0; i < this.STREAK_N; i++) {
      this.streakState.push({ p: new THREE.Vector3(), axis: new THREE.Vector3(), omega: 0, life: 0, max: 1, r: 0, g: 0, b: 0 });
      this.spawnStreak(i, Math.random() * 90);
    }

    // Slimmed to what the Datascape needs: the pulse pool (floor ripples) and
    // minimal corner brackets framing the construct (the old full cage boxed
    // the whole view; rings/glyph satellites/cage runners are retired).
    this.initPulses();
    this.initBrackets();
  }

  /** Pick an orthonormal basis (u,v) for a random plane through the origin. */
  private randomBasis(u: THREE.Vector3, v: THREE.Vector3) {
    const n = this._tmpV.set(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1);
    if (n.lengthSq() < 1e-4) n.set(0, 1, 0);
    n.normalize();
    u.set(0, 1, 0);
    if (Math.abs(n.y) > 0.9) u.set(1, 0, 0);
    u.crossVectors(u, n).normalize();
    v.crossVectors(n, u).normalize();
  }

  /**
   * Visibility multiplier for the view-aligned exclusion tunnel. The cube is
   * centred at the origin; `_camDir` is the unit view direction (current at the
   * top of updateVoidFX). We measure a point's perpendicular distance from the
   * line of sight through the cube centre — i.e. how far it sits from the cube
   * *on screen* — and fade it out as it enters the cube's footprint, on the near
   * AND far side. Because the tunnel is anchored to the view direction, the
   * clear zone tracks the camera, so nothing ever overlaps the playing field no
   * matter how the view is moved. Returns 1 well clear, eases to 0 over the cube.
   */
  private silhouetteFade(p: THREE.Vector3): number {
    const d = p.dot(this._camDir);                 // signed view-depth
    const perp = Math.sqrt(Math.max(0, p.lengthSq() - d * d));
    const ext = (this.game.size - 1) / 2;
    // Cube silhouette reaches its corner radius ≈1.73·ext; keep a generous gap
    // so nothing hugs the edges — fully clear below 2.8·ext, fully shown past 3.8·ext.
    const inner = ext * 2.8, outer = ext * 3.8;
    if (perp >= outer) return 1;
    if (perp <= inner) return 0;
    const t = (perp - inner) / (outer - inner);
    return t * t * (3 - 2 * t);                     // smoothstep
  }

  /** Hex 0xRRGGBB → normalized [r,g,b]. */
  private hexRGB(hex: number): [number, number, number] {
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  }

  /** Recolour every registered fade-line so its vertices vanish inside the tunnel. */
  private updateFadeLines() {
    for (const fl of this.fadeLines) {
      const inten = fl.intensity() * this.fxReveal;
      const [br, bg, bb] = fl.base;
      fl.mesh.updateWorldMatrix(true, false);
      const mw = fl.mesh.matrixWorld;
      const local = fl.local, col = fl.colorAttr.array as Float32Array;
      const n = local.length / 3;
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        this._tmpV.set(local[o], local[o + 1], local[o + 2]).applyMatrix4(mw);
        const k = inten * this.silhouetteFade(this._tmpV);
        col[o] = br * k; col[o + 1] = bg * k; col[o + 2] = bb * k;
      }
      fl.colorAttr.needsUpdate = true;
    }
  }

  /** Tilted neon loops orbiting outside the cube, each with a runner node. */
  private initRings() {
    const SEG = 120;
    const radii = [this.keepR * 1.06, this.keepR * 1.26, this.keepR * 1.5];
    for (let r = 0; r < radii.length; r++) {
      const R = radii[r];
      const pts: number[] = [];
      for (let i = 0; i < SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        pts.push(Math.cos(a) * R, Math.sin(a) * R, 0);
      }
      const local = new Float32Array(pts);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(local.slice(), 3));
      const colorAttr = new THREE.BufferAttribute(new Float32Array(SEG * 3), 3);
      colorAttr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('color', colorAttr);
      const hue = this.ringPalette[r % 3];
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.LineLoop(g, mat);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      mesh.frustumCulled = false;
      // Bright runner node that races around the ring (child → inherits tilt).
      const node = new THREE.Mesh(
        new THREE.SphereGeometry(this.keepR * 0.045, 12, 12),
        new THREE.MeshBasicMaterial({ color: hue, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      node.frustumCulled = false;
      mesh.add(node);
      this.scene.add(mesh);
      const axis = new THREE.Vector3(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1).normalize();
      const ring = {
        mesh, axis, spin: (0.0022 + Math.random()*0.0035) * (r % 2 ? -1 : 1),
        phase: Math.random()*6, baseOp: 0.4 - r*0.05, mat,
        node, nodeAng: Math.random()*6.28, nodeSpd: (0.03 + Math.random()*0.03) * (r % 2 ? 1 : -1), radius: R,
      };
      this.rings.push(ring);
      this.fadeLines.push({
        mesh, local, colorAttr, base: this.hexRGB(hue),
        intensity: () => ring.baseOp + 0.18 * Math.sin(ring.phase),
      });
    }
  }

  /** Sonar pulse-rings that bloom outward from the keep-out sphere and fade. */
  private initPulses() {
    const SEG = 96;
    const pts: number[] = [];
    for (let i = 0; i < SEG; i++) { const a = (i/SEG)*Math.PI*2; pts.push(Math.cos(a), Math.sin(a), 0); }
    const local = new Float32Array(pts);
    for (let i = 0; i < this.PULSE_N; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(local.slice(), 3));
      const colorAttr = new THREE.BufferAttribute(new Float32Array(SEG * 3), 3);
      colorAttr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('color', colorAttr);
      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.LineLoop(g, mat);
      mesh.frustumCulled = false; mesh.visible = false;
      this.scene.add(mesh);
      const pulse = { mesh, mat, life: 0, max: 1, bright: 0, str: 1, base: [0, 0.9, 1] as [number, number, number] };
      this.pulses.push(pulse);
      this.fadeLines.push({
        mesh, local, colorAttr, base: pulse.base,
        intensity: () => (pulse.mesh.visible ? pulse.bright : 0),
      });
    }
  }

  /** Eight corner brackets — three short ticks per corner — frame the
   *  construct without boxing the view the way the old full cage did. */
  private initBrackets() {
    const ext = (this.game.size - 1) / 2;
    const c = ext * 2.4, L = ext * 0.6;
    const pos: number[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * c, y = sy * c, z = sz * c;
      pos.push(x, y, z, x - sx * L, y, z);
      pos.push(x, y, z, x, y - sy * L, z);
      pos.push(x, y, z, x, y, z - sz * L);
    }
    const local = new Float32Array(pos);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(local.slice(), 3));
    const colorAttr = new THREE.BufferAttribute(new Float32Array(pos.length), 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('color', colorAttr);
    const brackets = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    brackets.frustumCulled = false;
    this.scene.add(brackets);
    this.fadeLines.push({
      mesh: brackets, local, colorAttr,
      base: this.hexRGB(0x0a5a6e),
      intensity: () => 0.7 + 0.25 * Math.sin(this.hoverPhase * 0.3),
    });
  }

  /** (Re)spawn packet i on a DATA RIVER: straight runs along the grid axes on
   *  the datascape floor — the city's bloodstream. Direction picks the hue. */
  private spawnStreak(i: number, lifeOffset = 0) {
    const s = this.streakState[i];
    const size = this.game.size;
    const G = size * 20;
    const alongX = Math.random() < 0.5;
    const lane = ((Math.random() * 14) | 0) - 7;
    const off  = lane * size * 1.6 + size * 0.8;
    const dir  = Math.random() < 0.5 ? 1 : -1;
    const start = -dir * G * (0.55 + Math.random() * 0.45);
    if (alongX) { s.p.set(start, this.floorY + 0.12, off); s.axis.set(dir, 0, 0); }
    else        { s.p.set(off,  this.floorY + 0.12, start); s.axis.set(0, 0, dir); }
    const fast = Math.random() < 0.3;
    s.omega = fast ? 0.45 + Math.random() * 0.4 : 0.16 + Math.random() * 0.18;
    s.life = -lifeOffset;
    s.max = 1e9;                                  // packets die at the grid edge
    const roll = Math.random();
    if (roll < 0.62)      { s.r = 0.35; s.g = 0.9;  s.b = 1.0; }
    else if (roll < 0.86) { s.r = 1.0;  s.g = 0.62; s.b = 0.18; }
    else                  { s.r = 1.0;  s.g = 0.1;  s.b = 0.45; }
  }

  /** Hide/show every void object (reduced-motion keeps the void dark). */
  private setVoidVisible(v: boolean) {
    for (const fl of this.fadeLines) fl.mesh.visible = v;
    this.streaks.visible = v;
    for (const p of this.pulses) p.mesh.visible = false;
    if (this.city) this.city.visible = v;
    if (this.rain) this.rain.visible = v;
  }

  /** Connection-loss ambience: the world dims while we're reconnecting. */
  setSignalLost(lost: boolean) { this._signalLost = lost; }

  /** Fire an expanding ring racing across the datascape floor. Strength 1 =
   *  a stone was played; smaller kicks come from the music's bass downbeats. */
  private spawnRipple(strength: number) {
    const p = this.pulses.find(q => !q.mesh.visible);
    if (!p) return;
    const m = this._pulseMat.makeBasis(
      this._tmpV.set(1, 0, 0), this._tmpV2.set(0, 0, 1), this._pulseW.set(0, 1, 0));
    p.mesh.quaternion.setFromRotationMatrix(m);
    p.mesh.position.set(0, this.floorY + 0.08, 0);
    const [pr, pg, pb] = this.hexRGB(0x00e5ff);
    p.base[0] = pr; p.base[1] = pg; p.base[2] = pb;
    p.max = 110; p.life = 0; p.str = Math.max(0.2, Math.min(1, strength));
    p.mesh.visible = true;
  }

  private updateVoidFX(f: number) {
    // Zoom-gated reveal; everything below is hard-culled at play framing.
    {
      const dist = this.camera.position.length();
      const start = this.game.size * 2.7, full = this.game.size * 4.6;
      const t = Math.min(1, Math.max(0, (dist - start) / (full - start)));
      this.fxReveal = t * t * (3 - 2 * t);
    }
    const rev = this.fxReveal;
    if (this.city) this.city.visible = rev > 0.002;
    if (this.rainMat) this.rainMat.opacity = rev * 0.5;

    // — Data rivers: packets flowing the grid; captures run them red —
    this.riverFlash = Math.max(0, this.riverFlash - 0.03 * f);
    const G = this.game.size * 20;
    for (let i = 0; i < this.STREAK_N; i++) {
      const s = this.streakState[i];
      s.life += f;
      if (s.life >= 0) s.p.addScaledVector(s.axis, s.omega * f);
      if (Math.abs(s.p.x) > G || Math.abs(s.p.z) > G) this.spawnStreak(i);
      this._streakTail.copy(s.p).addScaledVector(s.axis, -s.omega * 16);
      const fl = this.riverFlash;
      const rr = s.r + (1 - s.r) * fl, gg = s.g * (1 - fl * 0.85), bb = s.b * (1 - fl * 0.75);
      const hi = (s.life < 0 ? 0 : 1) * (0.7 + 1.0 * Math.min(1, s.omega))
               * this.silhouetteFade(s.p) * rev;
      const o = i * 6;
      this.streakPos[o]   = s.p.x; this.streakPos[o+1] = s.p.y; this.streakPos[o+2] = s.p.z;
      this.streakCol[o]   = rr * hi; this.streakCol[o+1] = gg * hi; this.streakCol[o+2] = bb * hi;
      this.streakPos[o+3] = this._streakTail.x; this.streakPos[o+4] = this._streakTail.y; this.streakPos[o+5] = this._streakTail.z;
      this.streakCol[o+3] = rr * hi * 0.05; this.streakCol[o+4] = gg * hi * 0.05; this.streakCol[o+5] = bb * hi * 0.05;
    }
    (this.streaks.geometry.attributes['position'] as THREE.BufferAttribute).needsUpdate = true;
    (this.streaks.geometry.attributes['color'] as THREE.BufferAttribute).needsUpdate = true;

    // — Floor ripples (every stone, bass downbeats, rare ambient) —
    for (const p of this.pulses) {
      if (!p.mesh.visible) continue;
      p.life += f;
      const u = p.life / p.max;
      p.mesh.scale.setScalar(this.game.size * (0.6 + u * 16));
      p.bright = p.str * Math.max(0, 1 - u) * Math.max(0, Math.sin(Math.PI * Math.min(1, u * 3)));
      if (u >= 1) { p.mesh.visible = false; p.life = 0; }
    }
    this.pulseCooldown -= f;
    if (this.pulseCooldown <= 0) {
      this.spawnRipple(0.25);
      this.pulseCooldown = 420 + (Math.random() * 360 | 0);
    }

    // — Light carpet twinkle + grid + the construct's glow pool —
    for (const bl of this.blockLayers) {
      bl.phase += 0.013 * f;
      bl.mat.opacity = rev * (0.6 + 0.25 * Math.sin(bl.phase));
    }
    if (this.gridMat) this.gridMat.opacity = rev * 0.5;
    if (this.glowMat) this.glowMat.opacity = rev * (0.5 + 0.08 * Math.sin(this.hoverPhase * 0.3) + 0.3 * this._beatGlow);

    // — Monoliths: slow drift, bob, edge glow —
    for (const m of this.monoliths) {
      m.grp.rotation.y += m.spin * f;
      m.grp.position.y = m.baseY + Math.sin(this.hoverPhase * 0.06 + m.phase) * this.game.size * 0.5;
      m.bodyMat.opacity = rev * 0.96;
      (m.edge.material as THREE.LineBasicMaterial).opacity = rev;
    }

    // Dock bursts: a bright flash collapses while a shock ring expands at the
    // point a ship entered the monolith hull.
    for (const fx of this.dockFx) {
      if (!fx.on) continue;
      fx.life += 0.04 * f;
      const u = fx.life;
      fx.ring.scale.setScalar(this.game.size * (0.3 + u * 3.5));
      fx.rMat.opacity = rev * Math.max(0, 1 - u);
      const sprS = this.game.size * (1.6 * (1 - u) + 0.2);
      fx.spr.scale.set(sprS, sprS, 1);
      fx.sMat.opacity = rev * Math.max(0, 1 - u * 1.6);
      if (u >= 1) { fx.on = false; fx.ring.visible = false; fx.spr.visible = false; }
    }
    for (const sg of this.signs) {
      sg.flick += sg.speed * f;
      const glitch = Math.random() < 0.01 ? 0.4 : 0;
      sg.mat.opacity = rev * Math.max(0.45, 0.92 - glitch + 0.06 * Math.sin(sg.flick * 1.7));
    }
    if (this.signPostMat) this.signPostMat.opacity = rev * 0.5;

    // — Rising embers —
    if (this.emberAttr && this.emberMat) {
      this.emberMat.opacity = rev * 0.65;
      const arr = this.emberAttr.array as Float32Array;
      const top = this.floorY + this.game.size * 8;
      for (let i = 0; i < this.emberVel.length; i++) {
        arr[i*3+1] += this.emberVel[i] * f;
        if (arr[i*3+1] > top) arr[i*3+1] = this.floorY;
      }
      this.emberAttr.needsUpdate = true;
    }

    // — Light pillars breathe asynchronously —
    for (const pl of this.pillars) {
      pl.phase += pl.speed * f;
      pl.mat.opacity = rev * (0.30 + 0.22 * Math.sin(pl.phase));
    }

    // — Aurora scroll —
    if (this.auroraTex) this.auroraTex.offset.x += 0.00018 * f;
    if (this.auroraMat) this.auroraMat.opacity = rev * 0.75;

    // — Drone flock weaving lissajous paths —
    if (this.droneAttr) {
      const t = this.hoverPhase * 0.22;
      const arr = this.droneAttr.array as Float32Array;
      for (let i = 0; i < this.droneParams.length; i++) {
        const d = this.droneParams[i];
        arr[i*3]   = this.droneCenter.x + d.ax * Math.sin(d.fx * t + d.px);
        arr[i*3+1] = this.droneCenter.y + d.ay * Math.sin(d.fy * t + d.py);
        arr[i*3+2] = this.droneCenter.z + d.az * Math.sin(d.fz * t + d.pz);
      }
      this.droneAttr.needsUpdate = true;
      if (this.droneMat) this.droneMat.opacity = rev * 0.7;
    }

    // — Airships: wander on curving paths; occasionally dock into a monolith —
    if (this.shipTrails && this.shipGroups.length) {
      const size = this.game.size;
      for (const mat of this.shipMats) (mat as THREE.MeshBasicMaterial).opacity = rev;
      (this.shipMats[0] as THREE.MeshBasicMaterial).opacity = rev * 0.95;
      for (let i = 0; i < this.ships.length; i++) {
        const sh = this.ships[i];
        const sg = this.shipGroups[i];
        sh.cooldown -= f;
        if (sh.mode === 'cruise') {
          sh.theta += Math.sin(this.hoverPhase * sh.w1 + sh.p1) * 0.02 * f;
          const yT = this.floorY + size * (3 + 2.5 * Math.sin(this.hoverPhase * sh.w2 + sh.p2));
          sh.v.set(Math.cos(sh.theta) * sh.speed, (yT - sh.p.y) * 0.006, Math.sin(sh.theta) * sh.speed);
          if (Math.hypot(sh.p.x, sh.p.z) > size * 15) sh.theta = Math.atan2(-sh.p.z, -sh.p.x);
          if (sh.cooldown <= 0 && this.monoliths.length) {
            const m = this.monoliths[(Math.random() * this.monoliths.length) | 0];
            sh.dock.copy(m.grp.position);
            sh.dock.y += (Math.random() - 0.4) * size * 2;
            sh.mode = 'dock';
          }
        } else {
          const to = this._tmpV.copy(sh.dock).sub(sh.p);
          if (to.length() < size * 0.6) {
            this._spawnBurst(sh.p.x, sh.p.y, sh.p.z, 0x66ddff);
            this.spawnDockFx(sh.dock);            // new local dock burst at the hull
            const m = this.monoliths[(Math.random() * this.monoliths.length) | 0];
            sh.p.copy(m.grp.position);
            sh.p.y += (Math.random() - 0.3) * size * 2;
            sh.theta = Math.random() * Math.PI * 2;
            sh.mode = 'cruise';
            sh.cooldown = 600 + Math.random() * 1200;
          } else {
            to.normalize().multiplyScalar(sh.speed * 1.4);
            sh.v.lerp(to, Math.min(1, 0.05 * f));
          }
        }
        sh.p.addScaledVector(sh.v, f);

        // Pose the vessel: position, face along velocity, hide when it would
        // cross the board's on-screen footprint (shared materials can't fade
        // per ship, so visibility carries the silhouette rule).
        const fade = this.silhouetteFade(sh.p);
        sg.grp.position.copy(sh.p);
        this._tmpV2.copy(sh.p).add(sh.v);
        sg.grp.lookAt(this._tmpV2);
        sg.grp.visible = rev > 0.002 && fade > 0.35;
        const blinkA = 0.4 + 0.6 * Math.max(0, Math.sin(this.hoverPhase * 1.8 + sh.p1 * 4));
        const blinkB = 0.4 + 0.6 * Math.max(0, Math.sin(this.hoverPhase * 1.8 + sh.p1 * 4 + 3.1));
        sg.navA.scale.setScalar(blinkA);
        sg.navB.scale.setScalar(blinkB);

        // Engine wake.
        const hi = rev * fade;
        const o = i * 6;
        const tail = this._tmpV2.copy(sh.p).addScaledVector(sh.v, -42);
        this.shipTrailPos[o]   = sh.p.x;  this.shipTrailPos[o+1] = sh.p.y;  this.shipTrailPos[o+2] = sh.p.z;
        this.shipTrailPos[o+3] = tail.x;  this.shipTrailPos[o+4] = tail.y;  this.shipTrailPos[o+5] = tail.z;
        this.shipTrailCol[o]   = sh.hue[0]*hi; this.shipTrailCol[o+1] = sh.hue[1]*hi; this.shipTrailCol[o+2] = sh.hue[2]*hi;
        this.shipTrailCol[o+3] = 0; this.shipTrailCol[o+4] = 0; this.shipTrailCol[o+5] = 0;
      }
      (this.shipTrails.geometry.attributes['position'] as THREE.BufferAttribute).needsUpdate = true;
      (this.shipTrails.geometry.attributes['color'] as THREE.BufferAttribute).needsUpdate = true;
    }

    // — Rare meteor across the deep sky —
    const ms = this.meteorState;
    if (!ms.active) {
      if (rev > 0.3 && Math.random() < 0.0007 * f) {
        ms.active = true; ms.life = 0;
        const side = Math.random() < 0.5 ? 1 : -1;
        ms.p.set(-side * this.game.size * 18, this.game.size * (6 + Math.random() * 4), (Math.random() - 0.5) * this.game.size * 20);
        ms.v.set(side * 0.32, -0.07, (Math.random() - 0.5) * 0.1);
      }
    } else if (this.meteor && this.meteorMat) {
      ms.life += f;
      ms.p.addScaledVector(ms.v, this.game.size * 0.5 * f * 0.32);
      const attr = this.meteor.geometry.attributes['position'] as THREE.BufferAttribute;
      const tail = this._tmpV.copy(ms.p).addScaledVector(ms.v, -this.game.size * 0.9);
      attr.setXYZ(0, ms.p.x, ms.p.y, ms.p.z);
      attr.setXYZ(1, tail.x, tail.y, tail.z);
      attr.needsUpdate = true;
      const env = Math.max(0, Math.sin(Math.PI * Math.min(1, ms.life / ms.max)));
      this.meteorMat.opacity = rev * env * 0.9;
      if (ms.life > ms.max) { ms.active = false; this.meteorMat.opacity = 0; }
    }

    // — Per-vertex fade for the brackets + ripple rings so no line segment
    //   ever crosses the cube's on-screen footprint —
    this.updateFadeLines();
  }

  // ── Stones ────────────────────────────────────────────────────────────────
  private initStones() {
    const cap = this.game.size ** 3;
    this.stoneGeo = new THREE.SphereGeometry(STONE_R, 24, 24);

    this.blackMat = new THREE.MeshPhysicalMaterial({
      color: 0x040412, emissive: 0x0055ee, emissiveIntensity: 0.5,
      roughness: 0.08, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.05,
    });
    this.whiteMat = new THREE.MeshPhysicalMaterial({
      color: 0x200010, emissive: PINK, emissiveIntensity: 0.9,
      roughness: 0.08, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.05,
    });
    // Hover/capture materials are clones taken BEFORE we patch blackMat/whiteMat
    // for per-instance alpha, so they keep their own simple opacity behaviour.
    this.blackHoverMat = this.blackMat.clone();
    this.blackHoverMat.transparent = true; this.blackHoverMat.opacity = 0.5;
    this.whiteHoverMat = this.whiteMat.clone();
    this.whiteHoverMat.transparent = true; this.whiteHoverMat.opacity = 0.5;
    this.captureMat1 = this.blackMat.clone(); this.captureMat1.transparent = true;
    this.captureMat2 = this.whiteMat.clone(); this.captureMat2.transparent = true;

    // Per-instance alpha so front-of-slice stones can fade and reveal the
    // interior. Each colour gets its own geometry carrying an instanceAlpha
    // attribute, and its material is patched to read that attribute.
    this.blackGeo = this.stoneGeo.clone();
    this.whiteGeo = this.stoneGeo.clone();
    const bAlpha = new Float32Array(cap).fill(1);
    const wAlpha = new Float32Array(cap).fill(1);
    this.blackAlpha = new THREE.InstancedBufferAttribute(bAlpha, 1);
    this.whiteAlpha = new THREE.InstancedBufferAttribute(wAlpha, 1);
    this.blackAlpha.setUsage(THREE.DynamicDrawUsage);
    this.whiteAlpha.setUsage(THREE.DynamicDrawUsage);
    this.blackGeo.setAttribute('instanceAlpha', this.blackAlpha);
    this.whiteGeo.setAttribute('instanceAlpha', this.whiteAlpha);

    this._patchAlpha(this.blackMat);
    this._patchAlpha(this.whiteMat);

    this.blackStones = new THREE.InstancedMesh(this.blackGeo, this.blackMat, cap);
    this.blackStones.count = 0;
    this.whiteStones = new THREE.InstancedMesh(this.whiteGeo, this.whiteMat, cap);
    this.whiteStones.count = 0;
    this.scene.add(this.blackStones, this.whiteStones);

    this.hoverMesh = new THREE.Mesh(this.stoneGeo, this.blackHoverMat);
    this.hoverMesh.visible = false;
    this.scene.add(this.hoverMesh);
  }

  /** Patch a material so it multiplies fragment alpha by a per-instance value. */
  private _patchAlpha(mat: THREE.MeshPhysicalMaterial) {
    mat.transparent = true;
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float instanceAlpha;\nvarying float vInstanceAlpha;'
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvInstanceAlpha = instanceAlpha;'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying float vInstanceAlpha;'
        )
        .replace(
          '#include <dithering_fragment>',
          'gl_FragColor.a *= vInstanceAlpha;\n#include <dithering_fragment>'
        );
    };
    mat.needsUpdate = true;
  }

  private _getCaptureMesh(player: Player): THREE.Mesh {
    const pool = player === 1 ? this.capturePool1 : this.capturePool2;
    if (pool.length) { const m = pool.pop()!; m.visible = true; return m; }
    const mat = (player === 1 ? this.captureMat1 : this.captureMat2).clone();
    mat.transparent = true;
    const m = new THREE.Mesh(this.stoneGeo, mat);
    this.scene.add(m); return m;
  }

  private _spawnBurst(wx: number, wy: number, wz: number, color: number) {
    const n = 14, positions = new Float32Array(n * 3), vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i*3] = wx; positions[i*3+1] = wy; positions[i*3+2] = wz;
      const theta = Math.random() * Math.PI * 2, phi = Math.acos(2 * Math.random() - 1);
      const sp = 0.04 + Math.random() * 0.06;
      vel[i*3]   = Math.sin(phi) * Math.cos(theta) * sp;
      vel[i*3+1] = Math.cos(phi) * sp;
      vel[i*3+2] = Math.sin(phi) * Math.sin(theta) * sp;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const pts = new THREE.Points(geo,
      new THREE.PointsMaterial({ color, size: 0.09, transparent: true, opacity: 1, depthWrite: false }));
    this.scene.add(pts);
    this.bursts.push({ geo, pts, vel, life: 0 });
  }

  triggerCaptures(positions: [number,number,number][], player: Player) {
    // Stones further from the capturing move start their shrink later, so a
    // multi-stone capture ripples outward from the killing stone.
    const lm = this.game.lastMove;
    const burstColor = player === 1 ? 0x0077ff : 0xff0077;
    this.riverFlash = 1;   // the datascape's rivers run red for a moment
    if (player === 1) this.capByBlack += positions.length; else this.capByWhite += positions.length;
    this._signDirty = true;
    for (const [x, y, z] of positions) {
      const mesh = this._getCaptureMesh(player);
      mesh.position.set(this.coord(x), this.coord(y), this.coord(z));
      mesh.scale.setScalar(1);
      (mesh.material as THREE.MeshPhysicalMaterial).opacity = 1;
      const pool = player === 1 ? this.capturePool1 : this.capturePool2;
      const dist = lm ? Math.hypot(x - lm[0], y - lm[1], z - lm[2]) : 0;
      const delay = REDUCED_MOTION ? 0 : dist * 1.6;
      this.captureAnims.push({ mesh, life: 0, delay, burstColor, pool });
      if (delay <= 0) this._spawnBurst(this.coord(x), this.coord(y), this.coord(z), burstColor);
    }
  }

  updateStones() {
    this._rebuildStones();
    if (this.signs.length) this.refreshSignage();
    if (this.game.lastMove && !REDUCED_MOTION) {
      const [x, y, z] = this.game.lastMove;
      this.popInMap.set(`${x},${y},${z}`, 0.05);
      // Every stone played sends a ripple racing across the datascape floor —
      // the city visibly reacts to the game (only seen when zoomed out).
      this.spawnRipple(1);
    }
  }

  clearAnimations() {
    this.popInMap.clear();
    for (const a of this.captureAnims) { a.mesh.visible = false; a.pool.push(a.mesh); }
    this.captureAnims.length = 0;
  }

  // Rebuild stone matrices + update last-move indicator
  private _rebuildStones(board?: Cell[][][], lastMove?: [number,number,number] | null) {
    const b = board ?? this.game.board;
    const lm = lastMove !== undefined ? lastMove : this.game.lastMove;
    const s = this.game.size;
    const dummy = new THREE.Object3D();
    this.stoneEntries = [];
    let bi = 0, wi = 0;

    for (let x = 0; x < s; x++)
      for (let y = 0; y < s; y++)
        for (let z = 0; z < s; z++) {
          const cell = b[x][y][z];
          if (!cell) continue;
          this.stoneEntries.push({ x, y, z, player: cell });
          const key   = `${x},${y},${z}`;
          const pop   = this.popInMap.get(key);
          const scale = pop === undefined ? 1 : backOut(Math.min(1, pop));
          dummy.position.set(this.coord(x), this.coord(y), this.coord(z));
          dummy.scale.setScalar(scale); dummy.updateMatrix();
          if (cell === 1) this.blackStones.setMatrixAt(bi++, dummy.matrix);
          else            this.whiteStones.setMatrixAt(wi++, dummy.matrix);
        }

    this.blackStones.count = bi; this.blackStones.instanceMatrix.needsUpdate = true;
    this.whiteStones.count = wi; this.whiteStones.instanceMatrix.needsUpdate = true;
    this._stonesColorDirty = true;

    if (lm) {
      this.lastMoveMesh.position.set(this.coord(lm[0]), this.coord(lm[1]), this.coord(lm[2]));
      this.lastMoveMesh.visible = true;
    } else {
      this.lastMoveMesh.visible = false;
    }
  }

  // Depth-cueing: per-instance color based on camera distance
  private _updateStoneColors() {
    if (!this.stoneEntries.length) return;
    const cam = this.camera.position;
    const maxD = this.game.size * 3.5;
    const col = new THREE.Color();
    // Camera-side test for slice fading: a stone is "in front" of the slice
    // plane when it sits on the same side as the camera along the slice axis.
    const slicePlane = this.sliceAxis !== 'none' ? this.coord(this.sliceIndex) : 0;
    const camAlong = this.sliceAxis === 'x' ? cam.x
                   : this.sliceAxis === 'y' ? cam.y
                   : this.sliceAxis === 'z' ? cam.z : 0;
    // How face-on is the slice? Compare the view direction (camera → orbit
    // target) against the slice axis. |alignment| is 1 when looking straight
    // through the slice (the near side fully occludes it) and ~0 when the slice
    // is viewed edge-on (the "near" side is off to the side and occludes
    // nothing, so it should not be dimmed). This makes the dim strength track
    // which side is actually more in view.
    let sliceAlign = 0;
    if (this.sliceAxis !== 'none') {
      const t = this.controls.target;
      let vx = t.x - cam.x, vy = t.y - cam.y, vz = t.z - cam.z;
      const vlen = Math.sqrt(vx*vx + vy*vy + vz*vz) || 1;
      const viewAlong = this.sliceAxis === 'x' ? vx
                      : this.sliceAxis === 'y' ? vy : vz;
      sliceAlign = Math.abs(viewAlong / vlen);
    }
    let bi = 0, wi = 0;
    for (const { x, y, z, player } of this.stoneEntries) {
      const wx = this.coord(x), wy = this.coord(y), wz = this.coord(z);
      const dx = wx - cam.x, dy = wy - cam.y, dz = wz - cam.z;
      let brightness = 0.45 + 0.55 * Math.max(0, 1 - Math.sqrt(dx*dx+dy*dy+dz*dz) / maxD);
      let alpha = 1.0;
      if (this.sliceAxis !== 'none') {
        const onSlice = (this.sliceAxis === 'x' && x === this.sliceIndex) ||
                        (this.sliceAxis === 'y' && y === this.sliceIndex) ||
                        (this.sliceAxis === 'z' && z === this.sliceIndex);
        if (!onSlice) {
          brightness *= 0.10;
          // Fade stones between the camera and the slice plane so the
          // interior is visible; keep stones behind the slice opaque.
          const along = this.sliceAxis === 'x' ? wx : this.sliceAxis === 'y' ? wy : wz;
          const inFront = (along - slicePlane) * (camAlong - slicePlane) > 0;
          // Only fade the near side in proportion to how much it occludes the
          // slice: full transparency when looking face-on, none when edge-on.
          if (inFront) alpha = 1 - (1 - 0.08) * sliceAlign;
        }
      } else if (this.cursorActive && y !== this.cursorPos.y) {
        brightness *= 0.4;
      }
      col.setScalar(brightness);
      if (player === 1) { this.blackStones.setColorAt(bi, col); this.blackAlpha.setX(bi, alpha); bi++; }
      else              { this.whiteStones.setColorAt(wi, col); this.whiteAlpha.setX(wi, alpha); wi++; }
    }
    if (this.blackStones.instanceColor) this.blackStones.instanceColor.needsUpdate = true;
    if (this.whiteStones.instanceColor) this.whiteStones.instanceColor.needsUpdate = true;
    this.blackAlpha.needsUpdate = true;
    this.whiteAlpha.needsUpdate = true;
  }

  // Per-dot colour: bright on active slice, near-invisible everywhere else.
  // In stack mode, layers above the active build layer are removed entirely
  // (zero-scale instance matrix) so not even a black speck remains.
  private _updateDotVisibility() {
    const s = this.game.size;
    const col = new THREE.Color();
    const dotDefault = new THREE.Color(DOT_C);
    const dummy = new THREE.Object3D();
    let idx = 0;
    let matricesDirty = false;
    for (let x = 0; x < s; x++)
      for (let y = 0; y < s; y++)
        for (let z = 0; z < s; z++) {
          // Stack mode hides everything above the active layer completely:
          // collapse the instance to zero scale so it is not rendered at all.
          const hiddenAbove = this.sliceAxis === 'none' &&
                              this.stackLayer !== null && y > this.stackLayer;
          dummy.position.set(this.coord(x), this.coord(y), this.coord(z));
          dummy.scale.setScalar(hiddenAbove ? 0 : 1);
          dummy.updateMatrix();
          this.dotInst.setMatrixAt(idx, dummy.matrix);
          matricesDirty = true;

          if (this.sliceAxis !== 'none') {
            const onSlice = (this.sliceAxis === 'x' && x === this.sliceIndex) ||
                            (this.sliceAxis === 'y' && y === this.sliceIndex) ||
                            (this.sliceAxis === 'z' && z === this.sliceIndex);
            if (onSlice) {
              const hex = this.sliceAxis === 'y' ? PINK : this.sliceAxis === 'z' ? 0x00ffaa : CYAN;
              col.setHex(hex).multiplyScalar(0.45);   // visible but not blinding
            } else {
              col.setScalar(0.03);   // nearly invisible off the plane
            }
          } else if (this.stackLayer !== null) {
            // Stack mode: only the current build layer and the already-played
            // layers below it are visible. On-layer points get a bright cyan
            // highlight; built layers below stay faintly lit for context;
            // unbuilt layers above are hidden (matrix collapsed above).
            if (y === this.stackLayer)      col.setHex(CYAN);
            else if (y < this.stackLayer)   col.copy(dotDefault).multiplyScalar(0.22);
            else                            col.setScalar(0);
          } else {
            col.copy(dotDefault);
          }
          this.dotInst.setColorAt(idx++, col);
        }
    if (matricesDirty) this.dotInst.instanceMatrix.needsUpdate = true;
    if (this.dotInst.instanceColor) this.dotInst.instanceColor.needsUpdate = true;
  }

  // Hoshi brightness: dim on slice, subtle otherwise. Stack mode collapses
  // above-layer star points to zero scale so nothing renders there.
  private _updateHoshiVisibility() {
    if (!this.hoshiInst) return;
    const col = new THREE.Color();
    const hoshiDefault = new THREE.Color(0xffaa33);
    const dummy = new THREE.Object3D();
    const hc = this.hoshiCoords.length;

    // Stack mode (no slice): the active build layer is a 2D board, so draw the
    // 2D star-point pattern (x,z ∈ star indices) AT that layer. The 3D hoshi set
    // would require y to also be a star index, leaving most layers — including
    // the starting layer 0 — with no star points at all.
    if (this.stackLayer !== null && this.sliceAxis === 'none') {
      col.setHex(0xffcc55);
      let i = 0;
      for (const ix of this.hoshiIdx) {
        for (const iz of this.hoshiIdx) {
          dummy.position.set(this.coord(ix), this.coord(this.stackLayer), this.coord(iz));
          dummy.scale.setScalar(1);
          dummy.updateMatrix();
          this.hoshiInst.setMatrixAt(i, dummy.matrix);
          this.hoshiInst.setColorAt(i, col);
          i++;
        }
      }
      // Collapse any unused instances (the 3D set has more points than the 2D one).
      dummy.scale.setScalar(0); dummy.updateMatrix();
      for (; i < hc; i++) this.hoshiInst.setMatrixAt(i, dummy.matrix);
      this.hoshiInst.instanceMatrix.needsUpdate = true;
      if (this.hoshiInst.instanceColor) this.hoshiInst.instanceColor.needsUpdate = true;
      return;
    }

    // Cube mode / slice mode: the full 3D star-point lattice.
    for (let i = 0; i < hc; i++) {
      const { x, y, z } = this.hoshiCoords[i];
      dummy.position.set(this.coord(x), this.coord(y), this.coord(z));
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      this.hoshiInst.setMatrixAt(i, dummy.matrix);

      if (this.sliceAxis !== 'none') {
        const onSlice = (this.sliceAxis === 'x' && x === this.sliceIndex) ||
                        (this.sliceAxis === 'y' && y === this.sliceIndex) ||
                        (this.sliceAxis === 'z' && z === this.sliceIndex);
        if (onSlice) col.setHex(0xffcc55); else col.setScalar(0.02);
      } else {
        col.copy(hoshiDefault);
      }
      this.hoshiInst.setColorAt(i, col);
    }
    this.hoshiInst.instanceMatrix.needsUpdate = true;
    if (this.hoshiInst.instanceColor) this.hoshiInst.instanceColor.needsUpdate = true;
  }

  // For replay: display an arbitrary board state
  showBoardState(board: Cell[][][], lastMove: [number,number,number] | null) {
    this._rebuildStones(board, lastMove);
  }

  setReplayMode(on: boolean) { this.replayMode = on; }

  // ── Territory ─────────────────────────────────────────────────────────────
  private initTerritory() {
    const cap  = this.game.size ** 3;
    const tGeo = new THREE.SphereGeometry(TERRITORY_R, 10, 10);
    this.blackTerritory = new THREE.InstancedMesh(tGeo,
      new THREE.MeshStandardMaterial({ color: 0x001133, emissive: 0x0077ff, emissiveIntensity: 2.5, transparent: true, opacity: 0.9 }), cap);
    this.blackTerritory.count = 0;
    this.whiteTerritory = new THREE.InstancedMesh(tGeo,
      new THREE.MeshStandardMaterial({ color: 0x280010, emissive: PINK, emissiveIntensity: 2.5, transparent: true, opacity: 0.9 }), cap);
    this.whiteTerritory.count = 0;
    this.scene.add(this.blackTerritory, this.whiteTerritory);
  }

  showTerritory(map: TerritoryResult['map']) {
    // Iterate the territory map directly (only empty regions appear in it)
    // rather than re-scanning the whole n³ board on every call.
    const dummy = new THREE.Object3D();
    let bi = 0, wi = 0;
    for (const key in map) {
      const owner = map[key];
      if (!owner) continue; // neutral (0) regions are recorded but not drawn
      const [x, y, z] = key.split(',');
      dummy.position.set(this.coord(+x), this.coord(+y), this.coord(+z));
      dummy.updateMatrix();
      if (owner === 1) this.blackTerritory.setMatrixAt(bi++, dummy.matrix);
      else             this.whiteTerritory.setMatrixAt(wi++, dummy.matrix);
    }
    this.blackTerritory.count = bi; this.blackTerritory.instanceMatrix.needsUpdate = true;
    this.whiteTerritory.count = wi; this.whiteTerritory.instanceMatrix.needsUpdate = true;
  }

  hideTerritory() { this.blackTerritory.count = 0; this.whiteTerritory.count = 0; }

  // ── Effects ───────────────────────────────────────────────────────────────
  private initEffects() {
    // Axis targeting lines (3D crosshair: one segment per axis, 6 points)
    this.axisLinePositions = new Float32Array(18);
    const axisGeo = new THREE.BufferGeometry();
    axisGeo.setAttribute('position', new THREE.BufferAttribute(this.axisLinePositions, 3));
    this.axisLines = new THREE.LineSegments(axisGeo,
      new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.6 }));
    this.axisLines.visible = false;
    this.scene.add(this.axisLines);

    // Slice panel (filled semi-transparent plane)
    const s = this.game.size;
    const span = s - 1;
    this.slicePanel = new THREE.Mesh(
      new THREE.PlaneGeometry(span, span),
      new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false })
    );
    this.slicePanel.visible = false;
    this.scene.add(this.slicePanel);

    // Slice border (bright rectangle outline)
    const h = span / 2;
    const bPts = new Float32Array([
      -h,-h,0,  h,-h,0,   h,-h,0,  h, h,0,
       h, h,0, -h, h,0,  -h, h,0, -h,-h,0,
    ]);
    const bGeo = new THREE.BufferGeometry();
    bGeo.setAttribute('position', new THREE.BufferAttribute(bPts, 3));
    this.sliceBorder = new THREE.LineSegments(bGeo,
      new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.9 }));
    this.sliceBorder.visible = false;
    this.scene.add(this.sliceBorder);

    // Stack mode build-surface highlight (a green glowing plane at the active
    // layer). Lies flat on the y axis; positioned each frame in stack mode.
    this.stackPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(span + 0.6, span + 0.6),
      new THREE.MeshBasicMaterial({ color: 0x19f5a0, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false })
    );
    this.stackPlane.rotation.set(Math.PI / 2, 0, 0);
    this.stackPlane.visible = false;
    this.scene.add(this.stackPlane);

    // Layer glyph DOM overlay
    this.layerGlyph = document.createElement('div');
    this.layerGlyph.id = 'layer-glyph';
    this.layerGlyph.style.cssText =
      'position:fixed;pointer-events:none;z-index:20;' +
      'font:bold 14px "Share Tech Mono",monospace;' +
      'color:#00e5ff;text-shadow:0 0 8px #00e5ff;' +
      'display:none;transform:translate(-50%,-100%);';
    document.body.appendChild(this.layerGlyph);

    this.flashMesh = new THREE.Mesh(new THREE.SphereGeometry(STONE_R*1.1, 14, 14),
      new THREE.MeshPhysicalMaterial({ color: 0x330000, emissive: 0xff2200, emissiveIntensity: 3, transparent: true, opacity: 0.8 }));
    this.flashMesh.visible = false; this.scene.add(this.flashMesh);

    this.lastMoveMesh = new THREE.Mesh(new THREE.TorusGeometry(STONE_R*1.5, 0.03, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
    this.lastMoveMesh.visible = false; this.scene.add(this.lastMoveMesh);
  }

  forbiddenFlash(x: number, y: number, z: number) {
    this.flashMesh.position.set(this.coord(x), this.coord(y), this.coord(z));
    this.flashMesh.visible = true; this.flashTimer = 18;
    this.sound.forbidden();
  }

  /** True when the camera moved since the last check; refreshes the snapshot. */
  private cameraMoved(): boolean {
    const moved = !this.camera.position.equals(this._lastCamPos) ||
                  !this.camera.quaternion.equals(this._lastCamQuat);
    if (moved) {
      this._lastCamPos.copy(this.camera.position);
      this._lastCamQuat.copy(this.camera.quaternion);
    }
    return moved;
  }

  // ── Keyboard cursor ───────────────────────────────────────────────────────
  setCursorActive(on: boolean) {
    this.cursorActive = on;
    if (!on) this.hoverMesh.visible = false;
    this._stonesColorDirty = true;
  }

  setCursorPos(x: number, y: number, z: number) {
    const s = this.game.size;
    const nx = Math.max(0, Math.min(s-1, x));
    // In stack mode only the active build layer accepts stones and only it is
    // drawn, so pin the cursor's height to it — otherwise the highlight sits on
    // a hidden layer and appears to vanish. (Vertical cursor moves become no-ops,
    // which is correct: you can't place off the active layer.)
    const ny = this.stackLayer !== null ? this.stackLayer : Math.max(0, Math.min(s-1, y));
    const nz = Math.max(0, Math.min(s-1, z));
    if (nx !== this.cursorPos.x || ny !== this.cursorPos.y || nz !== this.cursorPos.z)
      this.rippleTimer = 1;
    this.cursorPos = { x: nx, y: ny, z: nz };
    this._stonesColorDirty = true; // cursor height affects stone dimming
  }

  moveCursor(dx: number, dy: number, dz: number) {
    this.setCursorPos(this.cursorPos.x+dx, this.cursorPos.y+dy, this.cursorPos.z+dz);
  }

  getCursorPos() { return { ...this.cursorPos }; }

  getLastHover() { return this.lastHover ? { ...this.lastHover } : null; }

  /**
   * The empty, currently-placeable point whose projection is closest to the
   * centre of the screen (respecting an active slice or stack layer). Used to
   * seed the precision cursor on touch — where there's no hover — so it lands on
   * whatever you've zoomed/panned to, rather than a board centre that may be
   * off-screen. Returns null if nothing placeable projects in front of the camera.
   */
  nearestToViewCenter(): { x: number; y: number; z: number } | null {
    const s = this.game.size;
    const v = new THREE.Vector3();
    let best: { x: number; y: number; z: number } | null = null;
    let bestD = Infinity;
    for (let x = 0; x < s; x++) {
      if (this.sliceAxis === 'x' && x !== this.sliceIndex) continue;
      for (let y = 0; y < s; y++) {
        if (this.sliceAxis === 'y' && y !== this.sliceIndex) continue;
        if (this.stackLayer !== null && y !== this.stackLayer) continue;
        for (let z = 0; z < s; z++) {
          if (this.sliceAxis === 'z' && z !== this.sliceIndex) continue;
          if (this.game.board[x][y][z] !== 0) continue; // empty points only
          v.set(this.coord(x), this.coord(y), this.coord(z)).project(this.camera);
          if (v.z <= -1 || v.z >= 1) continue;          // outside the frustum
          const d = v.x * v.x + v.y * v.y;              // squared dist from screen centre
          if (d < bestD) { bestD = d; best = { x, y, z }; }
        }
      }
    }
    return best;
  }

  setSlice(axis: 'none' | 'x' | 'y' | 'z', index: number) {
    this.sliceAxis  = axis;
    this.sliceIndex = index;
    // Update panel/border color per axis
    const color = axis === 'y' ? PINK : axis === 'z' ? 0x00ffaa : CYAN;
    (this.slicePanel.material  as THREE.MeshBasicMaterial).color.setHex(color);
    (this.sliceBorder.material as THREE.LineBasicMaterial).color.setHex(color);
    // When slicing, faded front stones must not write depth or they'd occlude
    // the interior they're meant to reveal.
    const sliceActive = axis !== 'none';
    this.blackMat.depthWrite = !sliceActive;
    this.whiteMat.depthWrite = !sliceActive;
    // Dot/hoshi visibility depends on slice — mark dirty
    this._dotsDirty  = true;
    this._hoshiDirty = true;
    this._stonesColorDirty = true;
  }

  /**
   * Stack mode: restrict placement to a single vertical (y) layer and highlight
   * it. Pass null to disable (cube/sphere modes).
   */
  setStackLayer(layer: number | null) {
    this.stackLayer = layer;
    if (this.stackPlane) this.stackPlane.visible = layer !== null;
    // The active layer drives lattice dimming — recolour dots/hoshi/stones.
    this._dotsDirty  = true;
    this._hoshiDirty = true;
    this._stonesColorDirty = true;
  }

  // ── Camera control ────────────────────────────────────────────────────────
  private startIntroOrbit() {
    const d = this.game.size * 3;
    this.camera.position.set(d, d * 0.5, d);
    this.introPhase = 0;
    this.controls.enabled = false;
  }

  tweenCameraTo(pos: THREE.Vector3) {
    this.tweenTarget = pos.clone();
    this.controls.enabled = false;
  }

  faceCam(view: 'top' | 'front' | 'side' | 'iso') {
    const d = this.game.size * 1.6;
    const targets = {
      top:   new THREE.Vector3(0.01, d * 2.2, 0.01),
      front: new THREE.Vector3(0.01, 0, d * 2.5),
      side:  new THREE.Vector3(d * 2.5, 0, 0.01),
      iso:   new THREE.Vector3(d, d * 0.75, d),
    };
    this.tweenCameraTo(targets[view]);
  }

  // ── Sound proxies ─────────────────────────────────────────────────────────
  playPlaceSound()        { this.sound.place(); }
  playCaptureSound(n: number) { this.sound.capture(n); }
  playPassSound()         { this.sound.pass(); }
  playUndoSound()         { this.sound.undo(); }

  // ── Intersection picking ──────────────────────────────────────────────────
  private getHoveredIntersection(): { x: number; y: number; z: number } | null {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const { origin: o, direction: d } = this.raycaster.ray;
    const ox = o.x, oy = o.y, oz = o.z, dx = d.x, dy = d.y, dz = d.z;
    const s = this.game.size, THR2 = 0.38 * 0.38;
    let bestT = Infinity, best: { x: number; y: number; z: number } | null = null;
    for (let x = 0; x < s; x++) {
      if (this.sliceAxis === 'x' && x !== this.sliceIndex) continue;
      for (let y = 0; y < s; y++) {
        if (this.sliceAxis === 'y' && y !== this.sliceIndex) continue;
        // Stack mode: only the active build layer is clickable.
        if (this.stackLayer !== null && y !== this.stackLayer) continue;
        for (let z = 0; z < s; z++) {
          if (this.sliceAxis === 'z' && z !== this.sliceIndex) continue;
          const px = this.coord(x), py = this.coord(y), pz = this.coord(z);
          const t = (px-ox)*dx + (py-oy)*dy + (pz-oz)*dz;
          if (t <= 0 || t >= bestT) continue;
          const ex = ox+dx*t-px, ey = oy+dy*t-py, ez = oz+dz*t-pz;
          if (ex*ex+ey*ey+ez*ez < THR2) { bestT = t; best = { x, y, z }; }
        }
      }
    }
    return best;
  }

  // ── Events ────────────────────────────────────────────────────────────────
  private setupEvents() {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.set(((e.clientX-r.left)/r.width)*2-1, -((e.clientY-r.top)/r.height)*2+1);
      if (Math.hypot(e.clientX-this.pointerDownAt.x, e.clientY-this.pointerDownAt.y) > 5)
        this.pointerMoved = true;
    });
    canvas.addEventListener('pointerdown', (e) => {
      this.pointerDownAt.set(e.clientX, e.clientY); this.pointerMoved = false;
    });
    canvas.addEventListener('pointerup', (e) => {
      if (this.pointerMoved || this.replayMode) return;
      // In cursor mode (no slice), Enter places; in slice mode, mouse click always places
      if (this.cursorActive && this.sliceAxis === 'none') return;
      const r = canvas.getBoundingClientRect();
      this.mouse.set(((e.clientX-r.left)/r.width)*2-1, -((e.clientY-r.top)/r.height)*2+1);
      const pos = this.getHoveredIntersection();
      if (pos) this.onPlace(pos.x, pos.y, pos.z);
    });
    window.addEventListener('resize', this._onResize);
  }

  // ── Animate ───────────────────────────────────────────────────────────────
  private animate(now = 0) {
    this._rafId = requestAnimationFrame((t) => this.animate(t));
    // Frame-rate cap (touch devices): bail out early on frames that arrive
    // sooner than the target interval, so the heavy render work runs at the
    // capped rate while the loop itself stays alive.
    if (this._frameInterval > 0) {
      if (now - this._lastFrameAt < this._frameInterval) return;
      this._lastFrameAt = now;
    }
    // Delta time in 60fps-frame units: every animation below multiplies its
    // per-frame increment by f, so speeds are identical at any real frame rate
    // (the touch cap renders ~40fps; without this everything ran a third
    // slower on exactly the devices the cap was protecting). Clamped so a
    // hidden-tab resume can't fast-forward animations.
    const f = this._lastT > 0 ? Math.min(3, (now - this._lastT) / (1000 / 60)) : 1;
    this._lastT = now;
    this.hoverPhase += 0.05 * f;

    // Camera: intro orbit
    if (this.introPhase >= 0) {
      this.introPhase = Math.min(1, this.introPhase + 0.013 * f);
      const ease = 1 - Math.pow(1 - this.introPhase, 3);
      const angle = ease * Math.PI * 1.5;
      const d = this.game.size * (1.4 + (1 - ease) * 1.6);
      this.camera.position.set(Math.cos(angle)*d, d*0.75*(1-ease*0.2), Math.sin(angle)*d);
      this.camera.lookAt(0, 0, 0);
      if (this.introPhase >= 1) {
        this.introPhase = -1;
        this.controls.target.set(0, 0, 0);
        this.controls.enabled = true;
      }
    } else if (this.tweenTarget) {
      // Camera: smooth tween to face-cam position (frame-rate-corrected damping)
      this.camera.position.lerp(this.tweenTarget, 1 - Math.pow(0.9, f));
      this.camera.lookAt(0, 0, 0);
      if (this.camera.position.distanceTo(this.tweenTarget) < 0.08) {
        this.camera.position.copy(this.tweenTarget);
        this.tweenTarget = null;
        this.controls.target.set(0, 0, 0);
        this.controls.enabled = true;
      }
    } else {
      this.controls.update();
    }

    // Grid pulse — in stack mode the lattice structure recedes so the active
    // build layer reads clearly; otherwise it breathes at full strength.
    const stackFade = this.stackLayer !== null && this.sliceAxis === 'none';
    const breathe = REDUCED_MOTION ? 0 : Math.sin(this.hoverPhase * 0.18);
    (this.innerGrid.material as THREE.LineBasicMaterial).opacity = Math.min(1, (stackFade
      ? 0.10 + 0.04 * breathe
      : 0.55 + 0.35 * breathe) + 0.16 * this._beatGlow);
    (this.boundingBox.material as THREE.LineBasicMaterial).opacity = stackFade ? 0.22 : 1;

    // Rain: advance both streak vertices along the wind vector; respawn at the
    // top once a drop reaches the city floor. Skipped entirely at play framing.
    if (!REDUCED_MOTION && this.fxReveal > 0.002 && this.rain) {
      const arr = this.rainPos.array as Float32Array;
      const top = this.game.size * 6, floor = -this.game.size * 3.2;
      for (let i = 0; i < this.rainVel.length; i++) {
        const v = this.rainVel[i] * f;
        const dx = -0.16 * v, dy = -v, dz = -0.08 * v;
        arr[i*6]   += dx; arr[i*6+1] += dy; arr[i*6+2] += dz;
        arr[i*6+3] += dx; arr[i*6+4] += dy; arr[i*6+5] += dz;
        if (arr[i*6+1] < floor) {
          const lift = top - arr[i*6+1];
          arr[i*6+1] += lift; arr[i*6+4] += lift;
        }
      }
      this.rainPos.needsUpdate = true;
    }

    // Music beat bus: consume due events — bars/bass swell the lattice glow,
    // bass downbeats also fire a sonar ring when the rig is awake.
    while (musicBus.events.length && musicBus.events[0].at <= now) {
      const e = musicBus.events.shift()!;
      if (e.kind === 'bar')  this._beatGlow = 1;
      else if (e.kind === 'bass') { this._beatGlow = Math.max(this._beatGlow, 0.55); this.spawnRipple(0.45); }
    }
    this._beatGlow = Math.max(0, this._beatGlow - 0.035 * f);

    // Dim the world while the connection is lost.
    if (this._bloomPass) {
      const target = this._signalLost ? 0.45 : 1.1;
      this._bloomPass.strength += (target - this._bloomPass.strength) * Math.min(1, 0.08 * f);
    }
    // Void rig: skip the whole update while it is invisible (fxReveal is 0 at
    // play framing) — previously every frame still rotated streaks, ran the
    // per-vertex silhouette fades, and uploaded four GPU buffers for a rig
    // nobody could see. The wake margin (2.5×size, below the 2.7×size reveal
    // start) pre-warms it so everything is already moving by the time it
    // fades in. Reduced-motion keeps it off entirely.
    if (!REDUCED_MOTION && this.camera.position.length() > this.game.size * 2.5) {
      this.updateVoidFX(f);
    }

    // Stone depth-cueing depends only on camera position + board/slice/cursor;
    // recompute only when one of those actually changed (dots/hoshi already
    // dirty-flag the same way). cameraMoved() also refreshes the camera snapshot.
    const camMoved = this.cameraMoved();
    if (this._stonesColorDirty || camMoved) {
      this._updateStoneColors();
      this._stonesColorDirty = false;
    }
    if (this._dotsDirty)  { this._updateDotVisibility();   this._dotsDirty  = false; }
    if (this._hoshiDirty) { this._updateHoshiVisibility(); this._hoshiDirty = false; }

    // Pop-in animation
    if (this.popInMap.size > 0) {
      let changed = false;
      for (const [k, sc] of this.popInMap) {
        const ns = Math.min(1, sc + 0.09 * f);
        ns >= 1 ? this.popInMap.delete(k) : this.popInMap.set(k, ns);
        changed = true;
      }
      if (changed) this._rebuildStones();
    }

    // Capture shrink animations
    for (let i = this.captureAnims.length - 1; i >= 0; i--) {
      const a = this.captureAnims[i];
      // Stagger: stones further from the capturing move wait their turn, so
      // multi-stone captures ripple outward instead of vanishing at once. The
      // burst fires the moment each stone's shrink begins.
      if (a.delay > 0) {
        a.delay -= f;
        if (a.delay > 0) continue;
        this._spawnBurst(a.mesh.position.x, a.mesh.position.y, a.mesh.position.z, a.burstColor);
      }
      a.life += f;
      const t = a.life / 18;
      a.mesh.scale.setScalar(1 - t);
      (a.mesh.material as THREE.MeshPhysicalMaterial).opacity = 1 - t;
      if (a.life >= 18) { a.mesh.visible = false; a.pool.push(a.mesh); this.captureAnims.splice(i,1); }
    }

    // Particle bursts from captures
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i]; b.life += f;
      const pos = b.geo.attributes['position'] as THREE.BufferAttribute;
      for (let j = 0; j < pos.count; j++) {
        pos.setX(j, pos.getX(j) + b.vel[j*3] * f);
        pos.setY(j, pos.getY(j) + b.vel[j*3+1] * f);
        pos.setZ(j, pos.getZ(j) + b.vel[j*3+2] * f);
        b.vel[j*3+1] -= 0.0008 * f;
      }
      pos.needsUpdate = true;
      (b.pts.material as THREE.PointsMaterial).opacity = 1 - b.life/25;
      if (b.life >= 25) { this.scene.remove(b.pts); b.geo.dispose(); this.bursts.splice(i,1); }
    }

    // Forbidden flash decay
    if (this.flashTimer > 0) {
      this.flashTimer = Math.max(0, this.flashTimer - f);
      (this.flashMesh.material as THREE.MeshPhysicalMaterial).emissiveIntensity = (this.flashTimer/18)*3;
      if (this.flashTimer <= 0) this.flashMesh.visible = false;
    }

    // Last-move torus pulse + rotate
    if (this.lastMoveMesh.visible) {
      const mat = this.lastMoveMesh.material as THREE.MeshBasicMaterial;
      mat.color.set(this.game.currentPlayer === 2 ? CYAN : PINK);
      mat.opacity = 0.4 + 0.4 * Math.sin(this.hoverPhase * 1.8);
      this.lastMoveMesh.rotation.y += 0.02 * f;
      this.lastMoveMesh.rotation.x += 0.01 * f;
    }

    // ── Hover ghost (mouse or keyboard cursor) ───────────────────────────────
    let activePos: { x: number; y: number; z: number } | null = null;
    if (!this.replayMode) {
      if (this.cursorActive && this.sliceAxis === 'none') {
        activePos = this.cursorPos;
      } else {
        const hover = this.getHoveredIntersection();
        if (hover) this.lastHover = hover;
        activePos = hover;
      }
    }

    if (activePos && this.game.board[activePos.x][activePos.y][activePos.z] === 0) {
      const pulse   = 0.35 + 0.3 * Math.sin(this.hoverPhase);
      const isBlack = this.game.currentPlayer === 1;
      const mat     = isBlack ? this.blackHoverMat : this.whiteHoverMat;
      mat.emissiveIntensity = isBlack ? pulse * 0.9 : pulse * 1.6;
      this.hoverMesh.material = mat;
      this.hoverMesh.position.set(this.coord(activePos.x), this.coord(activePos.y), this.coord(activePos.z));
      this.hoverMesh.visible = true;
      // Colored XYZ coordinate display
      this.coordTip.innerHTML =
        `<span style="color:#00e5ff">X·${String.fromCharCode(65 + activePos.x)}</span>` +
        `<span style="color:#ff0077"> Y·${activePos.y + 1}</span>` +
        `<span style="color:#00ffaa"> Z·${String.fromCharCode(97 + activePos.z)}</span>`;
    } else {
      if (!this.cursorActive) {
        this.hoverMesh.visible = false;
        this.coordTip.innerHTML = '';
      }
    }

    // ── Axis targeting lines (keyboard cursor, non-slice mode) ───────────────
    if (this.cursorActive && this.sliceAxis === 'none') {
      const cx = this.coord(this.cursorPos.x);
      const cy = this.coord(this.cursorPos.y);
      const cz = this.coord(this.cursorPos.z);
      const lo = this.coord(0), hi = this.coord(this.game.size - 1);
      const p = this.axisLinePositions;
      p[0]  = lo; p[1]  = cy; p[2]  = cz;
      p[3]  = hi; p[4]  = cy; p[5]  = cz;
      p[6]  = cx; p[7]  = lo; p[8]  = cz;
      p[9]  = cx; p[10] = hi; p[11] = cz;
      p[12] = cx; p[13] = cy; p[14] = lo;
      p[15] = cx; p[16] = cy; p[17] = hi;
      (this.axisLines.geometry.attributes['position'] as THREE.BufferAttribute).needsUpdate = true;
      this.rippleTimer = Math.max(0, this.rippleTimer - 0.05 * f);
      (this.axisLines.material as THREE.LineBasicMaterial).opacity = 0.25 + 0.5 * this.rippleTimer;
      this.axisLines.visible = true;

      // Coord display above cursor stone
      const gv = new THREE.Vector3(cx, cy + STONE_R * 3, cz).project(this.camera);
      const sw = this._vw, sh = this._vh;
      if (gv.z < 1) {
        this.layerGlyph.style.display = 'block';
        this.layerGlyph.style.left = ((gv.x * 0.5 + 0.5) * sw) + 'px';
        this.layerGlyph.style.top  = ((gv.y * -0.5 + 0.5) * sh) + 'px';
        this.layerGlyph.innerHTML =
          `<span style="color:#00e5ff">X·${String.fromCharCode(65 + this.cursorPos.x)}</span>` +
          `<span style="color:#ff0077"> Y·${this.cursorPos.y + 1}</span>` +
          `<span style="color:#00ffaa"> Z·${String.fromCharCode(97 + this.cursorPos.z)}</span>`;
      } else {
        this.layerGlyph.style.display = 'none';
      }
    } else {
      this.axisLines.visible = false;
      if (this.sliceAxis === 'none') this.layerGlyph.style.display = 'none';
    }

    // ── Slice panel + border ─────────────────────────────────────────────────
    if (this.sliceAxis !== 'none') {
      const pos = this.coord(this.sliceIndex);
      if (this.sliceAxis === 'x') {
        this.slicePanel.rotation.set(0, Math.PI / 2, 0);
        this.slicePanel.position.set(pos, 0, 0);
        this.sliceBorder.rotation.set(0, Math.PI / 2, 0);
        this.sliceBorder.position.set(pos, 0, 0);
      } else if (this.sliceAxis === 'y') {
        this.slicePanel.rotation.set(Math.PI / 2, 0, 0);
        this.slicePanel.position.set(0, pos, 0);
        this.sliceBorder.rotation.set(Math.PI / 2, 0, 0);
        this.sliceBorder.position.set(0, pos, 0);
      } else {
        this.slicePanel.rotation.set(0, 0, 0);
        this.slicePanel.position.set(0, 0, pos);
        this.sliceBorder.rotation.set(0, 0, 0);
        this.sliceBorder.position.set(0, 0, pos);
      }
      this.slicePanel.visible  = true;
      this.sliceBorder.visible = true;
      // Pulse border brightness
      (this.sliceBorder.material as THREE.LineBasicMaterial).opacity =
        0.5 + 0.45 * Math.sin(this.hoverPhase * 0.9);

      // Slice label — project top-edge of panel to screen
      const hi = this.coord(this.game.size - 1) + 0.7;
      const glyphPt = this.sliceAxis === 'x'
        ? new THREE.Vector3(pos, hi, 0)
        : this.sliceAxis === 'y'
        ? new THREE.Vector3(0, pos, -hi)
        : new THREE.Vector3(0, hi, pos);
      const gv = glyphPt.project(this.camera);
      const sw = this._vw, sh = this._vh;
      if (gv.z < 1) {
        const color = this.sliceAxis === 'y' ? '#ff0077' : this.sliceAxis === 'z' ? '#00ffaa' : '#00e5ff';
        const label = this.sliceAxis === 'x'
          ? `X · ${String.fromCharCode(65 + this.sliceIndex)}`
          : this.sliceAxis === 'y'
          ? `Y · ${this.sliceIndex + 1}`
          : `Z · ${String.fromCharCode(97 + this.sliceIndex)}`;
        this.layerGlyph.style.display     = 'block';
        this.layerGlyph.style.left        = ((gv.x * 0.5 + 0.5) * sw) + 'px';
        this.layerGlyph.style.top         = ((gv.y * -0.5 + 0.5) * sh) + 'px';
        this.layerGlyph.style.color       = color;
        this.layerGlyph.style.textShadow  = `0 0 10px ${color}`;
        this.layerGlyph.textContent       = `[ ${label} ]`;
      } else {
        this.layerGlyph.style.display = 'none';
      }
    } else {
      this.slicePanel.visible  = false;
      this.sliceBorder.visible = false;
    }

    // ── Stack mode build-surface plane ───────────────────────────────────────
    if (this.stackLayer !== null) {
      this.stackPlane.position.set(0, this.coord(this.stackLayer), 0);
      this.stackPlane.visible = true;
      (this.stackPlane.material as THREE.MeshBasicMaterial).opacity =
        0.08 + 0.06 * Math.sin(this.hoverPhase * 0.9);
    } else {
      this.stackPlane.visible = false;
    }

    this._updateAxisLabels();
    this.composer.render();
  }

  // ── Disposal ──────────────────────────────────────────────────────────────
  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._rafId);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.controls.dispose();
    // Dispose all Three.js geometries and materials in the scene
    this.scene.traverse((obj) => {
      const o = obj as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      o.geometry?.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m: any) => m.dispose()); // eslint-disable-line @typescript-eslint/no-explicit-any
        else o.material.dispose();
      }
    });
    this.composer.dispose();
    this.renderer.dispose();
    // Remove DOM elements created by this instance
    this.renderer.domElement.remove();
    document.getElementById('axis-labels')?.remove();
    this.layerGlyph?.remove();
    this.coordTip.innerHTML = '';
  }
}
