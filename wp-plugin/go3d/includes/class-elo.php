<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * ELO rating system.
 *
 * Starting ELO : 1500
 * K-factor     : 32 for players with < 30 rated games, 16 thereafter.
 */
class Go3D_Elo {

    const STARTING_ELO  = 1500;
    const K_NEW         = 32;   // fewer than 30 games
    const K_ESTABLISHED = 16;

    /**
     * Calculate K-factor for a player based on games played.
     */
    private static function k( int $games_played ): int {
        return $games_played < 30 ? self::K_NEW : self::K_ESTABLISHED;
    }

    /**
     * Expected score for player A against player B.
     */
    private static function expected( float $ra, float $rb ): float {
        return 1.0 / ( 1.0 + pow( 10, ( $rb - $ra ) / 400.0 ) );
    }

    /**
     * Update ELO for both players after a game.
     *
     * @param string $outcome  'p1_wins' | 'p2_wins' | 'draw'
     * @return array{int,int}  [$delta_p1, $delta_p2]
     */
    public static function update( int $p1_id, int $p2_id, string $outcome ): array {
        global $wpdb;
        $t = $wpdb->prefix . 'go3d_users';

        $p1 = $wpdb->get_row( $wpdb->prepare( "SELECT elo, games_played, wins, losses, draws FROM $t WHERE id = %d", $p1_id ), ARRAY_A );
        $p2 = $wpdb->get_row( $wpdb->prepare( "SELECT elo, games_played, wins, losses, draws FROM $t WHERE id = %d", $p2_id ), ARRAY_A );

        if ( ! $p1 || ! $p2 ) return [0, 0];

        $ra = (float)$p1['elo'];
        $rb = (float)$p2['elo'];

        $ea = self::expected( $ra, $rb );
        $eb = self::expected( $rb, $ra );

        switch ( $outcome ) {
            case 'p1_wins': $sa = 1.0; $sb = 0.0; break;
            case 'p2_wins': $sa = 0.0; $sb = 1.0; break;
            default:        $sa = 0.5; $sb = 0.5; break; // draw
        }

        $ka = self::k( (int)$p1['games_played'] );
        $kb = self::k( (int)$p2['games_played'] );

        $delta_a = (int) round( $ka * ( $sa - $ea ) );
        $delta_b = (int) round( $kb * ( $sb - $eb ) );

        $new_ra = max( 100, $ra + $delta_a );
        $new_rb = max( 100, $rb + $delta_b );

        // Update P1
        $wpdb->update( $t, [
            'elo'          => $new_ra,
            'games_played' => (int)$p1['games_played'] + 1,
            'wins'         => (int)$p1['wins']   + ( $sa === 1.0 ? 1 : 0 ),
            'losses'       => (int)$p1['losses'] + ( $sa === 0.0 ? 1 : 0 ),
            'draws'        => (int)$p1['draws']  + ( $sa === 0.5 ? 1 : 0 ),
        ], [ 'id' => $p1_id ] );

        // Update P2
        $wpdb->update( $t, [
            'elo'          => $new_rb,
            'games_played' => (int)$p2['games_played'] + 1,
            'wins'         => (int)$p2['wins']   + ( $sb === 1.0 ? 1 : 0 ),
            'losses'       => (int)$p2['losses'] + ( $sb === 0.0 ? 1 : 0 ),
            'draws'        => (int)$p2['draws']  + ( $sb === 0.5 ? 1 : 0 ),
        ], [ 'id' => $p2_id ] );

        return [ $delta_a, $delta_b ];
    }

    /**
     * Return a leaderboard (top N players by ELO).
     * @return array<array<string,mixed>>
     */
    public static function leaderboard( int $limit = 50, int $offset = 0 ): array {
        global $wpdb;
        return $wpdb->get_results( $wpdb->prepare(
            "SELECT id, username, avatar_url, elo, games_played, wins, losses, draws
             FROM {$wpdb->prefix}go3d_users
             WHERE email_verified = 1
             ORDER BY elo DESC, games_played DESC
             LIMIT %d OFFSET %d",
            $limit, $offset
        ), ARRAY_A ) ?: [];
    }
}
