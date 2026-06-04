/**
 * Geodesic sphere (icosphere) generator — client port of Go3D_Geodesic (PHP).
 *
 * In multiplayer the server generates this and ships vertices+edges to the
 * client. LOCAL hot-seat games have no server, so we regenerate the identical
 * graph here. The algorithm mirrors class-geodesic.php exactly (same vertex
 * dedup quantisation and grid traversal) so a locally-built board is rule- and
 * render-compatible with a server-built one.
 *
 * Node count for frequency f is 10·f² + 2  (f=2→42, f=3→92, f=4→162 …).
 */

import { SphereGeometry } from './api';

/** Full geodesic graph: render geometry plus the adjacency the rule engine needs. */
export interface GeodesicGraph extends SphereGeometry {
  adjacency: number[][];
}

/** Quantisation scale for the dedup key (4 decimal places on the unit sphere). */
const KEY_SCALE = 10000;

type Vec3 = [number, number, number];

/** Canonical regular icosahedron: 12 vertices, 20 triangular faces. */
function icosahedron(): { v: Vec3[]; faces: [number, number, number][] } {
  const t = (1.0 + Math.sqrt(5.0)) / 2.0;
  const v: Vec3[] = [
    [-1,  t,  0], [ 1,  t,  0], [-1, -t,  0], [ 1, -t,  0],
    [ 0, -1,  t], [ 0,  1,  t], [ 0, -1, -t], [ 0,  1, -t],
    [ t,  0, -1], [ t,  0,  1], [-t,  0, -1], [-t,  0,  1],
  ];
  const faces: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { v, faces };
}

/** Quantised dedup key so vertices shared between faces collapse to one index. */
function key(x: number, y: number, z: number): string {
  // String(-0) === "0", so mirrored coordinates hash identically without a fixup.
  const qx = Math.round(x * KEY_SCALE);
  const qy = Math.round(y * KEY_SCALE);
  const qz = Math.round(z * KEY_SCALE);
  return `${qx},${qy},${qz}`;
}

/** Build the geodesic graph for a given subdivision frequency (clamped 1–12). */
export function buildGeodesic(frequency: number): GeodesicGraph {
  const f = Math.max(1, Math.min(12, Math.floor(frequency)));
  const { v: icoV, faces: icoF } = icosahedron();

  const vertices: Vec3[] = [];
  const indexOf = new Map<string, number>();
  const adjSet: Array<Set<number>> = [];

  const addVertex = (p: Vec3): number => {
    const len = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    const x = p[0] / len, y = p[1] / len, z = p[2] / len;
    const k = key(x, y, z);
    const existing = indexOf.get(k);
    if (existing !== undefined) return existing;
    const idx = vertices.length;
    vertices.push([x, y, z]);
    indexOf.set(k, idx);
    adjSet[idx] = new Set<number>();
    return idx;
  };

  const addEdge = (a: number, b: number): void => {
    if (a === b) return;
    adjSet[a].add(b);
    adjSet[b].add(a);
  };

  // Subdivide each icosahedron face into f² small triangles.
  for (const [ia, ib, ic] of icoF) {
    const A = icoV[ia], B = icoV[ib], C = icoV[ic];

    // Triangular grid P(i,j) = A + (B-A)·(i/f) + (C-A)·(j/f), 0 ≤ i, 0 ≤ j, i+j ≤ f.
    const grid: number[][] = [];
    for (let i = 0; i <= f; i++) {
      grid[i] = [];
      for (let j = 0; j <= f - i; j++) {
        const ti = i / f, tj = j / f;
        const px = A[0] + (B[0] - A[0]) * ti + (C[0] - A[0]) * tj;
        const py = A[1] + (B[1] - A[1]) * ti + (C[1] - A[1]) * tj;
        const pz = A[2] + (B[2] - A[2]) * ti + (C[2] - A[2]) * tj;
        grid[i][j] = addVertex([px, py, pz]);
      }
    }

    // Connect grid neighbours to form the small-triangle edges.
    for (let i = 0; i <= f; i++) {
      for (let j = 0; j <= f - i; j++) {
        const here = grid[i][j];
        if (j + 1 <= f - i) addEdge(here, grid[i][j + 1]);          // → C direction
        if (i + 1 <= f) {
          if (j <= f - (i + 1)) addEdge(here, grid[i + 1][j]);      // → B direction
          if (j - 1 >= 0)       addEdge(here, grid[i + 1][j - 1]);  // hypotenuse
        }
      }
    }
  }

  // Freeze adjacency into sorted integer lists for stable output.
  const adjacency: number[][] = [];
  const edges: [number, number][] = [];
  for (let idx = 0; idx < adjSet.length; idx++) {
    const neigh = [...adjSet[idx]].sort((a, b) => a - b);
    adjacency[idx] = neigh;
    for (const n of neigh) if (idx < n) edges.push([idx, n]);
  }

  return { vertices, adjacency, edges, count: vertices.length };
}
