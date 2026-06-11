<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Game CRUD, move submission, state management.
 */
class Go3D_Game {

    /** Geodesic subdivision frequency bounds for sphere mode (board_size column). */
    const SPHERE_FREQ_MIN = 2;
    const SPHERE_FREQ_MAX = 8;

    /** Edge-length bounds for cube/stack mode (board_size column). Presets are
     *  5/9/13/19 (the classic Go sizes); custom may be any value in this range. */
    const CUBE_SIZE_MIN = 2;
    const CUBE_SIZE_MAX = 19;

    // ── Create / join ─────────────────────────────────────────────────────────

    /**
     * Create a new game (or accept an open challenge).
     *
     * @return array{ok:true,game_id:int}|array{ok:false,error:string,code:int}
     */
    public static function create( int $player1_id, array $settings ): array {
        global $wpdb;
        $t = $wpdb->prefix . 'go3d_games';

        $mode         = in_array( $settings['mode'] ?? '', ['cube','stack','sphere'], true ) ? $settings['mode'] : 'cube';
        if ( $mode === 'sphere' ) {
            // Sphere games store the geodesic subdivision FREQUENCY in board_size.
            // Presets are 2/3/4 (42/92/162 points); custom is clamped to 2–8.
            $board_size = max( self::SPHERE_FREQ_MIN, min( self::SPHERE_FREQ_MAX, (int)( $settings['board_size'] ?? 3 ) ) );
        } else {
            // Cube/stack: any edge length in [CUBE_SIZE_MIN, CUBE_SIZE_MAX].
            // Presets (5/9/13/19) and the Custom n³ input both land here.
            $board_size = max( self::CUBE_SIZE_MIN, min( self::CUBE_SIZE_MAX, (int)( $settings['board_size'] ?? 9 ) ) );
        }
        $scoring_mode = in_array( $settings['scoring_mode'] ?? '', ['chinese','japanese'],      true ) ? $settings['scoring_mode']      : 'chinese';
        $komi         = (float)( $settings['komi']         ?? 6.5 );
        $time_control = in_array( $settings['time_control'] ?? '', ['none','absolute','byoyomi','fischer'], true ) ? $settings['time_control'] : 'none';
        $time_settings = isset( $settings['time_settings'] ) ? wp_json_encode( $settings['time_settings'] ) : null;

        // Derive initial clocks.
        //  – absolute/fischer: the clock is just main time (fischer adds an
        //    increment per move, applied in submit_move()).
        //  – byoyomi: main time plus a number of reserve periods that reset on
        //    every move completed within the period (real byōyomi). The period
        //    count is tracked in p1_periods/p2_periods; once main time runs out
        //    p1_in_byoyomi/p2_in_byoyomi flip and the per-move arithmetic lives
        //    in Go3D_Clock::byoyomi_move().
        $p1_time_ms = null;
        $p2_time_ms = null;
        $p1_periods = null;
        $p2_periods = null;
        if ( $time_control !== 'none' && isset( $settings['time_settings']['main_time_s'] ) ) {
            $main = (int)$settings['time_settings']['main_time_s'] * 1000;
            $p1_time_ms = $main;
            $p2_time_ms = $main;
            if ( $time_control === 'byoyomi' ) {
                $periods    = max( 0, (int)( $settings['time_settings']['byoyomi_periods'] ?? 0 ) );
                $p1_periods = $periods;
                $p2_periods = $periods;
            }
        }

        if ( $mode === 'sphere' ) {
            $empty_logic = new Go3D_Graph_Logic( Go3D_Geodesic::adjacency( $board_size ) );
        } else {
            $empty_logic = new Go3D_Game_Logic( $board_size );
        }
        $hash = $empty_logic->hash();

        $wpdb->insert( $t, [
            'player1_id'       => $player1_id,
            'board_size'       => $board_size,
            'mode'             => $mode,
            'active_layer'     => 0,
            'scoring_mode'     => $scoring_mode,
            'komi'             => $komi,
            'time_control'     => $time_control,
            'time_settings'    => $time_settings,
            'p1_time_ms'       => $p1_time_ms,
            'p2_time_ms'       => $p2_time_ms,
            'p1_periods'       => $p1_periods,
            'p2_periods'       => $p2_periods,
            'p1_in_byoyomi'    => 0,
            'p2_in_byoyomi'    => 0,
            'current_player'   => 1,
            'consecutive_passes' => 0,
            'board_hash'       => $hash,
            'history_hashes'   => wp_json_encode( [$hash] ),
            'status'           => 'open',
            'created_at'       => current_time( 'mysql', true ),
        ] );

        $game_id = (int) $wpdb->insert_id;
        if ( ! $game_id ) {
            return [ 'ok' => false, 'error' => 'Failed to create game.', 'code' => 500 ];
        }
        return [ 'ok' => true, 'game_id' => $game_id ];
    }

    /**
     * Player 2 joins an open game.
     *
     * @return array{ok:true}|array{ok:false,error:string,code:int}
     */
    public static function join( int $game_id, int $player2_id ): array {
        global $wpdb;
        $t    = $wpdb->prefix . 'go3d_games';
        $game = self::get_row( $game_id );

        if ( ! $game )
            return [ 'ok' => false, 'error' => 'Game not found.', 'code' => 404 ];
        if ( $game['status'] !== 'open' )
            return [ 'ok' => false, 'error' => 'Game is not open for joining.', 'code' => 409 ];
        if ( (int)$game['player1_id'] === $player2_id )
            return [ 'ok' => false, 'error' => 'You cannot play against yourself.', 'code' => 422 ];
        if ( $game['player2_id'] !== null )
            return [ 'ok' => false, 'error' => 'Game already has two players.', 'code' => 409 ];

        $joined = $wpdb->update( $t, [
            'player2_id' => $player2_id,
            'status'     => 'active',
        ], [
            'id'         => $game_id,
            'status'     => 'open',
            'player2_id' => null,
        ] );

        if ( $joined !== 1 ) {
            return [ 'ok' => false, 'error' => 'Game is no longer open for joining.', 'code' => 409 ];
        }

        $labels = self::player_labels( (int)$game['player1_id'], $player2_id );
        Go3D_Pusher::trigger( "private-game-$game_id", 'player-joined', [
            'player2_id'   => $player2_id,
            'player2_name' => $labels['p2_name'],
            'player2_elo'  => $labels['p2_elo'],
        ] );

        return [ 'ok' => true ];
    }

