import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { payloadHash } from "../../services/hubspot-api-mcp/src/policy/approval.ts";
import { PolicyError } from "../../services/hubspot-api-mcp/src/policy/errors.ts";
import type { CallParams, OperationRecord } from "../../services/hubspot-api-mcp/src/registry/types.ts";
import { APPROVAL_TTL_MS } from "./constants.ts";

export interface DirectProposal {
  id: string;
  portalId: string;
  operationId: string;
  method: string;
  path: string;
  pathParams: Record<string, string>;
  query: Record<string, string | number | boolean>;
  body: unknown;
  bodyHash: string;
  expiresAt: number;
  approved: boolean;
  used: boolean;
}

export function createProposal(input: {
  portalId: string;
  operation: OperationRecord;
  params: CallParams;
  resolvedPath: string;
  now?: number;
  ttlMs?: number;
}): DirectProposal {
  const now = input.now ?? Date.now();
  return {
    id: randomUUID(),
    portalId: input.portalId,
    operationId: input.operation.id,
    method: input.operation.method,
    path: input.resolvedPath,
    pathParams: input.params.pathParams ?? {},
    query: input.params.query ?? {},
    body: input.params.body ?? null,
    bodyHash: payloadHash({
      method: input.operation.method,
      path: input.resolvedPath,
      query: input.params.query ?? {},
      body: input.params.body ?? null,
    }),
    expiresAt: now + (input.ttlMs ?? APPROVAL_TTL_MS),
    approved: false,
    used: false,
  };
}

export class ApprovalStore {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  prepare(proposal: DirectProposal): DirectProposal {
    const all = this.read();
    all.push(proposal);
    this.write(all);
    return proposal;
  }

  approve(id: string): DirectProposal {
    return this.update(id, (proposal) => {
      this.assertUsable(proposal);
      if (proposal.approved || proposal.used) throw new PolicyError("Proposal was already reviewed.", "approval");
      proposal.approved = true;
      return proposal;
    });
  }

  consume(input: { id: string; operation: OperationRecord; params: CallParams; resolvedPath: string; portalId: string }): DirectProposal {
    return this.update(input.id, (proposal) => {
      this.assertUsable(proposal);
      if (!proposal.approved || proposal.used) throw new PolicyError("Approval is not active.", "approval");
      if (proposal.portalId !== input.portalId || proposal.operationId !== input.operation.id || proposal.method !== input.operation.method) {
        throw new PolicyError("Approval does not match this operation.", "approval");
      }
      if (proposal.path !== input.resolvedPath) throw new PolicyError("Approval does not match this path.", "approval");
      const requestHash = payloadHash({
        method: input.operation.method,
        path: input.resolvedPath,
        query: input.params.query ?? {},
        body: input.params.body ?? null,
      });
      if (proposal.bodyHash !== requestHash) throw new PolicyError("Approval does not match this payload.", "approval");
      proposal.used = true;
      return proposal;
    });
  }

  get(id: string): DirectProposal | null {
    return this.read().find((proposal) => proposal.id === id) ?? null;
  }

  private assertUsable(proposal: DirectProposal): void {
    if (proposal.expiresAt <= this.now()) throw new PolicyError("Proposal expired.", "approval");
    if (proposal.used) throw new PolicyError("Proposal was already used.", "approval");
  }

  private update(id: string, change: (proposal: DirectProposal) => DirectProposal): DirectProposal {
    const all = this.read();
    const proposal = all.find((item) => item.id === id);
    if (!proposal) throw new PolicyError("Unknown proposal.", "approval");
    const updated = change(proposal);
    this.write(all);
    return updated;
  }

  private read(): DirectProposal[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed as DirectProposal[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private write(proposals: DirectProposal[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(proposals, null, 2));
  }
}
