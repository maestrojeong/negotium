/** Epoch-shaped monotonic clock for stable elapsed-time rendering. */
export function terminalNowMs(): number {
  return performance.timeOrigin + performance.now();
}
