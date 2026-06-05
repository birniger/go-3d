<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Player-submitted bug reports. Created from the lobby ("Report a bug") and
 * listed in the wp-admin "3D Go" settings page.
 */
class Go3D_Bug_Report {

    /**
     * Store a report. $user_id may be 0 for an anonymous submission.
     *
     * @return array{ok:true,id:int}|array{ok:false,error:string,code:int}
     */
    const TYPES = [ 'bug', 'feature', 'improvement' ];

    public static function create( int $user_id, string $message, string $type = 'bug', string $context = '' ): array {
        global $wpdb;

        // Rate limit: 10 reports per IP per hour to blunt spam.
        $ip  = sanitize_text_field( $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0' );
        $key = 'go3d_bug_' . md5( $ip );
        $cnt = (int) get_transient( $key );
        if ( $cnt >= 10 ) {
            return [ 'ok' => false, 'error' => 'Too many reports just now. Please try again later.', 'code' => 429 ];
        }

        $type = in_array( $type, self::TYPES, true ) ? $type : 'bug';

        // Strip any markup — reports are shown as plain text in wp-admin.
        $message = trim( wp_strip_all_tags( $message ) );
        if ( strlen( $message ) < 5 ) {
            return [ 'ok' => false, 'error' => 'Please describe the bug (at least 5 characters).', 'code' => 422 ];
        }
        if ( strlen( $message ) > 2000 ) {
            $message = substr( $message, 0, 2000 );
        }

        $username = null;
        if ( $user_id ) {
            $user     = Go3D_Auth::get_user( $user_id );
            $username = $user['username'] ?? null;
        }

        $ok = $wpdb->insert( $wpdb->prefix . 'go3d_bug_reports', [
            'user_id'    => $user_id ?: null,
            'username'   => $username,
            'type'       => $type,
            'message'    => $message,
            'context'    => sanitize_text_field( substr( $context, 0, 255 ) ),
            'user_agent' => sanitize_text_field( substr( (string) ( $_SERVER['HTTP_USER_AGENT'] ?? '' ), 0, 255 ) ),
            'resolved'   => 0,
            'created_at' => current_time( 'mysql', true ),
        ] );

        if ( false === $ok || ! $wpdb->insert_id ) {
            return [ 'ok' => false, 'error' => 'Could not save your report. Please try again.', 'code' => 500 ];
        }

        set_transient( $key, $cnt + 1, HOUR_IN_SECONDS );
        return [ 'ok' => true, 'id' => (int) $wpdb->insert_id ];
    }

    /** Most recent reports first, unresolved before resolved. */
    public static function list( int $limit = 100 ): array {
        global $wpdb;
        $limit = max( 1, min( 500, $limit ) );
        return $wpdb->get_results( $wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}go3d_bug_reports
             ORDER BY resolved ASC, created_at DESC
             LIMIT %d",
            $limit
        ), ARRAY_A ) ?: [];
    }

    public static function set_resolved( int $id, bool $resolved ): void {
        global $wpdb;
        $wpdb->update( $wpdb->prefix . 'go3d_bug_reports', [ 'resolved' => $resolved ? 1 : 0 ], [ 'id' => $id ] );
    }

    public static function delete( int $id ): void {
        global $wpdb;
        $wpdb->delete( $wpdb->prefix . 'go3d_bug_reports', [ 'id' => $id ] );
    }

    public static function unresolved_count(): int {
        global $wpdb;
        return (int) $wpdb->get_var(
            "SELECT COUNT(*) FROM {$wpdb->prefix}go3d_bug_reports WHERE resolved = 0"
        );
    }
}
