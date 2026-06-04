<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Server-side graph Go rule engine.
 *
 * A generalisation of Go3D_Game_Logic that plays on an arbitrary graph instead
 * of a 3D lattice: the board is a flat array of node states (0 empty, 1 black,
 * 2 white) and adjacency is an explicit neighbour list. This drives SPHERE mode
 * (geodesic icosphere, see Go3D_Geodesic) but is topology-agnostic.
 *
 * Captures, suicide and superko are identical in spirit to the lattice engine —
 * only "neighbours of a point" changes from ±1 lattice steps to adjacency[$n].
 *
 * Moves are stored in the DB with the node index in the `x` column; `y`/`z` are
 * null for sphere games.
 */
class Go3D_Graph_Logic {

    /** @var array<int> node index → 0|1|2 */
    private array $board;
    /** @var array<array<int>> node index → list of neighbour indices */
    private array $adjacency;
    private int   $n;

    /**
     * @param array<array<int>> $adjacency  node → neighbour indices
     * @param array<int>|null   $board      optional existing state
     */
    public function __construct( array $adjacency, ?array $board = null ) {
        $this->adjacency = $adjacency;
        $this->n         = count( $adjacency );
        $this->board     = $board ?? array_fill( 0, $this->n, 0 );
    }

    // ── Replay ───────────────────────────────────────────────────────────────

    /**
     * Rebuild a board by replaying ordered move rows. Node index lives in `x`.
     * Stone colour derives from player1_id (Black = slot 1), same as the lattice
     * engine — user-id parity is meaningless.
     */
    public static function replay( array $adjacency, array $moves, int $player1_id ): self {
        $logic = new self( $adjacency );
        foreach ( $moves as $m ) {
            if ( $m['type'] === 'place' ) {
                $slot = ( (int) $m['player_id'] === $player1_id ) ? 1 : 2;
                $logic->place( (int) $m['x'], $slot );
            }
            // pass/resign don't affect the board
        }
        return $logic;
    }

    public function get_board(): array { return $this->board; }

    /** @return array<int> */
    public function neighbours( int $node ): array {
        return $this->adjacency[$node] ?? [];
    }

    // ── Group / liberties ────────────────────────────────────────────────────

    /** @return array<int> node indices in the connected same-colour group */
    private function get_group( int $node ): array {
        $color = $this->board[$node];
        if ( $color === 0 ) return [];
        $visited = []; $group = [];
        $stack   = [ $node ];
        while ( ! empty( $stack ) ) {
            $c = array_pop( $stack );
            if ( isset( $visited[$c] ) ) continue;
            $visited[$c] = true;
            $group[] = $c;
            foreach ( $this->neighbours( $c ) as $nb ) {
                if ( $this->board[$nb] === $color && ! isset( $visited[$nb] ) )
                    $stack[] = $nb;
            }
        }
        return $group;
    }

    /** @param array<int> $group */
    private function get_liberties( array $group ): int {
        $libs = [];
        foreach ( $group as $node )
            foreach ( $this->neighbours( $node ) as $nb )
                if ( $this->board[$nb] === 0 )
                    $libs[$nb] = true;
        return count( $libs );
    }

    // ── Hash ─────────────────────────────────────────────────────────────────

    public function hash(): string {
        // md5 keeps the stored hash a fixed 32 chars regardless of node count.
        return md5( implode( '', $this->board ) );
    }

    // ── Place ────────────────────────────────────────────────────────────────

    /**
     * Attempt to place a stone on $node for $player (1|2).
     *
     * @param array<string> $history_hashes prior board hashes (superko check)
     * @return array{ok:true,captured:array<int>,hash:string,board:array<int>}|array{ok:false,reason:string}
     */
    public function place( int $node, int $player, array $history_hashes = [] ): array {
        if ( $node < 0 || $node >= $this->n )
            return [ 'ok' => false, 'reason' => 'out_of_bounds' ];
        if ( $this->board[$node] !== 0 )
            return [ 'ok' => false, 'reason' => 'occupied' ];

        $saved    = $this->board;
        $opponent = 3 - $player;
        $this->board[$node] = $player;
        $captured = [];
        $checked  = [];

        foreach ( $this->neighbours( $node ) as $nb ) {
            if ( $this->board[$nb] !== $opponent ) continue;
            if ( isset( $checked[$nb] ) ) continue;
            $group = $this->get_group( $nb );
            foreach ( $group as $g ) $checked[$g] = true;
            if ( $this->get_liberties( $group ) === 0 ) {
                foreach ( $group as $g ) {
                    $this->board[$g] = 0;
                    $captured[] = $g;
                }
            }
        }

        // Suicide
        if ( $this->get_liberties( $this->get_group( $node ) ) === 0 ) {
            $this->board = $saved;
            return [ 'ok' => false, 'reason' => 'suicide' ];
        }

        // Superko
        $hash = $this->hash();
        if ( in_array( $hash, $history_hashes, true ) ) {
            $this->board = $saved;
            return [ 'ok' => false, 'reason' => 'superko' ];
        }

        return [ 'ok' => true, 'captured' => $captured, 'hash' => $hash, 'board' => $this->board ];
    }

    // ── Territory counting ───────────────────────────────────────────────────

    /**
     * Flood-fill empty regions; a region bordered by exactly one colour is that
     * colour's territory. Also tallies stones on the board for area scoring.
     *
     * @return array{black:int,white:int,neutral:int,blackStones:int,whiteStones:int,map:array<int,int>}
     */
    public function count_territory(): array {
        $seen = [];
        $black = 0; $white = 0; $neutral = 0;
        $blackStones = 0; $whiteStones = 0;
        $map = [];

        foreach ( $this->board as $cell ) {
            if      ( $cell === 1 ) $blackStones++;
            elseif  ( $cell === 2 ) $whiteStones++;
        }

        for ( $node = 0; $node < $this->n; $node++ ) {
            if ( $this->board[$node] !== 0 ) continue;
            if ( isset( $seen[$node] ) ) continue;

            $region  = [];
            $borders = [];
            $stack   = [ $node ];
            while ( ! empty( $stack ) ) {
                $c = array_pop( $stack );
                if ( isset( $seen[$c] ) ) continue;
                $seen[$c] = true;
                $region[] = $c;
                foreach ( $this->neighbours( $c ) as $nb ) {
                    $cell = $this->board[$nb];
                    if ( $cell === 0 ) { if ( ! isset( $seen[$nb] ) ) $stack[] = $nb; }
                    else               { $borders[$cell] = true; }
                }
            }

            $owner = ( count( $borders ) === 1 ) ? array_key_first( $borders ) : 0;
            foreach ( $region as $r ) $map[$r] = $owner;
            if ( $owner === 1 )     $black   += count( $region );
            elseif ( $owner === 2 ) $white   += count( $region );
            else                    $neutral += count( $region );
        }

        return [
            'black'       => $black,
            'white'       => $white,
            'neutral'     => $neutral,
            'blackStones' => $blackStones,
            'whiteStones' => $whiteStones,
            'map'         => $map,
        ];
    }
}