    /**
     * Cancel an open game you created (before anyone has joined). Only the
     * creator may cancel, and only while the game is still 'open'.
     *
     * @return array{ok:true}|array{ok:false,error:string,code:int}
     */
    public static function cancel( int $game_id, int $user_id ): array {
        global $wpdb;
        $t    = $wpdb->prefix . 'go3d_games';
        $game = self::get_row( $game_id );

        if ( ! $game )
            return [ 'ok' => false, 'error' => 'Game not found.', 'code' => 404 ];
        if ( (int)$game['player1_id'] !== $user_id )
            return [ 'ok' => false, 'error' => 'You can only cancel your own games.', 'code' => 403 ];
        if ( $game['status'] !== 'open' )
            return [ 'ok' => false, 'error' => 'Only open games can be cancelled.', 'code' => 409 ];

        // Atomic guard: the WHERE status='open' loses a race against a joiner
        // who flipped the game to 'active' a moment ago.
        $deleted = $wpdb->delete( $t, [ 'id' => $game_id, 'status' => 'open' ] );
        if ( ! $deleted )
            return [ 'ok' => false, 'error' => 'Game can no longer be cancelled.', 'code' => 409 ];

        $wpdb->delete( $wpdb->prefix . 'go3d_moves', [ 'game_id' => $game_id ] );

        return [ 'ok' => true ];
    }

    // ── Move submission ───────────────────────────────────────────────────────

    /**
     * Submit a move (place / pass / resign).
     *
     * @param array{type:string,x?:int,y?:int,z?:int,time_ms?:int} $move_data
     * @return array{ok:true,event:string,payload:array}|array{ok:false,error:string,code:int}
     */
    public static function submit_move( int $game_id, int $user_id, array $move_data ): array {
        global $wpdb;

        $game = self::get_row( $game_id );
        if ( ! $game )
            return [ 'ok' => false, 'error' => 'Game not found.', 'code' => 404 ];
        if ( $game['status'] !== 'active' )
            return [ 'ok' => false, 'error' => 'Game is not active.', 'code' => 409 ];

        // Lazily enforce the clock before accepting a move: if the current
        // player's time expired since the last action, end the game now rather
        // than letting a late move slip through before the cron sweep runs.
        if ( self::enforce_timeout( $game ) ) {
            return [ 'ok' => false, 'error' => 'Game ended on time.', 'code' => 409 ];
        }

        $player_slot = self::player_slot( $game, $user_id );
        if ( ! $player_slot )
            return [ 'ok' => false, 'error' => 'You are not a player in this game.', 'code' => 403 ];

        $type = $move_data['type'] ?? '';

        // Resignation is allowed at ANY time — including the opponent's turn —
        // so it must be handled before the turn-order check below. The clock is
        // irrelevant once the game ends, so we pass the stored times through.
        if ( $type === 'resign' ) {
            return self::end_game(
                $game, $user_id, $player_slot, 'resign', null,
                $game['p1_time_ms'] !== null ? (int) $game['p1_time_ms'] : null,
                $game['p2_time_ms'] !== null ? (int) $game['p2_time_ms'] : null,
                []
            );
        }

        if ( (int)$game['current_player'] !== $player_slot )
            return [ 'ok' => false, 'error' => 'It is not your turn.', 'code' => 409 ];

        // Clock deduction is SERVER-AUTHORITATIVE: we never trust a client-sent
        // time_ms. The elapsed time is the wall-clock gap between this move and
        // the previous one (last_move_at), so a tampered or laggy client can't
        // gain or lose time.
        $p1_time_ms = $game['p1_time_ms'] !== null ? (int)$game['p1_time_ms'] : null;
        $p2_time_ms = $game['p2_time_ms'] !== null ? (int)$game['p2_time_ms'] : null;
        $time_ms    = null;
        // Extra byōyomi columns to persist (empty for non-byōyomi games, which
        // leaves those columns untouched).
        $byo = [];
        if ( $game['time_control'] !== 'none' && ! empty( $game['last_move_at'] ) ) {
            $elapsed_ms = max( 0, ( time() - strtotime( $game['last_move_at'] . ' UTC' ) ) * 1000 );
            $time_ms    = $elapsed_ms;

            if ( $game['time_control'] === 'byoyomi' ) {
                // Real byōyomi: deduct via Go3D_Clock, tracking period count and
                // the main→byōyomi transition for the player who just moved.
                $ts        = json_decode( $game['time_settings'] ?? '{}', true ) ?: [];
                $period_ms = max( 1, (int)( $ts['byoyomi_time_s'] ?? 0 ) * 1000 );
                $cur_time  = $player_slot === 1 ? (int)$p1_time_ms : (int)$p2_time_ms;
                $cur_per   = (int)( $player_slot === 1 ? $game['p1_periods'] : $game['p2_periods'] );
                $cur_byo   = (bool)( $player_slot === 1 ? $game['p1_in_byoyomi'] : $game['p2_in_byoyomi'] );
                $r         = Go3D_Clock::byoyomi_move( $cur_time, $cur_per, $cur_byo, $period_ms, $elapsed_ms );

                if ( $r['flagged'] ) {
                    // The move itself ran out the clock → loss on time.
                    return self::end_game( $game, $user_id, $player_slot, 'timeout', $time_ms,
                        $player_slot === 1 ? 0 : $p1_time_ms,
                        $player_slot === 2 ? 0 : $p2_time_ms, $byo );
                }

                if ( $player_slot === 1 ) { $p1_time_ms = $r['time_ms']; } else { $p2_time_ms = $r['time_ms']; }
                $byo = [
                    'p1_periods'    => $player_slot === 1 ? $r['periods'] : (int)$game['p1_periods'],
                    'p2_periods'    => $player_slot === 2 ? $r['periods'] : (int)$game['p2_periods'],
                    'p1_in_byoyomi' => $player_slot === 1 ? ( $r['in_byoyomi'] ? 1 : 0 ) : (int)$game['p1_in_byoyomi'],
                    'p2_in_byoyomi' => $player_slot === 2 ? ( $r['in_byoyomi'] ? 1 : 0 ) : (int)$game['p2_in_byoyomi'],
                ];
            } else {
                // Absolute / Fischer: simple subtraction.
                // First, detect a flag: if the player consumed more time than
                // they had left, the move itself ran out the clock → loss on
                // time. Mirror the byōyomi branch and finalise immediately
                // rather than silently clamping to 0 and letting play continue.
                $cur_time = $player_slot === 1 ? $p1_time_ms : $p2_time_ms;
                if ( $cur_time !== null && $elapsed_ms > $cur_time ) {
                    return self::end_game( $game, $user_id, $player_slot, 'timeout', $time_ms,
                        $player_slot === 1 ? 0 : $p1_time_ms,
                        $player_slot === 2 ? 0 : $p2_time_ms, $byo );
                }

                if ( $player_slot === 1 && $p1_time_ms !== null ) $p1_time_ms = max( 0, $p1_time_ms - $elapsed_ms );
                if ( $player_slot === 2 && $p2_time_ms !== null ) $p2_time_ms = max( 0, $p2_time_ms - $elapsed_ms );

                // Fischer: add the increment back to the player who just moved
                // (only for real board moves, not resignation).
                if ( $game['time_control'] === 'fischer' && $type !== 'resign' ) {
                    $ts  = json_decode( $game['time_settings'] ?? '{}', true ) ?: [];
                    $inc = max( 0, (int)( $ts['fischer_increment_s'] ?? 0 ) ) * 1000;
                    if ( $player_slot === 1 && $p1_time_ms !== null ) $p1_time_ms += $inc;
                    if ( $player_slot === 2 && $p2_time_ms !== null ) $p2_time_ms += $inc;
                }
            }
        }

        if ( $type === 'pass' ) {
            return self::handle_pass( $game, $user_id, $player_slot, $time_ms, $p1_time_ms, $p2_time_ms, $byo );
        }

        if ( $type === 'place' ) {
            return self::handle_place( $game, $user_id, $player_slot, $move_data, $time_ms, $p1_time_ms, $p2_time_ms, $byo );
        }

        return [ 'ok' => false, 'error' => 'Unknown move type.', 'code' => 422 ];
    }

