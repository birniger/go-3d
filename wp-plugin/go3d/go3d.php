<?php
/**
 * Plugin Name:  3D Go
 * Plugin URI:   https://github.com/birniger/go-3d
 * Description:  Multiplayer 3D Go with user accounts, ELO ratings, and real-time play via Pusher. Includes a local hot-seat mode for two players at one screen.
 * Version:      1.6.0
 * Author:       birniger
 * License:      MIT
 * Text Domain:  go3d
 */

if ( ! defined( 'ABSPATH' ) ) exit;

define( 'GO3D_VERSION',    '1.6.0' );
define( 'GO3D_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'GO3D_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

// ── Autoload ──────────────────────────────────────────────────────────────────
foreach ( [
    'class-database',
    'class-jwt',
    'class-auth',
    'class-game-logic',
    'class-geodesic',
    'class-graph-logic',
    'class-clock',
    'class-game',
    'class-elo',
    'class-pusher',
    'class-notifications',
    'class-bug-report',
    'class-stats',
    'class-api',
    'class-api-auth',
    'class-api-games',
    'class-api-users',
    'class-shortcode',
] as $file ) {
    require_once GO3D_PLUGIN_DIR . "includes/{$file}.php";
}

// ── Activation / deactivation ─────────────────────────────────────────────────
register_activation_hook( __FILE__, function () {
    Go3D_Database::install();
    if ( ! wp_next_scheduled( 'go3d_hourly_notifications' ) ) {
        wp_schedule_event( time(), 'hourly', 'go3d_hourly_notifications' );
    }
} );

register_deactivation_hook( __FILE__, function () {
    Go3D_Database::deactivate();
} );

// ── REST API ──────────────────────────────────────────────────────────────────
add_action( 'rest_api_init', [ 'Go3D_API', 'register_routes' ] );

// ── Shortcode ─────────────────────────────────────────────────────────────────
add_action( 'init', [ 'Go3D_Shortcode', 'register' ] );

// ── WP-Cron: notifications + timeout checks ───────────────────────────────────
add_action( 'go3d_hourly_notifications', function () {
    Go3D_Notifications::run_hourly();
    Go3D_Game::process_timeouts();
    Go3D_Game::process_abandoned();
} );

// Reschedule on every load in case the option was cleared, and run any
// pending DB schema upgrade (adds new columns to existing installs).
add_action( 'plugins_loaded', function () {
    Go3D_Database::maybe_upgrade();
    if ( ! wp_next_scheduled( 'go3d_hourly_notifications' ) ) {
        wp_schedule_event( time(), 'hourly', 'go3d_hourly_notifications' );
    }
} );

// ── Full-screen app page (plain URL: /?go3d_app=1) ───────────────────────────
// The [go3d] launch button opens this in a new tab. It renders a self-contained
// full-screen document (independent of the active theme) hosting the auth →
// lobby → game flow that talks to the REST backend.
add_action( 'template_redirect', function () {
    if ( isset( $_GET['go3d_app'] ) ) {
        Go3D_Shortcode::render_app_page(); // prints the page and exits
    }
} );

// ── Email verification redirect (plain URL: /?go3d_verify=TOKEN) ─────────────
add_action( 'template_redirect', function () {
    if ( isset( $_GET['go3d_verify'] ) ) {
        $token = sanitize_text_field( wp_unslash( $_GET['go3d_verify'] ) );
        $ok    = Go3D_Auth::verify_email( $token );
        $dest  = home_url( '/' );
        // Find the page containing the shortcode and redirect there
        $pages = get_posts( [ 'post_type' => 'page', 's' => '[go3d]', 'numberposts' => 1 ] );
        if ( $pages ) $dest = get_permalink( $pages[0]->ID );
        $dest = add_query_arg( 'go3d_verified', $ok ? '1' : '0', $dest );
        wp_safe_redirect( $dest );
        exit;
    }

    if ( isset( $_GET['go3d_reset'] ) ) {
        // Just redirect to the shortcode page with the token in a fragment
        // The JS frontend handles the reset form
        $token = sanitize_text_field( wp_unslash( $_GET['go3d_reset'] ) );
        $pages = get_posts( [ 'post_type' => 'page', 's' => '[go3d]', 'numberposts' => 1 ] );
        $dest  = $pages ? get_permalink( $pages[0]->ID ) : home_url( '/' );
        $dest  = add_query_arg( 'go3d_reset_token', $token, $dest );
        wp_safe_redirect( $dest );
        exit;
    }
} );

// ── External cron endpoint (Hetzner Cron Job Manager) ────────────────────────
// Set up in Hetzner: GET https://bluebird-snowsports.ch/?go3d_cron=1&secret=YOUR_SECRET
add_action( 'template_redirect', function () {
    if ( isset( $_GET['go3d_cron'] ) ) {
        $secret = get_option( 'go3d_cron_secret', '' );
        // Refuse to run unless a secret is configured — an unprotected
        // endpoint would let anyone trigger cron work. Compare in constant time.
        $provided = isset( $_GET['secret'] ) ? sanitize_text_field( wp_unslash( $_GET['secret'] ) ) : '';
        if ( ! is_string( $secret ) || $secret === '' || ! hash_equals( $secret, $provided ) ) {
            status_header( 403 );
            exit( 'Forbidden' );
        }
        Go3D_Notifications::run_hourly();
        Go3D_Game::process_timeouts();
        Go3D_Game::process_abandoned();
        status_header( 200 );
        exit( 'ok ' . gmdate( 'c' ) );
    }
}, 1 );

// ── Admin settings ────────────────────────────────────────────────────────────
// Top-level menu item ("widget") in the wp-admin sidebar rather than buried
// under Settings, so the plugin has its own dedicated home.
add_action( 'admin_menu', function () {
    add_menu_page(
        '3D Go',                 // page title
        '3D Go',                 // menu label
        'manage_options',
        'go3d-settings',
        function () {
            include GO3D_PLUGIN_DIR . 'templates/admin-settings.php';
        },
        'dashicons-games',       // sidebar icon
        58                       // position (just below Settings)
    );
} );

add_action( 'admin_init', function () {
    $options = [
        'go3d_pusher_app_id',
        'go3d_pusher_key',
        'go3d_pusher_secret',
        'go3d_pusher_cluster',
        'go3d_from_email',
        'go3d_from_name',
        'go3d_site_name',
        'go3d_cron_secret',
    ];
    foreach ( $options as $opt ) {
        register_setting( 'go3d_options', $opt, [ 'sanitize_callback' => 'sanitize_text_field' ] );
    }
    register_setting( 'go3d_options', 'go3d_from_email', [ 'sanitize_callback' => 'sanitize_email' ] );
} );

// AJAX: rotate JWT secret
add_action( 'wp_ajax_go3d_rotate_jwt', function () {
    check_ajax_referer( 'go3d_rotate_jwt' );
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Forbidden', 403 );
    update_option( 'go3d_jwt_secret', wp_generate_password( 64, true, true ) );
    wp_send_json_success( 'JWT secret rotated. All players have been logged out.' );
} );
