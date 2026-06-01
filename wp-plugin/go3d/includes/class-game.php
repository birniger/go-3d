<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Game CRUD, move submission, state management.
 */
class Go3D_Game {

    // ── Create / join ─────────────────────────────────────────────────────────

    /**
     * Create a new game (or accept an open challenge).
     *
     * @return array{ok:true,game_id:int}|array{ok:false,error:string,code:int}
     */
    public static function create( int $player1_id, array $settings ): array {
        global $wpdb;
        $t = $wpdb->prefix . 'go3d_games';

        $board_size   = in_array( (int)($settings['board_size']   ?? 9), [4,5,6,7,8,9,13,19], true ) ? (int)$settings['board_size']   : 9;
        $scoring_mode = in_array( $settings['scoring_mode'] ?? '', ['chinese','japanese'],      true ) ? $settings['scoring_mode']      : 'chinese';
        $komi         = (float)( $settings['komi']         ?? 6.5 );
        $time_control = in_array( $settings['time_control'] ?? '', ['none','absolute','byoyomi','fischer'], true ) ? $settings['time_control'] : 'none';
        $time_settings = isset( $settings['time_settings'] ) ? wp_json_encode( $settings['time_settings'] ) : null;

        // Derive initial clocks
        $p1_time_ms = null;
        $p2_time_ms = null;
        if ( $time_control !== 'none' && isset( $settings['time_settings']['main_time_s'] ) ) {
            $main = (int)$settings['time_settings']['main_time_s'] * 1000;
            $p1_time_ms = $main;
            $p2_time_ms = $main;
        }

        $empty_logic = new Go3D_Game_Logic( $board_size );
        $hash        = $empty_logic->hash();

        $wpdb->insert( $t, [
            'player1_id'       => $player1_id,
            'board_size'       => $board_size,
            'scoring_mode'     => $scoring_mode,
            'komi'             => $komi,
            'time_control'     => $time_control,
            'time_settings'    => $time_settings,
            'p1_time_ms'       => $p1_time_ms,
            'p2_time_ms'       => $p2_time_ms,
            'current_player'   => 1,
            'consecutive_passes' => 0,
            'board_hash'       => $hash,
            'history_hashes'   => wp_json_encode( [$hash] ),
            'status'           => 'open',
            'created_at'       => current_time( 'mysql' ),
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

        $wpdb->update( $t, [
            'player2_id' => $player2_id,
            'status'     => 'active',
        ], [ 'id' => $game_id ] );

        Go3D_Pusher::trigger( "game-$game_id", 'player-joined', [
            'player2_id' => $player2_id,
        ] );

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

        $player_slot = self::player_slot( $game, $user_id );
        if ( ! $player_slot )
            return [ 'ok' => false, 'error' => 'You are not a player in this game.', 'code' => 403 ];
        if ( (int)$game['current_player'] !== $player_slot )
            return [ 'ok' => false, 'error' => 'It is not your turn.', 'code' => 409 ];

        $type    = $move_data['type'] ?? '';
        $time_ms = isset( $move_data['time_ms'] ) ? (int)$move_data['time_ms'] : null;

        // Deduct clock time
        $p1_time_ms = $game['p1_time_ms'] !== null ? (int)$game['p1_time_ms'] : null;
        $p2_time_ms = $game['p2_time_ms'] !== null ? (int)$game['p2_time_ms'] : null;
        if ( $time_ms !== null && $game['time_control'] !== 'none' ) {
            if ( $player_slot === 1 && $p1_time_ms !== null ) $p1_time_ms = max( 0, $p1_time_ms - $time_ms );
            if ( $player_slot === 2 && $p2_time_ms !== null ) $p2_time_ms = max( 0, $p2_time_ms - $time_ms );
        }

        if ( $type === 'resign' ) {
            return self::end_game( $game, $user_id, $player_slot, 'resign', $time_ms, $p1_time_ms, $p2_time_ms );
        }

        if ( $type === 'pass' ) {
            return self::handle_pass( $game, $user_id, $player_slot, $time_ms, $p1_time_ms, $p2_time_ms );
        }

        if ( $type === 'place' ) {
            return self::handle_place( $game, $user_id, $player_slot, $move_data, $time_ms, $p1_time_ms, $p2_time_ms );
        }

        return [ 'ok' => false, 'error' => 'Unknown move type.', 'code' => 422 ];
    }

    // ── Pass ─────────────────────────────────────────────────────────────────

    private static function handle_pass( array $game, int $user_id, int $player_slot, ?int $time_ms, ?int $p1_time_ms, ?int $p2_time_ms ): array {
        global $wpdb;
        $gt = $wpdb->prefix . 'go3d_games';
        $mt = $wpdb->prefix . 'go3d_moves';

        $consecutive = (int)$game['consecutive_passes'] + 1;
        $next_player = 3 - $player_slot;
        $move_number = self::next_move_number( (int)$game['id'] );

        $wpdb->insert( $mt, [
            'game_id'     => $game['id'],
            'move_number' => $move_number,
            'player_id'   => $user_id,
            'type'        => 'pass',
            'time_ms'     => $time_ms,
            'created_at'  => current_time( 'mysql' ),
        ] );

        $now = current_time( 'mysql' );

        if ( $consecutive >= 2 ) {
            // Two consecutive passes → score and end
            return self::end_by_scoring( $game, $move_number, $p1_time_ms, $p2_time_ms );
        }

        $wpdb->update( $gt, [
            'consecutive_passes' => $consecutive,
            'current_player'     => $next_player,
            'p1_time_ms'         => $p1_time_ms,
            'p2_time_ms'         => $p2_time_ms,
            'last_move_at'       => $now,
        ], [ 'id' => $game['id'] ] );

        $payload = [
            'type'        => 'pass',
            'move_number' => $move_number,
            'player_slot' => $player_slot,
            'next_player' => $next_player,
            'p1_time_ms'  => $p1_time_ms,
            'p2_time_ms'  => $p2_time_ms,
        ];
        Go3D_Pusher::trigger( "game-{$game['id']}", 'move', $payload );

        return [ 'ok' => true, 'event' => 'move', 'payload' => $payload ];
    }

    // ── Place ────────────────────────────────────────────────────────────────

    private static function handle_place( array $game, int $user_id, int $player_slot, array $move_data, ?int $time_ms, ?int $p1_time_ms, ?int $p2_time_ms ): array {
        global $wpdb;
        $gt = $wpdb->prefix . 'go3d_games';
        $mt = $wpdb->prefix . 'go3d_moves';

        $x = isset( $move_data['x'] ) ? (int)$move_data['x'] : -1;
        $y = isset( $move_data['y'] ) ? (int)$move_data['y'] : -1;
        $z = isset( $move_data['z'] ) ? (int)$move_data['z'] : -1;

        // Reconstruct board from move history
        $moves = self::get_moves( (int)$game['id'] );
        $logic = Go3D_Game_Logic::replay( (int)$game['board_size'], $moves );

        // Superko history
        $history = json_decode( $game['history_hashes'] ?? '[]', true ) ?: [];

        $result = $logic->place( $x, $y, $z, $player_slot, $history );
        if ( ! $result['ok'] ) {
            return [ 'ok' => false, 'error' => $result['reason'], 'code' => 422 ];
        }

        $move_number = self::next_move_number( (int)$game['id'] );
        $history[]   = $result['hash'];

        $wpdb->insert( $mt, [
            'game_id'     => $game['id'],
            'move_number' => $move_number,
            'player_id'   => $user_id,
            'type'        => 'place',
            'x'           => $x,
            'y'           => $y,
            'z'           => $z,
            'time_ms'     => $time_ms,
            'created_at'  => current_time( 'mysql' ),
        ] );

        $next_player = 3 - $player_slot;

        $wpdb->update( $gt, [
            'consecutive_passes' => 0,
            'current_player'     => $next_player,
            'board_hash'         => $result['hash'],
            'history_hashes'     => wp_json_encode( $history ),
            'p1_time_ms'         => $p1_time_ms,
            'p2_time_ms'         => $p2_time_ms,
            'last_move_at'       => current_time( 'mysql' ),
        ], [ 'id' => $game['id'] ] );

        $payload = [
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
        ];
        Go3D_Pusher::trigger( "game-{$game['id']}", 'move', $payload );

        return [ 'ok' => true, 'event' => 'move', 'payload' => $payload ];
    }

    // ── End game ──────────────────────────────────────────────────────────────

    /**
     * End game by resignation or timeout.
     * $loser_slot = 1 or 2 (the player who lost).
     */
    private static function end_game( array $game, int $user_id, int $loser_slot, string $reason, ?int $time_ms, ?int $p1_time_ms, ?int $p2_time_ms ): array {
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
                'created_at'  => current_time( 'mysql' ),
            ] );
        }