    public static function request_undo( int $game_id, int $user_id ): array {
        $game = self::get_row( $game_id );
        if ( ! $game ) return [ 'ok' => false, 'error' => 'Game not found.', 'code' => 404 ];
        if ( $game['status'] !== 'active' ) return [ 'ok' => false, 'error' => 'Game is not active.', 'code' => 409 ];
        $slot = self::player_slot( $game, $user_id );
        if ( ! $slot ) return [ 'ok' => false, 'error' => 'You are not a player in this game.', 'code' => 403 ];

        $moves = self::get_moves( $game_id );
        $last  = end( $moves );
        if ( ! $last ) return [ 'ok' => false, 'error' => 'There is no move to undo.', 'code' => 422 ];
        if ( (int)$last['player_id'] !== $user_id ) {
            return [ 'ok' => false, 'error' => 'Only the player who made the latest move can request undo.', 'code' => 403 ];
        }

        $user = Go3D_Auth::get_user( $user_id );
        $payload = [
            'requester_id'   => $user_id,
            'requester_name' => $user ? $user['username'] : 'Opponent',
            'move_number'    => (int)$last['move_number'],
        ];
        set_transient( self::undo_transient_key( $game_id ), $payload, 10 * MINUTE_IN_SECONDS );
        Go3D_Pusher::trigger( "private-game-$game_id", 'undo-request', $payload );
        return [ 'ok' => true ];
    }

    public static function respond_undo( int $game_id, int $user_id, bool $accept ): array {
        global $wpdb;
        $game = self::get_row( $game_id );
        if ( ! $game ) return [ 'ok' => false, 'error' => 'Game not found.', 'code' => 404 ];
        if ( $game['status'] !== 'active' ) return [ 'ok' => false, 'error' => 'Game is not active.', 'code' => 409 ];
        if ( ! self::player_slot( $game, $user_id ) ) return [ 'ok' => false, 'error' => 'You are not a player in this game.', 'code' => 403 ];

        $pending = get_transient( self::undo_transient_key( $game_id ) );
        if ( ! is_array( $pending ) ) return [ 'ok' => false, 'error' => 'No undo request is pending.', 'code' => 404 ];
        if ( (int)$pending['requester_id'] === $user_id ) {
            return [ 'ok' => false, 'error' => 'The opponent must respond to the undo request.', 'code' => 403 ];
        }

        $moves = self::get_moves( $game_id );
        $last  = end( $moves );
        if ( ! $last || (int)$last['move_number'] !== (int)$pending['move_number'] || (int)$last['player_id'] !== (int)$pending['requester_id'] ) {
            delete_transient( self::undo_transient_key( $game_id ) );
            return [ 'ok' => false, 'error' => 'The undo request is no longer valid.', 'code' => 409 ];
        }

        if ( ! $accept ) {
            delete_transient( self::undo_transient_key( $game_id ) );
            Go3D_Pusher::trigger( "private-game-$game_id", 'undo-declined', [
                'move_number' => (int)$last['move_number'],
            ] );
            return [ 'ok' => true ];
        }

        $wpdb->delete( $wpdb->prefix . 'go3d_moves', [
            'game_id'     => $game_id,
            'move_number' => (int)$last['move_number'],
        ] );

        $remaining = self::get_moves( $game_id );
        $meta = self::rebuild_meta( $game, $remaining );

        $p1_time_ms = $game['p1_time_ms'] !== null ? (int)$game['p1_time_ms'] : null;
        $p2_time_ms = $game['p2_time_ms'] !== null ? (int)$game['p2_time_ms'] : null;
        $refund_ms  = $last['time_ms'] !== null ? max( 0, (int)$last['time_ms'] ) : 0;
        if ( $refund_ms > 0 && $game['time_control'] !== 'none' ) {
            $mover_slot = self::player_slot( $game, (int)$last['player_id'] );
            if ( $mover_slot === 1 && $p1_time_ms !== null ) $p1_time_ms += $refund_ms;
            if ( $mover_slot === 2 && $p2_time_ms !== null ) $p2_time_ms += $refund_ms;
        }

        $wpdb->update( $wpdb->prefix . 'go3d_games', [
            'current_player'     => $meta['current_player'],
            'consecutive_passes' => $meta['consecutive_passes'],
            'active_layer'       => $meta['active_layer'],
            'board_hash'         => $meta['board_hash'],
            'history_hashes'     => wp_json_encode( $meta['history_hashes'] ),
            'p1_time_ms'         => $p1_time_ms,
            'p2_time_ms'         => $p2_time_ms,
            'last_move_at'       => current_time( 'mysql', true ),
        ], [ 'id' => $game_id ] );

        delete_transient( self::undo_transient_key( $game_id ) );
        $state = self::get_state( $game_id );
        Go3D_Pusher::trigger( "private-game-$game_id", 'undo-applied', [
            'move_number' => (int)$last['move_number'],
            'state'       => $state,
        ] );

        return [ 'ok' => true, 'state' => $state ];
    }

    // ── Pass ─────────────────────────────────────────────────────────────────

