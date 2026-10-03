import type { ErrorCategory } from "../types/index.ts";

export class ScopeError extends Error {
  readonly errorCategory = "validation" as const;
}

export class CancelledError extends Error {
  readonly errorCategory = "cancelled" as const;
  constructor(message = "Operation cancelled.") {
    super(message);
    this.name = "CancelledError";
  }
}

export class UncertainWriteError extends Error {
  readonly errorCategory = "unknown" as const;
  readonly uncertain = true;
  constructor(message: string) {
    super(message);
    this.name = "UncertainWriteError";
  }
}

export class HttpFailure extends Error {
  readonly errorCategory: ErrorCategory;
  readonly uncertain: boolean;

  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs: number | null,
    idempotent: boolean,
  ) {
    super(message);
    this.name = "HttpFailure";
    this.errorCategory = categoryFromStatus(status);
    this.uncertain = !idempotent && (status >= 500 || status === 408 || status === 429);
  }
}

const CATEGORIES = new Set<ErrorCategory>([
  "auth",
  "permission",
  "validation",
  "not_found",
  "rate_limit",
  "cancelled",
  "timeout",
  "unknown",
]);

export function categoryFromStatus(status: number): ErrorCategory {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 409 || status === 422) return "validation";
  return "unknown";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function sanitizeErrorMessage(err: unknown, secrets: readonly string[] = []): string {
  let message = errorMessage(err).replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  for (const secret of secrets) {
    if (secret.length > 0) message = message.split(secret).join("[redacted]");
  }
  return message.slice(0, 300);
}

export function statusOf(err: unknown): number | null {
  if (err instanceof HttpFailure) return err.status;
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return null;
}

export function categoryOf(err: unknown): ErrorCategory {
  if (err instanceof CancelledError || err instanceof ScopeError || err instanceof HttpFailure) {
    return err.errorCategory;
  }
  if (err instanceof UncertainWriteError) return "unknown";
  if (isAbortError(err)) return "cancelled";
  const status = statusOf(err);
  if (status !== null) return categoryFromStatus(status);
  if (/timeout|ETIMEDOUT|ECONNRESET|fetch failed|EAI_AGAIN/i.test(errorMessage(err))) return "timeout";
  return "unknown";
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof CancelledError ||
    (err instanceof Error && (err.name === "AbortError" || err.name === "CancelledError"))
  );
}

export function isAmbiguousFailure(err: unknown): boolean {
  if (isAbortError(err) || err instanceof ScopeError) return false;
  const status = statusOf(err);
  if (status === null) return categoryOf(err) === "timeout" || categoryOf(err) === "unknown";
  return status >= 500 || status === 408 || status === 429;
}

export function retryAfterMs(err: unknown): number | null {
  if (err instanceof HttpFailure) return err.retryAfterMs;
  const headers = (err as { headers?: { get?: (name: string) => string | null } }).headers;
  if (typeof headers?.get === "function") return parseRetryAfter(headers.get("retry-after"));
  return null;
}

export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}
