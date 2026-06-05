<?php
if ( ! defined( 'ABSPATH' ) ) exit;

// Handle bug-report row actions (mark resolved / reopen / delete) before output.
if ( ! empty( $_POST['go3d_bug_action'] ) && current_user_can( 'manage_options' ) ) {
    check_admin_referer( 'go3d_bug_action' );
    $bug_id = isset( $_POST['bug_id'] ) ? (int) $_POST['bug_id'] : 0;
    $action = sanitize_text_field( wp_unslash( $_POST['go3d_bug_action'] ) );
    if ( $bug_id ) {
        if ( 'resolve' === $action )      Go3D_Bug_Report::set_resolved( $bug_id, true );
        elseif ( 'reopen' === $action )   Go3D_Bug_Report::set_resolved( $bug_id, false );
        elseif ( 'delete' === $action )   Go3D_Bug_Report::delete( $bug_id );
    }
}
?>
<div class="wrap">
  <h1><?php esc_html_e( 'Go³D Settings', 'go3d' ); ?></h1>

  <?php settings_errors( 'go3d_messages' ); ?>

  <!-- ── Overview / statistics ───────────────────────────────────── -->
  <?php
    $go3d_stats = Go3D_Stats::summary();
    $go3d_u     = $go3d_stats['users'];
    $go3d_g     = $go3d_stats['games'];
    $go3d_modes = $go3d_stats['modes'];

    // Render one stat card. $sub is an optional smaller line under the number.
    $go3d_card = function ( $label, $value, $sub = '', $accent = '#2271b1' ) {
      printf(
        '<div style="flex:1;min-width:150px;background:#fff;border:1px solid #dcdcde;border-top:3px solid %s;border-radius:6px;padding:12px 16px;">
           <div style="font-size:26px;font-weight:600;line-height:1.1;">%s</div>
           <div style="color:#50575e;font-size:13px;margin-top:2px;">%s</div>
           %s
         </div>',
        esc_attr( $accent ),
        esc_html( number_format_i18n( (int) $value ) ),
        esc_html( $label ),
        $sub ? '<div style="color:#787c82;font-size:11px;margin-top:4px;">' . esc_html( $sub ) . '</div>' : ''
      );
    };
  ?>
  <h2 style="margin-top:18px;"><?php esc_html_e( 'Overview', 'go3d' ); ?></h2>
  <div style="display:flex;flex-wrap:wrap;gap:12px;max-width:1000px;margin:8px 0 6px;">
    <?php
      $go3d_card(
        __( 'Player accounts', 'go3d' ),
        $go3d_u['total'],
        sprintf( __( '%1$s verified · %2$s active (7d)', 'go3d' ), number_format_i18n( $go3d_u['verified'] ), number_format_i18n( $go3d_u['active7'] ) ),
        '#2271b1'
      );
      $go3d_card(
        __( 'New players (30d)', 'go3d' ),
        $go3d_u['new30'],
        sprintf( __( '%s in the last 7 days', 'go3d' ), number_format_i18n( $go3d_u['new7'] ) ),
        '#2271b1'
      );
      $go3d_card(
        __( 'Games total', 'go3d' ),
        $go3d_g['total'],
        sprintf( __( '%1$s open · %2$s active · %3$s finished', 'go3d' ),
          number_format_i18n( $go3d_g['open'] ), number_format_i18n( $go3d_g['active'] ), number_format_i18n( $go3d_g['finished'] ) ),
        '#00a32a'
      );
      $go3d_card(
        __( 'Games finished (30d)', 'go3d' ),
        $go3d_g['finished30'],
        sprintf( __( '%s in the last 7 days', 'go3d' ), number_format_i18n( $go3d_g['finished7'] ) ),
        '#00a32a'
      );
      $go3d_card(
        __( 'Stones placed', 'go3d' ),
        $go3d_stats['total_moves'],
        sprintf( __( 'Cube %1$s · Stack %2$s · Sphere %3$s', 'go3d' ),
          number_format_i18n( $go3d_modes['cube'] ?? 0 ),
          number_format_i18n( $go3d_modes['stack'] ?? 0 ),
          number_format_i18n( $go3d_modes['sphere'] ?? 0 ) ),
        '#8c5e00'
      );
    ?>
  </div>
  <p class="description" style="margin:0 0 4px;"><?php esc_html_e( 'Multiplayer games only — local hot-seat games are not recorded.', 'go3d' ); ?></p>

  <!-- ── Detailed stats ──────────────────────────────────────────── -->
  <?php
    $go3d_d = Go3D_Stats::detail();

    // Horizontal bar list: rows of [label, count, proportional bar].
    $go3d_bars = function ( array $data, array $labels = [], string $color = '#2271b1' ) {
      $max = max( 1, $data ? max( $data ) : 1 );
      $sum = array_sum( $data );
      if ( ! $sum ) { echo '<p style="color:#787c82;margin:4px 0;">' . esc_html__( 'No data yet.', 'go3d' ) . '</p>'; return; }
      echo '<div style="display:flex;flex-direction:column;gap:5px;max-width:460px;">';
      foreach ( $data as $k => $v ) {
        $label = $labels[ $k ] ?? ucfirst( (string) $k );
        $pct   = round( 100 * $v / $max );
        $share = round( 100 * $v / $sum );
        printf(
          '<div style="display:flex;align-items:center;gap:10px;font-size:13px;">
             <span style="width:120px;flex:none;color:#1d2327;">%s</span>
             <span style="flex:1;background:#f0f0f1;border-radius:4px;height:14px;overflow:hidden;">
               <span style="display:block;height:100%%;width:%d%%;background:%s;"></span>
             </span>
             <span style="width:96px;flex:none;color:#50575e;text-align:right;">%s (%d%%)</span>
           </div>',
          esc_html( $label ), (int) $pct, esc_attr( $color ),
          esc_html( number_format_i18n( $v ) ), (int) $share
        );
      }
      echo '</div>';
    };

    // Tiny sparkline as a row of vertical bars.
    $go3d_spark = function ( array $series, string $color = '#2271b1' ) {
      $counts = array_map( function ( $p ) { return (int) $p['count']; }, $series );
      $max    = max( 1, $counts ? max( $counts ) : 1 );
      $total  = array_sum( $counts );
      echo '<div style="display:flex;align-items:flex-end;gap:3px;height:46px;">';
      foreach ( $series as $p ) {
        $h = max( 2, round( 42 * $p['count'] / $max ) );
        printf(
          '<span title="%s: %d" style="width:14px;flex:none;height:%dpx;background:%s;border-radius:2px 2px 0 0;opacity:.85;"></span>',
          esc_attr( $p['day'] ), (int) $p['count'], (int) $h, esc_attr( $color )
        );
      }
      echo '</div>';
      printf( '<div style="color:#787c82;font-size:11px;margin-top:3px;">%s</div>',
        esc_html( sprintf( __( '%s in the last 14 days', 'go3d' ), number_format_i18n( $total ) ) ) );
    };

    $go3d_fmt_dur = function ( $secs ) {
      if ( $secs === null ) return '—';
      $secs = (int) $secs;
      if ( $secs < 90 )    return sprintf( _n( '%d sec', '%d secs', $secs, 'go3d' ), $secs );
      if ( $secs < 5400 )  return sprintf( __( '%d min', 'go3d' ), (int) round( $secs / 60 ) );
      return sprintf( __( '%.1f hrs', 'go3d' ), $secs / 3600 );
    };

    $go3d_o = $go3d_d['outcomes'];
  ?>

  <div style="display:flex;flex-wrap:wrap;gap:28px;max-width:1000px;margin:10px 0 6px;">
    <!-- How games end -->
    <div style="flex:1;min-width:380px;">
      <h2 style="margin:6px 0 8px;"><?php esc_html_e( 'How games end', 'go3d' ); ?></h2>
      <?php
        $go3d_bars(
          [ 'score' => $go3d_o['score'], 'resign' => $go3d_o['resign'], 'timeout' => $go3d_o['timeout'], 'draws' => $go3d_o['draws'] ],
          [ 'score' => __( 'Played out (scored)', 'go3d' ), 'resign' => __( 'Resignation', 'go3d' ), 'timeout' => __( 'Timeout', 'go3d' ), 'draws' => __( 'Draw', 'go3d' ) ],
          '#00a32a'
        );
      ?>
      <p style="margin:10px 0 0;color:#50575e;font-size:13px;">
        <?php printf(
          esc_html__( 'Avg length: %1$s moves · %2$s. Finished games: %3$s.', 'go3d' ),
          $go3d_o['avg_moves'] !== null ? esc_html( number_format_i18n( $go3d_o['avg_moves'], 1 ) ) : '—',
          esc_html( $go3d_fmt_dur( $go3d_o['avg_secs'] ) ),
          esc_html( number_format_i18n( $go3d_o['finished'] ) )
        ); ?>
      </p>
    </div>

    <!-- Colour balance -->
    <div style="flex:1;min-width:300px;">
      <h2 style="margin:6px 0 8px;"><?php esc_html_e( 'Black vs White', 'go3d' ); ?></h2>
      <?php
        $go3d_decided = $go3d_o['black_wins'] + $go3d_o['white_wins'];
        if ( ! $go3d_decided ) {
          echo '<p style="color:#787c82;">' . esc_html__( 'No decided games yet.', 'go3d' ) . '</p>';
        } else {
          $bp = round( 100 * $go3d_o['black_wins'] / $go3d_decided );
          printf(
            '<div style="display:flex;height:26px;border-radius:6px;overflow:hidden;max-width:380px;font-size:12px;color:#fff;">
               <span style="width:%1$d%%;background:#1d2327;display:flex;align-items:center;justify-content:center;">%2$s</span>
               <span style="flex:1;background:#787c82;display:flex;align-items:center;justify-content:center;">%3$s</span>
             </div>
             <div style="color:#50575e;font-size:13px;margin-top:6px;">%4$s</div>',
            (int) $bp,
            esc_html( $bp . '%' ),
            esc_html( ( 100 - $bp ) . '%' ),
            esc_html( sprintf( __( 'Black %1$s · White %2$s (decided games)', 'go3d' ),
              number_format_i18n( $go3d_o['black_wins'] ), number_format_i18n( $go3d_o['white_wins'] ) ) )
          );
        }
      ?>
    </div>
  </div>

  <!-- What people play -->
  <h2 style="margin:18px 0 8px;"><?php esc_html_e( 'What people play', 'go3d' ); ?></h2>
  <div style="display:flex;flex-wrap:wrap;gap:32px;max-width:1000px;">
    <div>
      <h4 style="margin:0 0 6px;color:#50575e;"><?php esc_html_e( 'Board size (N³ cube/stack, or sphere frequency)', 'go3d' ); ?></h4>
      <?php
        $go3d_bs = $go3d_d['dist']['board_size'];
        ksort( $go3d_bs, SORT_NUMERIC );
        $go3d_bars( $go3d_bs, [], '#2271b1' );
      ?>
    </div>
    <div>
      <h4 style="margin:0 0 6px;color:#50575e;"><?php esc_html_e( 'Time control', 'go3d' ); ?></h4>
      <?php $go3d_bars( $go3d_d['dist']['time_control'],
        [ 'none' => __( 'Correspondence', 'go3d' ), 'absolute' => __( 'Absolute', 'go3d' ), 'fischer' => __( 'Fischer', 'go3d' ), 'byoyomi' => __( 'Byo-yomi', 'go3d' ) ],
        '#8c5e00' ); ?>
    </div>
    <div>
      <h4 style="margin:0 0 6px;color:#50575e;"><?php esc_html_e( 'Scoring', 'go3d' ); ?></h4>
      <?php $go3d_bars( $go3d_d['dist']['scoring_mode'],
        [ 'chinese' => __( 'Chinese', 'go3d' ), 'japanese' => __( 'Japanese', 'go3d' ) ], '#3858e9' ); ?>
    </div>
  </div>

  <!-- Engagement + ratings -->
  <div style="display:flex;flex-wrap:wrap;gap:28px;max-width:1000px;margin-top:18px;">
    <div style="flex:1;min-width:300px;">
      <h2 style="margin:6px 0 8px;"><?php esc_html_e( 'Engagement', 'go3d' ); ?></h2>
      <table class="widefat striped" style="max-width:380px;">
        <tbody>
          <?php
            $go3d_e = $go3d_d['engagement'];
            $go3d_row = function ( $label, $value ) {
              printf( '<tr><td>%s</td><td style="text-align:right;font-weight:600;">%s</td></tr>',
                esc_html( $label ), esc_html( number_format_i18n( (int) $value ) ) );
            };
            $go3d_row( __( 'Active — last 24h', 'go3d' ),       $go3d_e['active1'] );
            $go3d_row( __( 'Active — last 7 days', 'go3d' ),    $go3d_e['active7'] );
            $go3d_row( __( 'Active — last 30 days', 'go3d' ),   $go3d_e['active30'] );
            $go3d_row( __( 'Players who have played', 'go3d' ), $go3d_e['played'] );
            $go3d_row( __( 'Returning (2+ games)', 'go3d' ),    $go3d_e['returning'] );
          ?>
        </tbody>
      </table>
    </div>
    <div style="flex:1;min-width:300px;">
      <h2 style="margin:6px 0 8px;"><?php esc_html_e( 'Ratings', 'go3d' ); ?></h2>
      <?php $go3d_el = $go3d_d['elo']; ?>
      <p style="font-size:14px;color:#50575e;">
        <?php printf(
          esc_html__( 'Average ELO %1$s · range %2$s–%3$s (players with games).', 'go3d' ),
          $go3d_el['avg'] !== null ? esc_html( number_format_i18n( $go3d_el['avg'] ) ) : '—',
          $go3d_el['min'] !== null ? esc_html( number_format_i18n( $go3d_el['min'] ) ) : '—',
          $go3d_el['max'] !== null ? esc_html( number_format_i18n( $go3d_el['max'] ) ) : '—'
        ); ?>
      </p>
    </div>
  </div>

  <!-- Top players -->
  <div style="display:flex;flex-wrap:wrap;gap:28px;max-width:1000px;margin-top:8px;">
    <div style="flex:1;min-width:300px;">
      <h4 style="margin:8px 0 6px;color:#50575e;"><?php esc_html_e( 'Top by rating', 'go3d' ); ?></h4>
      <?php if ( empty( $go3d_d['top_elo'] ) ) : ?>
        <p style="color:#787c82;"><?php esc_html_e( 'No rated players yet.', 'go3d' ); ?></p>
      <?php else : ?>
        <table class="widefat striped" style="max-width:380px;">
          <thead><tr><th><?php esc_html_e( 'Player', 'go3d' ); ?></th><th style="text-align:right;"><?php esc_html_e( 'ELO', 'go3d' ); ?></th><th style="text-align:right;"><?php esc_html_e( 'W/L', 'go3d' ); ?></th></tr></thead>
          <tbody>
            <?php foreach ( $go3d_d['top_elo'] as $p ) : ?>
              <tr>
                <td><?php echo esc_html( $p['username'] ); ?></td>
                <td style="text-align:right;font-weight:600;"><?php echo esc_html( number_format_i18n( (int) $p['elo'] ) ); ?></td>
                <td style="text-align:right;color:#50575e;"><?php echo esc_html( (int) $p['wins'] . '/' . (int) $p['losses'] ); ?></td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      <?php endif; ?>
    </div>
    <div style="flex:1;min-width:300px;">
      <h4 style="margin:8px 0 6px;color:#50575e;"><?php esc_html_e( 'Most active', 'go3d' ); ?></h4>
      <?php if ( empty( $go3d_d['top_games'] ) ) : ?>
        <p style="color:#787c82;"><?php esc_html_e( 'No games played yet.', 'go3d' ); ?></p>
      <?php else : ?>
        <table class="widefat striped" style="max-width:380px;">
          <thead><tr><th><?php esc_html_e( 'Player', 'go3d' ); ?></th><th style="text-align:right;"><?php esc_html_e( 'Games', 'go3d' ); ?></th><th style="text-align:right;"><?php esc_html_e( 'ELO', 'go3d' ); ?></th></tr></thead>
          <tbody>
            <?php foreach ( $go3d_d['top_games'] as $p ) : ?>
              <tr>
                <td><?php echo esc_html( $p['username'] ); ?></td>
                <td style="text-align:right;font-weight:600;"><?php echo esc_html( number_format_i18n( (int) $p['games_played'] ) ); ?></td>
                <td style="text-align:right;color:#50575e;"><?php echo esc_html( number_format_i18n( (int) $p['elo'] ) ); ?></td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      <?php endif; ?>
    </div>
  </div>

  <!-- Trends -->
  <h2 style="margin:18px 0 8px;"><?php esc_html_e( 'Last 14 days', 'go3d' ); ?></h2>
  <div style="display:flex;flex-wrap:wrap;gap:40px;max-width:1000px;">
    <div>
      <h4 style="margin:0 0 6px;color:#50575e;"><?php esc_html_e( 'New sign-ups', 'go3d' ); ?></h4>
      <?php $go3d_spark( $go3d_d['trend_signups'], '#2271b1' ); ?>
    </div>
    <div>
      <h4 style="margin:0 0 6px;color:#50575e;"><?php esc_html_e( 'Games created', 'go3d' ); ?></h4>
      <?php $go3d_spark( $go3d_d['trend_games'], '#00a32a' ); ?>
    </div>
  </div>

  <hr style="margin:24px 0;">

  <!-- ── Setup guide ─────────────────────────────────────────────── -->
  <div class="go3d-setup-guide card" style="max-width:800px;padding:4px 20px 16px;margin:16px 0;">
    <h2><?php esc_html_e( 'Quick setup guide', 'go3d' ); ?></h2>
    <ol style="line-height:1.7;font-size:14px;">
      <li>
        <strong><?php esc_html_e( 'Add the game to a page.', 'go3d' ); ?></strong>
        <?php
          printf(
            wp_kses(
              __( 'Create or edit a page and insert the shortcode <code>%s</code>. By default it renders a “Play” button that opens the full-screen game in a new tab. Use <code>%s</code> to embed the game directly in the page instead.', 'go3d' ),
              [ 'code' => [] ]
            ),
            '[go3d]',
            '[go3d mode=&quot;inline&quot;]'
          );
        ?>
      </li>
      <li>
        <strong><?php esc_html_e( 'Enable real-time play (recommended).', 'go3d' ); ?></strong>
        <?php
          printf(
            wp_kses(
              __( 'Create a free <a href="%s" target="_blank" rel="noopener">Pusher Channels</a> app and paste its App ID, Key, Secret and Cluster into the Pusher section below. Without it, the game falls back to slower HTTP polling.', 'go3d' ),
              [ 'a' => [ 'href' => [], 'target' => [], 'rel' => [] ] ]
            ),
            'https://pusher.com'
          );
        ?>
      </li>
      <li>
        <strong><?php esc_html_e( 'Configure account emails.', 'go3d' ); ?></strong>
        <?php esc_html_e( 'Set the From name/email under Email / Notifications so sign-up verification codes and password-reset links are delivered. If your host blocks wp_mail(), install an SMTP plugin.', 'go3d' ); ?>
      </li>
      <li>
        <strong><?php esc_html_e( 'Set up the cron trigger.', 'go3d' ); ?></strong>
        <?php esc_html_e( 'Move timeouts and idle-game reminders run on a schedule. WP-Cron works out of the box on busy sites; for reliability set a Cron secret below and call the external cron URL every few minutes from your host.', 'go3d' ); ?>
      </li>
      <li>
        <strong><?php esc_html_e( 'Players sign up.', 'go3d' ); ?></strong>
        <?php esc_html_e( 'Each player registers an account in the game (used for fast move sync and ELO ratings), confirms the 6-digit code we email them, and starts playing. A no-account local hot-seat mode is also available for two players on one screen.', 'go3d' ); ?>
      </li>
    </ol>
  </div>

  <form method="post" action="options.php">
    <?php settings_fields( 'go3d_options' ); ?>

    <!-- ── Pusher ──────────────────────────────────────────────── -->
    <h2 class="title"><?php esc_html_e( 'Pusher Channels (real-time)', 'go3d' ); ?></h2>
    <p>
      <?php
        printf(
          wp_kses(
            __( 'Create a free account at <a href="%s" target="_blank" rel="noopener">pusher.com</a> and create a Channels app. Paste the credentials below.', 'go3d' ),
            [ 'a' => [ 'href' => [], 'target' => [], 'rel' => [] ] ]
          ),
          'https://pusher.com'
        );
      ?>
    </p>
    <table class="form-table" role="presentation">
      <tr>
        <th scope="row"><label for="go3d_pusher_app_id"><?php esc_html_e( 'App ID', 'go3d' ); ?></label></th>
        <td><input type="text" id="go3d_pusher_app_id" name="go3d_pusher_app_id"
                   value="<?php echo esc_attr( get_option( 'go3d_pusher_app_id' ) ); ?>"
                   class="regular-text" autocomplete="off"></td>
      </tr>
      <tr>
        <th scope="row"><label for="go3d_pusher_key"><?php esc_html_e( 'Key', 'go3d' ); ?></label></th>
        <td><input type="text" id="go3d_pusher_key" name="go3d_pusher_key"
                   value="<?php echo esc_attr( get_option( 'go3d_pusher_key' ) ); ?>"
                   class="regular-text" autocomplete="off"></td>
      </tr>
      <tr>
        <th scope="row"><label for="go3d_pusher_secret"><?php esc_html_e( 'Secret', 'go3d' ); ?></label></th>
        <td><input type="password" id="go3d_pusher_secret" name="go3d_pusher_secret"
                   value="<?php echo esc_attr( get_option( 'go3d_pusher_secret' ) ); ?>"
                   class="regular-text" autocomplete="new-password"></td>
      </tr>
      <tr>
        <th scope="row"><label for="go3d_pusher_cluster"><?php esc_html_e( 'Cluster', 'go3d' ); ?></label></th>
        <td>
          <select id="go3d_pusher_cluster" name="go3d_pusher_cluster">
            <?php
            $clusters = [ 'eu' => 'eu (Europe)', 'us2' => 'us2 (United States)', 'us3' => 'us3 (United States)', 'ap1' => 'ap1 (Asia Pacific)', 'ap2' => 'ap2 (Asia Pacific)', 'ap3' => 'ap3 (Asia Pacific)', 'ap4' => 'ap4 (Australia)', 'sa1' => 'sa1 (South America)' ];
            $current  = get_option( 'go3d_pusher_cluster', 'eu' );
            foreach ( $clusters as $val => $label ) {
              printf( '<option value="%s"%s>%s</option>', esc_attr( $val ), selected( $current, $val, false ), esc_html( $label ) );
            }
            ?>
          </select>
          <p class="description"><?php esc_html_e( 'Pick the cluster closest to your users.', 'go3d' ); ?></p>
        </td>
      </tr>
    </table>

    <!-- ── Real-time diagnostics ─────────────────────────────── -->
    <h2 class="title"><?php esc_html_e( 'Real-time Diagnostics', 'go3d' ); ?></h2>
    <p><?php esc_html_e( 'Test your Pusher connection end-to-end. The server sends a real API call and reports exactly what it received.', 'go3d' ); ?></p>
    <p>
      <button type="button" id="go3d-test-pusher" class="button button-secondary">
        <?php esc_html_e( 'Test server → Pusher connection', 'go3d' ); ?>
      </button>
      <button type="button" id="go3d-test-auth" class="button button-secondary" style="margin-left:6px;">
        <?php esc_html_e( 'Test auth endpoint', 'go3d' ); ?>
      </button>
    </p>
    <pre id="go3d-debug-log" class="go3d-debug-console" aria-live="polite"><?php esc_html_e( 'Click a test button to see diagnostics here.', 'go3d' ); ?></pre>
    <style>
    .go3d-debug-console {
      background: #0a0c12; color: #cdd6e4; border: 1px solid #1d2433; border-radius: 8px;
      padding: 14px 16px; max-height: 320px; overflow: auto; font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: 13px; line-height: 1.55; white-space: pre-wrap; word-break: break-all;
      margin-top: 8px;
    }
    .go3d-debug-console:empty { display: none; }
    </style>
    <script>
    (function() {
      var log = document.getElementById('go3d-debug-log');
      var apiBase = '<?php echo esc_js( rest_url( Go3D_API::NAMESPACE ) ); ?>';
      // Shared REST nonce — WP cookie auth requires it, otherwise the request is
      // treated as anonymous and the admin-only routes return 401/403.
      var nonce = '<?php echo esc_js( wp_create_nonce( 'wp_rest' ) ); ?>';

      function ts() {
        return new Date().toLocaleTimeString('en-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      function append(line) {
        log.textContent = (log.textContent === 'Click a test button to see diagnostics here.' ? '' : log.textContent + '\n') + '[' + ts() + '] ' + line;
        log.scrollTop = log.scrollHeight;
      }

      function statusIcon(ok) {
        return ok ? '\u2705' : '\u274C';
      }

      document.getElementById('go3d-test-pusher').addEventListener('click', function() {
        append('--- Testing server \u2192 Pusher API ---');
        fetch(apiBase + '/pusher/health', { credentials: 'same-origin', headers: { 'X-WP-Nonce': nonce } })
          .then(function(r) { return r.json().then(function(d) { return { status: r.status, body: d }; }); })
          .then(function(res) {
            var b = res.body;
            if (res.status !== 200 && b.error) {
              append(statusIcon(false) + ' Endpoint error: ' + b.error);
              return;
            }
            var c = b.credentials;
            append('Credentials: App ID=' + c.app_id + ', Key=' + c.key + ', Secret=' + c.secret + ', Cluster=' + c.cluster);
            var h = b.http_test;
            append('HTTP ' + h.code + ' \u2192 ' + h.message);
            append('Channel: ' + h.channel);
            if (h.pusher_response) {
              append('Raw response: ' + h.pusher_response);
            }
            append(statusIcon(h.ok) + ' ' + (h.ok ? 'Pusher is working correctly.' : 'Check your credentials on pusher.com.'));
          })
          .catch(function(e) {
            append(statusIcon(false) + ' Request failed: ' + e.message);
          });
      });

      document.getElementById('go3d-test-auth').addEventListener('click', function() {
        append('--- Testing Pusher auth endpoint ---');
        fetch(apiBase + '/pusher/auth', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-WP-Nonce': nonce
          },
          body: JSON.stringify({
            socket_id: 'test-socket-id',
            channel_name: 'private-game-1'
          })
        })
          .then(function(r) { return r.json().then(function(d) { return { status: r.status, body: d }; }); })
          .then(function(res) {
            if (res.status === 401) {
              append(statusIcon(false) + ' Auth endpoint requires a logged-in user. This is expected when testing from settings \u2014 it means the endpoint is reachable and enforcing authentication.');
              return;
            }
            if (res.status === 404) {
              append(statusIcon(true) + ' Auth endpoint responded with 404 (game 1 not found). This is expected \u2014 the endpoint is working, it just rejected the synthetic game ID.');
              return;
            }
            append('Status: ' + res.status + ' \u2014 ' + JSON.stringify(res.body));
            append(statusIcon(res.status >= 200 && res.status < 300) + ' Complete.');
          })
          .catch(function(e) {
            append(statusIcon(false) + ' Request failed: ' + e.message);
          });
      });
    })();
    </script>

    <!-- ── Email ───────────────────────────────────────────────── -->
    <h2 class="title"><?php esc_html_e( 'Email / Notifications', 'go3d' ); ?></h2>
    <table class="form-table" role="presentation">
      <tr>
        <th scope="row"><label for="go3d_site_name"><?php esc_html_e( 'Site name (in emails)', 'go3d' ); ?></label></th>
        <td><input type="text" id="go3d_site_name" name="go3d_site_name"
                   value="<?php echo esc_attr( get_option( 'go3d_site_name', get_bloginfo( 'name' ) ) ); ?>"
                   class="regular-text"></td>
      </tr>
      <tr>
        <th scope="row"><label for="go3d_from_email"><?php esc_html_e( 'From email', 'go3d' ); ?></label></th>
        <td><input type="email" id="go3d_from_email" name="go3d_from_email"
                   value="<?php echo esc_attr( get_option( 'go3d_from_email', get_option( 'admin_email' ) ) ); ?>"
                   class="regular-text"></td>
      </tr>
      <tr>
        <th scope="row"><label for="go3d_from_name"><?php esc_html_e( 'From name', 'go3d' ); ?></label></th>
        <td><input type="text" id="go3d_from_name" name="go3d_from_name"
                   value="<?php echo esc_attr( get_option( 'go3d_from_name', get_bloginfo( 'name' ) ) ); ?>"
                   class="regular-text"></td>
      </tr>
    </table>

    <!-- ── Security ────────────────────────────────────────────── -->
    <h2 class="title"><?php esc_html_e( 'Security', 'go3d' ); ?></h2>
    <table class="form-table" role="presentation">
      <tr>
        <th scope="row"><?php esc_html_e( 'JWT secret', 'go3d' ); ?></th>
        <td>
          <p class="description">
            <?php
            $jwt_set = (bool) get_option( 'go3d_jwt_secret', '' );
            echo $jwt_set
              ? esc_html__( 'JWT secret is configured (auto-generated on first use).', 'go3d' )
              : esc_html__( 'JWT secret will be generated automatically on first login.', 'go3d' );
            ?>
          </p>
          <?php if ( $jwt_set ) : ?>
          <p>
            <button type="button" id="go3d-rotate-jwt" class="button button-secondary">
              <?php esc_html_e( 'Rotate JWT secret (logs out all users)', 'go3d' ); ?>
            </button>
          </p>
          <script>
          document.getElementById('go3d-rotate-jwt').addEventListener('click', function() {
            if ( ! confirm('<?php esc_js( __( 'This will log out all currently logged-in players. Continue?', 'go3d' ) ); ?>') ) return;
            fetch('<?php echo esc_url( admin_url( 'admin-ajax.php' ) ); ?>', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: 'action=go3d_rotate_jwt&_ajax_nonce=<?php echo esc_js( wp_create_nonce( 'go3d_rotate_jwt' ) ); ?>'
            }).then(r => r.json()).then(d => { alert(d.data || d.message || 'Done.'); location.reload(); });
          });
          </script>
          <?php endif; ?>
        </td>
      </tr>
      <tr>
        <th scope="row"><label for="go3d_cron_secret"><?php esc_html_e( 'Cron secret', 'go3d' ); ?></label></th>
        <td>
          <input type="text" id="go3d_cron_secret" name="go3d_cron_secret"
                 value="<?php echo esc_attr( get_option( 'go3d_cron_secret', '' ) ); ?>"
                 class="regular-text" autocomplete="off">
          <p class="description">
            <?php
            $cron_url = home_url( '/?go3d_cron=1&secret=' . get_option( 'go3d_cron_secret', 'YOUR_SECRET' ) );
            printf(
              wp_kses(
                __( 'Optional external cron URL (set in Hetzner): <code>%s</code><br>Leave blank to use WP-Cron.', 'go3d' ),
                [ 'code' => [], 'br' => [] ]
              ),
              esc_url( $cron_url )
            );
            ?>
          </p>
        </td>
      </tr>
    </table>

    <?php submit_button(); ?>
  </form>

  <!-- ── Bug reports ─────────────────────────────────────────────── -->
  <?php
    $go3d_reports     = Go3D_Bug_Report::list( 200 );
    $go3d_open_count  = Go3D_Bug_Report::unresolved_count();
  ?>
  <h2 style="margin-top:32px;">
    <?php esc_html_e( 'Feedback &amp; bug reports', 'go3d' ); ?>
    <?php if ( $go3d_open_count > 0 ) : ?>
      <span class="go3d-bug-badge" style="background:#d63638;color:#fff;border-radius:10px;padding:1px 9px;font-size:12px;vertical-align:middle;"><?php echo (int) $go3d_open_count; ?> <?php esc_html_e( 'open', 'go3d' ); ?></span>
    <?php endif; ?>
  </h2>
  <p class="description"><?php esc_html_e( 'Bug reports, feature requests and improvements players submit from the lobby.', 'go3d' ); ?></p>

  <?php if ( empty( $go3d_reports ) ) : ?>
    <p><em><?php esc_html_e( 'No feedback yet.', 'go3d' ); ?></em></p>
  <?php else : ?>
    <table class="widefat striped" style="max-width:1000px;margin-top:8px;">
      <thead>
        <tr>
          <th style="width:140px;"><?php esc_html_e( 'When', 'go3d' ); ?></th>
          <th style="width:120px;"><?php esc_html_e( 'Type', 'go3d' ); ?></th>
          <th style="width:120px;"><?php esc_html_e( 'Player', 'go3d' ); ?></th>
          <th><?php esc_html_e( 'Report', 'go3d' ); ?></th>
          <th style="width:170px;"><?php esc_html_e( 'Actions', 'go3d' ); ?></th>
        </tr>
      </thead>
      <tbody>
        <?php foreach ( $go3d_reports as $r ) : ?>
          <tr<?php echo $r['resolved'] ? ' style="opacity:0.55;"' : ''; ?>>
            <td>
              <?php echo esc_html( get_date_from_gmt( $r['created_at'], 'Y-m-d H:i' ) ); ?>
              <?php if ( $r['resolved'] ) : ?><br><span style="color:#46b450;">✔ <?php esc_html_e( 'resolved', 'go3d' ); ?></span><?php endif; ?>
            </td>
            <td>
              <?php
                $go3d_type   = $r['type'] ?? 'bug';
                $go3d_labels = [ 'bug' => __( 'Bug', 'go3d' ), 'feature' => __( 'Feature', 'go3d' ), 'improvement' => __( 'Improvement', 'go3d' ) ];
                $go3d_colors = [ 'bug' => '#d63638', 'feature' => '#2271b1', 'improvement' => '#8c5e00' ];
                $go3d_bg     = $go3d_colors[ $go3d_type ] ?? '#646970';
              ?>
              <span style="background:<?php echo esc_attr( $go3d_bg ); ?>;color:#fff;border-radius:10px;padding:1px 9px;font-size:11px;white-space:nowrap;">
                <?php echo esc_html( $go3d_labels[ $go3d_type ] ?? ucfirst( $go3d_type ) ); ?>
              </span>
            </td>
            <td>
              <?php echo $r['username'] ? esc_html( $r['username'] ) : '<em>' . esc_html__( 'anonymous', 'go3d' ) . '</em>'; ?>
            </td>
            <td>
              <div style="white-space:pre-wrap;word-break:break-word;"><?php echo esc_html( $r['message'] ); ?></div>
              <?php if ( ! empty( $r['context'] ) || ! empty( $r['user_agent'] ) ) : ?>
                <div style="color:#888;font-size:11px;margin-top:4px;">
                  <?php if ( ! empty( $r['context'] ) ) echo esc_html( $r['context'] ) . ' · '; ?>
                  <?php echo esc_html( $r['user_agent'] ); ?>
                </div>
              <?php endif; ?>
            </td>
            <td>
              <form method="post" style="display:inline;">
                <?php wp_nonce_field( 'go3d_bug_action' ); ?>
                <input type="hidden" name="bug_id" value="<?php echo (int) $r['id']; ?>">
                <?php if ( $r['resolved'] ) : ?>
                  <button class="button button-small" name="go3d_bug_action" value="reopen"><?php esc_html_e( 'Reopen', 'go3d' ); ?></button>
                <?php else : ?>
                  <button class="button button-small button-primary" name="go3d_bug_action" value="resolve"><?php esc_html_e( 'Resolve', 'go3d' ); ?></button>
                <?php endif; ?>
                <button class="button button-small button-link-delete" name="go3d_bug_action" value="delete"
                        onclick="return confirm('<?php echo esc_js( __( 'Delete this report?', 'go3d' ) ); ?>');"><?php esc_html_e( 'Delete', 'go3d' ); ?></button>
              </form>
            </td>
          </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
  <?php endif; ?>
</div>
