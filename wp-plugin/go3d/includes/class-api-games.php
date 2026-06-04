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
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_game' ],
            'permission_callback' => '__return_true',
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

        $settings = [
            'board_size'   => $req->get_param( 'board_size' )   ?? 9,
            'mode'         => $req->get_param( 'mode' )          ?? 'cube',
            'scoring_mode' => $req->get_param( 'scoring_mode' ) ?? 'chinese',
            'komi'         => $req->get_param( 'komi' )         ?? 6.5,
            'time_control' => $req->get_param( 'time_control' ) ?? 'none',
            'time_settings' => $req->get_param( 'time_settings' ) ?? null,
        ];

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
}