    private static function handle_pass( array $game, int $user_id, int $player_slot, ?int $time_ms, ?int $p1_time_ms, ?int $p2_time_ms, array $byo = [] ): array {
        global $wpdb;
        $gt = $wpdb->prefix . 'go3d_games';
        $mt = $wpdb->prefix . 'go3d_moves';

        $consecutive = (int)$game['consecutive_passes'] + 1;
        $next_player = 3 - $player_slot;
        $move_number = self::next_move_number( (int)$game['id'] );

        // The UNIQUE(game_id, move_number) index makes this insert fail if a
        // concurrent request already claimed this move number. Treat that as a
        // turn conflict rather than silently advancing the game twice.
        $inserted = $wpdb->insert( $mt, [
            'game_id'     => $game['id'],
            'move_number' => $move_number,
            'player_id'   => $user_id,
            'type'        => 'pass',
            'time_ms'     => $time_ms,
            'created_at'  => current_time( 'mysql', true ),
        ] );
        if ( false === $inserted ) {
            return [ 'ok' => false, 'error' => 'Move already registered. Please retry.', 'code' => 409 ];
        }

        $now = current_time( 'mysql', true );

        if ( $consecutive >= 2 ) {
            // Stack mode: two passes advance to the next layer rather than ending
            // the game — unless we're already on the top layer, in which case the
            // completed cube is scored. Lower layers are never replayed.
            if ( ( $game['mode'] ?? 'cube' ) === 'stack' ) {
                $size         = (int)$game['board_size'];
                $active_layer = (int)( $game['active_layer'] ?? 0 );
                if ( $active_layer < $size - 1 ) {
                    $new_layer   = $active_layer + 1;
                    $next_player = 3 - $player_slot;
                    $wpdb->update( $gt, array_merge( [
                        'consecutive_passes' => 0,
                        'active_layer'       => $new_layer,
                        'current_player'     => $next_player,
                        'p1_time_ms'         => $p1_time_ms,
                        'p2_time_ms'         => $p2_time_ms,
                        'last_move_at'       => $now,
                    ], $byo ), [ 'id' => $game['id'] ] );

                    $payload = array_merge( [
                        'type'         => 'layer-advance',
                        'move_number'  => $move_number,
                        'player_slot'  => $player_slot,
                        'next_player'  => $next_player,
                        'active_layer' => $new_layer,
                        'p1_time_ms'   => $p1_time_ms,
                        'p2_time_ms'   => $p2_time_ms,
                    ], $byo );
                    Go3D_Pusher::trigger( "private-game-{$game['id']}", 'move', $payload );
                    return [ 'ok' => true, 'event' => 'move', 'payload' => $payload ];
                }
                // Top layer reached → fall through and score the whole cube.
            }
            // Two consecutive passes → score and end
            return self::end_by_scoring( $game, $move_number, $p1_time_ms, $p2_time_ms, $byo );
        }

        $wpdb->update( $gt, array_merge( [
            'consecutive_passes' => $consecutive,
            'current_player'     => $next_player,
            'p1_time_ms'         => $p1_time_ms,
            'p2_time_ms'         => $p2_time_ms,
            'last_move_at'       => $now,
        ], $byo ), [ 'id' => $game['id'] ] );

        $payload = array_merge( [
            'type'        => 'pass',
            'move_number' => $move_number,
            'player_slot' => $player_slot,
            'next_player' => $next_player,
            'p1_time_ms'  => $p1_time_ms,
            'p2_time_ms'  => $p2_time_ms,
        ], $byo );
        Go3D_Pusher::trigger( "private-game-{$game['id']}", 'move', $payload );

        return [ 'ok' => true, 'event' => 'move', 'payload' => $payload ];
    }

    // ── Place ────────────────────────────────────────────────────────────────

    private static function handle_place( array $game, int $user_id, int $player_slot, array $move_data, ?int $time_ms, ?int $p1_time_ms, ?int $p2_time_ms, array $byo = [] ): array {
        global $wpdb;
        $gt = $wpdb->prefix . 'go3d_games';
        $mt = $wpdb->prefix . 'go3d_moves';

        // Sphere mode plays on a geodesic graph: a single node index (stored in
        // the x column, y/z null) and the graph rule engine.
        if ( ( $game['mode'] ?? 'cube' ) === 'sphere' ) {
            return self::handle_place_sphere( $game, $user_id, $player_slot, $move_data, $time_ms, $p1_time_ms, $p2_time_ms, $byo );
        }

        $x = isset( $move_data['x'] ) ? (int)$move_data['x'] : -1;
        $y = isset( $move_data['y'] ) ? (int)$move_data['y'] : -1;
        $z = isset( $move_data['z'] ) ? (int)$move_data['z'] : -1;

        // Stack mode: stones may only be placed on the currently active layer
        // (the vertical y axis). Captures still resolve in full 3D, so stones on
        // already-completed lower layers can be captured from above.
        if ( ( $game['mode'] ?? 'cube' ) === 'stack' && $y !== (int)( $game['active_layer'] ?? 0 ) ) {
            return [ 'ok' => false, 'error' => 'In stack mode you can only play on the active layer.', 'code' => 422 ];
        }

        // Reconstruct board from move history
        $moves = self::get_moves( (int)$game['id'] );
        $logic = Go3D_Game_Logic::replay( (int)$game['board_size'], $moves, (int)$game['player1_id'] );

        // Superko history
        $history = json_decode( $game['history_hashes'] ?? '[]', true ) ?: [];

        $result = $logic->place( $x, $y, $z, $player_slot, $history );
        if ( ! $result['ok'] ) {
            return [ 'ok' => false, 'error' => $result['reason'], 'code' => 422 ];
        }

        $move_number = self::next_move_number( (int)$game['id'], $moves );
        $history[]   = $result['hash'];

        // UNIQUE(game_id, move_number) guards against a concurrent double-submit:
        // if the insert fails the move number was already taken, so bail out
        // before mutating the game row (which would corrupt turn/board state).
        $inserted = $wpdb->insert( $mt, [
            'game_id'     => $game['id'],
            'move_number' => $move_number,
            'player_id'   => $user_id,
            'type'        => 'place',
            'x'           => $x,
            'y'           => $y,
            'z'           => $z,
            'time_ms'     => $time_ms,
            'created_at'  => current_time( 'mysql', true ),
        ] );
        if ( false === $inserted ) {
            return [ 'ok' => false, 'error' => 'Move already registered. Please retry.', 'code' => 409 ];
        }

        $next_player = 3 - $player_slot;

        $wpdb->update( $gt, array_merge( [
            'consecutive_passes' => 0,
            'current_player'     => $next_player,
            'board_hash'         => $result['hash'],
            'history_hashes'     => wp_json_encode( $history ),
            'p1_time_ms'         => $p1_time_ms,
            'p2_time_ms'         => $p2_time_ms,
            'last_move_at'       => current_time( 'mysql', true ),
        ], $byo ), [ 'id' => $game['id'] ] );

        $payload = array_merge( [
            'type'        => 'place',
            'move_number' => $move_number,
            'player_slot' => $player_slot,
            'x'           => $x,
            'y'           => $y,
            'z'           => $z,
            'captured'    => $result['captured'],
            'next_player' => $next_player,
            'p1_time_ms'  => $p1_time_ms,
            'p2_time_ms'  => $p2_time_ms,
        ], $byo );
        Go3D_Pusher::trigger( "private-game-{$game['id']}", 'move', $payload );

        return [ 'ok' => true, 'event' => 'move', 'payload' => $payload ];
    }

