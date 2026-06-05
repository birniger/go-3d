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
    <?php esc_html_e( 'Bug reports', 'go3d' ); ?>
    <?php if ( $go3d_open_count > 0 ) : ?>
      <span class="go3d-bug-badge" style="background:#d63638;color:#fff;border-radius:10px;padding:1px 9px;font-size:12px;vertical-align:middle;"><?php echo (int) $go3d_open_count; ?> <?php esc_html_e( 'open', 'go3d' ); ?></span>
    <?php endif; ?>
  </h2>
  <p class="description"><?php esc_html_e( 'Reports players submit from the lobby (“Report a bug”).', 'go3d' ); ?></p>

  <?php if ( empty( $go3d_reports ) ) : ?>
    <p><em><?php esc_html_e( 'No bug reports yet.', 'go3d' ); ?></em></p>
  <?php else : ?>
    <table class="widefat striped" style="max-width:1000px;margin-top:8px;">
      <thead>
        <tr>
          <th style="width:140px;"><?php esc_html_e( 'When', 'go3d' ); ?></th>
          <th style="width:130px;"><?php esc_html_e( 'Player', 'go3d' ); ?></th>
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
