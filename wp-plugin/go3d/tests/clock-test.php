<?php
/**
 * Standalone unit test for Go3D_Clock byōyomi maths.
 * Run with:  php wp-plugin/go3d/tests/clock-test.php
 * No WordPress environment required.
 */
define( 'ABSPATH', __DIR__ );
require __DIR__ . '/../includes/class-clock.php';

$failures = 0;
function check( string $label, $got, $expected ) {
    global $failures;
    $ok = $got === $expected;
    if ( ! $ok ) $failures++;
    printf( "[%s] %s\n    got=%s\n    exp=%s\n",
        $ok ? 'PASS' : 'FAIL', $label,
        json_encode( $got ), json_encode( $expected ) );
}

$P = 30000; // 30s period

// ── Main-time phase ────────────────────────────────────────────────────────
// Move inside main time: just deduct, no period change.
check( 'main: quick move',
    Go3D_Clock::byoyomi_move( 600000, 5, false, $P, 10000 ),
    [ 'time_ms' => 590000, 'periods' => 5, 'in_byoyomi' => false, 'flagged' => false ] );

// Move spills just past main time, well within first period → enter byōyomi, keep all periods.
check( 'main: spill into period 1',
    Go3D_Clock::byoyomi_move( 5000, 5, false, $P, 20000 ),   // over = 15000 < P
    [ 'time_ms' => 30000, 'periods' => 5, 'in_byoyomi' => true, 'flagged' => false ] );

// Spill consumes one whole period then completes in the next.
check( 'main: spill loses one period',
    Go3D_Clock::byoyomi_move( 0, 5, false, $P, 40000 ),      // over = 40000 → floor(40000/30000)=1
    [ 'time_ms' => 30000, 'periods' => 4, 'in_byoyomi' => true, 'flagged' => false ] );

// Spill burns through all periods → flag.
check( 'main: spill flags',
    Go3D_Clock::byoyomi_move( 0, 2, false, $P, 70000 ),      // over=70000 floor=2 >= 2 periods
    [ 'time_ms' => 0, 'periods' => 0, 'in_byoyomi' => true, 'flagged' => true ] );

// ── Byōyomi phase ──────────────────────────────────────────────────────────
// Quick move in byōyomi → period refreshes, keep all periods.
check( 'byo: refresh',
    Go3D_Clock::byoyomi_move( 12000, 5, true, $P, 8000 ),
    [ 'time_ms' => 30000, 'periods' => 5, 'in_byoyomi' => true, 'flagged' => false ] );

// Overran current period (lose 1), complete in next.
check( 'byo: lose one period',
    Go3D_Clock::byoyomi_move( 10000, 5, true, $P, 15000 ),   // over=5000 floor=0, lost=1
    [ 'time_ms' => 30000, 'periods' => 4, 'in_byoyomi' => true, 'flagged' => false ] );

// Overran current + one more full period.
check( 'byo: lose two periods',
    Go3D_Clock::byoyomi_move( 10000, 5, true, $P, 45000 ),   // over=35000 floor=1, lost=2
    [ 'time_ms' => 30000, 'periods' => 3, 'in_byoyomi' => true, 'flagged' => false ] );

// Last period overrun → flag.
check( 'byo: flag on last period',
    Go3D_Clock::byoyomi_move( 10000, 1, true, $P, 15000 ),   // lost=1 >= 1
    [ 'time_ms' => 0, 'periods' => 0, 'in_byoyomi' => true, 'flagged' => true ] );

// ── Total-remaining budget ─────────────────────────────────────────────────
check( 'total: main + periods',
    Go3D_Clock::byoyomi_remaining_total( 600000, 5, false, $P ),
    600000 + 5 * 30000 );
check( 'total: in byoyomi counts current period once',
    Go3D_Clock::byoyomi_remaining_total( 30000, 3, true, $P ),
    30000 + 2 * 30000 );

echo $failures === 0 ? "\nALL PASS\n" : "\n$failures FAILURE(S)\n";
exit( $failures === 0 ? 0 : 1 );
