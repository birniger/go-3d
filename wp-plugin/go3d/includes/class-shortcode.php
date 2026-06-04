<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * [go3d] shortcode.
 *
 * Default behaviour renders a single "Play" launch button. Clicking it opens
 * the full game app in a new browser tab (a self-contained full-screen page
 * served at /?go3d_app=1) which talks to the WordPress REST backend for auth,
 * lobby, and real-time play.
 *
 * Pass [go3d mode="inline"] to embed the full app directly in the page instead
 * (the legacy behaviour).
 *
 * Attributes:
 *   mode   "button" (default) | "inline"
 *   label  button text (default "Play Go³D")
 */
class Go3D_Shortcode {

    public static function register(): void {
        add_shortcode( 'go3d', [ __CLASS__, 'render' ] );
    }

    /** Full-screen app URL (opened in a new tab by the launch button). */
    public static function app_url(): string {
        return home_url( '/?go3d_app=1' );
    }

    public static function render( $atts ): string {
        $atts = shortcode_atts( [
            'mode'  => 'button',
            'label' => 'Play Go³D',
        ], $atts, 'go3d' );

        // Legacy: embed the whole app inline on the host page.
        if ( 'inline' === $atts['mode'] ) {
            self::enqueue_assets();
            ob_start();
            include GO3D_PLUGIN_DIR . 'templates/embed.php';
            return ob_get_clean();
        }

        // Default: a compact launch card with a button that opens the app tab.
        wp_enqueue_style( 'go3d-ui', GO3D_PLUGIN_URL . 'assets/go3d.css', [], GO3D_VERSION );

        $url   = esc_url( self::app_url() );
        $label = esc_html( $atts['label'] );
        ob_start();
        ?>
        <div class="go3d-launch" id="go3d-root">
          <div class="go3d-launch-card">
            <span class="go3d-logo">Go³D</span>
            <p class="go3d-launch-tag">3D Go · cube · stack · sphere — play online or two players on one screen</p>
            <a class="go3d-btn-primary go3d-launch-btn" href="<?php echo $url; ?>"
               target="_blank" rel="noopener"><?php echo $label; ?></a>
            <p class="go3d-launch-hint">Opens in a new tab.</p>
          </div>
        </div>
        <?php
        return ob_get_clean();
    }

    /**
     * Render the standalone full-screen app document (served at /?go3d_app=1).
     * Prints a complete HTML page — independent of the active theme — then exits.
     */
    public static function render_app_page(): void {
        [ $entry_js, $entry_css ] = self::resolve_assets();
        $dist = GO3D_PLUGIN_URL . 'assets/dist/';
        $ver  = GO3D_VERSION;

        $pusher_key     = get_option( 'go3d_pusher_key',     '' );
        $pusher_cluster = get_option( 'go3d_pusher_cluster', 'eu' );
        $config = wp_json_encode( [
            'apiBase'       => rest_url( Go3D_API::NAMESPACE ),
            'pusherKey'     => $pusher_key,
            'pusherCluster' => $pusher_cluster,
            'authEndpoint'  => rest_url( Go3D_API::NAMESPACE . '/pusher/auth' ),
            'nonce'         => wp_create_nonce( 'wp_rest' ),
        ] );

        nocache_headers();
        header( 'Content-Type: text/html; charset=utf-8' );

        ?><!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
  <meta charset="<?php bloginfo( 'charset' ); ?>">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Go³D — 3D Go</title>
  <link rel="stylesheet" href="<?php echo esc_url( GO3D_PLUGIN_URL . 'assets/go3d.css' ); ?>?ver=<?php echo esc_attr( $ver ); ?>">
  <?php foreach ( $entry_css as $css ) : ?>
  <link rel="stylesheet" href="<?php echo esc_url( $dist . ltrim( $css, '/' ) ); ?>?ver=<?php echo esc_attr( $ver ); ?>">
  <?php endforeach; ?>
  <style>
    html, body { margin: 0; height: 100%; background: #05060a;
      color: #cdd6e4; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
    #go3d-root { min-height: 100vh; }
  </style>
</head>
<body>
<?php include GO3D_PLUGIN_DIR . 'templates/embed.php'; ?>
<script>window.Go3DConfig = <?php echo $config; // phpcs:ignore WordPress.Security.EscapeOutput ?>;</script>
<script src="https://js.pusher.com/8.2.0/pusher.min.js"></script>
<script type="module" src="<?php echo esc_url( $dist . ltrim( $entry_js, '/' ) ); ?>?ver=<?php echo esc_attr( $ver ); ?>"></script>
</body>
</html>
        <?php
        exit;
    }

    /**
     * Resolve the hashed app bundle filename and its split CSS from the Vite
     * manifest. Returns [ entry_js, entry_css[] ].
     *
     * @return array{0:string,1:array<int,string>}
     */
    private static function resolve_assets(): array {
        $manifest_path = GO3D_PLUGIN_DIR . 'assets/dist/.vite/manifest.json';
        $entry_js  = 'assets/app.js';
        $entry_css = [];

        if ( file_exists( $manifest_path ) ) {
            $manifest = json_decode( file_get_contents( $manifest_path ), true ) ?? [];
            $entry    = $manifest['src/app.ts'] ?? null;
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
        return [ $entry_js, $entry_css ];
    }

    private static function enqueue_assets(): void {
        $dist = GO3D_PLUGIN_URL . 'assets/dist/';
        $ver  = GO3D_VERSION;

        [ $entry_js, $entry_css ] = self::resolve_assets();

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
