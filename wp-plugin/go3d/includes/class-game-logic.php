<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Server-side Go rule engine — PHP port of game.ts.
 * Validates moves, handles captures, checks superko.
 */
class Go3D_Game_Logic {

    private array $board;
    private int   $size;

    public function __construct( int $size, ?array $board = null ) {
        $this->size  = $size;
        $this->board = $board ?? $this->empty_board();
    }

    // ── Board setup ───────────────────────────────────────────────────────────

    private function empty_board(): array {
        return array_fill( 0, $this->size,
               array_fill( 0, $this->size,
               array_fill( 0, $this->size, 0 ) ) );
    }

    /** Rebuild a board by replaying an ordered list of move rows from the DB. */
    public static function replay( int $size, array $moves ): self {
        $logic = new self( $size );
        foreach ( $moves as $m ) {
            if ( $m['type'] === 'place' ) {
                $logic->place( (int)$m['x'], (int)$m['y'], (int)$m['z'], (int)$m['player_id'] % 2 === 1 ? 1 : 2 );
            }
            // pass/resign don't affect board
        }
        return $logic;
    }

    public function get_board(): array { return $this->board; }

    // ── Neighbours ───────────────────────────────────────────────────────────

    /** @return array<array{int,int,int}> */
    public function neighbours( int $x, int $y, int $z ): array {
        $result = [];
        foreach ( [ [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1] ] as [$dx,$dy,$dz] ) {
            $nx = $x+$dx; $ny = $y+$dy; $nz = $z+$dz;
            if ( $nx >= 0 && $nx < $this->size &&
                 $ny >= 0 && $ny < $this->size &&
                 $nz >= 0 && $nz < $this->size ) {
                $result[] = [$nx, $ny, $nz];
            }
        }
        return $result;
    }

    // ── Group / liberties ────────────────────────────────────────────────────

    /** @return array<array{int,int,int}> */
    private function get_group( int $x, int $y, int $z ): array {
        $color   = $this->board[$x][$y][$z];
        if ( $color === 0 ) return [];
        $visited = []; $group = [];
        $stack   = [ [$x,$y,$z] ];
        while ( ! empty( $stack ) ) {
            [$cx,$cy,$cz] = array_pop( $stack );
            $key = "$cx,$cy,$cz";
            if ( isset( $visited[$key] ) ) continue;
            $visited[$key] = true;
            $group[] = [$cx,$cy,$cz];
            foreach ( $this->neighbours($cx,$cy,$cz) as [$nx,$ny,$nz] ) {
                if ( $this->board[$nx][$ny][$nz] === $color && ! isset( $visited["$nx,$ny,$nz"] ) )
                    $stack[] = [$nx,$ny,$nz];
            }
        }
        return $group;
    }

    private function get_liberties( array $group ): int {
        $libs = [];
        foreach ( $group as [$x,$y,$z] )
            foreach ( $this->neighbours($x,$y,$z) as [$nx,$ny,$nz] )
                if ( $this->board[$nx][$ny][$nz] === 0 )
                    $libs["$nx,$ny,$nz"] = true;
        return count( $libs );
    }

    // ── Hash ─────────────────────────────────────────────────────────────────

    public function hash(): string {
        $flat = [];
        for ( $x = 0; $x < $this->size; $x++ )
            for ( $y = 0; $y < $this->size; $y++ )
                for ( $z = 0; $z < $this->size; $z++ )
                    $flat[] = $this->board[$x][$y][$z];
        return implode( '', $flat );
    }

    // ── Place ────────────────────────────────────────────────────────────────

    /**
     * Attempt to place a stone. Returns result array:
     *   ok=true  → captured positions, new board hash
     *   ok=false → reason string
     *
     * @param array<string> $history_hashes  All prior board hashes (superko check)
     * @return array{ok:true,captured:array,hash:string,board:array}|array{ok:false,reason:string}
     */
    public function place( int $x, int $y, int $z, int $player, array $history_hashes = [] ): array {
        if ( $x < 0 || $x >= $this->size || $y < 0 || $y >= $this->size || $z < 0 || $z >= $this->size )
            return [ 'ok' => false, 'reason' => 'out_of_bounds' ];
        if ( $this->board[$x][$y][$z] !== 0 )
            return [ 'ok' => false, 'reason' => 'occupied' ];

        $saved    = $this->deep_copy();
        $opponent = 3 - $player;
        $this->board[$x][$y][$z] = $player;
        $captured = [];
        $checked  = [];

        foreach ( $this->neighbours($x,$y,$z) as [$nx,$ny,$nz] ) {
            if ( $this->board[$nx][$ny][$nz] !== $opponent ) continue;
            $key = "$nx,$ny,$nz";
            if ( isset( $checked[$key] ) ) continue;
            $group = $this->get_group($nx,$ny,$nz);
            foreach ( $group as [$gx,$gy,$gz] ) $checked["$gx,$gy,$gz"] = true;
            if ( $this->get_liberties( $group ) === 0 ) {
                foreach ( $group as [$gx,$gy,$gz] ) {
                    $this->board[$gx][$gy][$gz] = 0;
                    $captured[] = [$gx,$gy,$gz];
                }
            }
        }

        // Suicide
        if ( $this->get_liberties( $this->get_group($x,$y,$z) ) === 0 ) {
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

    /** @return array{black:int,white:int,neutral:int,map:array} */
    public function count_territory(): array {
        $s     = $this->size;
        $seen  = [];
        $black = 0; $white = 0; $neutral = 0;
        $map   = [];

        for ( $x = 0; $x < $s; $x++ ) {
            for ( $y = 0; $y < $s; $y++ ) {
                for ( $z = 0; $z < $s; $z++ ) {
                    if ( $this->board[$x][$y][$z] !== 0 ) continue;
                    $key = "$x,$y,$z";
                    if ( isset( $seen[$key] ) ) continue;

                    $region  = [];
                    $borders = [];
                    $stack   = [[$x,$y,$z]];
                    while ( ! empty( $stack ) ) {
                        [$cx,$cy,$cz] = array_pop( $stack );
                        $k = "$cx,$cy,$cz";
                        if ( isset( $seen[$k] ) ) continue;
                        $seen[$k] = true;
                        $region[] = [$cx,$cy,$cz];
                        foreach ( $this->neighbours($cx,$cy,$cz) as [$nx,$ny,$nz] ) {
                            $cell = $this->board[$nx][$ny][$nz];
                            if ( $cell === 0 ) { if ( ! isset( $seen["$nx,$ny,$nz"] ) ) $stack[] = [$nx,$ny,$nz]; }
                            else               { $borders[$cell] = true; }
                        }
                    }

                    $owner = ( count($borders) === 1 ) ? array_key_first($borders) : 0;
                    foreach ( $region as [$rx,$ry,$rz] ) $map["$rx,$ry,$rz"] = $owner;
                    if ( $owner === 1 )      $black   += count($region);
                    elseif ( $owner === 2 )  $white   += count($region);
                    else                     $neutral += count($region);
                }
            }
        }
        return [ 'black' => $black, 'white' => $white, 'neutral' => $neutral, 'map' => $map ];
    }

    private function deep_copy(): array {
        return array_map( fn($l) => array_map( fn($r) => array_values($r), $l ), $this->board );
    }
}
