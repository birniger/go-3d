<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Email notifications for correspondence idle reminders.
 *
 * Design goals:
 *  – Never spam: each (user, game, turn, type) combo is logged and not resent.
 *  – Only nag when the player themselves hasn't moved in a correspondence game.
 *  – Keep optional game email surface tiny for small self-hosted installs.
 */
class Go3D_Notifications {

    // ── Immediate: game result ────────────────────────────────────────────────

    /**
     * Result emails are intentionally disabled. Keep this no-op for older code
     * paths or third-party hooks that may still call it.
     */
    public static function queue_result( int $game_id, int $user_id, ?int $winner_id ): void {
        unset( $game_id, $user_id, $winner_id );
    }

    // ── Cron: idle reminders ─────────────────────────────────────────────────

    /**
     * Hooked to 'go3d_hourly_notifications'.
     * Scans all active games and sends nudge emails as needed.
     */
    public static function run_hourly(): void {
        global $wpdb;
        $t = $wpdb->prefix . 'go3d_games';

        $games = $wpdb->get_results(
            "SELECT * FROM $t WHERE status = 'active' AND player2_id IS NOT NULL",
            ARRAY_A
        ) ?: [];

        foreach ( $games as $game ) {
            self::maybe_idle_nudge( $game );
        }
    }

    // ── Idle nudge ────────────────────────────────────────────────────────────

    private static function maybe_idle_nudge( array $game ): void {
        if ( $game['time_control'] !== 'none' ) return;

        $current = (int)$game['current_player'];
        $user_id = (int)$game[ "player{$current}_id" ];
        $user    = Go3D_Auth::get_user( $user_id );
        if ( ! $user || ! (int)$user['email_verified'] ) return;

        $threshold_hours = (int)( $user['notify_idle_hours'] ?? 24 );
        if ( $threshold_hours <= 0 ) return; // notifications disabled

        $turn_started_at = $game['last_move_at'] ?: $game['created_at'];
        if ( ! $turn_started_at ) return;

        // last_move_at is stored as a UTC 'mysql' datetime; strtotime() would
        // otherwise read it in the server's local zone and skew the elapsed time.
        $idle_hours = ( time() - strtotime( $turn_started_at . ' UTC' ) ) / HOUR_IN_SECONDS;
        if ( $idle_hours < $threshold_hours ) return;

        global $wpdb;
        $move_number = (int)$wpdb->get_var( $wpdb->prepare(
            "SELECT COALESCE(MAX(move_number), 0) FROM {$wpdb->prefix}go3d_moves WHERE game_id = %d",
            (int)$game['id']
        ) );
        $notif_key = "idle_{$threshold_hours}h_p{$current}_m{$move_number}";
        if ( self::already_sent( $user_id, (int)$game['id'], $notif_key ) ) return;

        self::send_idle_nudge( $user, (int)$game['id'], $threshold_hours );
        self::log_sent( $user_id, (int)$game['id'], $notif_key );
    }

    private static function send_idle_nudge( array $user, int $game_id, int $hours ): void {
        $site     = get_option( 'go3d_site_name', get_bloginfo( 'name' ) );
        $from     = get_option( 'go3d_from_email', get_option( 'admin_email' ) );
        $fname    = get_option( 'go3d_from_name', $site );
        $game_url = home_url( "/?go3d_game=$game_id" );

        $subject = "$site — It's your turn (game #$game_id)";
        $body    = "Hi {$user['username']},\n\nYour opponent is waiting! You haven't played in {$hours} hours.\n\nMake your move: $game_url\n\n— $site";

        wp_mail( $user['email'], $subject, $body, [
            "From: $fname <$from>",
            'Content-Type: text/plain; charset=UTF-8',
        ] );
    }

    // ── De-dupe log ───────────────────────────────────────────────────────────

    private static function already_sent( int $user_id, int $game_id, string $type ): bool {
        global $wpdb;
        $t = $wpdb->prefix . 'go3d_notif_log';
        return (bool) $wpdb->get_var( $wpdb->prepare(
            "SELECT id FROM $t WHERE user_id = %d AND game_id = %d AND type = %s LIMIT 1",
            $user_id, $game_id, $type
        ) );
    }

    private static function log_sent( int $user_id, int $game_id, string $type ): void {
        global $wpdb;
        $wpdb->insert( $wpdb->prefix . 'go3d_notif_log', [
            'user_id' => $user_id,
            'game_id' => $game_id,
            'type'    => $type,
            'sent_at' => current_time( 'mysql', true ),
        ] );
    }
}
