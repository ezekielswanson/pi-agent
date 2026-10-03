import { randomUUID } from "node:crypto";
import type { ConnectorResult, ErrorCategory, ResultMeta } from "../types/index.ts";
import {
  categoryOf,
  errorMessage,
  sanitizeErrorMessage,
  UncertainWriteError,
} from "./errors.ts";
import { redactText } from "./redact.ts";

const runId = randomUUID();

export function getRunId(): string {
  return runId;
}

export function logCall(
  entry: {
    client: string;
    system: string;
    operation: string;
    ok: boolean;
    durationMs: number;
    errorCategory?: ErrorCategory | null;
    uncertain?: boolean;
  },
  secrets: readonly string[] = [],
  write: (line: string) => void = (line) => {
    console.error(line);
  },
): void {
  const payload = {
    ts: new Date().toISOString(),
    runId,
    client: entry.client,
    system: entry.system,
    operation: entry.operation,
    durationMs: entry.durationMs,
    result: entry.ok ? "ok" : "error",
    errorCategory: entry.errorCategory ?? null,
    uncertain: entry.uncertain === true,
  };
  write(`[pi-agent] ${redactText(JSON.stringify(payload), secrets)}`);
}

export async function runOperation<T>(
  meta: ResultMeta,
  secrets: readonly string[],
  fn: () => Promise<T>,
  extras: Pick<ConnectorResult<T>, "links" | "completeness"> = {},
): Promise<ConnectorResult<T>> {
  const started = Date.now();
  try {
    const data = await fn();
    const result: ConnectorResult<T> = { ok: true, ...meta, ...extras, data };
    logCall({ ...meta, ok: true, durationMs: Date.now() - started }, secrets);
    return result;
  } catch (err) {
    const errorCategory = categoryOf(err);
    const uncertain = err instanceof UncertainWriteError || (err as { uncertain?: boolean }).uncertain === true;
    const result: ConnectorResult<T> = {
      ok: false,
      ...meta,
      errorCategory,
      error: sanitizeErrorMessage(err, secrets),
      uncertain: uncertain || undefined,
    };
    logCall(
      { ...meta, ok: false, durationMs: Date.now() - started, errorCategory, uncertain },
      secrets,
    );
    return result;
  }
}

export function failureMessage(err: unknown): string {
  return errorMessage(err);
}
