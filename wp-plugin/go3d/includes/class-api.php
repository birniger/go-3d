<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Registers all REST API routes under the go3d/v1 namespace.
 */
class Go3D_API {

    const NAMESPACE = 'go3d/v1';

    public static function register_routes(): void {
        Go3D_API_Auth::register_routes();
        Go3D_API_Games::register_routes();
        Go3D_API_Users::register_routes();

        // Pusher auth endpoint
        register_rest_route( self::NAMESPACE, '/pusher/auth', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'pusher_auth' ],
            'permission_callback' => '__return_true',
        ] );
    }

    // ── Pusher channel auth ───────────────────────────────────────────────────

    public static function pusher_auth( WP_REST_Request $req ): WP_REST_Response {
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return self::error( 'Unauthorized.', 401 );

        $socket_id = sanitize_text_field( $req->get_param( 'socket_id' ) ?? '' );
        $channel   = sanitize_text_field( $req->get_param( 'channel_name' ) ?? '' );

        if ( ! $socket_id || ! $channel ) return self::error( 'Missing socket_id or channel_name.', 422 );

        if ( str_starts_with( $channel, 'presence-' ) ) {
            $result = Go3D_Pusher::auth_presence( $socket_id, $channel, $user_id );
        } elseif ( str_starts_with( $channel, 'private-' ) ) {
            $result = Go3D_Pusher::auth_channel( $socket_id, $channel, $user_id );
        } else {
            return self::error( 'Only private/presence channels are authenticated.', 422 );
        }

        if ( ! $result['ok'] ) return self::error( $result['error'], $result['code'] );

        $data = [ 'auth' => $result['auth'] ];
        if ( isset( $result['channel_data'] ) ) $data['channel_data'] = $result['channel_data'];

        return new WP_REST_Response( $data, 200 );
    }

    // ── Shared helpers ────────────────────────────────────────────────────────

    /** Require a valid JWT. Returns user_id or WP_REST_Response error. */
    public static function require_auth( WP_REST_Request $req ): int|WP_REST_Response {
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return self::error( 'Unauthorized.', 401 );
        return $user_id;
    }

    public static function error( string $message, int $code = 400 ): WP_REST_Response {
        return new WP_REST_Response( [ 'error' => $message ], $code );
    }

    public static function ok( array $data = [], int $code = 200 ): WP_REST_Response {
        return new WP_REST_Response( $data, $code );
    }
}
