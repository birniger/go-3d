<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Minimal Pusher Channels HTTP API client — no SDK, no Composer.
 * Docs: https://pusher.com/docs/channels/library_auth_reference/rest-api/
 */
class Go3D_Pusher {

    // ── Trigger ───────────────────────────────────────────────────────────────

    /**
     * Trigger an event on a channel.
     *
     * @param string $channel  e.g. "game-42"
     * @param string $event    e.g. "move"
     * @param array  $data     Will be JSON-encoded as event body.
     * @return bool            True on success (2xx), false otherwise.
     */
    public static function trigger( string $channel, string $event, array $data ): bool {
        $app_id  = get_option( 'go3d_pusher_app_id',  '' );
        $key     = get_option( 'go3d_pusher_key',     '' );
        $secret  = get_option( 'go3d_pusher_secret',  '' );
        $cluster = get_option( 'go3d_pusher_cluster', 'eu' );

        if ( ! $app_id || ! $key || ! $secret ) return false;

        $body         = wp_json_encode( [
            'name'     => $event,
            'channel'  => $channel,
            'data'     => wp_json_encode( $data ), // Pusher expects data as a JSON string
        ] );
        $body_md5     = md5( $body );
        $timestamp    = time();
        $path         = "/apps/$app_id/events";
        $query_params = http_build_query( [
            'auth_key'       => $key,
            'auth_timestamp' => $timestamp,
            'auth_version'   => '1.0',
            'body_md5'       => $body_md5,
        ] );

        $string_to_sign = implode( "\n", [ 'POST', $path, $query_params ] );
        $auth_signature = hash_hmac( 'sha256', $string_to_sign, $secret );

        $url = "https://api-$cluster.pusher.com$path?$query_params&auth_signature=$auth_signature";

        $response = wp_remote_post( $url, [
            'body'    => $body,
            'headers' => [ 'Content-Type' => 'application/json' ],
            'timeout' => 5,
        ] );

        if ( is_wp_error( $response ) ) {
            error_log( 'Go3D Pusher error: ' . $response->get_error_message() );
            return false;
        }

        $code = wp_remote_retrieve_response_code( $response );
        return $code >= 200 && $code < 300;
    }

    // ── Auth endpoint (private channels) ─────────────────────────────────────

    /**
     * Authenticate a Pusher channel subscription request.
     * Called by the frontend Pusher JS SDK when it subscribes to "private-game-{id}".
     *
     * @return array{ok:true,auth:string}|array{ok:false,error:string,code:int}
     */
    public static function auth_channel( string $socket_id, string $channel, int $user_id ): array {
        $key    = get_option( 'go3d_pusher_key',    '' );
        $secret = get_option( 'go3d_pusher_secret', '' );
        if ( ! $key || ! $secret )
            return [ 'ok' => false, 'error' => 'Pusher not configured.', 'code' => 500 ];

        // Default-deny: the only private channels this app uses are per-game
        // channels, and you must be one of the two players to subscribe.
        if ( ! preg_match( '/^private-game-(\d+)$/', $channel, $matches ) ) {
            return [ 'ok' => false, 'error' => 'Unknown private channel.', 'code' => 403 ];
        }
        $game_id = (int)$matches[1];
        $game    = Go3D_Game::get_row( $game_id );
        if ( ! $game )
            return [ 'ok' => false, 'error' => 'Game not found.', 'code' => 404 ];
        if ( (int)$game['player1_id'] !== $user_id && (int)($game['player2_id'] ?? 0) !== $user_id )
            return [ 'ok' => false, 'error' => 'Not a player in this game.', 'code' => 403 ];

        $string_to_sign = "$socket_id:$channel";
        $signature      = hash_hmac( 'sha256', $string_to_sign, $secret );
        $auth           = "$key:$signature";

        return [ 'ok' => true, 'auth' => $auth ];
    }

    // ── Presence channel (lobby) ──────────────────────────────────────────────

    /**
     * Authenticate a presence channel (e.g. "presence-lobby").
     * Pusher passes user info along with the channel data so other subscribers
     * can see who is online.
     *
     * @return array{ok:true,auth:string,channel_data:string}|array{ok:false,error:string,code:int}
     */
    public static function auth_presence( string $socket_id, string $channel, int $user_id ): array {
        $key    = get_option( 'go3d_pusher_key',    '' );
        $secret = get_option( 'go3d_pusher_secret', '' );
        if ( ! $key || ! $secret )
            return [ 'ok' => false, 'error' => 'Pusher not configured.', 'code' => 500 ];

        $user     = Go3D_Auth::get_user( $user_id );
        $ch_data  = wp_json_encode( [
            'user_id'   => (string)$user_id,
            'user_info' => [
                'username'   => $user['username'] ?? '',
                'avatar_url' => $user['avatar_url'] ?? null,
                'elo'        => (int)($user['elo'] ?? 1500),
            ],
        ] );
        $string_to_sign = "$socket_id:$channel:$ch_data";
        $signature      = hash_hmac( 'sha256', $string_to_sign, $secret );

        return [
            'ok'           => true,
            'auth'         => "$key:$signature",
            'channel_data' => $ch_data,
        ];
    }
}
