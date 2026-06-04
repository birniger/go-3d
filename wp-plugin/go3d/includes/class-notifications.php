<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Email notifications for idle-too-long, time-running-out, and game results.
 *
 * Design goals:
 *  – Never spam: each (user, game, type) combo is logged and not resent.
 *  – Only nag when the player themselves hasn't moved in a while or time is critical.
 *  – Result emails fire once per player immediately after the game ends.
 */
class Go3D_Notifications {

    // ── Immediate: game result ────────────────────────────────────────────────

    /**
     * Called synchronously from Go3D_Game::finalise_game().
     * Queues a WP action that fires on shutdown so it doesn't block the API response.
     */
    public static function queue_result( int $game_id, int $user_id, ?int $winner_id ): void {
        add_action( 'shutdown', function() use ( $game_id, $user_id, $winner_id ) {
            self::send_result( $game_id, $user_id, $winner_id );
        } );
    }

    private static function send_result( int $game_id, int $user_id, ?int $winner_id ): void {
        if ( self::already_sent( $user_id, $game_id, 'result' ) ) return;

        $user = Go3D_Auth::get_user( $user_id );
        if ( ! $user || ! (int)$user['email_verified'] ) return;

        $game = Go3D_Game::get_row( $game_id );
        if ( ! $game ) return;

        $site    = get_option( 'go3d_site_name', get_bloginfo( 'name' ) );
        $from    = get_option( 'go3d_from_email', get_option( 'admin_email' ) );
        $fname   = get_option( 'go3d_from_name', $site );
        $game_url = home_url( "/?go3d_game=$game_id" );

        if ( $winner_id === null ) {
            $result_line = "The game ended in a draw.";
        } elseif ( $winner_id === $user_id ) {
            $result_line = "You won! 🎉";
        } else {
            $result_line = "You lost this one — better luck next time.";
        }

        $slot    = (int)$game['player1_id'] === $user_id ? 1 : 2;
        $my_score  = $slot === 1 ? $game['p1_score'] : $game['p2_score'];
        $opp_score = $slot === 1 ? $game['p2_score'] : $game['p1_score'];
        $score_line = ( $my_score !== null )
            ? "Final score: You $my_score — Opponent $opp_score"
            : '';

        $reason_map = [
            'score'      => 'by territory count',
            'resign'     => 'by resignation',
            'timeout'    => 'on time',
            'score_draw' => '(draw)',
        ];
        $reason_line = isset( $game['end_reason'] ) ? ( $reason_map[$game['end_reason']] ?? '' ) : '';

        $subject = "$site — Your game has ended";
        $body    = implode( "\n\n", array_filter( [
            "Hi {$user['username']},",
            "$result_line $reason_line",
            $score_line,
            "View the completed game: $game_url",
            "— $site",
        ] ) );

        wp_mail( $user['email'], $subject, $body, [
            "From: $fname <$from>",
            'Content-Type: text/plain; charset=UTF-8',
        ] );

        self::log_sent( $user_id, $game_id, 'result' );
    }

    // ── Cron: idle + timeout warnings ────────────────────────────────────────

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
            self::maybe_timeout_warning( $game );
        }
    }

    // ── Idle nudge ────────────────────────────────────────────────────────────

    private static function maybe_idle_nudge( array $game ): void {
        if ( ! $game['last_move_at'] ) return;

        $current = (int)$game['current_player'];
        $user_id = (int)$game[ "player{$current}_id" ];
        $user    = Go3D_Auth::get_user( $user_id );
        if ( ! $user ) return;

        $threshold_hours = (int)( $user['notify_idle_hours'] ?? 24 );
        if ( $threshold_hours <= 0 ) return; // notifications disabled

        // last_move_at is stored as a UTC 'mysql' datetime; strtotime() would
        // otherwise read it in the server's local zone and skew the elapsed time.
        $idle_hours = ( time() - strtotime( $game['last_move_at'] . ' UTC' ) ) / HOUR_IN_SECONDS;
        if ( $idle_hours < $threshold_hours ) return;

        $notif_key = "idle_$threshold_hours";
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

    // ── Timeout warning ───────────────────────────────────────────────────────

    private static function maybe_timeout_warning( array $game ): void {
        if ( $game['time_control'] === 'none' ) return;
        if ( ! $game['last_move_at'] ) return;

        $current  = (int)$game['current_player'];
        $user_id  = (int)$game[ "player{$current}_id" ];
        $user     = Go3D_Auth::get_user( $user_id );
        if ( ! $user ) return;

        $warn_mins = (int)( $user['notify_timeout_mins'] ?? 60 );
        if ( $warn_mins <= 0 ) return;

        $clock_raw = $current === 1 ? $game['p1_time_ms'] : $game['p2_time_ms'];
        if ( $clock_raw === null ) return;
        $clock_ms = (int)$clock_raw;

        // ' UTC' suffix: last_move_at is a UTC datetime, so parse it as UTC.
        $elapsed_ms  = ( time() - strtotime( $game['last_move_at'] . ' UTC' ) ) * 1000;
        if ( $game['time_control'] === 'byoyomi' ) {
            $ts        = json_decode( $game['time_settings'] ?? '{}', true ) ?: [];
            $period_ms = max( 1, (int)( $ts['byoyomi_time_s'] ?? 0 ) * 1000 );
            $periods   = (int)( $current === 1 ? $game['p1_periods'] : $game['p2_periods'] );
            $in_byo    = (bool)( $current === 1 ? $game['p1_in_byoyomi'] : $game['p2_in_byoyomi'] );
            $clock_ms  = Go3D_Clock::byoyomi_remaining_total( $clock_ms, $periods, $in_byo, $period_ms );
        }
        $remaining_ms = $clock_ms - $elapsed_ms;

        if ( $remaining_ms > $warn_mins * MINUTE_IN_SECONDS * 1000 ) return;
        if ( $remaining_ms <= 0 ) return; // already timed out — cron handles that elsewhere

        if ( self::already_sent( $user_id, (int)$game['id'], 'timeout_warn' ) ) return;

        self::send_timeout_warning( $user, (int)$game['id'], (int)round( $remaining_ms / 60000 ) );
        self::log_sent( $user_id, (int)$game['id'], 'timeout_warn' );
    }

    private static function send_timeout_warning( array $user, int $game_id, int $mins_left ): void {
        $site     = get_option( 'go3d_site_name', get_bloginfo( 'name' ) );
        $from     = get_option( 'go3d_from_email', get_option( 'admin_email' ) );
        $fname    = get_option( 'go3d_from_name', $site );
        $game_url = home_url( "/?go3d_game=$game_id" );

        $subject = "$site — Your clock is almost out! (~{$mins_left} min left)";
        $body    = "Hi {$user['username']},\n\nYou have roughly {$mins_left} minutes left on your clock in game #$game_id. Play now or you'll lose on time!\n\n$game_url\n\n— $site";

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
            'sent_at' => current_time( 'mysql' ),
        ] );
    }
}