    /**
     * Place a stone in SPHERE mode (geodesic graph). The move carries a single
     * node index in $move_data['x']; y/z are unused. Captures are returned as a
     * flat list of node indices.
     */
    private static function handle_place_sphere( array $game, int $user_id, int $player_slot, array $move_data, ?int $time_ms, ?int $p1_time_ms, ?int $p2_time_ms, array $byo = [] ): array {
        global $wpdb;
        $gt = $wpdb->prefix . 'go3d_games';
        $mt = $wpdb->prefix . 'go3d_moves';

        $node = isset( $move_data['x'] ) ? (int)$move_data['x'] : -1;

        $adj   = Go3D_Geodesic::adjacency( (int)$game['board_size'] );
        $moves = self::get_moves( (int)$game['id'] );
        $logic = Go3D_Graph_Logic::replay( $adj, $moves, (int)$game['player1_id'] );

        $history = json_decode( $game['history_hashes'] ?? '[]', true ) ?: [];

        $result = $logic->place( $node, $player_slot, $history );
        if ( ! $result['ok'] ) {
            return [ 'ok' => false, 'error' => $result['reason'], 'code' => 422 ];
        }

        $move_number = self::next_move_number( (int)$game['id'], $moves );
        $history[]   = $result['hash'];

        $inserted = $wpdb->insert( $mt, [
            'game_id'     => $game['id'],
            'move_number' => $move_number,
            'player_id'   => $user_id,
            'type'        => 'place',
            'x'           => $node,   // node index; y/z stay null for sphere
            'time_ms'     => $time_ms,
            'created_at'  => current_time( 'mysql', true ),
        ] );
        if ( false === $inserted ) {
            return [ 'ok' => false, 'error' => 'Move already registered. Please retry.', 'code' => 409 ];
        }

        $next_player = 3 - $player_slot;

        $wpdb->update( $gt, array_merge( [
            'consecutive_passes' => 0,
            'current_player'     => $next_player,
            'board_hash'         => $result['hash'],
            'history_hashes'     => wp_json_encode( $history ),
            'p1_time_ms'         => $p1_time_ms,
            'p2_time_ms'         => $p2_time_ms,
            'last_move_at'       => current_time( 'mysql', true ),
        ], $byo ), [ 'id' => $game['id'] ] );

        $payload = array_merge( [
            'type'        => 'place',
            'move_number' => $move_number,
            'player_slot' => $player_slot,
            'x'           => $node,
            'captured'    => $result['captured'],   // flat node indices (for the capture animation)
            'board'       => $result['board'],      // authoritative flat board (client has no engine)
            'next_player' => $next_player,
            'p1_time_ms'  => $p1_time_ms,
            'p2_time_ms'  => $p2_time_ms,
        ], $byo );
        Go3D_Pusher::trigger( "private-game-{$game['id']}", 'move', $payload );

        return [ 'ok' => true, 'event' => 'move', 'payload' => $payload ];
    }

    // ── End game ──────────────────────────────────────────────────────────────

    /**
     * End game by resignation or timeout.
     * $loser_slot = 1 or 2 (the player who lost).
     */
    private static function end_game( array $game, int $user_id, int $loser_slot, string $reason, ?int $time_ms, ?int $p1_time_ms, ?int $p2_time_ms, array $byo = [] ): array {
        global $wpdb;
        $mt = $wpdb->prefix . 'go3d_moves';

        // If resign, record move
        if ( $reason === 'resign' ) {
            $move_number = self::next_move_number( (int)$game['id'] );
            $wpdb->insert( $mt, [
                'game_id'     => $game['id'],
                'move_number' => $move_number,
                'player_id'   => $user_id,
                'type'        => 'resign',
                'time_ms'     => $time_ms,
                'created_at'  => current_time( 'mysql', true ),
            ] );
        }

        $winner_slot = 3 - $loser_slot;
        $winner_id   = (int)$game[ "player{$winner_slot}_id" ];
        $loser_id    = (int)$game[ "player{$loser_slot}_id" ];

        return self::finalise_game( $game, $winner_id, $loser_id, $reason, null, null, $p1_time_ms, $p2_time_ms, $byo );
    }

    /**
     * End game by double-pass → count territory.
     */
    private static function end_by_scoring( array $game, int $move_number, ?int $p1_time_ms, ?int $p2_time_ms, array $byo = [] ): array {
        $moves    = self::get_moves( (int)$game['id'] );
        $p1_id    = (int)$game['player1_id'];
        $p2_id    = (int)$game['player2_id'];
        $is_sphere = ( $game['mode'] ?? 'cube' ) === 'sphere';
        $adj       = $is_sphere ? Go3D_Geodesic::adjacency( (int)$game['board_size'] ) : null;

        $logic   = $is_sphere
            ? Go3D_Graph_Logic::replay( $adj, $moves, $p1_id )
            : Go3D_Game_Logic::replay( (int)$game['board_size'], $moves, $p1_id );
        $terr    = $logic->count_territory();
        $komi    = (float)$game['komi'];
        $mode    = $game['scoring_mode'];

        if ( $mode === 'japanese' ) {
            // Japanese: territory + prisoners (stones you captured) + komi.
            // The DB doesn't store per-move capture counts, so replay the game
            // incrementally and tally captures by the capturing player's slot.
            $p1_captures = 0; $p2_captures = 0;
            $logic2 = $is_sphere ? new Go3D_Graph_Logic( $adj ) : new Go3D_Game_Logic( (int)$game['board_size'] );
            foreach ( $moves as $m ) {
                if ( $m['type'] !== 'place' ) continue;
                $slot = ( (int)$m['player_id'] === $p1_id ) ? 1 : 2;
                $r = $is_sphere
                    ? $logic2->place( (int)$m['x'], $slot )
                    : $logic2->place( (int)$m['x'], (int)$m['y'], (int)$m['z'], $slot );
                if ( $r['ok'] ) {
                    $cap_count = count( $r['captured'] );
                    // A slot-1 (Black) move captures White's stones → adds to P1's prisoners.
                    if ( $slot === 1 ) $p1_captures += $cap_count;
                    else               $p2_captures += $cap_count;
                }
            }
            $p1_score = $terr['black'] + $p1_captures;
            $p2_score = $terr['white'] + $p2_captures + $komi;
        } else {
            // Chinese: territory + stones on board + komi.
            $p1_score = $terr['black'] + $terr['blackStones'];
            $p2_score = $terr['white'] + $terr['whiteStones'] + $komi;
        }

        if ( abs( $p1_score - $p2_score ) < 0.001 ) {
            // Draw (shouldn't happen with komi but handle it)
            $winner_id = null;
            $reason    = 'score_draw';
        } elseif ( $p1_score > $p2_score ) {
            $winner_id = $p1_id;
            $reason    = 'score';
        } else {
            $winner_id = $p2_id;
            $reason    = 'score';
        }

        return self::finalise_game( $game, $winner_id, null, $reason, $p1_score, $p2_score, $p1_time_ms, $p2_time_ms, $byo );
    }

