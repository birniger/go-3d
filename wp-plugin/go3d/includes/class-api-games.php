<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class Go3D_API_Games {

    public static function register_routes(): void {
        $ns = Go3D_API::NAMESPACE;

        // Game collection
        register_rest_route( $ns, '/games', [
            [
                'methods'             => 'GET',
                'callback'            => [ __CLASS__, 'list_games' ],
                'permission_callback' => '__return_true',
            ],
            [
                'methods'             => 'POST',
                'callback'            => [ __CLASS__, 'create_game' ],
                'permission_callback' => '__return_true',
            ],
        ] );

        // Open games (lobby)
        register_rest_route( $ns, '/games/open', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'list_open' ],
            'permission_callback' => '__return_true',
        ] );

        // Single game
        register_rest_route( $ns, '/games/(?P<id>\d+)', [
            [
                'methods'             => 'GET',
                'callback'            => [ __CLASS__, 'get_game' ],
                'permission_callback' => '__return_true',
            ],
            [
                'methods'             => 'DELETE',
                'callback'            => [ __CLASS__, 'cancel_game' ],
                'permission_callback' => '__return_true',
            ],
        ] );

        // Join an open game
        register_rest_route( $ns, '/games/(?P<id>\d+)/join', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'join_game' ],
            'permission_callback' => '__return_true',
        ] );

        // Submit a move
        register_rest_route( $ns, '/games/(?P<id>\d+)/move', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'submit_move' ],
            'permission_callback' => '__return_true',
        ] );

        register_rest_route( $ns, '/games/(?P<id>\d+)/undo-request', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'request_undo' ],
            'permission_callback' => '__return_true',
        ] );

        register_rest_route( $ns, '/games/(?P<id>\d+)/undo-respond', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'respond_undo' ],
            'permission_callback' => '__return_true',
        ] );

        register_rest_route( $ns, '/challenges', [
            [
                'methods'             => 'GET',
                'callback'            => [ __CLASS__, 'list_challenges' ],
                'permission_callback' => '__return_true',
            ],
            [
                'methods'             => 'POST',
                'callback'            => [ __CLASS__, 'create_challenge' ],
                'permission_callback' => '__return_true',
            ],
        ] );

        register_rest_route( $ns, '/challenges/(?P<id>\d+)/accept', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'accept_challenge' ],
            'permission_callback' => '__return_true',
        ] );

        register_rest_route( $ns, '/challenges/(?P<id>\d+)/decline', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'decline_challenge' ],
            'permission_callback' => '__return_true',
        ] );
    }

    // ── Handlers ──────────────────────────────────────────────────────────────

    public static function list_games( WP_REST_Request $req ): WP_REST_Response {
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );

        $status = sanitize_text_field( $req->get_param( 'status' ) ?? 'active' );
        if ( ! in_array( $status, ['open', 'active', 'finished'], true ) ) {
            return Go3D_API::error( 'Invalid status filter.', 422 );
        }

        $limit  = min( 50, max( 1, (int)( $req->get_param( 'limit' )  ?? 20 ) ) );
        $offset = max( 0, (int)( $req->get_param( 'offset' ) ?? 0 ) );

        $games = Go3D_Game::list_for_user( $user_id, $status, $limit, $offset );
        return Go3D_API::ok( [ 'games' => $games ] );
    }

    public static function list_open( WP_REST_Request $req ): WP_REST_Response {
        $limit  = min( 50, max( 1, (int)( $req->get_param( 'limit' )  ?? 20 ) ) );
        $offset = max( 0, (int)( $req->get_param( 'offset' ) ?? 0 ) );
        $games  = Go3D_Game::list_open( $limit, $offset );
        return Go3D_API::ok( [ 'games' => $games ] );
    }

    public static function create_game( WP_REST_Request $req ): WP_REST_Response {
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );

        $settings = self::settings_from_request( $req );

        $result = Go3D_Game::create( $user_id, $settings );
        if ( ! $result['ok'] ) return Go3D_API::error( $result['error'], $result['code'] );

        return Go3D_API::ok( [ 'game_id' => $result['game_id'] ], 201 );
    }

    public static function get_game( WP_REST_Request $req ): WP_REST_Response {
        $game_id = (int)$req->get_param( 'id' );
        $state   = Go3D_Game::get_state( $game_id );
        if ( ! $state ) return Go3D_API::error( 'Game not found.', 404 );
        return Go3D_API::ok( $state );
    }

    public static function cancel_game( WP_REST_Request $req ): WP_REST_Response {
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );

        $game_id = (int)$req->get_param( 'id' );
        $result  = Go3D_Game::cancel( $game_id, $user_id );
        if ( ! $result['ok'] ) return Go3D_API::error( $result['error'], $result['code'] );

        return Go3D_API::ok( [ 'message' => 'Game cancelled.', 'game_id' => $game_id ] );
    }

    public static function join_game( WP_REST_Request $req ): WP_REST_Response {
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );

        $game_id = (int)$req->get_param( 'id' );
        $result  = Go3D_Game::join( $game_id, $user_id );
        if ( ! $result['ok'] ) return Go3D_API::error( $result['error'], $result['code'] );

        return Go3D_API::ok( [ 'message' => 'Joined game.', 'game_id' => $game_id ] );
    }

    public static function submit_move( WP_REST_Request $req ): WP_REST_Response {
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );

        $game_id   = (int)$req->get_param( 'id' );
        $move_data = [
            'type'    => sanitize_text_field( $req->get_param( 'type' ) ?? '' ),
            'x'       => $req->get_param( 'x' ) !== null ? (int)$req->get_param( 'x' ) : null,
            'y'       => $req->get_param( 'y' ) !== null ? (int)$req->get_param( 'y' ) : null,
            'z'       => $req->get_param( 'z' ) !== null ? (int)$req->get_param( 'z' ) : null,
            'time_ms' => $req->get_param( 'time_ms' ) !== null ? (int)$req->get_param( 'time_ms' ) : null,
        ];

        if ( ! $move_data['type'] ) return Go3D_API::error( 'Move type is required.', 422 );

        $result = Go3D_Game::submit_move( $game_id, $user_id, $move_data );
        if ( ! $result['ok'] ) return Go3D_API::error( $result['error'], $result['code'] );

        return Go3D_API::ok( [
            'event'   => $result['event'],
            'payload' => $result['payload'],
        ] );
    }

    public static function request_undo( WP_REST_Request $req ): WP_REST_Response {
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );
        $result = Go3D_Game::request_undo( (int)$req->get_param( 'id' ), $user_id );
        if ( ! $result['ok'] ) return Go3D_API::error( $result['error'], $result['code'] );
        return Go3D_API::ok( [ 'message' => 'Undo request sent.' ] );
    }

    public static function respond_undo( WP_REST_Request $req ): WP_REST_Response {
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );
        $accept = (bool)$req->get_param( 'accept' );
        $result = Go3D_Game::respond_undo( (int)$req->get_param( 'id' ), $user_id, $accept );
        if ( ! $result['ok'] ) return Go3D_API::error( $result['error'], $result['code'] );
        return Go3D_API::ok( [
            'message' => $accept ? 'Undo accepted.' : 'Undo declined.',
            'state'   => $result['state'] ?? null,
        ] );
    }

    public static function list_challenges( WP_REST_Request $req ): WP_REST_Response {
        global $wpdb;
        unset( $req );
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );

        $c = $wpdb->prefix . 'go3d_challenges';
        $u = $wpdb->prefix . 'go3d_users';
        $select = "ch.id, ch.challenger_id, ch.challenged_id, ch.board_size, ch.mode, ch.scoring_mode, ch.komi, ch.time_control, ch.time_settings, ch.status, ch.game_id, ch.created_at, ch.expires_at";

        $incoming = $wpdb->get_results( $wpdb->prepare(
            "SELECT $select, u.username AS challenger_name, u.elo AS challenger_elo
             FROM $c ch JOIN $u u ON u.id = ch.challenger_id
             WHERE ch.challenged_id = %d AND ch.status = 'pending' AND ch.expires_at > UTC_TIMESTAMP()
             ORDER BY ch.created_at DESC LIMIT 50",
            $user_id
        ), ARRAY_A ) ?: [];

        $outgoing = $wpdb->get_results( $wpdb->prepare(
            "SELECT $select, u.username AS challenged_name, u.elo AS challenged_elo
             FROM $c ch JOIN $u u ON u.id = ch.challenged_id
             WHERE ch.challenger_id = %d AND ch.status = 'pending' AND ch.expires_at > UTC_TIMESTAMP()
             ORDER BY ch.created_at DESC LIMIT 50",
            $user_id
        ), ARRAY_A ) ?: [];

        return Go3D_API::ok( [
            'incoming' => array_map( [ __CLASS__, 'challenge_row' ], $incoming ),
            'outgoing' => array_map( [ __CLASS__, 'challenge_row' ], $outgoing ),
        ] );
    }

    public static function create_challenge( WP_REST_Request $req ): WP_REST_Response {
        global $wpdb;
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );
        $target_id = (int)$req->get_param( 'challenged_id' );
        if ( $target_id <= 0 || $target_id === $user_id ) return Go3D_API::error( 'Pick another verified user.', 422 );
        $target = Go3D_Auth::get_user( $target_id );
        if ( ! $target || ! (int)$target['email_verified'] ) return Go3D_API::error( 'User not found.', 404 );
        $settings = self::settings_from_request( $req );

        $existing = (int)$wpdb->get_var( $wpdb->prepare(
            "SELECT id FROM {$wpdb->prefix}go3d_challenges
             WHERE ((challenger_id = %d AND challenged_id = %d) OR (challenger_id = %d AND challenged_id = %d))
               AND status = 'pending' AND expires_at > UTC_TIMESTAMP()
             LIMIT 1",
            $user_id, $target_id, $target_id, $user_id
        ) );
        if ( $existing ) return Go3D_API::ok( [ 'message' => 'Challenge already pending.', 'challenge_id' => $existing ] );

        $wpdb->insert( $wpdb->prefix . 'go3d_challenges', [
            'challenger_id' => $user_id,
            'challenged_id' => $target_id,
            'board_size'    => $settings['board_size'],
            'mode'          => $settings['mode'],
            'scoring_mode'  => $settings['scoring_mode'],
            'komi'          => $settings['komi'],
            'time_control'  => $settings['time_control'],
            'time_settings' => isset( $settings['time_settings'] ) ? wp_json_encode( $settings['time_settings'] ) : null,
            'is_open'       => 0,
            'status'        => 'pending',
            'created_at'    => current_time( 'mysql', true ),
            'expires_at'    => gmdate( 'Y-m-d H:i:s', time() + 7 * DAY_IN_SECONDS ),
        ] );

        return Go3D_API::ok( [ 'message' => 'Challenge sent.', 'challenge_id' => (int)$wpdb->insert_id ], 201 );
    }

    public static function accept_challenge( WP_REST_Request $req ): WP_REST_Response {
        global $wpdb;
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );
        $id = (int)$req->get_param( 'id' );
        $t = $wpdb->prefix . 'go3d_challenges';
        $ch = $wpdb->get_row( $wpdb->prepare(
            "SELECT * FROM $t WHERE id = %d AND challenged_id = %d AND status = 'pending' AND expires_at > UTC_TIMESTAMP()",
            $id, $user_id
        ), ARRAY_A );
        if ( ! $ch ) return Go3D_API::error( 'Challenge not found.', 404 );

        $settings = [
            'board_size'    => (int)$ch['board_size'],
            'mode'          => $ch['mode'],
            'scoring_mode'  => $ch['scoring_mode'],
            'komi'          => (float)$ch['komi'],
            'time_control'  => $ch['time_control'],
            'time_settings' => $ch['time_settings'] ? json_decode( $ch['time_settings'], true ) : null,
        ];
        $created = Go3D_Game::create( (int)$ch['challenger_id'], $settings );
        if ( ! $created['ok'] ) return Go3D_API::error( $created['error'], $created['code'] );
        $joined = Go3D_Game::join( (int)$created['game_id'], $user_id );
        if ( ! $joined['ok'] ) return Go3D_API::error( $joined['error'], $joined['code'] );

        $wpdb->update( $t, [
            'status'  => 'accepted',
            'game_id' => (int)$created['game_id'],
        ], [ 'id' => $id ] );

        return Go3D_API::ok( [ 'message' => 'Challenge accepted.', 'game_id' => (int)$created['game_id'] ] );
    }

    public static function decline_challenge( WP_REST_Request $req ): WP_REST_Response {
        global $wpdb;
        $user_id = Go3D_JWT::current_user_id();
        if ( ! $user_id ) return Go3D_API::error( 'Unauthorized.', 401 );
        $id = (int)$req->get_param( 'id' );
        $updated = $wpdb->update( $wpdb->prefix . 'go3d_challenges', [
            'status' => 'declined',
        ], [
            'id'            => $id,
            'challenged_id' => $user_id,
            'status'        => 'pending',
        ] );
        if ( $updated !== 1 ) return Go3D_API::error( 'Challenge not found.', 404 );
        return Go3D_API::ok( [ 'message' => 'Challenge declined.' ] );
    }

    private static function settings_from_request( WP_REST_Request $req ): array {
        return [
            'board_size'    => $req->get_param( 'board_size' )    ?? 9,
            'mode'          => $req->get_param( 'mode' )          ?? 'cube',
            'scoring_mode'  => $req->get_param( 'scoring_mode' )  ?? 'chinese',
            'komi'          => $req->get_param( 'komi' )          ?? 6.5,
            'time_control'  => $req->get_param( 'time_control' )  ?? 'none',
            'time_settings' => $req->get_param( 'time_settings' ) ?? null,
        ];
    }

    private static function challenge_row( array $r ): array {
        return [
            'id'              => (int)$r['id'],
            'challenger_id'   => (int)$r['challenger_id'],
            'challenged_id'   => $r['challenged_id'] ? (int)$r['challenged_id'] : null,
            'challenger_name' => $r['challenger_name'] ?? null,
            'challenger_elo'  => isset( $r['challenger_elo'] ) ? (int)$r['challenger_elo'] : null,
            'challenged_name' => $r['challenged_name'] ?? null,
            'challenged_elo'  => isset( $r['challenged_elo'] ) ? (int)$r['challenged_elo'] : null,
            'board_size'      => (int)$r['board_size'],
            'mode'            => $r['mode'],
            'scoring_mode'    => $r['scoring_mode'],
            'komi'            => (float)$r['komi'],
            'time_control'    => $r['time_control'],
            'time_settings'   => $r['time_settings'] ? json_decode( $r['time_settings'], true ) : null,
            'status'          => $r['status'],
            'game_id'         => $r['game_id'] ? (int)$r['game_id'] : null,
            'created_at'      => $r['created_at'],
            'expires_at'      => $r['expires_at'],
        ];
    }
}
