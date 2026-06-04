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

        register_rest_route( $ns, '/users/friends', [
            [
                'methods'             => 'GET',
                'callback'            => [ __CLASS__, 'list_friends' ],
                'permission_callback' => '__return_true',
            ],
            [
                'methods'             => 'POST',
                'callback'            => [ __CLASS__, 'request_friend' ],
                'permission_callback' => '__return_true',
            ],
        ] );

        register_rest_route( $ns, '/users/friends/(?P<id>\d+)/accept', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'accept_friend' ],
            'permission_callback' => '__return_true',
        ] );

        register_rest_route( $ns, '/users/friends/(?P<id>\d+)', [
            'methods'             => 'DELETE',
            'callback'            => [ __CLASS__, 'remove_friend' ],
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

    public static function list_friends( WP_REST_Request $req ): WP_REST_Response {
        global $wpdb;
        unset( $req );
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );

        $f = $wpdb->prefix . 'go3d_friends';
        $u = $wpdb->prefix . 'go3d_users';

        $friends = $wpdb->get_results( $wpdb->prepare(
            "SELECT fr.id AS friendship_id, u.id, u.username, u.avatar_url, u.elo, u.games_played
             FROM $f fr
             JOIN $u u ON u.id = IF(fr.requester_id = %d, fr.addressee_id, fr.requester_id)
             WHERE (fr.requester_id = %d OR fr.addressee_id = %d) AND fr.status = 'accepted'
             ORDER BY u.username ASC LIMIT 100",
            $user_id, $user_id, $user_id
        ), ARRAY_A ) ?: [];

        $incoming = $wpdb->get_results( $wpdb->prepare(
            "SELECT fr.id AS friendship_id, u.id, u.username, u.avatar_url, u.elo, u.games_played
             FROM $f fr
             JOIN $u u ON u.id = fr.requester_id
             WHERE fr.addressee_id = %d AND fr.status = 'pending'
             ORDER BY fr.created_at DESC LIMIT 50",
            $user_id
        ), ARRAY_A ) ?: [];

        $outgoing = $wpdb->get_results( $wpdb->prepare(
            "SELECT fr.id AS friendship_id, u.id, u.username, u.avatar_url, u.elo, u.games_played
             FROM $f fr
             JOIN $u u ON u.id = fr.addressee_id
             WHERE fr.requester_id = %d AND fr.status = 'pending'
             ORDER BY fr.created_at DESC LIMIT 50",
            $user_id
        ), ARRAY_A ) ?: [];

        return Go3D_API::ok( [
            'friends'  => array_map( [ __CLASS__, 'friend_row' ], $friends ),
            'incoming' => array_map( [ __CLASS__, 'friend_row' ], $incoming ),
            'outgoing' => array_map( [ __CLASS__, 'friend_row' ], $outgoing ),
        ] );
    }

    public static function request_friend( WP_REST_Request $req ): WP_REST_Response {
        global $wpdb;
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );
        $target_id = (int)$req->get_param( 'user_id' );
        if ( $target_id <= 0 || $target_id === $user_id ) return Go3D_API::error( 'Pick another verified user.', 422 );
        $target = Go3D_Auth::get_user( $target_id );
        if ( ! $target || ! (int)$target['email_verified'] ) return Go3D_API::error( 'User not found.', 404 );

        $t = $wpdb->prefix . 'go3d_friends';
        $existing = $wpdb->get_row( $wpdb->prepare(
            "SELECT * FROM $t WHERE (requester_id = %d AND addressee_id = %d) OR (requester_id = %d AND addressee_id = %d) LIMIT 1",
            $user_id, $target_id, $target_id, $user_id
        ), ARRAY_A );

        if ( $existing ) {
            if ( $existing['status'] === 'accepted' ) return Go3D_API::ok( [ 'message' => 'Already friends.' ] );
            if ( (int)$existing['requester_id'] === $target_id ) {
                $wpdb->update( $t, [
                    'status'       => 'accepted',
                    'responded_at' => current_time( 'mysql', true ),
                ], [ 'id' => (int)$existing['id'] ] );
                return Go3D_API::ok( [ 'message' => 'Friend request accepted.' ] );
            }
            return Go3D_API::ok( [ 'message' => 'Friend request already sent.' ] );
        }

        $wpdb->insert( $t, [
            'requester_id' => $user_id,
            'addressee_id' => $target_id,
            'status'       => 'pending',
            'created_at'   => current_time( 'mysql', true ),
        ] );

        return Go3D_API::ok( [ 'message' => 'Friend request sent.' ], 201 );
    }

    public static function accept_friend( WP_REST_Request $req ): WP_REST_Response {
        global $wpdb;
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );
        $id = (int)$req->get_param( 'id' );
        $updated = $wpdb->update( $wpdb->prefix . 'go3d_friends', [
            'status'       => 'accepted',
            'responded_at' => current_time( 'mysql', true ),
        ], [
            'id'           => $id,
            'addressee_id' => $user_id,
            'status'       => 'pending',
        ] );
        if ( $updated !== 1 ) return Go3D_API::error( 'Friend request not found.', 404 );
        return Go3D_API::ok( [ 'message' => 'Friend request accepted.' ] );
    }

    public static function remove_friend( WP_REST_Request $req ): WP_REST_Response {
        global $wpdb;
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );
        $id = (int)$req->get_param( 'id' );
        $deleted = $wpdb->query( $wpdb->prepare(
            "DELETE FROM {$wpdb->prefix}go3d_friends WHERE id = %d AND (requester_id = %d OR addressee_id = %d)",
            $id, $user_id, $user_id
        ) );
        if ( $deleted !== 1 ) return Go3D_API::error( 'Friend relationship not found.', 404 );
        return Go3D_API::ok( [ 'message' => 'Friend removed.' ] );
    }

    private static function friend_row( array $r ): array {
        return [
            'friendship_id' => (int)$r['friendship_id'],
            'id'            => (int)$r['id'],
            'username'      => $r['username'],
            'avatar_url'    => $r['avatar_url'],
            'elo'           => (int)$r['elo'],
            'games_played'  => (int)$r['games_played'],
        ];
    }
}
