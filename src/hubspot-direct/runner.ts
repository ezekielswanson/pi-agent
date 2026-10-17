import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HubSpotClient, type HubSpotCallResult } from "../../services/hubspot-api-mcp/src/hubspot/client.ts";
import { buildPath } from "../../services/hubspot-api-mcp/src/policy/exclusions.ts";
import { PolicyError } from "../../services/hubspot-api-mcp/src/policy/errors.ts";
import { loadOperations, operationMap } from "../../services/hubspot-api-mcp/src/registry/load.ts";
import type { CallParams, OperationRecord } from "../../services/hubspot-api-mcp/src/registry/types.ts";
import { ApprovalStore, createProposal, type DirectProposal } from "./approvals.ts";
import { ACCOUNT_OPERATION_ID, PORTAL_ID } from "./constants.ts";
import { assertDirectAllowed, type WriteMode } from "./policy.ts";
import { loadDirectApp } from "./scopes.ts";

const RECORD_TYPES: Record<string, string> = {
  contacts: "0-1",
  companies: "0-2",
  deals: "0-3",
  tickets: "0-5",
};

export interface DirectResult {
  ok: boolean;
  status: number;
  operationId: string;
  method: string;
  path: string;
  portalId: string;
  body: unknown;
  truncated: boolean;
  pages: number;
  recordUrl: string | null;
  scopeIntrospection: "unavailable";
}

export interface DirectRunnerOptions {
  token: string;
  writes?: WriteMode;
  fetchImpl?: typeof fetch;
  approvalFile?: string;
  now?: () => number;
  operations?: OperationRecord[];
  portalId?: string;
}

export class DirectRunner {
  private readonly client: HubSpotClient;
  private readonly operations: Map<string, OperationRecord>;
  private readonly grantedScopes: readonly string[];
  private readonly store: ApprovalStore;
  private readonly writes: WriteMode;
  private readonly portalId: string;

  constructor(private readonly options: DirectRunnerOptions) {
    this.client = new HubSpotClient({ fetchImpl: options.fetchImpl });
    this.operations = operationMap(options.operations ?? loadOperations());
    this.grantedScopes = loadDirectApp().requiredScopes;
    this.writes = options.writes ?? "deny";
    this.portalId = options.portalId ?? PORTAL_ID;
    this.store = new ApprovalStore(
      options.approvalFile ?? join(dirname(fileURLToPath(import.meta.url)), "../../.pi/hubspot-direct/approvals.json"),
      options.now,
    );
  }

  list(match = ""): { id: string; method: string; effect: string; path: string }[] {
    const needle = match.toLowerCase();
    return [...this.operations.values()]
      .filter((operation) => operation.implemented)
      .filter((operation) => !needle || `${operation.id} ${operation.path}`.toLowerCase().includes(needle))
      .map((operation) => ({
        id: operation.id,
        method: operation.method,
        effect: operation.effect,
        path: operation.path,
      }));
  }

  async read(operationId: string, params: CallParams = {}): Promise<DirectResult> {
    const operation = this.operation(operationId);
    assertDirectAllowed(operation, "read", this.writes);
    if (operation.id === ACCOUNT_OPERATION_ID) {
      const result = await this.call(operation, params);
      this.assertPortal(result.body);
      return this.toResult(operation, result);
    }
    await this.verifyPortal();
    const result = await this.call(operation, params);
    return this.toResult(operation, result);
  }

  async prepare(operationId: string, params: CallParams = {}): Promise<DirectProposal> {
    const operation = this.operation(operationId);
    assertDirectAllowed(operation, "prepare", this.writes);
    await this.verifyPortal();
    const proposal = createProposal({
      portalId: this.portalId,
      operation,
      params,
      resolvedPath: buildPath(operation.path, params.pathParams),
      now: this.options.now?.(),
    });
    return this.store.prepare(proposal);
  }

  approve(proposalId: string): DirectProposal {
    if (this.writes !== "approval") {
      throw new PolicyError("Writes are denied. Set HUBSPOT_DIRECT_WRITES=approval before approving.", "policy");
    }
    return this.store.approve(proposalId);
  }

  async execute(proposalId: string): Promise<DirectResult> {
    const stored = this.store.get(proposalId);
    if (!stored) throw new PolicyError("Unknown proposal.", "approval");
    const operation = this.operation(stored.operationId);
    const params: CallParams = {
      pathParams: stored.pathParams,
      query: stored.query,
      body: stored.body === null ? undefined : stored.body,
    };
    assertDirectAllowed(operation, "execute", this.writes);
    await this.verifyPortal();
    this.store.consume({
      id: proposalId,
      operation,
      params,
      resolvedPath: stored.path,
      portalId: this.portalId,
    });
    const result = await this.call(operation, params);
    return this.toResult(operation, result);
  }

  private async verifyPortal(): Promise<void> {
    const account = this.operation(ACCOUNT_OPERATION_ID);
    assertDirectAllowed(account, "read", this.writes);
    const result = await this.call(account, {});
    this.assertPortal(result.body);
  }

  private assertPortal(body: unknown): void {
    const portalId = portalFrom(body);
    if (portalId !== this.portalId) {
      throw new PolicyError(`Connected portal ${portalId ?? "unknown"} is not ${this.portalId}.`, "auth");
    }
  }

  private async call(operation: OperationRecord, params: CallParams): Promise<HubSpotCallResult> {
    return this.client.call({
      operation,
      params,
      token: this.options.token,
      grantedScopes: this.grantedScopes,
      followPages: operation.effect === "read",
    });
  }

  private toResult(operation: OperationRecord, result: HubSpotCallResult): DirectResult {
    return {
      ok: result.ok,
      status: result.status,
      operationId: result.operationId,
      method: result.method,
      path: result.path,
      portalId: this.portalId,
      body: result.body,
      truncated: result.truncated,
      pages: result.pages,
      recordUrl: recordUrl(this.portalId, operation.path, result.body),
      scopeIntrospection: "unavailable",
    };
  }

  private operation(id: string): OperationRecord {
    const operation = this.operations.get(id);
    if (!operation) throw new PolicyError(`Unknown operation ${id}.`, "validation");
    return operation;
  }
}

function portalFrom(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const value = record.portalId ?? record.hubId;
  if (typeof value === "number" || typeof value === "string") return String(value);
  return null;
}

function recordUrl(portalId: string, path: string, body: unknown): string | null {
  if (!body || typeof body !== "object" || !("id" in body)) return null;
  const id = String((body as { id: unknown }).id);
  const match = path.match(/\/crm\/objects\/[^/]+\/([^/]+)\//);
  const typeId = match ? RECORD_TYPES[match[1]] : undefined;
  if (!typeId || !id) return null;
  return `https://app.hubspot.com/contacts/${portalId}/record/${typeId}/${id}`;
}
