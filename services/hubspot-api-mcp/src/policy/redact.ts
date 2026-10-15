const SECRET = /token|secret|authorization|password|refresh|access_token|client_secret/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET.test(key) ? "[redacted]" : redact(item, depth + 1);
  }
  return output;
}

export function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]")
    .replace(/(access_token|refresh_token|client_secret|authorization)=([^&\s]+)/gi, "$1=[redacted]");
}
