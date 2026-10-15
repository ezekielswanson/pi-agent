import { audit } from "../audit/log.ts";
import { HubSpotClient } from "../hubspot/client.ts";
import type { HubSpotGrant } from "../hubspot/tokenStore.ts";
import { actionLabel, assertActionAllowed, isDeletion, type ActionPolicy } from "../policy/actionPolicy.ts";
import { approveProposal, consumeApproval, prepareChange, proposalsForDisplay } from "../policy/approval.ts";
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
  actionPolicy: ActionPolicy;
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
  const labeled = implemented.map((operation) => ({ operation, label: actionLabel(ctx.actionPolicy, operation) }));
  const granted = (operation: OperationRecord) => grantedScopes.length > 0 && scopesSatisfied(operation, grantedScopes);
  return {
    retrievedAt: meta.retrievedAt,
    apiVersion: meta.apiVersion,
    implementedOperations: implemented.length,
    executableOperations: labeled.filter((item) => item.label.action === "allow" && granted(item.operation)).length,
    approvalRequiredOperations: labeled.filter((item) => item.label.action === "approval_required" && granted(item.operation)).length,
    deniedByPolicy: labeled.filter((item) => item.label.action === "deny").length,
    excludedOperations: [...ctx.operations.values()].filter((operation) => operation.excluded).length,
    grantedScopes,
    grantState,
    actionPolicy: ctx.actionPolicy,
    runtime: "authorized_by_documented_scope_until_a_live_read_is_approved",
    deletion: "denied_this_release",
  };
}

export function listOperations(
  operations: Map<string, OperationRecord>,
  filter?: { domain?: string; effect?: string; query?: string; cursor?: number; limit?: number; policy?: ActionPolicy },
) {
  const needle = filter?.query?.toLowerCase();
  const matches = [...operations.values()]
    .filter((operation) => operation.implemented)
    .filter((operation) => !filter?.domain || operation.domain === filter.domain)
    .filter((operation) => !filter?.effect || operation.effect === filter.effect)
    .filter((operation) => !needle || `${operation.id} ${operation.title} ${operation.path}`.toLowerCase().includes(needle));
  const start = Math.max(0, filter?.cursor ?? 0);
  const limit = Math.min(100, Math.max(1, filter?.limit ?? 50));
  const policy = filter?.policy;
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
      action: policy ? actionLabel(policy, operation).action : undefined,
      tool: operation.tool,
      scopes: operation.scopeGroups,
      sourceUrl: operation.sourceUrl,
    })),
  };
}

export async function readOperation(ctx: ToolContext, operationId: string, params: CallParams, followPages = false) {
  const operation = requiredOperation(ctx, operationId);
  assertActionAllowed(ctx.actionPolicy, operation, "read");
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
  assertActionAllowed(ctx.actionPolicy, operation, "prepare");
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
  assertActionAllowed(ctx.actionPolicy, operation, "execute");
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
  const proposal = proposalsForDisplay(proposalId);
  if (proposal && isDeletion(proposal)) {
    throw new PolicyError("Delete, archive, and purge operations are denied for this release.", "policy");
  }
  return approveProposal({ proposalId, actor: ctx.actor, portalId: ctx.portalId, secret: ctx.approvalSecret });
}

function requiredOperation(ctx: ToolContext, operationId: string): OperationRecord {
  const operation = ctx.operations.get(operationId);
  if (!operation) throw new PolicyError("Unknown operation.", "validation");
  return operation;
}
