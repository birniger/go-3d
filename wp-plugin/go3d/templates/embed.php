<?php if ( ! defined( 'ABSPATH' ) ) exit; ?>
<div id="go3d-root" class="go3d-embed">

  <!-- ── Auth screens ───────────────────────────────────────────── -->
  <div id="go3d-auth" class="go3d-screen" style="display:none;">

    <div class="go3d-auth-tabs">
      <button class="go3d-tab-btn active" data-tab="login">Log in</button>
      <button class="go3d-tab-btn"        data-tab="register">Register</button>
    </div>

    <!-- Login -->
    <form id="go3d-login-form" class="go3d-form go3d-tab-panel active" data-tab="login" novalidate>
      <h2>Log in</h2>
      <label>Email<input type="email" name="email" autocomplete="email" required></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
      <div class="go3d-form-error" aria-live="polite"></div>
      <button type="submit" class="go3d-btn-primary">Log in</button>
      <p><a href="#" id="go3d-forgot-link">Forgot your password?</a></p>
    </form>

    <!-- Register -->
    <form id="go3d-register-form" class="go3d-form go3d-tab-panel" data-tab="register" novalidate>
      <h2>Create account</h2>
      <label>Username<input type="text" name="username" autocomplete="username" required minlength="3" maxlength="30"></label>
      <label>Email<input type="email" name="email" autocomplete="email" required></label>
      <label>Password<input type="password" name="password" autocomplete="new-password" required minlength="8"></label>
      <div class="go3d-form-error" aria-live="polite"></div>
      <button type="submit" class="go3d-btn-primary">Create account</button>
    </form>

    <!-- Password reset request -->
    <form id="go3d-forgot-form" class="go3d-form" style="display:none;" novalidate>
      <h2>Reset password</h2>
      <p>Enter your email and we'll send you a reset link.</p>
      <label>Email<input type="email" name="email" autocomplete="email" required></label>
      <div class="go3d-form-error" aria-live="polite"></div>
      <button type="submit" class="go3d-btn-primary">Send reset link</button>
      <p><a href="#" id="go3d-back-to-login">Back to login</a></p>
    </form>

  </div><!-- #go3d-auth -->

  <!-- ── Lobby ──────────────────────────────────────────────────── -->
  <div id="go3d-lobby" class="go3d-screen" style="display:none;">

    <header class="go3d-lobby-header">
      <span class="go3d-logo">Go³D</span>
      <div class="go3d-user-bar">
        <span id="go3d-lobby-username"></span>
        <span id="go3d-lobby-elo" class="go3d-elo-badge"></span>
        <a href="#" id="go3d-profile-link">Profile</a>
        <button id="go3d-logout-btn" class="go3d-btn-ghost">Log out</button>
      </div>
    </header>

    <div class="go3d-lobby-body">

      <!-- New game panel -->
      <section class="go3d-panel">
        <h3>New game</h3>
        <form id="go3d-new-game-form" class="go3d-form">
          <div class="go3d-form-row">
            <label>Mode
              <select name="mode" id="go3d-mode-select">
                <option value="cube" selected>Cube</option>
                <option value="stack">Stack</option>
                <option value="sphere">Sphere</option>
              </select>
            </label>
            <label id="go3d-cube-size-wrap">Board size
              <select id="go3d-cube-size">
                <option value="9" selected>9×9×9</option>
                <option value="5">5×5×5</option>
                <option value="13">13×13×13</option>
                <option value="19">19×19×19</option>
                <option value="custom">Custom…</option>
              </select>
              <input type="number" id="go3d-cube-custom" value="9" min="2" max="19" step="1" style="width:4em;display:none;" title="Cube edge length (2–19)">
            </label>
            <label id="go3d-sphere-size-wrap" style="display:none;">Sphere size
              <select id="go3d-sphere-size">
                <option value="2">Small (42 points)</option>
                <option value="3" selected>Medium (92 points)</option>
                <option value="4">Large (162 points)</option>
                <option value="custom">Custom…</option>
              </select>
              <input type="number" id="go3d-sphere-freq" value="5" min="2" max="8" step="1" style="width:4em;display:none;" title="Geodesic frequency (2–8)">
            </label>
            <label>Scoring
              <select name="scoring_mode">
                <option value="chinese" selected>Chinese</option>
                <option value="japanese">Japanese</option>
              </select>
            </label>
            <label>Komi
              <input type="number" name="komi" value="6.5" step="0.5" min="0" max="20" style="width:5em;">
            </label>
          </div>
          <div class="go3d-form-row">
            <label>Time control
              <select name="time_control" id="go3d-time-control-select">
                <option value="none" selected>None (correspondence)</option>
                <option value="absolute">Absolute</option>
                <option value="byoyomi">Byōyomi</option>
                <option value="fischer">Fischer</option>
              </select>
            </label>
            <div id="go3d-time-settings" style="display:none;">
              <label>Main time (s)<input type="number" name="main_time_s" value="600" min="30" step="30"></label>
              <span id="go3d-byoyomi-extra" style="display:none;">
                <label>Periods<input type="number" name="byoyomi_periods" value="5" min="1"></label>
                <label>Period (s)<input type="number" name="byoyomi_time_s" value="30" min="5"></label>
              </span>
              <span id="go3d-fischer-extra" style="display:none;">
                <label>Increment (s)<input type="number" name="fischer_increment_s" value="10" min="1"></label>
              </span>
            </div>
          </div>
          <div class="go3d-form-actions">
            <button type="submit" class="go3d-btn-primary">Create open game</button>
            <button type="button" id="go3d-play-local-btn" class="go3d-btn-ghost">Play locally (2 players, 1 screen)</button>
          </div>
          <p class="go3d-form-hint">Local games run entirely in your browser — no opponent or account needed. Both players take turns at this computer.</p>
        </form>
      </section>

      <!-- Open games table -->
      <section class="go3d-panel">
        <h3>Open games <button id="go3d-refresh-open" class="go3d-btn-ghost go3d-btn-sm">↻</button></h3>
        <table class="go3d-table" id="go3d-open-games-table">
          <thead><tr>
            <th>Host</th><th>Size</th><th>Scoring</th><th>Komi</th><th>Time</th><th></th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <p class="go3d-empty-msg" id="go3d-no-open-games" style="display:none;">No open games. Create one above!</p>
      </section>

      <!-- Your active games -->
      <section class="go3d-panel">
        <h3>Your active games</h3>
        <table class="go3d-table" id="go3d-active-games-table">
          <thead><tr>
            <th>Opponent</th><th>Size</th><th>Your turn?</th><th>Last move</th><th></th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <p class="go3d-empty-msg" id="go3d-no-active-games" style="display:none;">No active games.</p>
      </section>

      <!-- Leaderboard -->
      <section class="go3d-panel">
        <h3>Leaderboard <button id="go3d-refresh-leaderboard" class="go3d-btn-ghost go3d-btn-sm">↻</button></h3>
        <table class="go3d-table" id="go3d-leaderboard-table">
          <thead><tr>
            <th>#</th><th>Player</th><th>ELO</th><th>W</th><th>L</th><th>D</th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <p class="go3d-empty-msg" id="go3d-no-leaderboard" style="display:none;">No ranked players yet.</p>
      </section>

    </div><!-- .go3d-lobby-body -->
  </div><!-- #go3d-lobby -->

  <!-- ── Profile ────────────────────────────────────────────────── -->
  <div id="go3d-profile" class="go3d-screen" style="display:none;">
    <div class="go3d-screen-header">
      <button id="go3d-back-to-lobby" class="go3d-btn-ghost">← Lobby</button>
      <h2 id="go3d-profile-heading">Profile</h2>
    </div>
    <div id="go3d-profile-content"></div>
  </div>

  <!-- ── In-game ────────────────────────────────────────────────── -->
  <div id="go3d-game-screen" class="go3d-screen" style="display:none;">

    <!-- Top bar: back button · player names & turn indicator · clocks -->
    <div id="go3d-game-topbar">

      <button id="go3d-back-to-lobby-game" class="go3d-btn-ghost">← Lobby</button>

      <div id="go3d-player-info">
        <!-- Player 1 (Black) -->
        <div class="go3d-player-badge go3d-p1" id="go3d-p1-info">
          <span class="go3d-stone-dot go3d-stone-black">●</span>
          <span id="go3d-p1-name">—</span>
          <span id="go3d-p1-elo" class="go3d-elo-badge"></span>
          <span id="go3d-p1-caps" class="go3d-cap-count" title="Stones captured"></span>
        </div>

        <span id="go3d-turn-indicator" class="go3d-turn-label" aria-live="polite"></span>

        <!-- Player 2 (White) -->
        <div class="go3d-player-badge go3d-p2" id="go3d-p2-info">
          <span class="go3d-stone-dot go3d-stone-white">○</span>
          <span id="go3d-p2-name">—</span>
          <span id="go3d-p2-elo" class="go3d-elo-badge"></span>
          <span id="go3d-p2-caps" class="go3d-cap-count" title="Stones captured"></span>
        </div>
      </div>

      <!--
        Clock bar — hidden for correspondence games (time_control = 'none').
        MultiplayerClockDisplay.init() shows/hides it and writes the values.

        Each clock span gets CSS classes applied by JS:
          .go3d-clock-active  → this player's clock is currently running
          .go3d-clock-urgent  → ≤ 30 seconds left  (yellow → red)
          .go3d-clock-flagged → time is up (should not normally appear;
                                the server ends the game before this)
      -->
      <div id="go3d-clock-bar" style="display:none;">
        <div class="go3d-clock-cell">
          <span class="go3d-clock-label">Black</span>
          <span id="go3d-p1-clock" class="go3d-clock">—</span>
        </div>
        <div class="go3d-clock-cell">
          <span class="go3d-clock-label">White</span>
          <span id="go3d-p2-clock" class="go3d-clock">—</span>
        </div>
      </div>

    </div><!-- #go3d-game-topbar -->

    <!-- Stack mode: which build layer is active -->
    <div id="go3d-layer-banner" style="display:none;" aria-live="polite"></div>

    <!-- Canvas injected here by the JS bundle -->
    <div id="go3d-canvas-wrap"></div>

    <!--
      View controls — slice / camera / score. JS shows the relevant groups per
      mode (slice + camera are cube/stack only; score works in every mode).
    -->
    <div id="go3d-view-controls">
      <div class="go3d-vc-group" id="go3d-slice-group">
        <span class="go3d-vc-label">Slice</span>
        <button class="go3d-btn-ghost go3d-btn-sm" id="go3d-slice-x" title="Slice along X (key: X)">X</button>
        <button class="go3d-btn-ghost go3d-btn-sm" id="go3d-slice-y" title="Slice along Y (key: Y)">Y</button>
        <button class="go3d-btn-ghost go3d-btn-sm" id="go3d-slice-z" title="Slice along Z (key: Z)">Z</button>
      </div>
      <div class="go3d-vc-group" id="go3d-camera-group">
        <span class="go3d-vc-label">View</span>
        <button class="go3d-btn-ghost go3d-btn-sm" id="go3d-cam-top"   title="Top view">Top</button>
        <button class="go3d-btn-ghost go3d-btn-sm" id="go3d-cam-front" title="Front view">Front</button>
        <button class="go3d-btn-ghost go3d-btn-sm" id="go3d-cam-side"  title="Side view">Side</button>
        <button class="go3d-btn-ghost go3d-btn-sm" id="go3d-cam-iso"   title="Isometric view">Iso</button>
      </div>
      <button class="go3d-btn-ghost go3d-btn-sm" id="go3d-score-btn" title="Estimate territory">Score</button>
    </div>

    <!-- In-game action buttons (pass / resign) shown over the canvas -->
    <div id="go3d-game-actions">
      <button id="go3d-pass-btn"   class="go3d-btn-ghost">Pass</button>
      <button id="go3d-resign-btn" class="go3d-btn-ghost go3d-btn-danger">Resign</button>
    </div>

    <!-- Replay controls — shown only after a finished game is opened -->
    <div id="go3d-replay-bar" style="display:none;">
      <button class="go3d-btn-ghost go3d-btn-sm" id="go3d-replay-first" title="First move">⏮</button>
      <button class="go3d-btn-ghost go3d-btn-sm" id="go3d-replay-prev"  title="Previous move">◀</button>
      <span id="go3d-replay-status">—</span>
      <button class="go3d-btn-ghost go3d-btn-sm" id="go3d-replay-next"  title="Next move">▶</button>
      <button class="go3d-btn-ghost go3d-btn-sm" id="go3d-replay-last"  title="Last move">⏭</button>
    </div>

    <!-- Waiting overlay — shown when it's the opponent's turn -->
    <div id="go3d-waiting-overlay" style="display:none;" aria-live="polite">
      Waiting for opponent…
    </div>

    <!-- First-run onboarding overlay (dismissed; remembered in localStorage) -->
    <div id="go3d-onboarding" style="display:none;">
      <div class="go3d-onboarding-card">
        <h3>Welcome to Go³D</h3>
        <ul>
          <li><strong>Place a stone:</strong> click an empty point on the board.</li>
          <li><strong>See inside (cube/stack):</strong> press <kbd>X</kbd>/<kbd>Y</kbd>/<kbd>Z</kbd> or the <em>Slice</em> buttons, then arrow keys to move the slice.</li>
          <li><strong>Keyboard cursor:</strong> arrow keys move a cursor; <kbd>Enter</kbd> places. <kbd>Q</kbd>/<kbd>E</kbd> move on the vertical axis.</li>
          <li><strong>Snap the camera:</strong> use the <em>View</em> buttons (Top / Front / Side / Iso).</li>
          <li><strong>Score:</strong> the <em>Score</em> button shades estimated territory.</li>
        </ul>
        <button class="go3d-btn-primary" id="go3d-onboarding-dismiss">Got it</button>
      </div>
    </div>

  </div>

  <!-- ── Global status message ─────────────────────────────────── -->
  <div id="go3d-toast" role="status" aria-live="polite"></div>

</div><!-- #go3d-root -->
