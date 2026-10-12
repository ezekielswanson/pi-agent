import { assertBatchBound, assertOperationAllowed, buildPath, scopesSatisfied } from "../policy/exclusions.ts";
import { PolicyError } from "../policy/errors.ts";
import { redact } from "../policy/redact.ts";
import type { CallParams, OperationRecord } from "../registry/types.ts";

export interface HubSpotCallResult {
  ok: boolean;
  status: number;
  operationId: string;
  method: string;
  path: string;
  body: unknown;
  truncated: boolean;
  correlationId: string | null;
  sourceUrl: string;
  pages: number;
}

export interface HubSpotClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  maxRecords?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepDefault = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class HubSpotClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxRecords: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HubSpotClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://api.hubapi.com").replace(/\/$/, "");
    this.maxRecords = options.maxRecords ?? 100;
    this.sleep = options.sleep ?? (async (ms: number) => {
      await sleepDefault(ms);
    });
  }

  async call(input: {
    operation: OperationRecord;
    params: CallParams;
    token: string;
    grantedScopes: readonly string[];
    followPages?: boolean;
  }): Promise<HubSpotCallResult> {
    assertOperationAllowed(input.operation);
    if (!scopesSatisfied(input.operation, input.grantedScopes)) {
      throw new PolicyError("Granted HubSpot scopes do not satisfy this operation.", "scope");
    }
    assertBatchBound(input.params.body, input.operation.batch);
    const path = buildPath(input.operation.path, input.params.pathParams);
    const pages: unknown[] = [];
    let after: string | undefined;
    let status = 0;
    let correlationId: string | null = null;
    let truncated = false;
    const exportCall = isExport(input.operation);
    const recordCap = exportCall ? Math.min(this.maxRecords, 10) : this.maxRecords;
    const limit = exportCall ? 1 : input.followPages && input.operation.paginated ? 5 : 1;
    const sensitive = allowsSensitiveProperties(input.operation, input.grantedScopes);
    for (let page = 0; page < limit; page += 1) {
      const query = stripSensitiveQuery({ ...(input.params.query ?? {}) }, sensitive);
      if (after) query.after = after;
      const response = await this.request(input.operation, path, query, input.params.body, input.token);
      status = response.status;
      correlationId = response.correlationId ?? correlationId;
      pages.push(response.body);
      const next = nextCursor(response.body);
      const count = countResults(pages);
      if (!input.followPages || !next || count >= recordCap) {
        truncated = Boolean(next);
        break;
      }
      after = next;
    }
    const combined = pages.length === 1 ? pages[0] : { pages };
    const capped = exportCall ? capExport(combined, recordCap) : { body: combined, truncated: false };
    return {
      ok: status >= 200 && status < 300,
      status,
      operationId: input.operation.id,
      method: input.operation.method,
      path,
      body: redact(stripSensitiveValue(capped.body, sensitive)),
      truncated: truncated || capped.truncated,
      correlationId,
      sourceUrl: input.operation.sourceUrl,
      pages: pages.length,
    };
  }

  private async request(
    operation: OperationRecord,
    path: string,
    query: Record<string, string | number | boolean>,
    body: unknown,
    token: string,
  ): Promise<{ status: number; body: unknown; correlationId: string | null }> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const init: RequestInit = {
      method: operation.method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body !== undefined && operation.method !== "GET" ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined && operation.method !== "GET" ? JSON.stringify(body) : undefined,
    };
    let response = await this.fetchImpl(url, init);
    let correlationId = response.headers.get("x-hubspot-correlation-id");
    const retryable = operation.effect === "read" && (response.status === 429 || response.status === 503);
    if (retryable) {
      const wait = retryDelay(response);
      await this.sleep(wait);
      response = await this.fetchImpl(url, init);
      correlationId = response.headers.get("x-hubspot-correlation-id") ?? correlationId;
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
    }
    return {
      status: response.status,
      body: parsed,
      correlationId,
    };
  }
}

function retryDelay(response: Response): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : 0;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 2000);
  return 10;
}

function nextCursor(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const paging = (body as { paging?: { next?: { after?: unknown } } }).paging;
  const after = paging?.next?.after;
  return typeof after === "string" && after ? after : undefined;
}

const SENSITIVE_KEY = /sensitive|ssn|passport|tax_?id|social_security/i;

export function allowsSensitiveProperties(operation: OperationRecord, grantedScopes: readonly string[]): boolean {
  const names = operation.scopeGroups.flatMap((group) => group.scopes).filter((scope) => /sensitive/i.test(scope));
  return names.length > 0 && names.some((scope) => grantedScopes.includes(scope));
}

function isExport(operation: OperationRecord): boolean {
  return operation.path.includes("/exports") || operation.id.includes("export");
}

function stripSensitiveQuery(query: Record<string, string | number | boolean>, allow: boolean): Record<string, string | number | boolean> {
  if (allow || typeof query.properties !== "string") return query;
  const properties = query.properties.split(",").map((name) => name.trim()).filter((name) => name && !SENSITIVE_KEY.test(name));
  return { ...query, properties: properties.join(",") };
}

function capExport(body: unknown, cap: number): { body: unknown; truncated: boolean } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { body, truncated: false };
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length <= cap) return { body, truncated: false };
  return { body: { ...(body as Record<string, unknown>), results: results.slice(0, cap) }, truncated: true };
}

function stripSensitiveValue(value: unknown, allow: boolean): unknown {
  if (allow || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripSensitiveValue(item, allow));
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) continue;
    output[key] = stripSensitiveValue(child, allow);
  }
  return output;
}

function countResults(pages: unknown[]): number {
  return pages.reduce<number>((total, page) => {
    if (page && typeof page === "object" && Array.isArray((page as { results?: unknown }).results)) {
      return total + (page as { results: unknown[] }).results.length;
    }
    return total + 1;
  }, 0);
}
