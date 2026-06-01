<?php
// Runs when the plugin is deleted (not just deactivated).
// Drops all custom tables and removes all plugin options.

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) exit;

global $wpdb;

$tables = [
    $wpdb->prefix . 'go3d_users',
    $wpdb->prefix . 'go3d_games',
    $wpdb->prefix . 'go3d_moves',
    $wpdb->prefix . 'go3d_challenges',
    $wpdb->prefix . 'go3d_notif_log',
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

wp_clear_scheduled_hook( 'go3d_hourly_notifications' );
