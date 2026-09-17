import type { ConnectorResult } from "../../types/index.ts";

function asId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function readNested(source: unknown, keys: string[]): unknown {
  let current = source;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function extractPortalId(userDetails: unknown): string | null {
  const candidates = [
    readNested(userDetails, ["portalId"]),
    readNested(userDetails, ["portal_id"]),
    readNested(userDetails, ["hubId"]),
    readNested(userDetails, ["hub_id"]),
    readNested(userDetails, ["account", "portalId"]),
    readNested(userDetails, ["account", "portal_id"]),
    readNested(userDetails, ["user", "portalId"]),
    readNested(userDetails, ["user", "hub_id"]),
  ];
  for (const candidate of candidates) {
    const id = asId(candidate);
    if (id) return id;
  }
  return null;
}

export function checkExpectedPortal(
  actualPortalId: string | number | null | undefined,
  expectedPortalId: string | number | null | undefined,
): ConnectorResult<{
  matched: boolean;
  actual: string | null;
  expected: string | null;
  note?: string;
}> {
  const actual = asId(actualPortalId);
  const expected = asId(expectedPortalId);

  if (!expected) {
    return {
      ok: true,
      data: {
        matched: true,
        actual,
        expected,
        note: "No expected HubSpot portal is configured for this client.",
      },
    };
  }

  if (actual !== expected) {
    return {
      ok: false,
      error: `HubSpot portal mismatch: expected ${expected}, got ${actual ?? "unknown"}. Re-auth with /mcp-auth hubspot for the correct account.`,
    };
  }

  return { ok: true, data: { matched: true, actual, expected } };
}
