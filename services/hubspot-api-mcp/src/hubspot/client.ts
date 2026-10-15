import { assertBatchBound, assertOperationAllowed, buildPath, scopesSatisfied } from "../policy/exclusions.ts";
import { PolicyError } from "../policy/errors.ts";
import { redact } from "../policy/redact.ts";
import { assertRequestedProperties, assertWritableProperties, filterPropertyBag, filterPropertyList, objectNameFromPath } from "../policy/sensitivity.ts";
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
    assertExportBounded(input.operation, input.params);
    const path = buildPath(input.operation.path, input.params.pathParams);
    const objectName = objectNameFromPath(path);
    const effect = input.operation.effect === "mutate" ? "mutate" : "read";
    const sensitivity = { objectName, effect, grantedScopes: input.grantedScopes } as const;
    assertRequestedProperties(input.params.body, sensitivity);
    if (effect === "mutate") assertWritableProperties(input.params.body, sensitivity);
    const pages: unknown[] = [];
    let after: string | undefined;
    let status = 0;
    let correlationId: string | null = null;
    let truncated = false;
    const limit = input.followPages && input.operation.paginated ? 5 : 1;
    for (let page = 0; page < limit; page += 1) {
      const query = filterQuery({ ...(input.params.query ?? {}) }, sensitivity);
      if (after) query.after = after;
      const response = await this.request(input.operation, path, query, input.params.body, input.token);
      status = response.status;
      correlationId = response.correlationId ?? correlationId;
      pages.push(response.body);
      const next = nextCursor(response.body);
      const count = countResults(pages);
      if (!input.followPages || !next || count >= this.maxRecords) {
        truncated = Boolean(next);
        break;
      }
      after = next;
    }
    const combined = pages.length === 1 ? pages[0] : { pages };
    return {
      ok: status >= 200 && status < 300,
      status,
      operationId: input.operation.id,
      method: input.operation.method,
      path,
      body: redact(filterPropertyBag(combined, sensitivity)),
      truncated,
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
    if (url.origin !== new URL(this.baseUrl).origin) throw new PolicyError("HubSpot request host is not allowed.", "validation");
    let response = await this.fetchOnce(url, init);
    let correlationId = response.headers.get("x-hubspot-correlation-id");
    const retryable = operation.effect === "read" && (response.status === 429 || response.status === 503);
    if (retryable) {
      const wait = retryDelay(response);
      await this.sleep(wait);
      response = await this.fetchOnce(url, init);
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

  private async fetchOnce(url: URL, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(url, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) throw new PolicyError("HubSpot redirect is not followed.", "validation");
    return response;
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

function assertExportBounded(operation: OperationRecord, params: CallParams): void {
  const exportCall = operation.path.includes("/exports") || operation.id.includes("export");
  if (!exportCall) return;
  if (operation.method === "GET" || operation.path.includes("/download")) {
    throw new PolicyError("Unbounded export retrieval is disabled.", "validation");
  }
  const raw = params.query?.limit ?? (params.body as { limit?: unknown } | undefined)?.limit;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new PolicyError("Export creation requires an explicit limit of 1 to 10.", "validation");
  }
}

function filterQuery(
  query: Record<string, string | number | boolean>,
  input: { objectName: string | null; effect: "read" | "mutate"; grantedScopes: readonly string[] },
): Record<string, string | number | boolean> {
  if (typeof query.properties !== "string") return query;
  const properties = filterPropertyList(query.properties.split(",").map((name) => name.trim()).filter(Boolean), input);
  return { ...query, properties: properties.join(",") };
}

function countResults(pages: unknown[]): number {
  return pages.reduce<number>((total, page) => {
    if (page && typeof page === "object" && Array.isArray((page as { results?: unknown }).results)) {
      return total + (page as { results: unknown[] }).results.length;
    }
    return total + 1;
  }, 0);
}
