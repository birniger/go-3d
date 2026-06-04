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

  // ── Exterior void FX (orbiting rig outside the globe) ──────────────────────
  private fxReveal = 0;                 // 0 when the globe fills the view, →1 zoomed out
  private _camDir  = new THREE.Vector3();
  private _fxTmp   = new THREE.Vector3();
  private fxRings: {
    mesh: THREE.LineLoop; local: Float32Array; colorAttr: THREE.BufferAttribute;
    base: [number, number, number]; spinAxis: THREE.Vector3; spin: number;
  }[] = [];
  private fxGlyphTex: THREE.Texture[] = [];
  private fxGlyphs: {
    spr: THREE.Sprite; u: THREE.Vector3; v: THREE.Vector3; r: number;
    ang: number; speed: number; flick: number;
  }[] = [];
  private fxSparks: THREE.Points | null = null;
  private fxSparkColor!: THREE.BufferAttribute;
  private fxSparkPos!:   THREE.BufferAttribute;
  private fxSparkData: { u: THREE.Vector3; v: THREE.Vector3; r: number; ang: number; speed: number; base: [number,number,number]; tw: number }[] = [];

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
  }

  /** Animate captured stones shrinking out. Nodes are already cleared in board. */
  triggerCaptures(nodes: number[], player: 1 | 2): void {
    // Clone the base material once per captured stone (each animates its own
    // opacity and is disposed when the animation ends — see animate()). The
    // previous code cloned an extra template material that was never disposed.
    const base = player === 1 ? this.whiteMat : this.blackMat;
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

    // ── Orbit rings ── three tilted neon loops on far shells. Per-vertex colour
    // lets us fade the arc that sweeps in front of the globe.
    const SEG = 128;
    const ringSpec: { rad: number; hue: number; tilt: [number, number, number]; spin: number }[] = [
      { rad: R * 1.55, hue: 0x00e5ff, tilt: [0.95, 0.2, 0.0],  spin:  0.0016 },
      { rad: R * 1.95, hue: 0xff0077, tilt: [0.15, 0.6, 0.78], spin: -0.0011 },
      { rad: R * 2.35, hue: 0x1affa0, tilt: [0.5, -0.4, 0.55], spin:  0.0008 },
    ];
    for (const spec of ringSpec) {
      const tilt = new THREE.Vector3(...spec.tilt).normalize();
      // Build an orthonormal basis (u,v) spanning the ring plane (⟂ tilt).
      const u = new THREE.Vector3();
      const seed = Math.abs(tilt.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      u.copy(seed).cross(tilt).normalize();
      const v = new THREE.Vector3().crossVectors(tilt, u).normalize();
      const local = new Float32Array(SEG * 3);
      const colArr = new Float32Array(SEG * 3);
      for (let i = 0; i < SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        const x = u.x * Math.cos(a) * spec.rad + v.x * Math.sin(a) * spec.rad;
        const y = u.y * Math.cos(a) * spec.rad + v.y * Math.sin(a) * spec.rad;
        const z = u.z * Math.cos(a) * spec.rad + v.z * Math.sin(a) * spec.rad;
        local[i*3] = x; local[i*3+1] = y; local[i*3+2] = z;
      }
      const g = new THREE.BufferGeometry();
      const posAttr = new THREE.Float32BufferAttribute(local.slice(), 3);
      const colorAttr = new THREE.Float32BufferAttribute(colArr, 3);
      colorAttr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', posAttr);
      g.setAttribute('color', colorAttr);
      const mesh = new THREE.LineLoop(g, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.fxRings.push({
        mesh, local, colorAttr: colorAttr as THREE.BufferAttribute,
        base: this.hexRGB(spec.hue),
        spinAxis: tilt.clone(), spin: spec.spin,
      });
    }

    // ── Drifting glyph sprites ── flickering matrix/kanji on circular orbits.
    const chars = ['ｱ','ﾂ','ﾈ','ﾜ','ﾔ','0','1','7','◇','#','>','零','弐','囲'];
    for (const ch of chars) {
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
      const ctx = cv.getContext('2d')!;
      ctx.clearRect(0, 0, 64, 64);
      ctx.font = 'bold 44px "Share Tech Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 8;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(ch, 32, 34);
      this.fxGlyphTex.push(new THREE.CanvasTexture(cv));
    }
    const glyphHues = [0x00e5ff, 0xff0077, 0x1affa0];
    for (let i = 0; i < 11; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.fxGlyphTex[(Math.random() * this.fxGlyphTex.length) | 0],
        color: glyphHues[i % glyphHues.length], transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const spr = new THREE.Sprite(mat);
      const sc = R * (0.14 + Math.random() * 0.1);
      spr.scale.set(sc, sc, sc);
      spr.frustumCulled = false;
      this.scene.add(spr);
      const u = new THREE.Vector3(), v = new THREE.Vector3();
      this.fxRandomBasis(u, v);
      this.fxGlyphs.push({
        spr, u, v, r: R * (1.45 + Math.random() * 0.95),
        ang: Math.random() * Math.PI * 2,
        speed: (0.003 + Math.random() * 0.006) * (Math.random() < 0.5 ? 1 : -1),
        flick: Math.random() * Math.PI * 2,
      });
    }

    // ── Spark field ── slow neon embers orbiting the globe, per-vertex faded.
    const N = 90;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const sparkHues = [0x00e5ff, 0xff0077, 0x1affa0, 0x66e0ff];
    for (let i = 0; i < N; i++) {
      const u = new THREE.Vector3(), v = new THREE.Vector3();
      this.fxRandomBasis(u, v);
      this.fxSparkData.push({
        u, v, r: R * (1.25 + Math.random() * 1.2),
        ang: Math.random() * Math.PI * 2,
        speed: (0.002 + Math.random() * 0.005) * (Math.random() < 0.5 ? 1 : -1),
        base: this.hexRGB(sparkHues[(Math.random() * sparkHues.length) | 0]),
        tw: Math.random() * Math.PI * 2,
      });
    }
    const g = new THREE.BufferGeometry();
    this.fxSparkPos   = new THREE.Float32BufferAttribute(pos, 3); this.fxSparkPos.setUsage(THREE.DynamicDrawUsage);
    this.fxSparkColor = new THREE.Float32BufferAttribute(col, 3); this.fxSparkColor.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.fxSparkPos);
    g.setAttribute('color', this.fxSparkColor);
    this.fxSparks = new THREE.Points(g, new THREE.PointsMaterial({
      size: R * 0.05, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
      sizeAttenuation: true,
    }));
    this.fxSparks.frustumCulled = false;
    this.scene.add(this.fxSparks);
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

  private updateVoidFX() {
    this._camDir.copy(this.camera.position).normalize();
    if (this._camDir.lengthSq() < 1e-4) this._camDir.set(1, 0.6, 1).normalize();

    // Zoom gate: hidden at normal framing, fades in only once you dolly out
    // well past the globe — the rig is an ambient reward for leaning back.
    const dist  = this.camera.position.length();
    const start = this.radius * 4.7, full = this.radius * 6.6;
    const t = Math.min(1, Math.max(0, (dist - start) / (full - start)));
    this.fxReveal = t * t * (3 - 2 * t);
    const reveal = this.fxReveal;

    // Rings — spin in place; per-vertex colour faded by silhouette × reveal.
    for (const ring of this.fxRings) {
      ring.mesh.rotateOnAxis(ring.spinAxis, ring.spin);
      ring.mesh.updateWorldMatrix(true, false);
      const mw = ring.mesh.matrixWorld;
      const col = ring.colorAttr.array as Float32Array;
      const loc = ring.local;
      const n = loc.length / 3;
      const [br, bg, bb] = ring.base;
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        this._fxTmp.set(loc[o], loc[o+1], loc[o+2]).applyMatrix4(mw);
        const k = reveal * this.fxSilhouette(this._fxTmp);
        col[o] = br * k; col[o+1] = bg * k; col[o+2] = bb * k;
      }
      ring.colorAttr.needsUpdate = true;
    }

    // Glyphs — advance along their orbit, flicker, fade.
    for (const gl of this.fxGlyphs) {
      gl.ang += gl.speed;
      gl.flick += 0.07;
      const c = Math.cos(gl.ang) * gl.r, s = Math.sin(gl.ang) * gl.r;
      gl.spr.position.set(
        gl.u.x * c + gl.v.x * s,
        gl.u.y * c + gl.v.y * s,
        gl.u.z * c + gl.v.z * s,
      );
      const flick = 0.55 + 0.45 * Math.sin(gl.flick);
      (gl.spr.material as THREE.SpriteMaterial).opacity =
        flick * this.fxSilhouette(gl.spr.position) * reveal;
    }

    // Sparks — orbit + twinkle, per-vertex faded.
    if (this.fxSparks) {
      const pos = this.fxSparkPos.array as Float32Array;
      const col = this.fxSparkColor.array as Float32Array;
      for (let i = 0; i < this.fxSparkData.length; i++) {
        const sp = this.fxSparkData[i];
        sp.ang += sp.speed; sp.tw += 0.05;
        const c = Math.cos(sp.ang) * sp.r, s = Math.sin(sp.ang) * sp.r;
        const x = sp.u.x * c + sp.v.x * s;
        const y = sp.u.y * c + sp.v.y * s;
        const z = sp.u.z * c + sp.v.z * s;
        const o = i * 3;
        pos[o] = x; pos[o+1] = y; pos[o+2] = z;
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(sp.tw));
        const k = reveal * tw * this.fxSilhouette(this._fxTmp.set(x, y, z));
        col[o] = sp.base[0] * k; col[o+1] = sp.base[1] * k; col[o+2] = sp.base[2] * k;
      }
      this.fxSparkPos.needsUpdate = true;
      this.fxSparkColor.needsUpdate = true;
    }
  }

  // ── Animate ───────────────────────────────────────────────────────────────
  private animate() {
    this._rafId = requestAnimationFrame(() => this.animate());
    this.hoverPhase += 0.05;
    this.controls.update();
    this.updateVoidFX();

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
      const a = this.captureAnims[i]; a.life++;
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
      const a = this.rejectAnims[i]; a.life++;
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
    cancelAnimationFrame(this._rafId);
    window.removeEventListener('resize', this._onResize);
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
