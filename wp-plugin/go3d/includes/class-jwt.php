<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Minimal HS256 JWT — no Composer dependency.
 */
class Go3D_JWT {

    private static function secret(): string {
        // A wp-config.php constant takes precedence over the DB option, so the
        // signing key can live outside the database (and survive a DB dump /
        // backup leak). Define it as:  define( 'GO3D_JWT_SECRET', '…' );
        if ( defined( 'GO3D_JWT_SECRET' ) && is_string( GO3D_JWT_SECRET ) && GO3D_JWT_SECRET !== '' ) {
            return GO3D_JWT_SECRET;
        }
        $s = get_option( 'go3d_jwt_secret', '' );
        if ( ! $s ) {
            $s = wp_generate_password( 64, true, true );
            update_option( 'go3d_jwt_secret', $s );
        }
        return $s;
    }

    private static function b64u_encode( string $data ): string {
        return rtrim( strtr( base64_encode( $data ), '+/', '-_' ), '=' );
    }

    private static function b64u_decode( string $data ): string {
        $pad = strlen( $data ) % 4;
        if ( $pad ) $data .= str_repeat( '=', 4 - $pad );
        return base64_decode( strtr( $data, '-_', '+/' ) );
    }

    /** Create a signed token. $extra_payload is merged into the claims. */
    public static function encode( int $user_id, array $extra = [], int $ttl_days = 30 ): string {
        $header  = self::b64u_encode( json_encode( [ 'alg' => 'HS256', 'typ' => 'JWT' ] ) );
        $payload = self::b64u_encode( json_encode( array_merge( [
            'sub' => $user_id,
            'iat' => time(),
            'exp' => time() + $ttl_days * DAY_IN_SECONDS,
        ], $extra ) ) );
        $sig = self::b64u_encode( hash_hmac( 'sha256', "$header.$payload", self::secret(), true ) );
        return "$header.$payload.$sig";
    }

    /**
     * Decode and validate. Returns the payload array or null on failure.
     * @return array<string,mixed>|null
     */
    public static function decode( string $token ): ?array {
        $parts = explode( '.', $token );
        if ( count( $parts ) !== 3 ) return null;

        [ $header, $payload, $sig ] = $parts;

        // Reject anything that doesn't explicitly declare HS256. We only ever
        // issue HS256, and pinning the algorithm closes off "alg" confusion
        // (e.g. a forged header asking for "none") before we trust the token.
        $hdr = json_decode( self::b64u_decode( $header ), true );
        if ( ! is_array( $hdr ) || ( $hdr['alg'] ?? '' ) !== 'HS256' ) return null;

        $expected = self::b64u_encode( hash_hmac( 'sha256', "$header.$payload", self::secret(), true ) );
        if ( ! hash_equals( $expected, $sig ) ) return null;

        $data = json_decode( self::b64u_decode( $payload ), true );
        if ( ! is_array( $data ) ) return null;
        if ( isset( $data['exp'] ) && $data['exp'] < time() ) return null;

        return $data;
    }

    /**
     * Extract JWT from the Authorization header.
     *
     * On Apache/CGI/FastCGI setups (common on shared hosts like Hetzner) the
     * Authorization header is frequently stripped from $_SERVER. We try every
     * known location in turn:
     *   1. $_SERVER['HTTP_AUTHORIZATION']            — standard
     *   2. $_SERVER['REDIRECT_HTTP_AUTHORIZATION']   — set by the .htaccess rule
     *   3. apache_request_headers() / getallheaders() — last resort
     *
     * The plugin ships an .htaccess snippet that repopulates (2); see
     * docs/htaccess-auth.txt.
     */
    public static function from_request(): ?string {
        $header = null;

        if ( ! empty( $_SERVER['HTTP_AUTHORIZATION'] ) ) {
            $header = $_SERVER['HTTP_AUTHORIZATION'];
        } elseif ( ! empty( $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ) ) {
            $header = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
        } else {
            $all = null;
            if ( function_exists( 'apache_request_headers' ) ) {
                $all = apache_request_headers();
            } elseif ( function_exists( 'getallheaders' ) ) {
                $all = getallheaders();
            }
            if ( is_array( $all ) ) {
                // Header names are case-insensitive — normalise before lookup.
                foreach ( $all as $name => $value ) {
                    if ( strcasecmp( $name, 'Authorization' ) === 0 ) {
                        $header = $value;
                        break;
                    }
                }
            }
        }

        if ( ! $header ) return null;
        $header = sanitize_text_field( $header );
        if ( preg_match( '/^Bearer\s+(.+)$/i', $header, $m ) ) return $m[1];
        return null;
    }

    /** Return the authenticated user_id for the current request, or null. */
    public static function current_user_id(): ?int {
        $token = self::from_request();
        if ( ! $token ) return null;
        $payload = self::decode( $token );
        return ( $payload && isset( $payload['sub'] ) ) ? (int) $payload['sub'] : null;
    }
}
