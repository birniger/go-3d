import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Go3D, Player, Cell, TerritoryResult } from './game';

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
  private get ac(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  place() {
    const c = this.ac, o = c.createOscillator(), g = c.createGain();
    o.connect(g); g.connect(c.destination);
    o.frequency.value = 700 + Math.random() * 150; o.type = 'sine';
    g.gain.setValueAtTime(0.12, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.09);
    o.start(c.currentTime); o.stop(c.currentTime + 0.09);
  }
  capture(n: number) {
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
  private captureAnims: { mesh: THREE.Mesh; life: number; pool: THREE.Mesh[] }[] = [];

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
  private particles!: THREE.Points;

  // DOM
  private coordTip!: HTMLElement;

  // Axis labels
  private axisLabels: { el: HTMLElement; wx: number; wy: number; wz: number }[] = [];

  // Intersection dots (need per-instance color for slice visibility)
  private dotInst!:   THREE.InstancedMesh;
  // Hoshi star points
  private hoshiInst:  THREE.InstancedMesh | null = null;
  private hoshiCoords: { x: number; y: number; z: number }[] = [];

  private pointerDownAt = new THREE.Vector2();
  private pointerMoved  = false;

  // RAF id (for dispose) and dirty flags (dot/hoshi only update on slice change)
  private _rafId       = 0;
  private _dotsDirty   = true;
  private _hoshiDirty  = true;

  private game:    Go3D;
  private onPlace: (x: number, y: number, z: number) => void;

  constructor(game: Go3D, onPlace: (x: number, y: number, z: number) => void) {
    this.game    = game;
    this.onPlace = onPlace;
    this.initRenderer();
    this.initBloom();
    this.initLights();
    this.buildBoard();
    this.initParticles();
    this.initStones();
    this.initTerritory();
    this.initEffects();
    this.setupEvents();
    this.startIntroOrbit();
    this.animate();
  }

  private coord(i: number): number { return i - (this.game.size - 1) / 2; }

  // ── Renderer & camera ─────────────────────────────────────────────────────
  private initRenderer() {
    this.scene.background = new THREE.Color(BG);
    this.scene.fog = new THREE.FogExp2(BG, 0.012);

    const w = window.innerWidth, h = window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 300);
    const d = this.game.size * 1.4;
    this.camera.position.set(d, d * 0.75, d);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ReinhardToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    document.body.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = this.game.size * 0.5;
    this.controls.maxDistance = this.game.size * 8;
    (this.controls as unknown as Record<string, unknown>).zoomToCursor = true;

    this.coordTip = document.getElementById('coord-tip') ?? (() => {
      const el = document.createElement('div'); el.id = 'coord-tip';
      document.body.appendChild(el); return el;
    })();
  }

  private initBloom() {
    const w = window.innerWidth, h = window.innerHeight;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 1.1, 0.55, 0.28));
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
    this.scene.add(new THREE.LineSegments(bGeo, new THREE.LineBasicMaterial({ color: GRID_O })));

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
    const w = window.innerWidth, h = window.innerHeight;
    const v = new THREE.Vector3();
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
    const n = 600, pos = new Float32Array(n * 3), r = this.game.size * 5;
    for (let i = 0; i < n * 3; i++) pos[i] = (Math.random() - 0.5) * 2 * r;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.particles = new THREE.Points(geo,
      new THREE.PointsMaterial({ color: 0x003344, size: 0.05, transparent: true, opacity: 0.55 }));
    this.scene.add(this.particles);
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
    for (const [x, y, z] of positions) {
      const mesh = this._getCaptureMesh(player);
      mesh.position.set(this.coord(x), this.coord(y), this.coord(z));
      mesh.scale.setScalar(1);
      (mesh.material as THREE.MeshPhysicalMaterial).opacity = 1;
      const pool = player === 1 ? this.capturePool1 : this.capturePool2;
      this.captureAnims.push({ mesh, life: 0, pool });
      this._spawnBurst(this.coord(x), this.coord(y), this.coord(z), player === 1 ? 0x0077ff : 0xff0077);
    }
  }

  updateStones() {
    this._rebuildStones();
    if (this.game.lastMove) {
      const [x, y, z] = this.game.lastMove;
      this.popInMap.set(`${x},${y},${z}`, 0.05);
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
          const scale = this.popInMap.get(key) ?? 1;
          dummy.position.set(this.coord(x), this.coord(y), this.coord(z));
          dummy.scale.setScalar(scale); dummy.updateMatrix();
          if (cell === 1) this.blackStones.setMatrixAt(bi++, dummy.matrix);
          else            this.whiteStones.setMatrixAt(wi++, dummy.matrix);
        }

    this.blackStones.count = bi; this.blackStones.instanceMatrix.needsUpdate = true;
    this.whiteStones.count = wi; this.whiteStones.instanceMatrix.needsUpdate = true;
    this._updateStoneColors();

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

  // Per-dot colour: bright on active slice, near-invisible everywhere else
  private _updateDotVisibility() {
    const s = this.game.size;
    const col = new THREE.Color();
    const dotDefault = new THREE.Color(DOT_C);
    let idx = 0;
    for (let x = 0; x < s; x++)
      for (let y = 0; y < s; y++)
        for (let z = 0; z < s; z++) {
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
          } else {
            col.copy(dotDefault);
          }
          this.dotInst.setColorAt(idx++, col);
        }
    if (this.dotInst.instanceColor) this.dotInst.instanceColor.needsUpdate = true;
  }

  // Hoshi brightness: dim on slice, subtle otherwise
  private _updateHoshiVisibility() {
    if (!this.hoshiInst) return;
    const col = new THREE.Color();
    const hoshiDefault = new THREE.Color(0xffaa33);
    for (let i = 0; i < this.hoshiCoords.length; i++) {
      const { x, y, z } = this.hoshiCoords[i];
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
    const s = this.game.size;
    const dummy = new THREE.Object3D();
    let bi = 0, wi = 0;
    for (let x = 0; x < s; x++)
      for (let y = 0; y < s; y++)
        for (let z = 0; z < s; z++) {
          if (this.game.board[x][y][z] !== 0) continue;
          const owner = map[`${x},${y},${z}`];
          if (!owner) continue;
          dummy.position.set(this.coord(x), this.coord(y), this.coord(z));
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

  // ── Keyboard cursor ───────────────────────────────────────────────────────
  setCursorActive(on: boolean) {
    this.cursorActive = on;
    if (!on) this.hoverMesh.visible = false;
  }

  setCursorPos(x: number, y: number, z: number) {
    const s = this.game.size;
    const nx = Math.max(0, Math.min(s-1, x));
    const ny = Math.max(0, Math.min(s-1, y));
    const nz = Math.max(0, Math.min(s-1, z));
    if (nx !== this.cursorPos.x || ny !== this.cursorPos.y || nz !== this.cursorPos.z)
      this.rippleTimer = 1;
    this.cursorPos = { x: nx, y: ny, z: nz };
  }

  moveCursor(dx: number, dy: number, dz: number) {
    this.setCursorPos(this.cursorPos.x+dx, this.cursorPos.y+dy, this.cursorPos.z+dz);
  }

  getCursorPos() { return { ...this.cursorPos }; }

  getLastHover() { return this.lastHover ? { ...this.lastHover } : null; }

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
    this._updateStoneColors();
  }

  /**
   * Stack mode: restrict placement to a single vertical (y) layer and highlight
   * it. Pass null to disable (cube/sphere modes).
   */
  setStackLayer(layer: number | null) {
    this.stackLayer = layer;
    if (this.stackPlane) this.stackPlane.visible = layer !== null;
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
    window.addEventListener('resize', () => {
      const w = window.innerWidth, h = window.innerHeight;
      this.camera.aspect = w/h; this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h); this.composer.setSize(w, h);
    });
  }

  // ── Animate ───────────────────────────────────────────────────────────────
  private animate() {
    this._rafId = requestAnimationFrame(() => this.animate());
    this.hoverPhase += 0.05;

    // Camera: intro orbit
    if (this.introPhase >= 0) {
      this.introPhase = Math.min(1, this.introPhase + 0.013);
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
      // Camera: smooth tween to face-cam position
      this.camera.position.lerp(this.tweenTarget, 0.1);
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

    // Grid pulse
    (this.innerGrid.material as THREE.LineBasicMaterial).opacity =
      0.55 + 0.35 * Math.sin(this.hoverPhase * 0.18);

    // Particle drift
    this.particles.rotation.y += 0.0002;

    // Stone depth-cueing updates every frame (camera moves); dots/hoshi only on slice change
    this._updateStoneColors();
    if (this._dotsDirty)  { this._updateDotVisibility();   this._dotsDirty  = false; }
    if (this._hoshiDirty) { this._updateHoshiVisibility(); this._hoshiDirty = false; }

    // Pop-in animation
    if (this.popInMap.size > 0) {
      let changed = false;
      for (const [k, sc] of this.popInMap) {
        const ns = Math.min(1, sc + 0.09);
        ns >= 1 ? this.popInMap.delete(k) : this.popInMap.set(k, ns);
        changed = true;
      }
      if (changed) this._rebuildStones();
    }

    // Capture shrink animations
    for (let i = this.captureAnims.length - 1; i >= 0; i--) {
      const a = this.captureAnims[i];
      a.life++;
      const t = a.life / 18;
      a.mesh.scale.setScalar(1 - t);
      (a.mesh.material as THREE.MeshPhysicalMaterial).opacity = 1 - t;
      if (a.life >= 18) { a.mesh.visible = false; a.pool.push(a.mesh); this.captureAnims.splice(i,1); }
    }

    // Particle bursts from captures
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i]; b.life++;
      const pos = b.geo.attributes['position'] as THREE.BufferAttribute;
      for (let j = 0; j < pos.count; j++) {
        pos.setX(j, pos.getX(j) + b.vel[j*3]);
        pos.setY(j, pos.getY(j) + b.vel[j*3+1]);
        pos.setZ(j, pos.getZ(j) + b.vel[j*3+2]);
        b.vel[j*3+1] -= 0.0008;
      }
      pos.needsUpdate = true;
      (b.pts.material as THREE.PointsMaterial).opacity = 1 - b.life/25;
      if (b.life >= 25) { this.scene.remove(b.pts); b.geo.dispose(); this.bursts.splice(i,1); }
    }

    // Forbidden flash decay
    if (this.flashTimer > 0) {
      this.flashTimer--;
      (this.flashMesh.material as THREE.MeshPhysicalMaterial).emissiveIntensity = (this.flashTimer/18)*3;
      if (this.flashTimer === 0) this.flashMesh.visible = false;
    }

    // Last-move torus pulse + rotate
    if (this.lastMoveMesh.visible) {
      const mat = this.lastMoveMesh.material as THREE.MeshBasicMaterial;
      mat.color.set(this.game.currentPlayer === 2 ? CYAN : PINK);
      mat.opacity = 0.4 + 0.4 * Math.sin(this.hoverPhase * 1.8);
      this.lastMoveMesh.rotation.y += 0.02;
      this.lastMoveMesh.rotation.x += 0.01;
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
      this.rippleTimer = Math.max(0, this.rippleTimer - 0.05);
      (this.axisLines.material as THREE.LineBasicMaterial).opacity = 0.25 + 0.5 * this.rippleTimer;
      this.axisLines.visible = true;

      // Coord display above cursor stone
      const gv = new THREE.Vector3(cx, cy + STONE_R * 3, cz).project(this.camera);
      const sw = window.innerWidth, sh = window.innerHeight;
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
      const sw = window.innerWidth, sh = window.innerHeight;
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
    cancelAnimationFrame(this._rafId);
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
