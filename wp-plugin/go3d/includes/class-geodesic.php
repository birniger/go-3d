<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Geodesic sphere (icosphere) generator.
 *
 * Subdivides a regular icosahedron `frequency` times to produce a near-uniform
 * tiling of the unit sphere. Vertices have degree 6 everywhere except the 12
 * original icosahedron corners (degree 5) — i.e. a hexagonal Go board wrapped
 * onto a globe with no edges.
 *
 * This runs SERVER-SIDE only. The resulting vertices + edges are sent to the
 * client for rendering, and the adjacency drives the rule engine. Because the
 * server is the single source of truth, the client never regenerates the graph,
 * so there is no cross-language reproducibility concern.
 *
 * Node count for frequency f is 10·f² + 2  (f=2→42, f=3→92, f=4→162 …).
 */
class Go3D_Geodesic {

    /** Quantisation scale for the dedup key (4 decimal places on the unit sphere). */
    const KEY_SCALE = 10000;

    /**
     * Build the geodesic graph for a given subdivision frequency.
     *
     * @return array{
     *   vertices:  array<array{float,float,float}>,
     *   adjacency: array<array<int>>,
     *   edges:     array<array{int,int}>,
     *   count:     int
     * }
     */
    public static function build( int $frequency ): array {
        $f = max( 1, min( 12, $frequency ) );

        [ $ico_v, $ico_f ] = self::icosahedron();

        $vertices = [];   // index → [x,y,z]
        $index_of = [];   // dedup key → index
        $adj_set  = [];   // index → [neighbour index => true]

        $add_vertex = function ( array $p ) use ( &$vertices, &$index_of, &$adj_set ): int {
            // Normalise to the unit sphere.
            $len = sqrt( $p[0]*$p[0] + $p[1]*$p[1] + $p[2]*$p[2] );
            $x = $p[0]/$len; $y = $p[1]/$len; $z = $p[2]/$len;
            $key = self::key( $x, $y, $z );
            if ( isset( $index_of[$key] ) ) return $index_of[$key];
            $idx = count( $vertices );
            $vertices[$idx]   = [ $x, $y, $z ];
            $index_of[$key]   = $idx;
            $adj_set[$idx]    = [];
            return $idx;
        };

        $add_edge = function ( int $a, int $b ) use ( &$adj_set ): void {
            if ( $a === $b ) return;
            $adj_set[$a][$b] = true;
            $adj_set[$b][$a] = true;
        };

        // Subdivide each icosahedron face into f² small triangles.
        foreach ( $ico_f as [$ia, $ib, $ic] ) {
            $A = $ico_v[$ia]; $B = $ico_v[$ib]; $C = $ico_v[$ic];

            // Build the triangular grid of points P(i,j), 0 ≤ i, 0 ≤ j, i+j ≤ f.
            //   P = A + (B-A)·(i/f) + (C-A)·(j/f)
            $grid = [];
            for ( $i = 0; $i <= $f; $i++ ) {
                $grid[$i] = [];
                for ( $j = 0; $j <= $f - $i; $j++ ) {
                    $ti = $i / $f; $tj = $j / $f;
                    $px = $A[0] + ($B[0]-$A[0])*$ti + ($C[0]-$A[0])*$tj;
                    $py = $A[1] + ($B[1]-$A[1])*$ti + ($C[1]-$A[1])*$tj;
                    $pz = $A[2] + ($B[2]-$A[2])*$ti + ($C[2]-$A[2])*$tj;
                    $grid[$i][$j] = $add_vertex( [ $px, $py, $pz ] );
                }
            }

            // Connect grid neighbours to form the small-triangle edges.
            for ( $i = 0; $i <= $f; $i++ ) {
                for ( $j = 0; $j <= $f - $i; $j++ ) {
                    $here = $grid[$i][$j];
                    if ( $j + 1 <= $f - $i )      $add_edge( $here, $grid[$i][$j+1] );      // → C direction
                    if ( $i + 1 <= $f )           {
                        if ( $j <= $f - ($i+1) )  $add_edge( $here, $grid[$i+1][$j] );      // → B direction
                        if ( $j - 1 >= 0 )        $add_edge( $here, $grid[$i+1][$j-1] );    // hypotenuse
                    }
                }
            }
        }

        // Freeze adjacency into sorted integer lists for stable output.
        $adjacency = [];
        $edges     = [];
        foreach ( $adj_set as $idx => $set ) {
            $neigh = array_keys( $set );
            sort( $neigh );
            $adjacency[$idx] = $neigh;
            foreach ( $neigh as $n ) {
                if ( $idx < $n ) $edges[] = [ $idx, $n ];
            }
        }

        return [
            'vertices'  => $vertices,
            'adjacency' => $adjacency,
            'edges'     => $edges,
            'count'     => count( $vertices ),
        ];
    }

    /** Just the adjacency list — used by the rule engine (no geometry needed). */
    public static function adjacency( int $frequency ): array {
        return self::build( $frequency )['adjacency'];
    }

    /** Quantised dedup key so vertices shared between faces collapse to one index. */
    private static function key( float $x, float $y, float $z ): string {
        // +0.0 collapses -0.0 to 0.0 so mirrored coordinates hash identically.
        $qx = (int) round( $x * self::KEY_SCALE ) + 0;
        $qy = (int) round( $y * self::KEY_SCALE ) + 0;
        $qz = (int) round( $z * self::KEY_SCALE ) + 0;
        return "$qx,$qy,$qz";
    }

    /**
     * Canonical regular icosahedron: 12 vertices, 20 triangular faces.
     * @return array{0:array<array{float,float,float}>,1:array<array{int,int,int}>}
     */
    private static function icosahedron(): array {
        $t = ( 1.0 + sqrt( 5.0 ) ) / 2.0;
        $v = [
            [ -1,  $t,  0 ], [  1,  $t,  0 ], [ -1, -$t,  0 ], [  1, -$t,  0 ],
            [  0, -1,  $t ], [  0,  1,  $t ], [  0, -1, -$t ], [  0,  1, -$t ],
            [  $t,  0, -1 ], [  $t,  0,  1 ], [ -$t,  0, -1 ], [ -$t,  0,  1 ],
        ];
        $faces = [
            [0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],
            [1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
            [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],
            [4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1],
        ];
        return [ $v, $faces ];
    }
}
