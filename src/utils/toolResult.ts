export function markFailedToolResult(toolName: string, details: unknown): { isError: true } | undefined {
  if (!/^(notion_|asana_|external_|hubspot_)/.test(toolName)) return undefined;
  if (typeof details === "object" && details !== null && "ok" in details && details.ok === false) {
    return { isError: true };
  }
  return undefined;
}
