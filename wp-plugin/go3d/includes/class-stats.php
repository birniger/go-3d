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
}
