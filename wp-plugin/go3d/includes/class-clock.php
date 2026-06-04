<?php
if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Pure, side-effect-free clock arithmetic.
 *
 * Keeping the byōyomi maths in one tiny class (no DB, no globals) makes it
 * unit-testable in isolation — see tests/clock-test.php, which can be run with
 * a plain `php` CLI without a WordPress environment.
 *
 * State convention for a byōyomi clock:
 *   - time_ms     current allowance: during main time this is the main-time
 *                 remainder; once in byōyomi it is the time left in the
 *                 currently-ticking period.
 *   - periods     during main time: the full number of byōyomi periods N.
 *                 during byōyomi: the number of periods that remain INCLUDING
 *                 the one currently ticking.
 *   - in_byoyomi  false while main time is being spent, true thereafter.
 *
 * A move completed within the current period refreshes that period to its full
 * length and costs nothing; overrunning consumes whole periods. Running out of
 * periods flags (loss on time).
 */
class Go3D_Clock {

    /**
     * Apply a completed move of duration $elapsed_ms to a byōyomi clock.
     *
     * @return array{time_ms:int,periods:int,in_byoyomi:bool,flagged:bool}
     */
    public static function byoyomi_move( int $time_ms, int $periods, bool $in_byoyomi, int $period_ms, int $elapsed_ms ): array {
        $period_ms  = max( 1, $period_ms );
        $elapsed_ms = max( 0, $elapsed_ms );

        if ( ! $in_byoyomi ) {
            // Still spending main time.
            if ( $elapsed_ms <= $time_ms ) {
                return [ 'time_ms' => $time_ms - $elapsed_ms, 'periods' => $periods, 'in_byoyomi' => false, 'flagged' => false ];
            }
            // Main time exhausted → spill into byōyomi. `over` is the time spent
            // after main ran out; each FULL period it covers is one period lost.
            $over = $elapsed_ms - $time_ms;
            $lost = intdiv( $over, $period_ms );           // floor
            if ( $lost >= $periods ) {
                return [ 'time_ms' => 0, 'periods' => 0, 'in_byoyomi' => true, 'flagged' => true ];
            }
            return [ 'time_ms' => $period_ms, 'periods' => $periods - $lost, 'in_byoyomi' => true, 'flagged' => false ];
        }

        // Already in byōyomi.
        if ( $elapsed_ms <= $time_ms ) {
            // Completed within the current period → refresh, lose nothing.
            return [ 'time_ms' => $period_ms, 'periods' => $periods, 'in_byoyomi' => true, 'flagged' => false ];
        }
        // Overran the current period (that's one lost) plus any further full periods.
        $over = $elapsed_ms - $time_ms;
        $lost = 1 + intdiv( $over, $period_ms );
        if ( $lost >= $periods ) {
            return [ 'time_ms' => 0, 'periods' => 0, 'in_byoyomi' => true, 'flagged' => true ];
        }
        return [ 'time_ms' => $period_ms, 'periods' => $periods - $lost, 'in_byoyomi' => true, 'flagged' => false ];
    }

    /**
     * Total wall-clock time (ms) a byōyomi player may consume before flagging.
     * Used for lazy/cron timeout detection when no move has been submitted.
     */
    public static function byoyomi_remaining_total( int $time_ms, int $periods, bool $in_byoyomi, int $period_ms ): int {
        $period_ms = max( 1, $period_ms );
        if ( ! $in_byoyomi ) {
            return $time_ms + max( 0, $periods ) * $period_ms;
        }
        // The currently-ticking period is already counted in $time_ms, so only
        // the reserve periods beyond it (periods - 1) add to the budget.
        return $time_ms + max( 0, $periods - 1 ) * $period_ms;
    }
}
