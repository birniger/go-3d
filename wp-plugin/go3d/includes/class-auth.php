<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class Go3D_Auth {

    // ── Registration ─────────────────────────────────────────────────────────

    /**
     * @return array{ok:true,user_id:int}|array{ok:false,error:string,code:int}
     */
    public static function register( string $username, string $email, string $password ): array {
        global $wpdb;
        $t = $wpdb->prefix . 'go3d_users';

        // Rate limit: max 10 registrations per IP per day
        $ip  = sanitize_text_field( $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0' );
        $key = 'go3d_reg_' . md5( $ip );
        $cnt = (int) get_transient( $key );
        if ( $cnt >= 10 ) {
            return [ 'ok' => false, 'error' => 'Too many registrations from your IP. Try again tomorrow.', 'code' => 429 ];
        }

        // Validate
        $username = sanitize_user( $username, true );
        $email    = sanitize_email( $email );

        if ( strlen( $username ) < 3 || strlen( $username ) > 30 ) {
            return [ 'ok' => false, 'error' => 'Username must be 3–30 characters.', 'code' => 422 ];
        }
        if ( ! preg_match( '/^[a-zA-Z0-9_\-]+$/', $username ) ) {
            return [ 'ok' => false, 'error' => 'Username may only contain letters, numbers, _ and -.', 'code' => 422 ];
        }
        if ( ! is_email( $email ) ) {
            return [ 'ok' => false, 'error' => 'Invalid email address.', 'code' => 422 ];
        }
        if ( strlen( $password ) < 8 ) {
            return [ 'ok' => false, 'error' => 'Password must be at least 8 characters.', 'code' => 422 ];
        }

        // Uniqueness
        if ( $wpdb->get_var( $wpdb->prepare( "SELECT id FROM $t WHERE username = %s", $username ) ) ) {
            return [ 'ok' => false, 'error' => 'Username already taken.', 'code' => 409 ];
        }
        if ( $wpdb->get_var( $wpdb->prepare( "SELECT id FROM $t WHERE email = %s", $email ) ) ) {
            return [ 'ok' => false, 'error' => 'An account with that email already exists.', 'code' => 409 ];
        }

        $token  = bin2hex( random_bytes( 32 ) );
        $result = $wpdb->insert( $t, [
            'username'           => $username,
            'email'              => $email,
            'password_hash'      => password_hash( $password, PASSWORD_BCRYPT, [ 'cost' => 12 ] ),
            'email_verified'     => 0,
            'verification_token' => $token,
            'created_at'         => current_time( 'mysql', true ),
        ] );

        // $wpdb->insert returns false on failure (e.g. a race on the unique
        // username/email index between the check above and this insert).
        if ( false === $result || ! $wpdb->insert_id ) {
            return [ 'ok' => false, 'error' => 'Could not create your account. Please try again.', 'code' => 500 ];
        }
        $user_id = (int) $wpdb->insert_id;

        // Bump rate-limit counter
        set_transient( $key, $cnt + 1, DAY_IN_SECONDS );

        // Send verification email
        self::send_verification_email( $user_id, $email, $username, $token );

        return [ 'ok' => true, 'user_id' => $user_id ];
    }

    // ── Login ────────────────────────────────────────────────────────────────

    /**
     * @return array{ok:true,token:string,user:array}|array{ok:false,error:string,code:int}
     */
    public static function login( string $email, string $password ): array {
        global $wpdb;
        $t = $wpdb->prefix . 'go3d_users';

        // Rate limit: 10 attempts per IP per 15 min
        $ip  = sanitize_text_field( $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0' );
        $key = 'go3d_login_' . md5( $ip );
        $cnt = (int) get_transient( $key );
        if ( $cnt >= 10 ) {
            return [ 'ok' => false, 'error' => 'Too many login attempts. Please wait 15 minutes.', 'code' => 429 ];
        }

        $user = $wpdb->get_row(
            $wpdb->prepare( "SELECT * FROM $t WHERE email = %s", sanitize_email( $email ) ),
            ARRAY_A
        );

        if ( ! $user || ! password_verify( $password, $user['password_hash'] ) ) {
            set_transient( $key, $cnt + 1, 15 * MINUTE_IN_SECONDS );
            return [ 'ok' => false, 'error' => 'Invalid email or password.', 'code' => 401 ];
        }

        if ( ! (int) $user['email_verified'] ) {
            return [ 'ok' => false, 'error' => 'Please verify your email address first. Check your inbox.', 'code' => 403 ];
        }

        // Rehash if cost has changed
        if ( password_needs_rehash( $user['password_hash'], PASSWORD_BCRYPT, [ 'cost' => 12 ] ) ) {
            $wpdb->update( $t, [ 'password_hash' => password_hash( $password, PASSWORD_BCRYPT, [ 'cost' => 12 ] ) ], [ 'id' => $user['id'] ] );
        }

        $wpdb->update( $t, [ 'last_seen_at' => current_time( 'mysql', true ) ], [ 'id' => $user['id'] ] );

        $token = Go3D_JWT::encode( (int) $user['id'] );
        return [ 'ok' => true, 'token' => $token, 'user' => self::public_user( $user ) ];
    }

    // ── Email verification ────────────────────────────────────────────────────

    public static function verify_email( string $token ): bool {
        global $wpdb;
        $t    = $wpdb->prefix . 'go3d_users';
        $user = $wpdb->get_row( $wpdb->prepare( "SELECT id FROM $t WHERE verification_token = %s", $token ), ARRAY_A );
        if ( ! $user ) return false;

        $wpdb->update( $t, [ 'email_verified' => 1, 'verification_token' => null ], [ 'id' => $user['id'] ] );
        return true;
    }

    // ── Password reset ────────────────────────────────────────────────────────

    public static function request_reset( string $email ): void {
        global $wpdb;
        $t    = $wpdb->prefix . 'go3d_users';
        $user = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM $t WHERE email = %s AND email_verified = 1", sanitize_email( $email ) ), ARRAY_A );
        if ( ! $user ) return; // Silently succeed — don't reveal whether email exists

        $token   = bin2hex( random_bytes( 32 ) );
        $expires = gmdate( 'Y-m-d H:i:s', time() + HOUR_IN_SECONDS );
        $wpdb->update( $t, [ 'reset_token' => $token, 'reset_expires' => $expires ], [ 'id' => $user['id'] ] );

        self::send_password_reset_email( $user['email'], $user['username'], $token );
    }

    public static function reset_password( string $token, string $new_password ): bool {
        global $wpdb;
        $t    = $wpdb->prefix . 'go3d_users';
        $user = $wpdb->get_row(
            $wpdb->prepare( "SELECT id FROM $t WHERE reset_token = %s AND reset_expires > %s", $token, gmdate( 'Y-m-d H:i:s' ) ),
            ARRAY_A
        );
        if ( ! $user ) return false;
        if ( strlen( $new_password ) < 8 ) return false;

        $wpdb->update( $t, [
            'password_hash' => password_hash( $new_password, PASSWORD_BCRYPT, [ 'cost' => 12 ] ),
            'reset_token'   => null,
            'reset_expires' => null,
        ], [ 'id' => $user['id'] ] );
        return true;
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** @return array<string,mixed>|null */
    public static function get_user( int $id ): ?array {
        global $wpdb;
        $row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}go3d_users WHERE id = %d", $id ), ARRAY_A );
        return $row ?: null;
    }

    /** Strip private fields before sending to clients. */
    public static function public_user( array $user ): array {
        unset( $user['password_hash'], $user['verification_token'], $user['reset_token'], $user['reset_expires'], $user['email'] );
        return $user;
    }

    // ── Emails ───────────────────────────────────────────────────────────────

    private static function send_verification_email( int $user_id, string $email, string $username, string $token ): void {
        $site  = get_option( 'go3d_site_name', get_bloginfo( 'name' ) );
        $from  = get_option( 'go3d_from_email', get_option( 'admin_email' ) );
        $fname = get_option( 'go3d_from_name',  $site );
        $url   = home_url( "/?go3d_verify=$token" );

        $subject = "Verify your $site game account";
        $body    = "Hi $username,\n\nClick the link below to verify your email and start playing:\n\n$url\n\nThis link expires in 48 hours.\n\n— $site";

        wp_mail( $email, $subject, $body, [
            "From: $fname <$from>",
            'Content-Type: text/plain; charset=UTF-8',
        ] );
    }

    private static function send_password_reset_email( string $email, string $username, string $token ): void {
        $site  = get_option( 'go3d_site_name', get_bloginfo( 'name' ) );
        $from  = get_option( 'go3d_from_email', get_option( 'admin_email' ) );
        $fname = get_option( 'go3d_from_name',  $site );
        $url   = home_url( "/?go3d_reset=$token" );

        $subject = "Reset your $site password";
        $body    = "Hi $username,\n\nSomeone requested a password reset for your account.\n\nClick here to set a new password (link valid for 1 hour):\n\n$url\n\nIf you didn't request this, you can safely ignore this email.\n\n— $site";

        wp_mail( $email, $subject, $body, [
            "From: $fname <$from>",
            'Content-Type: text/plain; charset=UTF-8',
        ] );
    }
}
