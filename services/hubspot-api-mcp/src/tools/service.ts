import { audit } from "../audit/log.ts";
import { HubSpotClient } from "../hubspot/client.ts";
import type { HubSpotGrant } from "../hubspot/tokenStore.ts";
import { approveProposal, consumeApproval, prepareChange } from "../policy/approval.ts";
import { assertOperationAllowed, buildPath, scopesSatisfied } from "../policy/exclusions.ts";
import { PolicyError } from "../policy/errors.ts";
import { redact } from "../policy/redact.ts";
import type { CallParams, OperationRecord } from "../registry/types.ts";

export interface ToolContext {
  actor: string;
  clientId: string;
  portalId: string;
  operations: Map<string, OperationRecord>;
  client: HubSpotClient;
  grant: () => Promise<HubSpotGrant>;
  approvalSecret: string;
  auditFile?: string;
}

export async function capabilityReport(ctx: ToolContext, meta: { retrievedAt: string; apiVersion: string }) {
  let grantedScopes: string[] = [];
  let grantState = "not_connected";
  try {
    grantedScopes = [...(await ctx.grant()).scopes];
    grantState = "connected";
  } catch {
    grantState = "not_connected";
  }
  const implemented = [...ctx.operations.values()].filter((operation) => operation.implemented);
  const executable = implemented.filter((operation) => grantedScopes.length > 0 && scopesSatisfied(operation, grantedScopes));
  return {
    retrievedAt: meta.retrievedAt,
    apiVersion: meta.apiVersion,
    implementedOperations: implemented.length,
    executableOperations: executable.length,
    excludedOperations: [...ctx.operations.values()].filter((operation) => operation.excluded).length,
    grantedScopes,
    grantState,
    runtime: "authorized_by_documented_scope_until_a_live_read_is_approved",
    destructiveExecution: "untested_live",
  };
}

export function listOperations(
  operations: Map<string, OperationRecord>,
  filter?: { domain?: string; effect?: string; query?: string; cursor?: number; limit?: number },
) {
  const needle = filter?.query?.toLowerCase();
  const matches = [...operations.values()]
    .filter((operation) => operation.implemented)
    .filter((operation) => !filter?.domain || operation.domain === filter.domain)
    .filter((operation) => !filter?.effect || operation.effect === filter.effect)
    .filter((operation) => !needle || `${operation.id} ${operation.title} ${operation.path}`.toLowerCase().includes(needle));
  const start = Math.max(0, filter?.cursor ?? 0);
  const limit = Math.min(100, Math.max(1, filter?.limit ?? 50));
  const page = matches.slice(start, start + limit);
  const next = start + page.length;
  return {
    total: matches.length,
    truncated: next < matches.length,
    nextCursor: next < matches.length ? next : null,
    operations: page.map((operation) => ({
      id: operation.id,
      title: operation.title,
      method: operation.method,
      path: operation.path,
      effect: operation.effect,
      destructive: operation.destructive,
      tool: operation.tool,
      scopes: operation.scopeGroups,
      sourceUrl: operation.sourceUrl,
    })),
  };
}

export async function readOperation(ctx: ToolContext, operationId: string, params: CallParams, followPages = false) {
  const operation = requiredOperation(ctx, operationId);
  if (operation.effect !== "read") throw new PolicyError("This operation is not a read. Prepare it instead.", "validation");
  assertOperationAllowed(operation);
  const grant = await ctx.grant();
  const result = await ctx.client.call({ operation, params, token: grant.accessToken, grantedScopes: grant.scopes, followPages });
  audit(
    {
      actor: ctx.actor,
      clientId: ctx.clientId,
      portalId: ctx.portalId,
      operation: operation.id,
      targetIds: Object.values(params.pathParams ?? {}),
      timestamp: new Date().toISOString(),
      outcome: result.ok ? "ok" : `http_${result.status}`,
      correlationId: result.correlationId,
    },
    ctx.auditFile,
  );
  return redact(result);
}

export async function prepareOperation(ctx: ToolContext, operationId: string, params: CallParams) {
  const operation = requiredOperation(ctx, operationId);
  if (operation.effect !== "mutate") throw new PolicyError("This operation is a read. Call the read tool.", "validation");
  assertOperationAllowed(operation);
  const path = buildPath(operation.path, params.pathParams);
  const proposal = prepareChange({
    actor: ctx.actor,
    clientId: ctx.clientId,
    portalId: ctx.portalId,
    operation,
    params,
    resolvedPath: path,
  });
  return redact({
    proposalId: proposal.id,
    expiresAt: new Date(proposal.expiresAt).toISOString(),
    method: proposal.method,
    path: proposal.path,
    destructive: proposal.destructive,
    elevated: proposal.elevated,
    sourceUrl: operation.sourceUrl,
    note: "This is a proposal. Execution requires the approval token from the human approval endpoint.",
  });
}

export async function executeOperation(ctx: ToolContext, operationId: string, params: CallParams, approvalToken: string) {
  const operation = requiredOperation(ctx, operationId);
  assertOperationAllowed(operation);
  const path = buildPath(operation.path, params.pathParams);
  const proposal = consumeApproval({
    token: approvalToken,
    secret: ctx.approvalSecret,
    actor: ctx.actor,
    clientId: ctx.clientId,
    portalId: ctx.portalId,
    operation,
    params,
    resolvedPath: path,
  });
  const grant = await ctx.grant();
  const result = await ctx.client.call({ operation, params, token: grant.accessToken, grantedScopes: grant.scopes });
  audit(
    {
      actor: ctx.actor,
      clientId: ctx.clientId,
      portalId: ctx.portalId,
      operation: operation.id,
      targetIds: Object.values(params.pathParams ?? {}),
      timestamp: new Date().toISOString(),
      approvalId: proposal.id,
      outcome: result.ok ? "ok" : `http_${result.status}`,
      correlationId: result.correlationId,
    },
    ctx.auditFile,
  );
  return redact(result);
}

export function approveForActor(ctx: Pick<ToolContext, "actor" | "portalId" | "approvalSecret">, proposalId: string) {
  return approveProposal({ proposalId, actor: ctx.actor, portalId: ctx.portalId, secret: ctx.approvalSecret });
}

function requiredOperation(ctx: ToolContext, operationId: string): OperationRecord {
  const operation = ctx.operations.get(operationId);
  if (!operation) throw new PolicyError("Unknown operation.", "validation");
  return operation;
}