    /**
     * Write the finished state, update ELO, fire Pusher event, queue notification.
     */
    private static function finalise_game( array $game, ?int $winner_id, ?int $loser_id, string $end_reason, ?float $p1_score, ?float $p2_score, ?int $p1_time_ms, ?int $p2_time_ms, array $byo = [] ): array {
        global $wpdb;
        $gt  = $wpdb->prefix . 'go3d_games';
        $now = current_time( 'mysql', true );

        $p1_id = (int)$game['player1_id'];
        $p2_id = $game['player2_id'] ? (int)$game['player2_id'] : null;

        // Atomically claim the finish. The WHERE status='active' guard means
        // only the FIRST of any concurrent finalisers (e.g. a real move and a
        // cron timeout sweep racing) flips the row — every later one sees
        // rows_affected === 0 and bails out below. This is what stops ELO from
        // being applied twice and duplicate result notifications being queued.
        $claimed = $wpdb->update( $gt, array_merge( [
            'status'        => 'finished',
            'winner_id'     => $winner_id,
            'end_reason'    => $end_reason,
            'p1_score'      => $p1_score,
            'p2_score'      => $p2_score,
            'p1_time_ms'    => $p1_time_ms,
            'p2_time_ms'    => $p2_time_ms,
            'finished_at'   => $now,
            'last_move_at'  => $now,
        ], $byo ), [ 'id' => $game['id'], 'status' => 'active' ] );

        if ( $claimed !== 1 ) {
            // Someone else already finished this game. Don't touch ELO or
            // notifications — just report the already-recorded outcome.
            $row = self::get_row( (int)$game['id'] );
            return [ 'ok' => true, 'event' => 'game-over', 'payload' => [
                'status'        => 'finished',
                'end_reason'    => $row['end_reason']    ?? $end_reason,
                'winner_id'     => isset( $row['winner_id'] ) ? (int)$row['winner_id'] : $winner_id,
                'p1_score'      => $row['p1_score']      ?? $p1_score,
                'p2_score'      => $row['p2_score']      ?? $p2_score,
                'elo_change_p1' => (int)( $row['elo_change_p1'] ?? 0 ),
                'elo_change_p2' => (int)( $row['elo_change_p2'] ?? 0 ),
            ] ];
        }

        // We won the claim — now (and only now) apply ELO + win/loss/draw stats.
        // Every finished two-player game counts, including draws (which update
        // games_played and the draw column).
        $elo_change_p1 = 0;
        $elo_change_p2 = 0;
        if ( $p2_id ) {
            if ( $winner_id === $p1_id )      $outcome = 'p1_wins';
            elseif ( $winner_id === $p2_id )  $outcome = 'p2_wins';
            else                              $outcome = 'draw';
            [ $elo_change_p1, $elo_change_p2 ] = Go3D_Elo::update( $p1_id, $p2_id, $outcome );

            $wpdb->update( $gt, [
                'elo_change_p1' => $elo_change_p1,
                'elo_change_p2' => $elo_change_p2,
            ], [ 'id' => $game['id'] ] );
        }

        $payload = [
            'status'        => 'finished',
            'end_reason'    => $end_reason,
            'winner_id'     => $winner_id,
            'p1_score'      => $p1_score,
            'p2_score'      => $p2_score,
            'elo_change_p1' => $elo_change_p1,
            'elo_change_p2' => $elo_change_p2,
        ];
        Go3D_Pusher::trigger( "private-game-{$game['id']}", 'game-over', $payload );

        return [ 'ok' => true, 'event' => 'game-over', 'payload' => $payload ];
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /** @return array<string,mixed>|null */
    public static function get_row( int $game_id ): ?array {
        global $wpdb;
        $row = $wpdb->get_row(
            $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}go3d_games WHERE id = %d", $game_id ),
            ARRAY_A
        );
        return $row ?: null;
    }

    /**
     * Resolve username + ELO for one or both players in a single query.
     *
     * @return array{p1_name:?string,p2_name:?string,p1_elo:?int,p2_elo:?int}
     */
    private static function player_labels( int $p1_id, ?int $p2_id ): array {
        global $wpdb;
        $u   = $wpdb->prefix . 'go3d_users';
        $ids = array_values( array_filter( [ $p1_id, $p2_id ] ) );
        $map = [];
        if ( $ids ) {
            $ph   = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
            $rows = $wpdb->get_results(
                $wpdb->prepare( "SELECT id, username, elo FROM $u WHERE id IN ($ph)", ...$ids ),
                ARRAY_A
            ) ?: [];
            foreach ( $rows as $r ) $map[ (int)$r['id'] ] = $r;
        }
        return [
            'p1_name' => isset( $map[ $p1_id ] ) ? $map[ $p1_id ]['username'] : null,
            'p2_name' => ( $p2_id && isset( $map[ $p2_id ] ) ) ? $map[ $p2_id ]['username'] : null,
            'p1_elo'  => isset( $map[ $p1_id ] ) ? (int)$map[ $p1_id ]['elo'] : null,
            'p2_elo'  => ( $p2_id && isset( $map[ $p2_id ] ) ) ? (int)$map[ $p2_id ]['elo'] : null,
        ];
    }

    /** @return array<array<string,mixed>> */
    public static function get_moves( int $game_id ): array {
        global $wpdb;
        return $wpdb->get_results(
            $wpdb->prepare(
                "SELECT * FROM {$wpdb->prefix}go3d_moves WHERE game_id = %d ORDER BY move_number ASC",
                $game_id
            ),
            ARRAY_A
        ) ?: [];
    }

