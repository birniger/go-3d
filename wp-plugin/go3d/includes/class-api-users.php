<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class Go3D_API_Users {

    public static function register_routes(): void {
        $ns = Go3D_API::NAMESPACE;

        // Leaderboard
        register_rest_route( $ns, '/users/leaderboard', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'leaderboard' ],
            'permission_callback' => '__return_true',
        ] );

        // Search users
        register_rest_route( $ns, '/users/search', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'search' ],
            'permission_callback' => '__return_true',
        ] );

        // Public profile
        register_rest_route( $ns, '/users/(?P<id>\d+)', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_profile' ],
            'permission_callback' => '__return_true',
        ] );

        // Update own profile
        register_rest_route( $ns, '/users/me', [
            'methods'             => 'PATCH',
            'callback'            => [ __CLASS__, 'update_profile' ],
            'permission_callback' => '__return_true',
        ] );

        // Update notification preferences
        register_rest_route( $ns, '/users/me/notifications', [
            'methods'             => 'PATCH',
            'callback'            => [ __CLASS__, 'update_notifications' ],
            'permission_callback' => '__return_true',
        ] );
    }

    // ── Handlers ──────────────────────────────────────────────────────────────

    public static function leaderboard( WP_REST_Request $req ): WP_REST_Response {
        $limit  = min( 100, max( 1, (int)( $req->get_param( 'limit' )  ?? 50 ) ) );
        $offset = max( 0, (int)( $req->get_param( 'offset' ) ?? 0 ) );
        $rows   = Go3D_Elo::leaderboard( $limit, $offset );
        return Go3D_API::ok( [ 'players' => $rows ] );
    }

    public static function search( WP_REST_Request $req ): WP_REST_Response {
        global $wpdb;
        $q = sanitize_text_field( $req->get_param( 'q' ) ?? '' );
        if ( strlen( $q ) < 2 ) return Go3D_API::error( 'Query must be at least 2 characters.', 422 );

        $like = '%' . $wpdb->esc_like( $q ) . '%';
        $rows = $wpdb->get_results( $wpdb->prepare(
            "SELECT id, username, avatar_url, elo, games_played
             FROM {$wpdb->prefix}go3d_users
             WHERE email_verified = 1 AND username LIKE %s
             ORDER BY elo DESC LIMIT 20",
            $like
        ), ARRAY_A ) ?: [];

        return Go3D_API::ok( [ 'users' => $rows ] );
    }

    public static function get_profile( WP_REST_Request $req ): WP_REST_Response {
        $user_id = (int)$req->get_param( 'id' );
        $user    = Go3D_Auth::get_user( $user_id );
        if ( ! $user || ! (int)$user['email_verified'] )
            return Go3D_API::error( 'User not found.', 404 );

        $public = Go3D_Auth::public_user( $user );

        // Recent finished games
        $games = Go3D_Game::list_for_user( $user_id, 'finished', 10, 0 );

        return Go3D_API::ok( [
            'user'         => $public,
            'recent_games' => $games,
        ] );
    }

    public static function update_profile( WP_REST_Request $req ): WP_REST_Response {
        global $wpdb;
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );

        $updates = [];

        $bio = $req->get_param( 'bio' );
        if ( $bio !== null ) {
            $sanitized_bio = sanitize_textarea_field( $bio );
            if ( strlen( $sanitized_bio ) > 500 )
                return Go3D_API::error( 'Bio must be 500 characters or fewer.', 422 );
            $updates['bio'] = $sanitized_bio;
        }

        $avatar_url = $req->get_param( 'avatar_url' );
        if ( $avatar_url !== null ) {
            $url = esc_url_raw( $avatar_url );
            if ( ! filter_var( $url, FILTER_VALIDATE_URL ) )
                return Go3D_API::error( 'Invalid avatar URL.', 422 );
            $updates['avatar_url'] = $url;
        }

        if ( empty( $updates ) )
            return Go3D_API::error( 'Nothing to update.', 422 );

        $wpdb->update( $wpdb->prefix . 'go3d_users', $updates, [ 'id' => $user_id ] );

        $user = Go3D_Auth::get_user( $user_id );
        return Go3D_API::ok( Go3D_Auth::public_user( $user ) );
    }

    public static function update_notifications( WP_REST_Request $req ): WP_REST_Response {
        global $wpdb;
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );

        $updates = [];

        $idle = $req->get_param( 'notify_idle_hours' );
        if ( $idle !== null ) {
            $idle = (int)$idle;
            if ( $idle < 0 || $idle > 168 )
                return Go3D_API::error( 'notify_idle_hours must be 0–168.', 422 );
            $updates['notify_idle_hours'] = $idle;
        }

        $timeout = $req->get_param( 'notify_timeout_mins' );
        if ( $timeout !== null ) {
            $timeout = (int)$timeout;
            if ( $timeout < 0 || $timeout > 1440 )
                return Go3D_API::error( 'notify_timeout_mins must be 0–1440.', 422 );
            $updates['notify_timeout_mins'] = $timeout;
        }

        if ( empty( $updates ) )
            return Go3D_API::error( 'Nothing to update.', 422 );

        $wpdb->update( $wpdb->prefix . 'go3d_users', $updates, [ 'id' => $user_id ] );
        return Go3D_API::ok( [ 'message' => 'Notification preferences updated.' ] );
    }
}
