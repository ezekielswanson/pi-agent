import {
  CancelledError,
  categoryOf,
  isAbortError,
  isAmbiguousFailure,
  retryAfterMs,
  UncertainWriteError,
  sanitizeErrorMessage,
} from "./errors.ts";

export interface RetryOptions {
  idempotent: boolean;
  signal?: AbortSignal;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_ATTEMPTS = 3;
const BASE_MS = 200;
const MAX_BACKOFF_MS = 2_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = options.idempotent ? (options.attempts ?? DEFAULT_ATTEMPTS) : 1;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let last: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfCancelled(options.signal);
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (isAbortError(err) || options.signal?.aborted) throw new CancelledError();
      const retryable =
        options.idempotent &&
        attempt < attempts - 1 &&
        (categoryOf(err) === "rate_limit" || categoryOf(err) === "timeout" || isTransientStatus(err));
      if (!retryable) {
        if (!options.idempotent && isAmbiguousFailure(err)) {
          throw err instanceof UncertainWriteError ? err : new UncertainWriteError(sanitizeErrorMessage(err));
        }
        throw err;
      }
      const retryAfter = retryAfterMs(err);
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_MS * 2 ** attempt);
      const wait = retryAfter ?? backoff + random() * 50;
      await sleep(wait);
    }
  }

  throw last;
}

function isTransientStatus(err: unknown): boolean {
  const status = (err as { status?: unknown }).status;
  return status === 500 || status === 502 || status === 503;
}