    /** Full game state for API response (sanitised). */
    public static function get_state( int $game_id ): ?array {
        $game = self::get_row( $game_id );
        if ( ! $game ) return null;

        // Lazily enforce the clock so a viewer (either player or a spectator)
        // sees the game flip to "finished" as soon as the flag falls, even if
        // the WP-Cron sweep hasn't fired yet. Re-read the row after ending so
        // the returned state reflects the timeout result.
        if ( self::enforce_timeout( $game ) ) {
            $game = self::get_row( $game_id ) ?: $game;
        }

        $moves    = self::get_moves( $game_id );
        $is_sphere = ( $game['mode'] ?? 'cube' ) === 'sphere';

        // Resolve player display names + ELO up front so the client can label
        // the board immediately, instead of flashing "Player 12" and then
        // back-filling it with two extra /users/{id} round-trips.
        $names = self::player_labels( (int)$game['player1_id'], $game['player2_id'] ? (int)$game['player2_id'] : null );

        // Sphere games carry the geodesic geometry so the client can render the
        // globe without regenerating the graph (the server is the single source
        // of truth for both rules and rendering). board is a FLAT node array.
        $geometry = null;
        if ( $is_sphere ) {
            $geo      = Go3D_Geodesic::build( (int)$game['board_size'] );
            $logic    = Go3D_Graph_Logic::replay( $geo['adjacency'], $moves, (int)$game['player1_id'] );
            $geometry = [
                'vertices' => $geo['vertices'],
                'edges'    => $geo['edges'],
                'count'    => $geo['count'],
            ];
        } else {
            $logic = Go3D_Game_Logic::replay( (int)$game['board_size'], $moves, (int)$game['player1_id'] );
        }

        return [
            'id'                 => (int)$game['id'],
            'player1_id'         => (int)$game['player1_id'],
            'player2_id'         => $game['player2_id'] ? (int)$game['player2_id'] : null,
            'player1_name'       => $names['p1_name'],
            'player2_name'       => $names['p2_name'],
            'player1_elo'        => $names['p1_elo'],
            'player2_elo'        => $names['p2_elo'],
            'board_size'         => (int)$game['board_size'],
            'mode'               => $game['mode'] ?? 'cube',
            'active_layer'       => isset( $game['active_layer'] ) ? (int)$game['active_layer'] : 0,
            'scoring_mode'       => $game['scoring_mode'],
            'komi'               => (float)$game['komi'],
            'time_control'       => $game['time_control'],
            'time_settings'      => $game['time_settings'] ? json_decode( $game['time_settings'], true ) : null,
            'p1_time_ms'         => $game['p1_time_ms'] !== null ? (int)$game['p1_time_ms'] : null,
            'p2_time_ms'         => $game['p2_time_ms'] !== null ? (int)$game['p2_time_ms'] : null,
            'p1_periods'         => isset( $game['p1_periods'] ) && $game['p1_periods'] !== null ? (int)$game['p1_periods'] : null,
            'p2_periods'         => isset( $game['p2_periods'] ) && $game['p2_periods'] !== null ? (int)$game['p2_periods'] : null,
            'p1_in_byoyomi'      => ! empty( $game['p1_in_byoyomi'] ),
            'p2_in_byoyomi'      => ! empty( $game['p2_in_byoyomi'] ),
            'current_player'     => (int)$game['current_player'],
            'consecutive_passes' => (int)$game['consecutive_passes'],
            'status'             => $game['status'],
            'winner_id'          => $game['winner_id'] ? (int)$game['winner_id'] : null,
            'end_reason'         => $game['end_reason'],
            'p1_score'           => $game['p1_score'] !== null ? (float)$game['p1_score'] : null,
            'p2_score'           => $game['p2_score'] !== null ? (float)$game['p2_score'] : null,
            'elo_change_p1'      => $game['elo_change_p1'] !== null ? (int)$game['elo_change_p1'] : null,
            'elo_change_p2'      => $game['elo_change_p2'] !== null ? (int)$game['elo_change_p2'] : null,
            'board'              => $logic->get_board(),
            'geometry'           => $geometry,
            'moves'              => array_map( [ __CLASS__, 'sanitise_move' ], $moves ),
            'pending_undo'       => self::pending_undo_for_state( $game_id ),
            'created_at'         => $game['created_at'],
            'last_move_at'       => $game['last_move_at'],
            'finished_at'        => $game['finished_at'],
        ];
    }

    /**
     * List games for a user (active, open, or finished).
     * @return array<array<string,mixed>>
     */
    public static function list_for_user( int $user_id, string $status = 'active', int $limit = 20, int $offset = 0 ): array {
        global $wpdb;
        $t = $wpdb->prefix . 'go3d_games';

        $u = $wpdb->prefix . 'go3d_users';

        // Defence-in-depth: validate the status whitelist inside the method
        // so a caller bypassing the API handler can't inject SQL.
        $allowed = [ 'open', 'active', 'finished' ];
        if ( ! in_array( $status, $allowed, true ) ) $status = 'active';
        $status_sql = $wpdb->prepare( 'g.status = %s', $status );
        $rows = $wpdb->get_results( $wpdb->prepare(
            "SELECT g.id, g.player1_id, g.player2_id, g.board_size, g.mode, g.scoring_mode, g.komi,
                    g.time_control, g.current_player, g.status, g.winner_id, g.end_reason,
                    g.p1_score, g.p2_score, g.elo_change_p1, g.elo_change_p2,
                    g.created_at, g.last_move_at, g.finished_at,
                    u1.username AS player1_name, u2.username AS player2_name
             FROM $t g
             LEFT JOIN $u u1 ON u1.id = g.player1_id
             LEFT JOIN $u u2 ON u2.id = g.player2_id
             WHERE (g.player1_id = %d OR g.player2_id = %d) AND $status_sql
             ORDER BY g.last_move_at DESC
             LIMIT %d OFFSET %d",
            $user_id, $user_id, $limit, $offset
        ), ARRAY_A ) ?: [];

        return $rows;
    }

    /**
     * List open games (waiting for P2).
     * @return array<array<string,mixed>>
     */
    public static function list_open( int $limit = 20, int $offset = 0 ): array {
        global $wpdb;
        $t = $wpdb->prefix . 'go3d_games';
        $u = $wpdb->prefix . 'go3d_users';
        return $wpdb->get_results( $wpdb->prepare(
            "SELECT g.id, g.player1_id, g.board_size, g.mode, g.scoring_mode, g.komi, g.time_control, g.created_at,
                    u1.username AS player1_name
             FROM $t g
             LEFT JOIN $u u1 ON u1.id = g.player1_id
             WHERE g.status = 'open' ORDER BY g.created_at DESC LIMIT %d OFFSET %d",
            $limit, $offset
        ), ARRAY_A ) ?: [];
    }

    // ── Timeout handling (called from WP cron) ─────────────────────────────

    /**
     * Check all active timed games and end any where the clock has expired.
     * Called hourly (or more frequently) via WP-Cron.
     */
    public static function process_timeouts(): void {
        global $wpdb;
        $t = $wpdb->prefix . 'go3d_games';

        $games = $wpdb->get_results(
            "SELECT * FROM $t WHERE status = 'active' AND time_control != 'none'",
            ARRAY_A
        ) ?: [];

        foreach ( $games as $game ) {
            self::enforce_timeout( $game );
        }
    }

    /** Days of total inactivity after which a game is considered abandoned. */
    const ABANDON_DAYS = 7;

    /**
     * Clean up games that have been abandoned, covering two cases the clock
     * sweep can't:
     *   1. Open games that never found an opponent.
     *   2. Active games where the first move was never played — the clock only
     *      starts on the first move, so these never time out and would sit
     *      "active" forever.
     *
     * Both are effectively non-games (zero moves), so they're deleted rather
     * than recorded as losses — no ELO change, no cluttered history. Active
     * games WITH moves are left to the clock (timed) or to the players
     * (correspondence) as before.
     *
     * Called from WP-Cron alongside process_timeouts().
     */
    public static function process_abandoned(): void {
        global $wpdb;
        $g      = $wpdb->prefix . 'go3d_games';
        $m      = $wpdb->prefix . 'go3d_moves';
        $cutoff = gmdate( 'Y-m-d H:i:s', time() - self::ABANDON_DAYS * DAY_IN_SECONDS );

        $ids = $wpdb->get_col( $wpdb->prepare(
            "SELECT id FROM $g
              WHERE created_at < %s
                AND ( status = 'open'
                   OR ( status = 'active' AND last_move_at IS NULL ) )",
            $cutoff
        ) );

        foreach ( $ids as $id ) {
            $id = (int) $id;
            // Re-check the abandonment conditions inside the DELETE itself
            // (same atomic-guard pattern as cancel()): between the SELECT above
            // and this statement a player may have joined the open game or made
            // the first move — an unconditional delete-by-id would then destroy
            // a live game. If the guard no longer matches, the delete is a no-op
            // and we leave the moves untouched.
            $deleted = $wpdb->query( $wpdb->prepare(
                "DELETE FROM $g
                  WHERE id = %d
                    AND ( status = 'open'
                       OR ( status = 'active' AND last_move_at IS NULL ) )",
                $id
            ) );
            if ( $deleted ) {
                $wpdb->delete( $m, [ 'game_id' => $id ] );
            }
        }
    }

