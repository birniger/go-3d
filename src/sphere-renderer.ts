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

  private hoverPhase = 0;
  private _rafId = 0;

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
    this.controls.maxDistance = this.radius * 6;
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

    // Node dots.
    this.nodeDots = new THREE.InstancedMesh(
      new THREE.SphereGeometry(this.stoneR * 0.28, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x33d6ee }), geo.count);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < geo.count; i++) {
      dummy.position.copy(this.nodePos[i]);
      dummy.updateMatrix();
      this.nodeDots.setMatrixAt(i, dummy.matrix);
    }
    this.nodeDots.instanceMatrix.needsUpdate = true;
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
    const mat = (player === 1 ? this.whiteMat : this.blackMat).clone();
    mat.transparent = true;
    for (const n of nodes) {
      const m = new THREE.Mesh(this.stoneGeo, mat.clone());
      const p = this.nodePos[n];
      m.position.copy(p); m.lookAt(p.clone().multiplyScalar(2));
      this.scene.add(m);
      this.captureAnims.push({ mesh: m, life: 0 });
    }
  }

  forbiddenFlash(node: number): void {
    void node;
    this.sound.forbidden();
  }

  playPlaceSound()            { this.sound.place(); }
  playCaptureSound(n: number) { this.sound.capture(n); }
  playPassSound()             { this.sound.pass(); }

  /** Highlight final territory: tint empty nodes by owner (1 black / 2 white). */
  showTerritory(map: Record<number, number>): void {
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
      if (!nodes.length) return;
      const inst = new THREE.InstancedMesh(tGeo, m, nodes.length);
      nodes.forEach((n, i) => { dummy.position.copy(this.nodePos[n]); dummy.updateMatrix(); inst.setMatrixAt(i, dummy.matrix); });
      inst.instanceMatrix.needsUpdate = true;
      this.scene.add(inst);
    };
    mk(bNodes, bMat); mk(wNodes, wMat);
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

  // ── Animate ───────────────────────────────────────────────────────────────
  private animate() {
    this._rafId = requestAnimationFrame(() => this.animate());
    this.hoverPhase += 0.05;
    this.controls.update();

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
