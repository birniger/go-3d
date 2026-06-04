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
        $dist = GO3D_PLUGIN_URL . 'assets/dist/';
        $ver  = GO3D_VERSION;

        // Resolve the hashed filenames of the multiplayer entry (src/app.ts)
        // and any CSS it imports from the Vite manifest.
        $manifest_path = GO3D_PLUGIN_DIR . 'assets/dist/.vite/manifest.json';
        $entry_js   = 'assets/app.js';
        $entry_css  = [];

        if ( file_exists( $manifest_path ) ) {
            $manifest = json_decode( file_get_contents( $manifest_path ), true ) ?? [];
            $entry    = $manifest['src/app.ts'] ?? null;
            // Fall back to the first isEntry whose src looks like our app entry.
            if ( ! $entry ) {
                foreach ( $manifest as $src => $info ) {
                    if ( ! empty( $info['isEntry'] ) && false !== strpos( (string) $src, 'app' ) ) {
                        $entry = $info;
                        break;
                    }
                }
            }
            if ( $entry ) {
                $entry_js  = $entry['file'] ?? $entry_js;
                $entry_css = $entry['css'] ?? [];
            }
        }

        // Hand-written plugin stylesheet (the .go3d-* UI). Always present.
        wp_enqueue_style( 'go3d-ui', GO3D_PLUGIN_URL . 'assets/go3d.css', [], $ver );

        // Any CSS Vite split out of the bundle.
        foreach ( $entry_css as $i => $css ) {
            wp_enqueue_style( 'go3d-app-' . $i, $dist . ltrim( $css, '/' ), [], $ver );
        }

        // Pusher real-time client (CDN). The bundle expects a global `Pusher`;
        // if this fails to load the controller falls back to HTTP polling.
        wp_enqueue_script( 'pusher-js', 'https://js.pusher.com/8.2.0/pusher.min.js', [], '8.2.0', true );

        wp_enqueue_script(
            'go3d-app',
            $dist . ltrim( $entry_js, '/' ),
            [ 'pusher-js' ], // ensure Pusher is defined before the bundle runs
            $ver,
            true // load in footer
        );
        // It's an ES module.
        add_filter( 'script_loader_tag', [ __CLASS__, 'module_type' ], 10, 3 );

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

    /** Mark the Vite bundle as an ES module so its imports resolve. */
    public static function module_type( string $tag, string $handle, string $src ): string {
        if ( 'go3d-app' === $handle ) {
            $tag = '<script type="module" src="' . esc_url( $src ) . '" id="go3d-app-js"></script>' . "\n";
        }
        return $tag;
    }
}
