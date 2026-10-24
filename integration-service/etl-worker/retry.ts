export function nextRetryDelay(attempt: number): number { return Math.min(60000, 1000 * 2 ** Math.max(0, Math.min(10, attempt))); }

const DURABLE_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;

export function durableRetryDelayMs(attemptStarted: number): number | null {
  if (!Number.isInteger(attemptStarted) || attemptStarted < 1 || attemptStarted > 3) return null;
  return DURABLE_RETRY_DELAYS_MS[attemptStarted - 1] ?? null;
}
