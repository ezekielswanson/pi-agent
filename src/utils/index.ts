export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function logCall(connector: string, action: string, summary: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    connector,
    action,
    ...summary,
  });
  console.error(`[pi-agent] ${line}`);
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const message = errorMessage(err);
      const retryable = /429|503|timeout|ECONNRESET|fetch failed/i.test(message);
      if (!retryable || i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** i));
    }
  }
  throw last;
}

export async function confirmWrite(
  ctx: { ui?: { confirm?: (title: string, message: string) => Promise<boolean> } } | undefined,
  title: string,
  message: string,
): Promise<boolean> {
  if (!ctx?.ui?.confirm) return true;
  return ctx.ui.confirm(title, message);
}
