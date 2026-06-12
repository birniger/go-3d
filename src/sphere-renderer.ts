/**
 * Sphere-mode renderer (geodesic Go on a globe).
 *
 * Unlike the cube Renderer, this owns NO game engine: the server is the single
 * source of truth for the geodesic graph (vertices + edges) and the board
 * state. We just draw the globe, place stones from an authoritative flat board
 * array, and report clicked node indices back via onPlace.
 *
 * Picking works by raycasting against an invisible globe sphere (so only the
 * near, visible hemisphere is hittable) and snapping the surface hit to the
 * nearest node — which naturally handles back-face occlusion.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SoundSystem } from './renderer';
import { SphereGeometry as GeoData } from './api';

// Touch devices render at lower resolution and a capped frame rate to keep the
// bloom pipeline from overheating the GPU (see the same constant in renderer.ts).
const IS_TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
const REDUCED_MOTION = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const CYAN = 0x00e5ff;
const PINK = 0xff0077;
const BG   = 0x020408;

export class SphereRenderer {
  private scene     = new THREE.Scene();
  private camera!:   THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private controls!: OrbitControls;
  private sound     = new SoundSystem();

  private raycaster = new THREE.Raycaster();
  private mouse     = new THREE.Vector2(-9999, -9999);

  /** World-space node positions (unit vertices × globe radius). */
  private nodePos: THREE.Vector3[] = [];
  private radius   = 6;
  private stoneR   = 0.36;

  /** Authoritative board: index → 0 empty / 1 black / 2 white. */
  private board: number[] = [];
  private currentPlayer: 1 | 2 = 1;
  private interactive = true;

  private globeHit!:    THREE.Mesh;   // invisible pick target
  private nodeDots!:    THREE.InstancedMesh;
  private blackStones!: THREE.InstancedMesh;
  private whiteStones!: THREE.InstancedMesh;
  private stoneGeo!:    THREE.SphereGeometry;
  private blackMat!:    THREE.MeshPhysicalMaterial;
  private whiteMat!:    THREE.MeshPhysicalMaterial;
  private hoverMesh!:   THREE.Mesh;
  private blackHoverMat!: THREE.MeshPhysicalMaterial;
  private whiteHoverMat!: THREE.MeshPhysicalMaterial;
  private lastMoveMesh!:  THREE.Mesh;

  // Capture shrink animations
  private captureAnims: { mesh: THREE.Mesh; life: number }[] = [];
  private rejectAnims: { mesh: THREE.Mesh; life: number }[] = [];
  // Territory overlay (shown at game end). Tracked so it can be disposed.
  private territoryMeshes: THREE.InstancedMesh[] = [];
  private territoryGeo: THREE.BufferGeometry | null = null;

  private hoverPhase = 0;
  private _rafId = 0;
  private _frameInterval = IS_TOUCH ? 1000 / 40 : 0;
  private _lastFrameAt   = 0;
  private _lastT         = 0;
  private _disposed      = false;
  private _onVisibility = () => {
    if (document.hidden) {
      if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
    } else if (this._rafId === 0 && !this._disposed) {
      this._lastFrameAt = 0;
      this.animate();
    }
  };

  // ── Galaxy void: the globe sits in a star cluster ──────────────────────────
  // Spherical starfield shells (depth-tested so the opaque globe occludes the
  // stars behind it — no per-star silhouette maths needed), a warm core-bulge
  // halo glowing behind the board, drifting nebula clouds, and comets on long
  // elliptical orbits whose ion tails always point away from the globe.
  private fxReveal = 0;
  private _camDir  = new THREE.Vector3();
  private _fxTmp   = new THREE.Vector3();
  private _fxTmp2  = new THREE.Vector3();
  private starShells: { pts: THREE.Points; mat: THREE.PointsMaterial; spin: number; baseOp: number }[] = [];
  private coreHalo:  THREE.Sprite | null = null;
  private coreMat:   THREE.SpriteMaterial | null = null;
  private nebulae:   { spr: THREE.Sprite; mat: THREE.SpriteMaterial; u: THREE.Vector3; v: THREE.Vector3; r: number; ang: number; speed: number; baseOp: number }[] = [];
  private comets:    { p: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; a: number; b: number; ang: number; speed: number; hue: [number, number, number] }[] = [];
  private cometHeadAttr: THREE.BufferAttribute | null = null;
  private cometHeadCol:  THREE.BufferAttribute | null = null;
  private cometHeads: THREE.Points | null = null;
  private cometTailPos!: Float32Array;
  private cometTailCol!: Float32Array;
  private cometTails: THREE.LineSegments | null = null;
  // Reactive: density-wave rings on stone placement + a core flash on capture.
  private waves: { mesh: THREE.LineLoop; mat: THREE.LineBasicMaterial; life: number; on: boolean }[] = [];
  private coreFlash = 0;

  private onPlace: (node: number) => void;

  constructor(geo: GeoData, board: number[], onPlace: (node: number) => void) {
    this.onPlace = onPlace;
    this.board   = board.slice();

    this._deriveScale(geo);
    this.initRenderer();
    this.initBloom();
    this.initLights();
    this.buildGlobe(geo);
    this.initStones(geo.count);
    this.updateStones();
    this.initVoidFX();
    this.setupEvents();
    document.addEventListener('visibilitychange', this._onVisibility);
    this.animate();
  }

  // ── Scale ───────────────────────────────────────────────────────────────────
  /** Pick a globe radius so neighbouring nodes sit ~1 world unit apart. */
  private _deriveScale(geo: GeoData) {
    let sum = 0;
    for (const [a, b] of geo.edges) {
      const va = geo.vertices[a], vb = geo.vertices[b];
      sum += Math.hypot(va[0]-vb[0], va[1]-vb[1], va[2]-vb[2]);
    }
    const meanUnitEdge = geo.edges.length ? sum / geo.edges.length : 0.5;
    this.radius = 1.0 / Math.max(1e-6, meanUnitEdge);   // → ~1 unit spacing
    this.stoneR = this.radius * meanUnitEdge * 0.36;
    this.nodePos = geo.vertices.map(
      ([x, y, z]) => new THREE.Vector3(x, y, z).multiplyScalar(this.radius)
    );
  }

  private initRenderer() {
    this.scene.background = new THREE.Color(BG);

    const w = window.innerWidth, h = window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 1000);
    const d = this.radius * 2.6;
    this.camera.position.set(d, d * 0.5, d);
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
    this.controls.minDistance = this.radius * 1.25;
    this.controls.maxDistance = this.radius * 8;   // room to dolly out and reveal the FX rig
    this.controls.enablePan = false;
  }

  private initBloom() {
    const w = window.innerWidth, h = window.innerHeight;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 1.1, 0.55, 0.28));
  }

  private initLights() {
    this.scene.add(new THREE.AmbientLight(0x182030, 1.1));
    const a = new THREE.PointLight(CYAN, 3, this.radius * 8);
    a.position.set(0, this.radius * 2.5, this.radius * 1.5); this.scene.add(a);
    const b = new THREE.PointLight(PINK, 2, this.radius * 8);
    b.position.set(0, -this.radius * 2.5, -this.radius * 1.5); this.scene.add(b);
  }

  // ── Globe ─────────────────────────────────────────────────────────────────
  private buildGlobe(geo: GeoData) {
    // Solid inner shell, slightly under the node radius so edges/stones float
    // just above the surface and the back hemisphere is occluded.
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius * 0.985, 48, 48),
      new THREE.MeshPhysicalMaterial({
        color: 0x05101c, emissive: 0x021019, emissiveIntensity: 0.6,
        roughness: 0.55, metalness: 0.1, side: THREE.FrontSide,
      })
    );
    this.scene.add(shell);

    // Faint outer atmosphere glow.
    this.scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(this.radius * 1.06, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x003344, transparent: true, opacity: 0.06, side: THREE.BackSide, depthWrite: false })
    ));

    // Edges as line segments between node positions.
    const pts: number[] = [];
    for (const [a, b] of geo.edges) {
      const pa = this.nodePos[a], pb = this.nodePos[b];
      pts.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    }
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.LineSegments(eGeo,
      new THREE.LineBasicMaterial({ color: 0x0aa6c8, transparent: true, opacity: 0.5 })));

    // Node valence — the 12 original icosahedron vertices have 5 neighbours
    // (pentagons); every other node has 6 (hexagons). Mark the pentagons so
    // players can orient themselves on the globe.
    const valence = new Array<number>(geo.count).fill(0);
    for (const [a, b] of geo.edges) { valence[a]++; valence[b]++; }

    // Node dots — per-instance colour: amber for pentagons, cyan otherwise.
    // Pentagons are drawn slightly larger so they read at a glance.
    this.nodeDots = new THREE.InstancedMesh(
      new THREE.SphereGeometry(this.stoneR * 0.28, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff }), geo.count);
    const dummy = new THREE.Object3D();
    const cyan = new THREE.Color(0x33d6ee);
    const gold = new THREE.Color(0xffb020);
    for (let i = 0; i < geo.count; i++) {
      const isPent = valence[i] === 5;
      dummy.position.copy(this.nodePos[i]);
      dummy.scale.setScalar(isPent ? 1.8 : 1);
      dummy.updateMatrix();
      this.nodeDots.setMatrixAt(i, dummy.matrix);
      this.nodeDots.setColorAt(i, isPent ? gold : cyan);
    }
    dummy.scale.setScalar(1);
    this.nodeDots.instanceMatrix.needsUpdate = true;
    if (this.nodeDots.instanceColor) this.nodeDots.instanceColor.needsUpdate = true;
    this.scene.add(this.nodeDots);

    // Invisible pick sphere at the exact node radius.
    this.globeHit = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius, 32, 32),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    this.scene.add(this.globeHit);
  }

  // ── Stones ──────────────────────────────────────────────────────────────────
  private initStones(count: number) {
    this.stoneGeo = new THREE.SphereGeometry(this.stoneR, 20, 20);
    this.blackMat = new THREE.MeshPhysicalMaterial({
      color: 0x040412, emissive: 0x0055ee, emissiveIntensity: 0.5,
      roughness: 0.08, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.05,
    });
    this.whiteMat = new THREE.MeshPhysicalMaterial({
      color: 0x200010, emissive: PINK, emissiveIntensity: 0.9,
      roughness: 0.08, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.05,
    });
    this.blackHoverMat = this.blackMat.clone(); this.blackHoverMat.transparent = true; this.blackHoverMat.opacity = 0.5;
    this.whiteHoverMat = this.whiteMat.clone(); this.whiteHoverMat.transparent = true; this.whiteHoverMat.opacity = 0.5;

    this.blackStones = new THREE.InstancedMesh(this.stoneGeo, this.blackMat, count);
    this.whiteStones = new THREE.InstancedMesh(this.stoneGeo, this.whiteMat, count);
    this.blackStones.count = 0;
    this.whiteStones.count = 0;
    this.scene.add(this.blackStones, this.whiteStones);

    this.hoverMesh = new THREE.Mesh(this.stoneGeo, this.blackHoverMat);
    this.hoverMesh.visible = false;
    this.scene.add(this.hoverMesh);

    this.lastMoveMesh = new THREE.Mesh(
      new THREE.TorusGeometry(this.stoneR * 1.5, this.stoneR * 0.13, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
    this.lastMoveMesh.visible = false;
    this.scene.add(this.lastMoveMesh);
  }

  /** Orient a stone instance so its "north pole" points outward from the globe. */
  private _placeMatrix(dummy: THREE.Object3D, node: number) {
    const p = this.nodePos[node];
    dummy.position.copy(p);
    dummy.lookAt(p.clone().multiplyScalar(2));   // face outward
    dummy.updateMatrix();
  }

  private updateStones() {
    const dummy = new THREE.Object3D();
    let bi = 0, wi = 0;
    for (let i = 0; i < this.board.length; i++) {
      const cell = this.board[i];
      if (!cell) continue;
      this._placeMatrix(dummy, i);
      if (cell === 1) this.blackStones.setMatrixAt(bi++, dummy.matrix);
      else            this.whiteStones.setMatrixAt(wi++, dummy.matrix);
    }
    this.blackStones.count = bi; this.blackStones.instanceMatrix.needsUpdate = true;
    this.whiteStones.count = wi; this.whiteStones.instanceMatrix.needsUpdate = true;
  }

  // ── Public API (driven by the sphere session) ───────────────────────────────

  /** Replace the whole board (authoritative) and redraw. */
  setBoard(board: number[]): void {
    this.board = board.slice();
    this.updateStones();
  }

  setCurrentPlayer(p: 1 | 2): void { this.currentPlayer = p; }
  setInteractive(on: boolean): void { this.interactive = on; }

  markLastMove(node: number): void {
    const p = this.nodePos[node];
    this.lastMoveMesh.position.copy(p);
    this.lastMoveMesh.lookAt(p.clone().multiplyScalar(2));
    this.lastMoveMesh.visible = true;
    if (!REDUCED_MOTION) this.spawnWave();   // a density wave ripples out through the cluster
  }

  /** Animate captured stones shrinking out. Nodes are already cleared in board. */
  triggerCaptures(nodes: number[], player: 1 | 2): void {
    // Clone the base material once per captured stone (each animates its own
    // opacity and is disposed when the animation ends — see animate()). The
    // previous code cloned an extra template material that was never disposed.
    const base = player === 1 ? this.whiteMat : this.blackMat;
    this.coreFlash = 1;                       // the galactic core flares on a capture
    for (const n of nodes) {
      const mat = base.clone();
      mat.transparent = true;
      const m = new THREE.Mesh(this.stoneGeo, mat);
      const p = this.nodePos[n];
      m.position.copy(p); m.lookAt(p.clone().multiplyScalar(2));
      this.scene.add(m);
      this.captureAnims.push({ mesh: m, life: 0 });
    }
  }

  forbiddenFlash(node: number): void {
    this.sound.forbidden();
    const p = this.nodePos[node];
    if (!p) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff3028,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const geo = new THREE.TorusGeometry(this.stoneR * 1.35, 0.035, 8, 48);
    const ring = new THREE.Mesh(geo, mat);
    ring.position.copy(p.clone().multiplyScalar(1.012));
    ring.lookAt(p.clone().multiplyScalar(2));
    this.scene.add(ring);
    this.rejectAnims.push({ mesh: ring, life: 0 });
  }

  playPlaceSound()            { this.sound.place(); }
  playCaptureSound(n: number) { this.sound.capture(n); }
  playPassSound()             { this.sound.pass(); }

  /** Highlight final territory: tint empty nodes by owner (1 black / 2 white). */
  showTerritory(map: Record<number, number>): void {
    // Clear any previous territory overlay so repeated calls don't pile up
    // orphaned GPU resources.
    this.clearTerritory();

    const dummy = new THREE.Object3D();
    const bMat = new THREE.MeshStandardMaterial({ color: 0x001133, emissive: 0x0077ff, emissiveIntensity: 2.5, transparent: true, opacity: 0.9 });
    const wMat = new THREE.MeshStandardMaterial({ color: 0x280010, emissive: PINK, emissiveIntensity: 2.5, transparent: true, opacity: 0.9 });
    const tGeo = new THREE.SphereGeometry(this.stoneR * 0.5, 8, 8);
    const bNodes: number[] = [], wNodes: number[] = [];
    for (const [k, owner] of Object.entries(map)) {
      const n = Number(k);
      if (this.board[n] !== 0) continue;
      if (owner === 1) bNodes.push(n); else if (owner === 2) wNodes.push(n);
    }
    const mk = (nodes: number[], m: THREE.Material) => {
      if (!nodes.length) { m.dispose(); return; }
      const inst = new THREE.InstancedMesh(tGeo, m, nodes.length);
      nodes.forEach((n, i) => { dummy.position.copy(this.nodePos[n]); dummy.updateMatrix(); inst.setMatrixAt(i, dummy.matrix); });
      inst.instanceMatrix.needsUpdate = true;
      this.scene.add(inst);
      this.territoryMeshes.push(inst);
    };
    mk(bNodes, bMat); mk(wNodes, wMat);
    // tGeo is shared by both instanced meshes; keep a handle so clearTerritory
    // can free it. Dispose immediately if nothing was rendered.
    if (this.territoryMeshes.length) this.territoryGeo = tGeo;
    else tGeo.dispose();
  }

  /** Remove and dispose the territory overlay (meshes, shared geometry, materials). */
  clearTerritory(): void {
    for (const inst of this.territoryMeshes) {
      this.scene.remove(inst);
      (inst.material as THREE.Material).dispose();
      inst.dispose();
    }
    this.territoryMeshes = [];
    if (this.territoryGeo) { this.territoryGeo.dispose(); this.territoryGeo = null; }
  }

  // ── Picking ─────────────────────────────────────────────────────────────────
  private pickNode(): number | null {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObject(this.globeHit, false);
    if (!hits.length) return null;
    const pt = hits[0].point;
    // Snap surface hit to nearest node.
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.nodePos.length; i++) {
      const d = this.nodePos[i].distanceToSquared(pt);
      if (d < bestD) { bestD = d; best = i; }
    }
    // Reject if the closest node is implausibly far (clicked between globe and
    // a grazing edge) — a node should be within ~1 spacing of the hit.
    return bestD < (this.stoneR * 3) ** 2 ? best : null;
  }

  private setupEvents() {
    const canvas = this.renderer.domElement;
    let downAt = new THREE.Vector2(); let moved = false;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.set(((e.clientX-r.left)/r.width)*2-1, -((e.clientY-r.top)/r.height)*2+1);
      if (Math.hypot(e.clientX-downAt.x, e.clientY-downAt.y) > 5) moved = true;
    });
    canvas.addEventListener('pointerdown', (e) => { downAt = new THREE.Vector2(e.clientX, e.clientY); moved = false; });
    canvas.addEventListener('pointerup', (e) => {
      if (moved || !this.interactive) return;
      const r = canvas.getBoundingClientRect();
      this.mouse.set(((e.clientX-r.left)/r.width)*2-1, -((e.clientY-r.top)/r.height)*2+1);
      const node = this.pickNode();
      if (node !== null) this.onPlace(node);
    });
    window.addEventListener('resize', this._onResize);
  }

  private _onResize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w/h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h); this.composer.setSize(w, h);
  };

  // ── Exterior void FX ────────────────────────────────────────────────────────
  /**
   * Cyberpunk rig that orbits OUTSIDE the globe. Mirrors the cube renderer's
   * approach: everything lives beyond the play surface (radius), fades out where
   * it would cross the globe silhouette, and is gated behind zoom so a full-globe
   * framing stays clean — the rig only reveals itself as you dolly out.
   */
  private initVoidFX() {
    const R = this.radius;

    // Soft round sprite for points (default square GL points look harsh).
    const dotCv = document.createElement('canvas'); dotCv.width = 64; dotCv.height = 64;
    const dotG = dotCv.getContext('2d')!;
    const dotGrad = dotG.createRadialGradient(32, 32, 0, 32, 32, 32);
    dotGrad.addColorStop(0, 'rgba(255,255,255,1)');
    dotGrad.addColorStop(0.5, 'rgba(255,255,255,0.6)');
    dotGrad.addColorStop(1, 'rgba(255,255,255,0)');
    dotG.fillStyle = dotGrad; dotG.fillRect(0, 0, 64, 64);
    const dotTex = new THREE.CanvasTexture(dotCv);

    // ── Starfield shells ── thousands of stars on three large spherical shells
    // around the globe. depthTest:true + the opaque globe writing depth means
    // stars behind the planet are correctly occluded; the ones around and
    // beyond read as the cluster the board floats in.
    const shellSpec = [
      { n: 1400, r0: R * 6,  r1: R * 9,  size: 0.9, op: 0.9,  spin:  0.00018 },
      { n: 1100, r0: R * 9,  r1: R * 14, size: 0.7, op: 0.7,  spin: -0.00012 },
      { n: 700,  r0: R * 14, r1: R * 22, size: 0.55, op: 0.5, spin:  0.00008 },
    ];
    for (const sh of shellSpec) {
      const pos = new Float32Array(sh.n * 3);
      const col = new Float32Array(sh.n * 3);
      for (let i = 0; i < sh.n; i++) {
        // uniform direction on the sphere
        const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
        const rxy = Math.sqrt(1 - z * z);
        const rad = sh.r0 + Math.random() * (sh.r1 - sh.r0);
        pos[i*3]   = Math.cos(a) * rxy * rad;
        pos[i*3+1] = z * rad;
        pos[i*3+2] = Math.sin(a) * rxy * rad;
        const roll = Math.random(), b = 0.55 + Math.random() * 0.45;
        if (roll < 0.6)       { col[i*3] = b; col[i*3+1] = b; col[i*3+2] = b; }            // white
        else if (roll < 0.85) { col[i*3] = 0.55*b; col[i*3+1] = 0.75*b; col[i*3+2] = b; }  // blue
        else                  { col[i*3] = b; col[i*3+1] = 0.78*b; col[i*3+2] = 0.5*b; }    // amber
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const mat = new THREE.PointsMaterial({
        size: R * sh.size * 0.07, map: dotTex, vertexColors: true, transparent: true, opacity: 0,
        depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, sizeAttenuation: true,
      });
      const pts = new THREE.Points(g, mat);
      pts.frustumCulled = false;
      this.scene.add(pts);
      this.starShells.push({ pts, mat, spin: sh.spin, baseOp: sh.op });
    }

    // ── Core bulge ── a big warm radial glow centred on the globe. The opaque
    // planet occludes its middle (depthTest), leaving a luminous halo around
    // the board — the galactic core the construct hangs in.
    {
      const cc = document.createElement('canvas'); cc.width = 256; cc.height = 256;
      const cg = cc.getContext('2d')!;
      const grad = cg.createRadialGradient(128, 128, 8, 128, 128, 128);
      grad.addColorStop(0,    'rgba(255,244,214,0.95)');
      grad.addColorStop(0.18, 'rgba(255,210,140,0.7)');
      grad.addColorStop(0.45, 'rgba(255,150,90,0.32)');
      grad.addColorStop(1,    'rgba(120,60,160,0)');
      cg.fillStyle = grad; cg.fillRect(0, 0, 256, 256);
      this.coreMat = new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(cc), transparent: true, opacity: 0,
        depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
      });
      this.coreHalo = new THREE.Sprite(this.coreMat);
      this.coreHalo.scale.set(R * 7, R * 7, 1);
      this.scene.add(this.coreHalo);
    }

    // ── Nebula clouds ── a few large soft sprites drifting at mid-far range. —
    const nebHue = ['rgba(90,120,255,', 'rgba(190,70,220,', 'rgba(60,200,200,'];
    for (let i = 0; i < 5; i++) {
      const nc = document.createElement('canvas'); nc.width = 128; nc.height = 128;
      const ng = nc.getContext('2d')!;
      const hue = nebHue[i % nebHue.length];
      for (let b = 0; b < 5; b++) {
        const gx = 32 + Math.random() * 64, gy = 32 + Math.random() * 64, gr = 24 + Math.random() * 40;
        const gr2 = ng.createRadialGradient(gx, gy, 2, gx, gy, gr);
        gr2.addColorStop(0, hue + (0.12 + Math.random() * 0.12) + ')');
        gr2.addColorStop(1, hue + '0)');
        ng.fillStyle = gr2; ng.fillRect(0, 0, 128, 128);
      }
      const mat = new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(nc), transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const spr = new THREE.Sprite(mat);
      const sc = R * (3 + Math.random() * 3);
      spr.scale.set(sc, sc, 1);
      this.scene.add(spr);
      const u = new THREE.Vector3(), v = new THREE.Vector3();
      this.fxRandomBasis(u, v);
      this.nebulae.push({ spr, mat, u, v, r: R * (8 + Math.random() * 7),
        ang: Math.random() * Math.PI * 2, speed: (0.0006 + Math.random() * 0.001) * (Math.random() < 0.5 ? 1 : -1),
        baseOp: 0.4 + Math.random() * 0.25 });
    }

    // ── Comets ── a few on long elliptical orbits; ion tails point away from
    // the globe (the cluster's gravity well), like comets off a sun. —
    {
      const N = 5;
      this.cometTailPos = new Float32Array(N * 6);
      this.cometTailCol = new Float32Array(N * 6);
      const tg = new THREE.BufferGeometry();
      const tp = new THREE.BufferAttribute(this.cometTailPos, 3); tp.setUsage(THREE.DynamicDrawUsage);
      const tcl = new THREE.BufferAttribute(this.cometTailCol, 3); tcl.setUsage(THREE.DynamicDrawUsage);
      tg.setAttribute('position', tp); tg.setAttribute('color', tcl);
      this.cometTails = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false }));
      this.cometTails.frustumCulled = false;
      this.scene.add(this.cometTails);
      const hg = new THREE.BufferGeometry();
      this.cometHeadAttr = new THREE.BufferAttribute(new Float32Array(N * 3), 3); this.cometHeadAttr.setUsage(THREE.DynamicDrawUsage);
      this.cometHeadCol  = new THREE.BufferAttribute(new Float32Array(N * 3), 3); this.cometHeadCol.setUsage(THREE.DynamicDrawUsage);
      hg.setAttribute('position', this.cometHeadAttr); hg.setAttribute('color', this.cometHeadCol);
      this.cometHeads = new THREE.Points(hg, new THREE.PointsMaterial({
        size: R * 0.2, map: dotTex, vertexColors: true, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
      this.cometHeads.frustumCulled = false;
      this.scene.add(this.cometHeads);
      const hues: [number,number,number][] = [[0.6,0.95,1.0],[1.0,0.7,0.3],[0.7,1.0,0.8]];
      for (let i = 0; i < N; i++) {
        const u = new THREE.Vector3(), v = new THREE.Vector3();
        this.fxRandomBasis(u, v);
        this.comets.push({
          p: new THREE.Vector3(), u, v,
          a: R * (3 + Math.random() * 4), b: R * (5 + Math.random() * 7),
          ang: Math.random() * Math.PI * 2,
          speed: (0.004 + Math.random() * 0.006) * (Math.random() < 0.5 ? 1 : -1),
          hue: hues[i % hues.length],
        });
      }
    }

    // ── Density-wave rings ── expanding loops fired on each stone placement. —
    {
      const SEG = 64;
      const local = new Float32Array(SEG * 3);
      for (let i = 0; i < SEG; i++) { const a = (i / SEG) * Math.PI * 2; local[i*3] = Math.cos(a); local[i*3+1] = 0; local[i*3+2] = Math.sin(a); }
      for (let k = 0; k < 4; k++) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(local.slice(), 3));
        const mat = new THREE.LineBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
        const mesh = new THREE.LineLoop(g, mat);
        mesh.frustumCulled = false; mesh.visible = false;
        this.scene.add(mesh);
        this.waves.push({ mesh, mat, life: 0, on: false });
      }
    }
  }

  /** Fire an expanding density wave from the globe — called on stone placement. */
  private spawnWave(): void {
    const w = this.waves.find(q => !q.on);
    if (!w) return;
    w.on = true; w.life = 0; w.mesh.visible = true;
    // Random orientation so successive waves don't stack on one plane.
    w.mesh.quaternion.setFromEuler(new THREE.Euler(Math.random() * 3, Math.random() * 3, 0));
  }

  /** Random orthonormal basis (u,v) for a great-circle / orbit plane. */
  private fxRandomBasis(u: THREE.Vector3, v: THREE.Vector3) {
    const n = this._fxTmp.set(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1);
    if (n.lengthSq() < 1e-3) n.set(0, 1, 0);
    n.normalize();
    const seed = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
    u.copy(seed).cross(n).normalize();
    v.crossVectors(n, u).normalize();
  }

  private hexRGB(hex: number): [number, number, number] {
    return [((hex >> 16) & 255)/255, ((hex >> 8) & 255)/255, (hex & 255)/255];
  }

  /**
   * Fade factor (0..1) for a world point: 0 where it projects within the globe's
   * on-screen footprint (would overlap the play surface from this view), 1 well
   * outside it. Anchored to the current view direction so the clear zone tracks
   * the camera.
   */
  private fxSilhouette(p: THREE.Vector3): number {
    const d = p.dot(this._camDir);
    const perp = Math.sqrt(Math.max(0, p.lengthSq() - d * d));
    const inner = this.radius * 1.08, outer = this.radius * 1.55;
    if (perp >= outer) return 1;
    if (perp <= inner) return 0;
    const t = (perp - inner) / (outer - inner);
    return t * t * (3 - 2 * t);
  }

  private updateVoidFX(f: number) {
    this._camDir.copy(this.camera.position).normalize();
    if (this._camDir.lengthSq() < 1e-4) this._camDir.set(1, 0.6, 1).normalize();
    const R = this.radius;

    // Zoom gate.
    const dist  = this.camera.position.length();
    const start = R * 3.8, full = R * 6.0;
    const t = Math.min(1, Math.max(0, (dist - start) / (full - start)));
    this.fxReveal = t * t * (3 - 2 * t);
    const rev = this.fxReveal;

    this.coreFlash = Math.max(0, this.coreFlash - 0.04 * f);

    // Starfield shells: slow rotation + a gentle global twinkle.
    for (const sh of this.starShells) {
      sh.pts.rotation.y += sh.spin * f;
      sh.mat.opacity = rev * sh.baseOp * (0.82 + 0.18 * Math.sin(this.hoverPhase * 0.5 + sh.baseOp * 6));
    }

    // Core bulge halo: breathes, flares on capture, pulses with the beat glow.
    if (this.coreMat) {
      this.coreMat.opacity = rev * (0.45 + 0.08 * Math.sin(this.hoverPhase * 0.3) + 0.5 * this.coreFlash);
      const sc = R * (7 + this.coreFlash * 1.5);
      this.coreHalo!.scale.set(sc, sc, 1);
    }

    // Nebula clouds drift on slow orbits.
    for (const nb of this.nebulae) {
      nb.ang += nb.speed * f;
      const c = Math.cos(nb.ang) * nb.r, sn = Math.sin(nb.ang) * nb.r;
      nb.spr.position.set(nb.u.x*c + nb.v.x*sn, nb.u.y*c + nb.v.y*sn, nb.u.z*c + nb.v.z*sn);
      nb.mat.opacity = rev * nb.baseOp * 0.4;
    }

    // Comets: elliptical orbit; ion tail points away from the globe.
    if (this.cometHeads && this.cometTails) {
      for (let i = 0; i < this.comets.length; i++) {
        const cm = this.comets[i];
        cm.ang += cm.speed * f;
        const c = Math.cos(cm.ang) * cm.a, sn = Math.sin(cm.ang) * cm.b;
        cm.p.set(cm.u.x*c + cm.v.x*sn, cm.u.y*c + cm.v.y*sn, cm.u.z*c + cm.v.z*sn);
        const fade = this.fxSilhouette(cm.p);
        const hi = rev * fade;
        // tail away from globe centre
        const dir = this._fxTmp.copy(cm.p).normalize();
        const tail = this._fxTmp2.copy(cm.p).addScaledVector(dir, R * 2.4);
        const o = i * 6;
        this.cometTailPos[o]   = cm.p.x; this.cometTailPos[o+1] = cm.p.y; this.cometTailPos[o+2] = cm.p.z;
        this.cometTailPos[o+3] = tail.x; this.cometTailPos[o+4] = tail.y; this.cometTailPos[o+5] = tail.z;
        this.cometTailCol[o]   = cm.hue[0]*hi; this.cometTailCol[o+1] = cm.hue[1]*hi; this.cometTailCol[o+2] = cm.hue[2]*hi;
        this.cometTailCol[o+3] = 0; this.cometTailCol[o+4] = 0; this.cometTailCol[o+5] = 0;
        this.cometHeadAttr!.setXYZ(i, cm.p.x, cm.p.y, cm.p.z);
        this.cometHeadCol!.setXYZ(i, cm.hue[0]*hi, cm.hue[1]*hi, cm.hue[2]*hi);
      }
      (this.cometTails.geometry.attributes['position'] as THREE.BufferAttribute).needsUpdate = true;
      (this.cometTails.geometry.attributes['color'] as THREE.BufferAttribute).needsUpdate = true;
      this.cometHeadAttr!.needsUpdate = true;
      this.cometHeadCol!.needsUpdate = true;
    }

    // Density-wave rings expand and fade.
    for (const w of this.waves) {
      if (!w.on) continue;
      w.life += 0.02 * f;
      const u = w.life;
      w.mesh.scale.setScalar(R * (1.1 + u * 5));
      w.mat.opacity = rev * Math.max(0, 1 - u) * 0.6;
      if (u >= 1) { w.on = false; w.mesh.visible = false; }
    }
  }

  // ── Animate ───────────────────────────────────────────────────────────────
  private animate(now = 0) {
    this._rafId = requestAnimationFrame((t) => this.animate(t));
    if (this._frameInterval > 0) {
      if (now - this._lastFrameAt < this._frameInterval) return;
      this._lastFrameAt = now;
    }
    // Delta-time in 60fps-frame units (see renderer.ts) + void-rig sleep while
    // it is invisible at play framing; reduced-motion keeps it off entirely.
    const f = this._lastT > 0 ? Math.min(3, (now - this._lastT) / (1000 / 60)) : 1;
    this._lastT = now;
    this.hoverPhase += 0.05 * f;
    this.controls.update();
    if (!REDUCED_MOTION && this.camera.position.length() > this.radius * 3.6) this.updateVoidFX(f);

    // Hover ghost
    const node = this.interactive ? this.pickNode() : null;
    if (node !== null && this.board[node] === 0) {
      const pulse = 0.35 + 0.3 * Math.sin(this.hoverPhase);
      const isBlack = this.currentPlayer === 1;
      const mat = isBlack ? this.blackHoverMat : this.whiteHoverMat;
      mat.emissiveIntensity = isBlack ? pulse * 0.9 : pulse * 1.6;
      this.hoverMesh.material = mat;
      const p = this.nodePos[node];
      this.hoverMesh.position.copy(p);
      this.hoverMesh.lookAt(p.clone().multiplyScalar(2));
      this.hoverMesh.visible = true;
    } else {
      this.hoverMesh.visible = false;
    }

    // Last-move torus pulse
    if (this.lastMoveMesh.visible) {
      const mat = this.lastMoveMesh.material as THREE.MeshBasicMaterial;
      mat.color.set(this.currentPlayer === 2 ? CYAN : PINK);
      mat.opacity = 0.4 + 0.4 * Math.sin(this.hoverPhase * 1.8);
    }

    // Capture shrink animations
    for (let i = this.captureAnims.length - 1; i >= 0; i--) {
      const a = this.captureAnims[i]; a.life += f;
      const t = a.life / 18;
      a.mesh.scale.setScalar(Math.max(0.001, 1 - t));
      (a.mesh.material as THREE.MeshPhysicalMaterial).opacity = 1 - t;
      if (a.life >= 18) {
        this.scene.remove(a.mesh);
        (a.mesh.material as THREE.Material).dispose();
        this.captureAnims.splice(i, 1);
      }
    }

    for (let i = this.rejectAnims.length - 1; i >= 0; i--) {
      const a = this.rejectAnims[i]; a.life += f;
      const t = a.life / 22;
      a.mesh.scale.setScalar(1 + t * 1.5);
      const mat = a.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 0.95 * (1 - t));
      if (a.life >= 22) {
        this.scene.remove(a.mesh);
        a.mesh.geometry.dispose();
        mat.dispose();
        this.rejectAnims.splice(i, 1);
      }
    }

    this.composer.render();
  }

  // ── Disposal ────────────────────────────────────────────────────────────────
  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._rafId);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.controls.dispose();
    this.scene.traverse((obj) => {
      const o = obj as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      o.geometry?.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
