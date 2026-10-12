import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ELEVATED, type CallParams, type OperationRecord } from "../registry/types.ts";
import { PolicyError } from "./errors.ts";

export interface Proposal {
  id: string;
  actor: string;
  clientId: string;
  portalId: string;
  operationId: string;
  method: string;
  path: string;
  pathParams: Record<string, string>;
  query: Record<string, string | number | boolean>;
  body: unknown;
  bodyHash: string;
  destructive: string;
  elevated: boolean;
  expiresAt: number;
  approved: boolean;
  used: boolean;
}

export interface ApprovalRecord {
  proposal: Proposal;
  token: string;
}

const proposals = new Map<string, Proposal>();

export function payloadHash(input: unknown): string {
  return createHmac("sha256", "payload").update(stable(input)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function prepareChange(input: {
  actor: string;
  clientId: string;
  portalId: string;
  operation: OperationRecord;
  params: CallParams;
  resolvedPath: string;
  ttlMs?: number;
}): Proposal {
  const proposal: Proposal = {
    id: randomUUID(),
    actor: input.actor,
    clientId: input.clientId,
    portalId: input.portalId,
    operationId: input.operation.id,
    method: input.operation.method,
    path: input.resolvedPath,
    pathParams: input.params.pathParams ?? {},
    query: input.params.query ?? {},
    body: input.params.body ?? null,
    bodyHash: payloadHash(input.params.body ?? null),
    destructive: input.operation.destructive,
    elevated: ELEVATED.has(input.operation.destructive),
    expiresAt: Date.now() + (input.ttlMs ?? 10 * 60 * 1000),
    approved: false,
    used: false,
  };
  proposals.set(proposal.id, proposal);
  return proposal;
}

export function approveProposal(input: { proposalId: string; actor: string; portalId: string; secret: string }): ApprovalRecord {
  const proposal = requiredProposal(input.proposalId);
  if (proposal.actor !== input.actor || proposal.portalId !== input.portalId) {
    throw new PolicyError("Approval actor or portal does not match the proposal.", "approval");
  }
  if (proposal.expiresAt <= Date.now()) throw new PolicyError("Proposal expired.", "approval");
  proposal.approved = true;
  const token = sign(proposal, input.secret);
  return { proposal, token };
}

export function consumeApproval(input: {
  token: string;
  secret: string;
  actor: string;
  clientId: string;
  portalId: string;
  operation: OperationRecord;
  params: CallParams;
  resolvedPath: string;
}): Proposal {
  const proposalId = verify(input.token, input.secret);
  const proposal = requiredProposal(proposalId);
  if (!proposal.approved || proposal.used) throw new PolicyError("Approval is not active.", "approval");
  if (proposal.expiresAt <= Date.now()) throw new PolicyError("Approval expired.", "approval");
  if (proposal.actor !== input.actor || proposal.clientId !== input.clientId || proposal.portalId !== input.portalId) {
    throw new PolicyError("Approval does not match this caller.", "approval");
  }
  if (proposal.operationId !== input.operation.id || proposal.method !== input.operation.method || proposal.path !== input.resolvedPath) {
    throw new PolicyError("Approval does not match this operation.", "approval");
  }
  if (proposal.bodyHash !== payloadHash(input.params.body ?? null)) {
    throw new PolicyError("Approval does not match this payload.", "approval");
  }
  proposal.used = true;
  return proposal;
}

export function resetApprovals(): void {
  proposals.clear();
}

function requiredProposal(id: string): Proposal {
  const proposal = proposals.get(id);
  if (!proposal) throw new PolicyError("Unknown proposal.", "approval");
  return proposal;
}

function sign(proposal: Proposal, secret: string): string {
  const body = Buffer.from(JSON.stringify({ id: proposal.id, exp: proposal.expiresAt, hash: proposal.bodyHash })).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify(token: string, secret: string): string {
  const [body, mac] = token.split(".");
  if (!body || !mac) throw new PolicyError("Malformed approval.", "approval");
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new PolicyError("Approval signature rejected.", "approval");
  }
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString()) as { id?: string; exp?: number };
  if (!parsed.id || !parsed.exp || parsed.exp <= Date.now()) throw new PolicyError("Approval expired.", "approval");
  return parsed.id;
}