        $winner_slot = 3 - $loser_slot;
        $winner_id   = (int)$game[ "player{$winner_slot}_id" ];
        $loser_id    = (int)$game[ "player{$loser_slot}_id" ];

        return self::finalise_game( $game, $winner_id, $loser_id, $reason, null, null, $p1_time_ms, $p2_time_ms );
    }

    /**
     * End game by double-pass → count territory.
     */
    private static function end_by_scoring( array $game, int $move_number, ?int $p1_time_ms, ?int $p2_time_ms ): array {
        $moves  = self::get_moves( (int)$game['id'] );
        $logic  = Go3D_Game_Logic::replay( (int)$game['board_size'], $moves );
        $terr   = $logic->count_territory();
        $komi   = (float)$game['komi'];
        $mode   = $game['scoring_mode'];

        if ( $mode === 'japanese' ) {
            // Count prisoners from move log
            $prisoners = [1 => 0, 2 => 0];
            foreach ( $moves as $m ) {
                // captured stones go to the capturing player's count — but
                // we don't store per-move captured count in the DB.
                // Re-replay incrementally to count captures.
            }
            // Simple approach: replay capture counts
            $p1_captures = 0; $p2_captures = 0;
            $logic2 = new Go3D_Game_Logic( (int)$game['board_size'] );
            foreach ( $moves as $m ) {
                if ( $m['type'] === 'place' ) {
                    $slot = (int)$m['player_id'] % 2 === 0 ? 2 : 1; // approximation
                    // Determine slot from game
                    if ( (int)$m['player_id'] === (int)$game['player1_id'] ) $slot = 1;
                    elseif ( (int)$m['player_id'] === (int)$game['player2_id'] ) $slot = 2;
                    $r = $logic2->place( (int)$m['x'], (int)$m['y'], (int)$m['z'], $slot );
                    if ( $r['ok'] ) {
                        $cap_count = count( $r['captured'] );
                        if ( $slot === 1 ) $p2_captures += $cap_count; // p1 captures p2's stones
                        else              $p1_captures += $cap_count;
                    }
                }
            }
            $p1_score = $terr['black'] + $p1_captures;
            $p2_score = $terr['white'] + $p2_captures + $komi;
        } else {
            // Chinese: territory + stones on board + komi
            $p1_score = $terr['black'] + $terr['blackStones'];
            $p2_score = $terr['white'] + $terr['whiteStones'] + $komi;
        }

        $p1_id = (int)$game['player1_id'];
        $p2_id = (int)$game['player2_id'];

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

        return self::finalise_game( $game, $winner_id, null, $reason, $p1_score, $p2_score, $p1_time_ms, $p2_time_ms );
    }

    /**
     * Write the finished state, update ELO, fire Pusher event, queue notification.
     */
    private static function finalise_game( array $game, ?int $winner_id, ?int $loser_id, string $end_reason, ?float $p1_score, ?float $p2_score, ?int $p1_time_ms, ?int $p2_time_ms ): array {
        global $wpdb;
        $gt  = $wpdb->prefix . 'go3d_games';
        $now = current_time( 'mysql' );

        $p1_id = (int)$game['player1_id'];
        $p2_id = $game['player2_id'] ? (int)$game['player2_id'] : null;

        // ELO
        $elo_change_p1 = 0;
        $elo_change_p2 = 0;
        if ( $p2_id && $end_reason !== 'score_draw' ) {
            $outcome = null;
            if ( $winner_id === $p1_id )      $outcome = 'p1_wins';
            elseif ( $winner_id === $p2_id )   $outcome = 'p2_wins';
            if ( $outcome ) {
                [ $elo_change_p1, $elo_change_p2 ] = Go3D_Elo::update( $p1_id, $p2_id, $outcome );
            }
        }

        $wpdb->update( $gt, [
            'status'        => 'finished',
            'winner_id'     => $winner_id,
            'end_reason'    => $end_reason,
            'p1_score'      => $p1_score,
            'p2_score'      => $p2_score,
            'elo_change_p1' => $elo_change_p1,
            'elo_change_p2' => $elo_change_p2,
            'p1_time_ms'    => $p1_time_ms,
            'p2_time_ms'    => $p2_time_ms,
            'finished_at'   => $now,
            'last_move_at'  => $now,
        ], [ 'id' => $game['id'] ] );

        $payload = [
            'status'        => 'finished',
            'end_reason'    => $end_reason,
            'winner_id'     => $winner_id,
            'p1_score'      => $p1_score,
            'p2_score'      => $p2_score,
            'elo_change_p1' => $elo_change_p1,
            'elo_change_p2' => $elo_change_p2,
        ];
        Go3D_Pusher::trigger( "game-{$game['id']}", 'game-over', $payload );

        // Queue result notifications
        if ( $p2_id ) {
            Go3D_Notifications::queue_result( (int)$game['id'], $p1_id, $winner_id );
            Go3D_Notifications::queue_result( (int)$game['id'], $p2_id, $winner_id );
        }

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

        $moves = self::get_moves( $game_id );
        $logic = Go3D_Game_Logic::replay( (int)$game['board_size'], $moves );

        return [
            'id'                 => (int)$game['id'],
            'player1_id'         => (int)$game['player1_id'],
            'player2_id'         => $game['player2_id'] ? (int)$game['player2_id'] : null,
            'board_size'         => (int)$game['board_size'],
            'scoring_mode'       => $game['scoring_mode'],
            'komi'               => (float)$game['komi'],
            'time_control'       => $game['time_control'],
            'time_settings'      => $game['time_settings'] ? json_decode( $game['time_settings'], true ) : null,
            'p1_time_ms'         => $game['p1_time_ms'] !== null ? (int)$game['p1_time_ms'] : null,
            'p2_time_ms'         => $game['p2_time_ms'] !== null ? (int)$game['p2_time_ms'] : null,
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
            'moves'              => array_map( [ __CLASS__, 'sanitise_move' ], $moves ),
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

        $status_sql = $wpdb->prepare( 'status = %s', $status );
        $rows = $wpdb->get_results( $wpdb->prepare(
            "SELECT id, player1_id, player2_id, board_size, scoring_mode, komi,
                    time_control, current_player, status, winner_id, end_reason,
                    p1_score, p2_score, elo_change_p1, elo_change_p2,
                    created_at, last_move_at, finished_at
             FROM $t
             WHERE (player1_id = %d OR player2_id = %d) AND $status_sql
             ORDER BY last_move_at DESC
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
        return $wpdb->get_results( $wpdb->prepare(
            "SELECT id, player1_id, board_size, scoring_mode, komi, time_control, created_at
             FROM $t WHERE status = 'open' ORDER BY created_at DESC LIMIT %d OFFSET %d",
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
            $current = (int)$game['current_player'];
            $clock   = $current === 1 ? (int)$game['p1_time_ms'] : (int)$game['p2_time_ms'];
            if ( $game['last_move_at'] === null ) continue;

            $elapsed_ms = ( time() - strtotime( $game['last_move_at'] ) ) * 1000;
            if ( $elapsed_ms > $clock ) {
                // This player timed out
                $loser_id  = (int)$game[ "player{$current}_id" ];
                self::end_game( $game, $loser_id, $current, 'timeout', null,
                    $current === 1 ? 0 : (int)$game['p1_time_ms'],
                    $current === 2 ? 0 : (int)$game['p2_time_ms'] );
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static function player_slot( array $game, int $user_id ): ?int {
        if ( (int)$game['player1_id'] === $user_id ) return 1;
        if ( $game['player2_id'] && (int)$game['player2_id'] === $user_id ) return 2;
        return null;
    }

    private static function next_move_number( int $game_id ): int {
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
        if ( $m['x'] !== null ) { $out['x'] = (int)$m['x']; $out['y'] = (int)$m['y']; $out['z'] = (int)$m['z']; }
        if ( $m['time_ms'] !== null ) $out['time_ms'] = (int)$m['time_ms'];
        return $out;
    }
}
