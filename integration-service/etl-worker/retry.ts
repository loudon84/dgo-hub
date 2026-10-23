export function nextRetryDelay(attempt: number): number { return Math.min(60000, 1000 * 2 ** Math.max(0, Math.min(10, attempt))); }
