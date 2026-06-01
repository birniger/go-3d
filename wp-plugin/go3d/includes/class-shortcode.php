<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * [go3d] shortcode — enqueues assets and renders the app shell.
 */
class Go3D_Shortcode {

    public static function register(): void {
        add_shortcode( 'go3d', [ __CLASS__, 'render' ] );
    }

    public static function render( $atts ): string {
        $atts = shortcode_atts( [], $atts, 'go3d' );

        self::enqueue_assets();

        ob_start();
        include GO3D_PLUGIN_DIR . 'templates/embed.php';
        return ob_get_clean();
    }

    private static function enqueue_assets(): void {
        $dist   = GO3D_PLUGIN_URL . 'assets/dist/';
        $ver    = GO3D_VERSION;

        // Vite manifest-based asset loading
        $manifest_path = GO3D_PLUGIN_DIR . 'assets/dist/.vite/manifest.json';
        $entry_js  = 'assets/go3d-app.js';
        $entry_css = 'assets/go3d-app.css';

        if ( file_exists( $manifest_path ) ) {
            $manifest = json_decode( file_get_contents( $manifest_path ), true ) ?? [];
            // Find the main entry
            foreach ( $manifest as $src => $info ) {
                if ( ! empty( $info['isEntry'] ) ) {
                    $entry_js = $info['file'] ?? $entry_js;
                    if ( ! empty( $info['css'] ) ) {
                        $entry_css = $info['css'][0] ?? $entry_css;
                    }
                    break;
                }
            }
        }

        wp_enqueue_style(
            'go3d-app',
            $dist . ltrim( $entry_css, '/' ),
            [],
            $ver
        );

        wp_enqueue_script(
            'go3d-app',
            $dist . ltrim( $entry_js, '/' ),
            [],
            $ver,
            true // load in footer
        );

        // Inline config for the JS bundle
        $pusher_key     = get_option( 'go3d_pusher_key',     '' );
        $pusher_cluster = get_option( 'go3d_pusher_cluster', 'eu' );

        wp_add_inline_script( 'go3d-app', sprintf(
            'window.Go3DConfig = %s;',
            wp_json_encode( [
                'apiBase'       => rest_url( Go3D_API::NAMESPACE ),
                'pusherKey'     => $pusher_key,
                'pusherCluster' => $pusher_cluster,
                'authEndpoint'  => rest_url( Go3D_API::NAMESPACE . '/pusher/auth' ),
                'nonce'         => wp_create_nonce( 'wp_rest' ),
            ] )
        ), 'before' );
    }
}
