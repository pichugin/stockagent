export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Timestamped, single-line logger so the unattended loop is easy to follow. */
export const log = {
  info(msg: string): void {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  },
  warn(msg: string): void {
    console.warn(`[${new Date().toISOString()}] WARN  ${msg}`);
  },
  error(msg: string): void {
    console.error(`[${new Date().toISOString()}] ERROR ${msg}`);
  },
};

export interface RetryOpts {
  retries?: number;
  baseDelayMs?: number;
  label?: string;
}

/**
 * Run `fn`, retrying transient failures with exponential backoff. The final
 * error is re-thrown so callers can log it and move on without crashing.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const { retries = 2, baseDelayMs = 500, label } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt;
        if (label) {
          log.warn(
            `${label}: attempt ${attempt + 1}/${retries + 1} failed (${errMsg(err)}); ` +
              `retrying in ${delay}ms`,
          );
        }
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
