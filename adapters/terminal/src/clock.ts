/**
 * Wall clock used by persisted runtime-event timestamps.
 *
 * Do not derive this from `performance.timeOrigin + performance.now()`: on
 * macOS the monotonic clock may pause while the machine sleeps, while event
 * `createdAt` values continue on wall time. Mixing those clocks makes a turn
 * started after wake-up appear to begin in the future and pins Working at 0s.
 */
export function terminalNowMs(): number {
  return Date.now();
}
