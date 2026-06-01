<?php if ( ! defined( 'ABSPATH' ) ) exit; ?>
<div class="wrap">
  <h1><?php esc_html_e( 'Go³D Settings', 'go3d' ); ?></h1>

  <?php settings_errors( 'go3d_messages' ); ?>

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
</div>
