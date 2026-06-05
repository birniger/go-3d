<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Aggregate counts for the wp-admin overview: how many accounts exist and how
 * many games have been played. Computed on demand (admin page load only).
 */
class Go3D_Stats {

    /** @return array<string,mixed> */
    public static function summary(): array {
        global $wpdb;
        $u = $wpdb->prefix . 'go3d_users';
        $g = $wpdb->prefix . 'go3d_games';
        $m = $wpdb->prefix . 'go3d_moves';

        $d7  = gmdate( 'Y-m-d H:i:s', time() - 7 * DAY_IN_SECONDS );
        $d30 = gmdate( 'Y-m-d H:i:s', time() - 30 * DAY_IN_SECONDS );

        // ── Users ────────────────────────────────────────────────────────────
        $users = $wpdb->get_row( $wpdb->prepare(
            "SELECT
                COUNT(*)                       AS total,
                SUM( email_verified = 1 )      AS verified,
                SUM( created_at   >= %s )      AS new7,
                SUM( created_at   >= %s )      AS new30,
                SUM( last_seen_at >= %s )      AS active7
             FROM $u",
            $d7, $d30, $d7
        ), ARRAY_A ) ?: [];

        // ── Games ────────────────────────────────────────────────────────────
        $games = $wpdb->get_row( $wpdb->prepare(
            "SELECT
                COUNT(*)                        AS total,
                SUM( status = 'open' )          AS open,
                SUM( status = 'active' )        AS active,
                SUM( status = 'finished' )      AS finished,
                SUM( finished_at >= %s )        AS finished7,
                SUM( finished_at >= %s )        AS finished30
             FROM $g",
            $d7, $d30
        ), ARRAY_A ) ?: [];

        // Games per mode (cube / stack / sphere).
        $modes = [];
        foreach ( $wpdb->get_results( "SELECT mode, COUNT(*) AS c FROM $g GROUP BY mode", ARRAY_A ) ?: [] as $row ) {
            $modes[ $row['mode'] ] = (int) $row['c'];
        }

        $total_moves = (int) $wpdb->get_var( "SELECT COUNT(*) FROM $m" );

        return [
            'users' => [
                'total'    => (int) ( $users['total']    ?? 0 ),
                'verified' => (int) ( $users['verified'] ?? 0 ),
                'new7'     => (int) ( $users['new7']     ?? 0 ),
                'new30'    => (int) ( $users['new30']    ?? 0 ),
                'active7'  => (int) ( $users['active7']  ?? 0 ),
            ],
            'games' => [
                'total'      => (int) ( $games['total']      ?? 0 ),
                'open'       => (int) ( $games['open']       ?? 0 ),
                'active'     => (int) ( $games['active']     ?? 0 ),
                'finished'   => (int) ( $games['finished']   ?? 0 ),
                'finished7'  => (int) ( $games['finished7']  ?? 0 ),
                'finished30' => (int) ( $games['finished30'] ?? 0 ),
            ],
            'modes'       => $modes,
            'total_moves' => $total_moves,
        ];
    }

    /**
     * Richer breakdowns for the admin overview: how games end, what people
     * play, engagement, ratings, top players, and 14-day trends. All multiplayer
     * (local hot-seat games aren't persisted). Computed on demand.
     *
     * @return array<string,mixed>
     */
    public static function detail(): array {
        global $wpdb;
        $u = $wpdb->prefix . 'go3d_users';
        $g = $wpdb->prefix . 'go3d_games';
        $m = $wpdb->prefix . 'go3d_moves';

        $d1  = gmdate( 'Y-m-d H:i:s', time() -  1 * DAY_IN_SECONDS );
        $d7  = gmdate( 'Y-m-d H:i:s', time() -  7 * DAY_IN_SECONDS );
        $d30 = gmdate( 'Y-m-d H:i:s', time() - 30 * DAY_IN_SECONDS );

        // ── How finished games end + colour balance ─────────────────────────
        $outcomes = $wpdb->get_row(
            "SELECT
                COUNT(*)                                                 AS finished,
                SUM( end_reason = 'resign' )                             AS resign,
                SUM( end_reason = 'timeout' )                            AS timeout,
                SUM( end_reason = 'score' )                              AS score,
                SUM( end_reason = 'score_draw' )                         AS draws,
                SUM( winner_id IS NOT NULL AND winner_id = player1_id )  AS black_wins,
                SUM( winner_id IS NOT NULL AND winner_id = player2_id )  AS white_wins
             FROM $g WHERE status = 'finished'",
            ARRAY_A
        ) ?: [];

        $avg_moves = $wpdb->get_var(
            "SELECT AVG(mc) FROM (
                SELECT COUNT(*) AS mc FROM $m
                JOIN $g ON $g.id = $m.game_id
                WHERE $g.status = 'finished'
                GROUP BY $m.game_id
             ) t"
        );
        $avg_secs = $wpdb->get_var(
            "SELECT AVG( TIMESTAMPDIFF(SECOND, created_at, finished_at) )
             FROM $g WHERE status = 'finished' AND finished_at IS NOT NULL"
        );

