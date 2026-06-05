<?php
// Runs when the plugin is DELETED (not just deactivated).
// Drops all custom tables, removes all plugin options, clears the cron, and
// sweeps the per-IP rate-limit transients. On multisite it repeats the cleanup
// for every blog in the network so nothing is left orphaned.

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) exit;

global $wpdb;

/**
 * Wipe every trace of the plugin from the CURRENT site's tables/options.
 */
function go3d_uninstall_site(): void {
    global $wpdb;

    $tables = [
        $wpdb->prefix . 'go3d_users',
        $wpdb->prefix . 'go3d_games',
        $wpdb->prefix . 'go3d_moves',
        $wpdb->prefix . 'go3d_challenges',
        $wpdb->prefix . 'go3d_friends',
        $wpdb->prefix . 'go3d_notif_log',
        $wpdb->prefix . 'go3d_bug_reports',
    ];
    foreach ( $tables as $table ) {
        $wpdb->query( "DROP TABLE IF EXISTS `{$table}`" ); // phpcs:ignore
    }

    $options = [
        'go3d_pusher_app_id', 'go3d_pusher_key', 'go3d_pusher_secret',
        'go3d_pusher_cluster', 'go3d_jwt_secret', 'go3d_from_email',
        'go3d_from_name', 'go3d_site_name', 'go3d_cron_secret',
        'go3d_db_version',
    ];
    foreach ( $options as $opt ) {
        delete_option( $opt );
    }

    // Per-IP rate-limit transients (registration, login, verify/resend codes).
    // They auto-expire, but sweep them so the options table is left spotless.
    $like = $wpdb->esc_like( '_transient_go3d_' ) . '%';
    $tlike = $wpdb->esc_like( '_transient_timeout_go3d_' ) . '%';
    $wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s", $like, $tlike ) );

    wp_clear_scheduled_hook( 'go3d_hourly_notifications' );
}

if ( is_multisite() ) {
    // Network install: clean each blog, then restore the original context.
    $blog_ids = $wpdb->get_col( "SELECT blog_id FROM {$wpdb->blogs}" );
    foreach ( $blog_ids as $blog_id ) {
        switch_to_blog( (int) $blog_id );
        go3d_uninstall_site();
        restore_current_blog();
    }
} else {
    go3d_uninstall_site();
}
