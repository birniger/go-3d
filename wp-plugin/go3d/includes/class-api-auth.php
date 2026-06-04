<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class Go3D_API_Auth {

    public static function register_routes(): void {
        $ns = Go3D_API::NAMESPACE;

        register_rest_route( $ns, '/auth/register', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'register' ],
            'permission_callback' => '__return_true',
        ] );

        register_rest_route( $ns, '/auth/login', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'login' ],
            'permission_callback' => '__return_true',
        ] );

        register_rest_route( $ns, '/auth/verify-email', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'verify_email' ],
            'permission_callback' => '__return_true',
        ] );

        register_rest_route( $ns, '/auth/verify-code', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'verify_code' ],
            'permission_callback' => '__return_true',
        ] );

        register_rest_route( $ns, '/auth/request-reset', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'request_reset' ],
            'permission_callback' => '__return_true',
        ] );

        register_rest_route( $ns, '/auth/reset-password', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'reset_password' ],
            'permission_callback' => '__return_true',
        ] );

        register_rest_route( $ns, '/auth/me', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'me' ],
            'permission_callback' => '__return_true',
        ] );
    }

    // ── Handlers ──────────────────────────────────────────────────────────────

    public static function register( WP_REST_Request $req ): WP_REST_Response {
        $username = sanitize_text_field( $req->get_param( 'username' ) ?? '' );
        $email    = sanitize_email(      $req->get_param( 'email' )    ?? '' );
        $password =                      $req->get_param( 'password' ) ?? '';

        $result = Go3D_Auth::register( $username, $email, $password );
        if ( ! $result['ok'] ) return Go3D_API::error( $result['error'], $result['code'] );

        return Go3D_API::ok( [
            'message' => 'Account created. Please check your email to verify your address.',
            'user_id' => $result['user_id'],
        ], 201 );
    }

    public static function login( WP_REST_Request $req ): WP_REST_Response {
        $email    = sanitize_email( $req->get_param( 'email' )    ?? '' );
        $password =                 $req->get_param( 'password' ) ?? '';

        $result = Go3D_Auth::login( $email, $password );
        if ( ! $result['ok'] ) return Go3D_API::error( $result['error'], $result['code'] );

        return Go3D_API::ok( [
            'token' => $result['token'],
            'user'  => $result['user'],
        ] );
    }

    public static function verify_email( WP_REST_Request $req ): WP_REST_Response {
        $token = sanitize_text_field( $req->get_param( 'token' ) ?? '' );
        if ( ! $token ) return Go3D_API::error( 'Missing token.', 422 );

        $ok = Go3D_Auth::verify_email( $token );
        if ( ! $ok ) return Go3D_API::error( 'Invalid or expired verification token.', 400 );

        // Redirect to the shortcode page so the user lands on the game
        $redirect = home_url( '/?go3d_verified=1' );
        wp_redirect( $redirect );
        exit;
    }

    public static function verify_code( WP_REST_Request $req ): WP_REST_Response {
        $email = sanitize_email( $req->get_param( 'email' ) ?? '' );
        $code  =                 $req->get_param( 'code' )  ?? '';

        if ( ! $email || ! $code ) return Go3D_API::error( 'Missing email or code.', 422 );

        $result = Go3D_Auth::verify_email_code( $email, (string) $code );
        if ( ! $result['ok'] ) return Go3D_API::error( $result['error'], $result['code'] );

        return Go3D_API::ok( [
            'token' => $result['token'],
            'user'  => $result['user'],
        ] );
    }

    public static function request_reset( WP_REST_Request $req ): WP_REST_Response {
        $email = sanitize_email( $req->get_param( 'email' ) ?? '' );
        Go3D_Auth::request_reset( $email ); // always silently succeeds
        return Go3D_API::ok( [ 'message' => 'If that email exists, a reset link has been sent.' ] );
    }

    public static function reset_password( WP_REST_Request $req ): WP_REST_Response {
        $token    = sanitize_text_field( $req->get_param( 'token' )        ?? '' );
        $password =                      $req->get_param( 'new_password' ) ?? '';

        if ( ! $token || ! $password ) return Go3D_API::error( 'Missing token or new_password.', 422 );

        $ok = Go3D_Auth::reset_password( $token, $password );
        if ( ! $ok ) return Go3D_API::error( 'Invalid or expired reset token, or password too short.', 400 );

        return Go3D_API::ok( [ 'message' => 'Password updated. You can now log in.' ] );
    }

    public static function me( WP_REST_Request $req ): WP_REST_Response {
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );

        $user = Go3D_Auth::get_user( $user_id );
        if ( ! $user ) return Go3D_API::error( 'User not found.', 404 );

        return Go3D_API::ok( Go3D_Auth::public_user( $user ) );
    }
}
