<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class Go3D_Database {

    const DB_VERSION = '1.1';

    /**
     * Run install() (dbDelta) whenever the stored schema version is behind the
     * code. dbDelta diffs the CREATE TABLE statements and issues ALTER TABLE
     * ADD COLUMN for any new columns, so existing installs pick up new fields
     * (e.g. games.mode / games.active_layer) without a manual reinstall.
     */
    public static function maybe_upgrade(): void {
        if ( get_option( 'go3d_db_version' ) !== self::DB_VERSION ) {
            self::install();
        }
    }

    public static function install(): void {
        global $wpdb;
        $charset = $wpdb->get_charset_collate();
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';

        // ── Users ────────────────────────────────────────────────────────────
        dbDelta( "CREATE TABLE {$wpdb->prefix}go3d_users (
            id            BIGINT(20)   NOT NULL AUTO_INCREMENT,
            username      VARCHAR(30)  NOT NULL,
            email         VARCHAR(254) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            avatar_url    VARCHAR(512)          DEFAULT NULL,
            bio           TEXT                  DEFAULT NULL,
            elo           SMALLINT(5)  NOT NULL DEFAULT 1500,
            games_played  SMALLINT(5)  NOT NULL DEFAULT 0,
            wins          SMALLINT(5)  NOT NULL DEFAULT 0,
            losses        SMALLINT(5)  NOT NULL DEFAULT 0,
            draws         SMALLINT(5)  NOT NULL DEFAULT 0,
            email_verified     TINYINT(1)   NOT NULL DEFAULT 0,
            verification_token VARCHAR(64)          DEFAULT NULL,
            reset_token        VARCHAR(64)          DEFAULT NULL,
            reset_expires      DATETIME             DEFAULT NULL,
            notify_idle_hours  TINYINT(3)   NOT NULL DEFAULT 24,
            notify_timeout_mins SMALLINT(5) NOT NULL DEFAULT 60,
            created_at    DATETIME     NOT NULL,
            last_seen_at  DATETIME              DEFAULT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_username (username),
            UNIQUE KEY uq_email    (email),
            KEY idx_verification_token (verification_token),
            KEY idx_reset_token        (reset_token)
        ) $charset;" );

        // ── Games ────────────────────────────────────────────────────────────
        dbDelta( "CREATE TABLE {$wpdb->prefix}go3d_games (
            id                BIGINT(20)   NOT NULL AUTO_INCREMENT,
            player1_id        BIGINT(20)   NOT NULL,
            player2_id        BIGINT(20)            DEFAULT NULL,
            board_size        TINYINT(2)   NOT NULL DEFAULT 9,
            mode              VARCHAR(8)   NOT NULL DEFAULT 'cube',
            active_layer      TINYINT(2)   NOT NULL DEFAULT 0,
            scoring_mode      VARCHAR(12)  NOT NULL DEFAULT 'chinese',
            komi              DECIMAL(4,1) NOT NULL DEFAULT 6.5,
            time_control      VARCHAR(12)  NOT NULL DEFAULT 'none',
            time_settings     TEXT                  DEFAULT NULL,
            p1_time_ms        INT(11)               DEFAULT NULL,
            p2_time_ms        INT(11)               DEFAULT NULL,
            current_player    TINYINT(1)   NOT NULL DEFAULT 1,
            consecutive_passes TINYINT(1)  NOT NULL DEFAULT 0,
            board_hash        VARCHAR(512)          DEFAULT NULL,
            history_hashes    MEDIUMTEXT            DEFAULT NULL,
            status            VARCHAR(12)  NOT NULL DEFAULT 'open',
            winner_id         BIGINT(20)            DEFAULT NULL,
            end_reason        VARCHAR(20)           DEFAULT NULL,
            p1_score          DECIMAL(6,1)          DEFAULT NULL,
            p2_score          DECIMAL(6,1)          DEFAULT NULL,
            elo_change_p1     SMALLINT(5)           DEFAULT NULL,
            elo_change_p2     SMALLINT(5)           DEFAULT NULL,
            created_at        DATETIME     NOT NULL,
            last_move_at      DATETIME              DEFAULT NULL,
            finished_at       DATETIME              DEFAULT NULL,
            PRIMARY KEY (id),
            KEY idx_player1   (player1_id),
            KEY idx_player2   (player2_id),
            KEY idx_status    (status),
            KEY idx_last_move (last_move_at)
        ) $charset;" );

        // ── Moves ────────────────────────────────────────────────────────────
        dbDelta( "CREATE TABLE {$wpdb->prefix}go3d_moves (
            id          BIGINT(20)  NOT NULL AUTO_INCREMENT,
            game_id     BIGINT(20)  NOT NULL,
            move_number SMALLINT(5) NOT NULL,
            player_id   BIGINT(20)  NOT NULL,
            type        VARCHAR(8)  NOT NULL,
            x           TINYINT(2)           DEFAULT NULL,
            y           TINYINT(2)           DEFAULT NULL,
            z           TINYINT(2)           DEFAULT NULL,
            time_ms     INT(11)              DEFAULT NULL,
            created_at  DATETIME    NOT NULL,
            PRIMARY KEY (id),
            KEY idx_game_id (game_id),
            UNIQUE KEY uq_game_move (game_id, move_number)
        ) $charset;" );

        // ── Challenges ───────────────────────────────────────────────────────
        dbDelta( "CREATE TABLE {$wpdb->prefix}go3d_challenges (
            id             BIGINT(20)   NOT NULL AUTO_INCREMENT,
            challenger_id  BIGINT(20)   NOT NULL,
            challenged_id  BIGINT(20)            DEFAULT NULL,
            board_size     TINYINT(2)   NOT NULL DEFAULT 9,
            mode           VARCHAR(8)   NOT NULL DEFAULT 'cube',
            scoring_mode   VARCHAR(12)  NOT NULL DEFAULT 'chinese',
            komi           DECIMAL(4,1) NOT NULL DEFAULT 6.5,
            time_control   VARCHAR(12)  NOT NULL DEFAULT 'none',
            time_settings  TEXT                  DEFAULT NULL,
            is_open        TINYINT(1)   NOT NULL DEFAULT 0,
            status         VARCHAR(10)  NOT NULL DEFAULT 'pending',
            game_id        BIGINT(20)            DEFAULT NULL,
            created_at     DATETIME     NOT NULL,
            expires_at     DATETIME     NOT NULL,
            PRIMARY KEY (id),
            KEY idx_challenger  (challenger_id),
            KEY idx_challenged  (challenged_id),
            KEY idx_status      (status)
        ) $charset;" );

        // ── Notification log (prevents duplicate sends) ───────────────────────
        dbDelta( "CREATE TABLE {$wpdb->prefix}go3d_notif_log (
            id        BIGINT(20)  NOT NULL AUTO_INCREMENT,
            user_id   BIGINT(20)  NOT NULL,
            game_id   BIGINT(20)           DEFAULT NULL,
            type      VARCHAR(20) NOT NULL,
            sent_at   DATETIME    NOT NULL,
            PRIMARY KEY (id),
            KEY idx_user_game_type (user_id, game_id, type)
        ) $charset;" );

        update_option( 'go3d_db_version', self::DB_VERSION );
    }

    public static function deactivate(): void {
        wp_clear_scheduled_hook( 'go3d_hourly_notifications' );
    }
}