        // ── Distributions (across all games) ────────────────────────────────
        $dist = function ( string $col ) use ( $wpdb, $g ): array {
            // $col is a fixed, code-supplied column name (never user input).
            $out = [];
            foreach ( $wpdb->get_results( "SELECT $col AS k, COUNT(*) AS c FROM $g GROUP BY $col ORDER BY c DESC", ARRAY_A ) ?: [] as $r ) {
                $out[ (string) $r['k'] ] = (int) $r['c'];
            }
            return $out;
        };

        // ── Engagement ──────────────────────────────────────────────────────
        $eng = $wpdb->get_row( $wpdb->prepare(
            "SELECT
                SUM( last_seen_at >= %s ) AS a1,
                SUM( last_seen_at >= %s ) AS a7,
                SUM( last_seen_at >= %s ) AS a30,
                SUM( games_played >= 1 )  AS played,
                SUM( games_played >= 2 )  AS returning
             FROM $u",
            $d1, $d7, $d30
        ), ARRAY_A ) ?: [];

        // ── ELO spread (players who have actually played) ───────────────────
        $elo = $wpdb->get_row(
            "SELECT AVG(elo) AS avg, MIN(elo) AS min, MAX(elo) AS max
             FROM $u WHERE email_verified = 1 AND games_played > 0",
            ARRAY_A
        ) ?: [];

        // ── Top players ─────────────────────────────────────────────────────
        $top_elo = $wpdb->get_results(
            "SELECT username, elo, games_played, wins, losses
             FROM $u WHERE email_verified = 1 AND games_played > 0
             ORDER BY elo DESC LIMIT 5",
            ARRAY_A
        ) ?: [];
        $top_games = $wpdb->get_results(
            "SELECT username, games_played, elo
             FROM $u WHERE email_verified = 1 AND games_played > 0
             ORDER BY games_played DESC, elo DESC LIMIT 5",
            ARRAY_A
        ) ?: [];

        // ── 14-day trends (UTC day buckets) ─────────────────────────────────
        $series = function ( string $table, string $since ) use ( $wpdb ): array {
            $rows = $wpdb->get_results( $wpdb->prepare(
                "SELECT DATE(created_at) AS d, COUNT(*) AS c FROM $table WHERE created_at >= %s GROUP BY DATE(created_at)",
                $since
            ), ARRAY_A ) ?: [];
            $byday = [];
            foreach ( $rows as $r ) $byday[ $r['d'] ] = (int) $r['c'];
            $out = [];
            for ( $i = 13; $i >= 0; $i-- ) {
                $day   = gmdate( 'Y-m-d', time() - $i * DAY_IN_SECONDS );
                $out[] = [ 'day' => $day, 'count' => $byday[ $day ] ?? 0 ];
            }
            return $out;
        };
        $d14 = gmdate( 'Y-m-d 00:00:00', time() - 13 * DAY_IN_SECONDS );

        return [
            'outcomes' => [
                'finished'   => (int) ( $outcomes['finished']   ?? 0 ),
                'resign'     => (int) ( $outcomes['resign']     ?? 0 ),
                'timeout'    => (int) ( $outcomes['timeout']    ?? 0 ),
                'score'      => (int) ( $outcomes['score']      ?? 0 ),
                'draws'      => (int) ( $outcomes['draws']      ?? 0 ),
                'black_wins' => (int) ( $outcomes['black_wins'] ?? 0 ),
                'white_wins' => (int) ( $outcomes['white_wins'] ?? 0 ),
                'avg_moves'  => $avg_moves !== null ? round( (float) $avg_moves, 1 ) : null,
                'avg_secs'   => $avg_secs  !== null ? (int) round( (float) $avg_secs ) : null,
            ],
            'dist' => [
                'board_size'   => $dist( 'board_size' ),
                'time_control' => $dist( 'time_control' ),
                'scoring_mode' => $dist( 'scoring_mode' ),
            ],
            'engagement' => [
                'active1'   => (int) ( $eng['a1']        ?? 0 ),
                'active7'   => (int) ( $eng['a7']        ?? 0 ),
                'active30'  => (int) ( $eng['a30']       ?? 0 ),
                'played'    => (int) ( $eng['played']    ?? 0 ),
                'returning' => (int) ( $eng['returning'] ?? 0 ),
            ],
            'elo' => [
                'avg' => isset( $elo['avg'] ) && $elo['avg'] !== null ? (int) round( (float) $elo['avg'] ) : null,
                'min' => isset( $elo['min'] ) ? (int) $elo['min'] : null,
                'max' => isset( $elo['max'] ) ? (int) $elo['max'] : null,
            ],
            'top_elo'   => $top_elo,
            'top_games' => $top_games,
            'trend_signups' => $series( $u, $d14 ),
            'trend_games'   => $series( $g, $d14 ),
        ];
    }
}