    /**
     * If the given (active, timed) game's current player has run out the clock,
     * end the game by timeout. Returns true if the game was ended.
     *
     * This is the single source of truth for timeout detection. It is called
     * both from the WP-Cron sweep (process_timeouts) and lazily on every
     * get_state / submit_move so a flag is enforced the moment either player
     * looks at the board — not only when the hourly cron happens to run.
     */
    public static function enforce_timeout( array $game ): bool {
        if ( ( $game['status'] ?? '' ) !== 'active' || ( $game['time_control'] ?? 'none' ) === 'none' ) {
            return false;
        }

        $current   = (int)$game['current_player'];
        $clock_raw = $current === 1 ? $game['p1_time_ms'] : $game['p2_time_ms'];

        // Skip games with no usable clock yet:
        //  – no move has been made (last_move_at null) → clock not running
        //  – the current player's clock column is NULL (not an absolute
        //    main-time game) → casting NULL to 0 would falsely time them out
        if ( empty( $game['last_move_at'] ) || $clock_raw === null ) return false;
        $clock = (int)$clock_raw;

        // Byōyomi: the flag only falls once main time AND every reserve period
        // are exhausted, so the real budget is larger than the current allowance.
        if ( ( $game['time_control'] ?? '' ) === 'byoyomi' ) {
            $ts        = json_decode( $game['time_settings'] ?? '{}', true ) ?: [];
            $period_ms = max( 1, (int)( $ts['byoyomi_time_s'] ?? 0 ) * 1000 );
            $periods   = (int)( $current === 1 ? $game['p1_periods'] : $game['p2_periods'] );
            $in_byo    = (bool)( $current === 1 ? $game['p1_in_byoyomi'] : $game['p2_in_byoyomi'] );
            $clock     = Go3D_Clock::byoyomi_remaining_total( $clock, $periods, $in_byo, $period_ms );
        }

        $elapsed_ms = ( time() - strtotime( $game['last_move_at'] . ' UTC' ) ) * 1000;
        if ( $elapsed_ms > $clock ) {
            // This player timed out
            $loser_id = (int)$game[ "player{$current}_id" ];
            self::end_game( $game, $loser_id, $current, 'timeout', null,
                $current === 1 ? 0 : (int)$game['p1_time_ms'],
                $current === 2 ? 0 : (int)$game['p2_time_ms'] );
            return true;
        }
        return false;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static function player_slot( array $game, int $user_id ): ?int {
        if ( (int)$game['player1_id'] === $user_id ) return 1;
        if ( $game['player2_id'] && (int)$game['player2_id'] === $user_id ) return 2;
        return null;
    }

    private static function undo_transient_key( int $game_id ): string {
        return "go3d_undo_$game_id";
    }

    private static function pending_undo_for_state( int $game_id ): ?array {
        $pending = get_transient( self::undo_transient_key( $game_id ) );
        if ( ! is_array( $pending ) ) return null;
        return [
            'requester_id'   => (int)$pending['requester_id'],
            'requester_name' => $pending['requester_name'] ?? 'Opponent',
            'move_number'    => (int)$pending['move_number'],
        ];
    }

    private static function rebuild_meta( array $game, array $moves ): array {
        $mode = $game['mode'] ?? 'cube';
        $is_sphere = $mode === 'sphere';
        if ( $is_sphere ) {
            $logic = new Go3D_Graph_Logic( Go3D_Geodesic::adjacency( (int)$game['board_size'] ) );
        } else {
            $logic = new Go3D_Game_Logic( (int)$game['board_size'] );
        }
        $history = [ $logic->hash() ];
        $active_layer = 0;
        $consecutive = 0;
        $current = 1;
        $last_move_at = null;

        foreach ( $moves as $m ) {
            $slot = ( (int)$m['player_id'] === (int)$game['player1_id'] ) ? 1 : 2;
            if ( $m['type'] === 'place' ) {
                $result = $is_sphere
                    ? $logic->place( (int)$m['x'], $slot, $history )
                    : $logic->place( (int)$m['x'], (int)$m['y'], (int)$m['z'], $slot, $history );
                if ( ! empty( $result['ok'] ) && isset( $result['hash'] ) ) $history[] = $result['hash'];
                $consecutive = 0;
            } elseif ( $m['type'] === 'pass' ) {
                $consecutive++;
                if ( $mode === 'stack' && $consecutive >= 2 && $active_layer < (int)$game['board_size'] - 1 ) {
                    $active_layer++;
                    $consecutive = 0;
                }
            }
            $current = 3 - $slot;
            $last_move_at = $m['created_at'];
        }

        return [
            'current_player'     => $current,
            'consecutive_passes' => $consecutive,
            'active_layer'       => $active_layer,
            'board_hash'         => end( $history ),
            'history_hashes'     => $history,
            'last_move_at'       => $last_move_at,
        ];
    }

    /**
     * Next sequential move number. Pass the already-loaded move list (ordered
     * by move_number ASC) to avoid a redundant MAX() query; the caller's snapshot
     * is authoritative because the UNIQUE(game_id, move_number) index is what
     * actually guards against a concurrent double-submit.
     */
    private static function next_move_number( int $game_id, ?array $moves = null ): int {
        if ( is_array( $moves ) ) {
            return $moves ? (int) end( $moves )['move_number'] + 1 : 1;
        }
        global $wpdb;
        $max = (int) $wpdb->get_var( $wpdb->prepare(
            "SELECT COALESCE(MAX(move_number), 0) FROM {$wpdb->prefix}go3d_moves WHERE game_id = %d",
            $game_id
        ) );
        return $max + 1;
    }

    private static function sanitise_move( array $m ): array {
        $out = [
            'move_number' => (int)$m['move_number'],
            'player_id'   => (int)$m['player_id'],
            'type'        => $m['type'],
            'created_at'  => $m['created_at'],
        ];
        // Cube/stack moves carry full x,y,z. Sphere moves carry only x (a node
        // index); y/z are null and must stay absent rather than collapse to 0.
        if ( $m['x'] !== null ) {
            $out['x'] = (int)$m['x'];
            if ( $m['y'] !== null ) $out['y'] = (int)$m['y'];
            if ( $m['z'] !== null ) $out['z'] = (int)$m['z'];
        }
        if ( $m['time_ms'] !== null ) $out['time_ms'] = (int)$m['time_ms'];
        return $out;
    }
}
