import type { ErrorCategory } from "../../types/index.ts";

export interface PortalAssessment {
  ok: boolean;
  actual: string | null;
  expected: string | null;
  error?: string;
  errorCategory?: ErrorCategory;
}

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
    readNested(userDetails, ["accountId"]),
    readNested(userDetails, ["account_id"]),
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
): PortalAssessment {
  const actual = asId(actualPortalId);
  const expected = asId(expectedPortalId);
  if (!expected) {
    return {
      ok: false,
      actual,
      expected,
      errorCategory: "validation",
      error: "No expected HubSpot portal is configured. Writes are blocked and identity is unverified.",
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      actual,
      expected,
      errorCategory: "validation",
      error: `HubSpot portal mismatch: expected ${expected}, got ${actual ?? "unknown"}.`,
    };
  }
  return { ok: true, actual, expected };
}

export function hubspotCheckForTool(assessment: PortalAssessment): {
  ok: false;
  writesAllowed: false;
  errorCategory: "validation";
  error: string;
  actual: string | null;
  expected: string | null;
} {
  return {
    ok: false,
    writesAllowed: false,
    errorCategory: "validation",
    actual: assessment.actual,
    expected: assessment.expected,
    error: assessment.ok
      ? "Portal ids match, but this session has not verified the MCP connection. Writes are blocked."
      : (assessment.error ?? "HubSpot identity is unverified. Writes are blocked."),
  };
}
