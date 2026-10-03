import { createHash } from "node:crypto";
import type { ErrorCategory } from "../types/index.ts";
import type { ClientSession } from "../runtime/clientSession.ts";
import { sanitizeErrorMessage, ScopeError } from "./errors.ts";
import { redactText } from "./redact.ts";

export interface ApprovalTarget {
  id?: string;
  title?: string;
  link?: string;
}

export interface ApprovalRequest {
  clientSlug: string;
  system: string;
  operation: string;
  target: ApprovalTarget;
  changes: Record<string, unknown>;
  sessionGeneration: number;
}

export interface ConfirmContext {
  ui?: {
    confirm?: (title: string, message: string) => Promise<boolean>;
  };
}

export type ConfirmDecision =
  | { ok: true; grantId: string; hash: string }
  | { ok: false; error: string; errorCategory: ErrorCategory };

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function approvalHash(request: ApprovalRequest): string {
  return createHash("sha256")
    .update(
      stableStringify({
        clientSlug: request.clientSlug,
        system: request.system,
        operation: request.operation,
        target: request.target,
        changes: request.changes,
        sessionGeneration: request.sessionGeneration,
      }),
    )
    .digest("hex");
}

export function formatApprovalPreview(request: ApprovalRequest, secrets: readonly string[] = []): string {
  const target = [request.target.title, request.target.id, request.target.link].filter(Boolean).join(" ");
  const lines = [
    `Client: ${request.clientSlug}`,
    `System: ${request.system}`,
    `Operation: ${request.operation}`,
    `Target: ${target || "unspecified"}`,
    "Changes:",
  ];
  for (const [key, value] of Object.entries(request.changes)) {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    lines.push(`- ${key}: ${rendered}`);
  }
  return redactText(lines.join("\n"), secrets);
}

function denied(error: string, errorCategory: ErrorCategory = "validation"): ConfirmDecision {
  return { ok: false, error, errorCategory };
}

export async function confirmWrite(
  ctx: ConfirmContext | undefined,
  request: ApprovalRequest,
  session: ClientSession,
  secrets: readonly string[] = [],
): Promise<ConfirmDecision> {
  if (!session.toolsEnabled) {
    return denied("Client tools are disabled until /client completes a fresh session.");
  }
  if (request.sessionGeneration !== session.generation) {
    return denied("Approval is stale for this client session.");
  }
  const confirm = ctx?.ui?.confirm;
  if (!confirm) return denied("Approval UI is unavailable. Write blocked.");

  session.beginApproval();
  let allowed = false;
  try {
    allowed = await confirm(request.operation, formatApprovalPreview(request, secrets));
  } catch {
    allowed = false;
  } finally {
    session.endApproval();
  }

  if (session.generation !== request.sessionGeneration) {
    return denied("Client changed during approval. Write blocked.");
  }
  if (!allowed) return denied("Write denied.");
  const hash = approvalHash(request);
  return { ok: true, grantId: session.rememberGrant(hash), hash };
}

export async function executeApprovedWrite<T>(
  session: ClientSession,
  decision: { grantId: string; hash: string },
  request: ApprovalRequest,
  write: () => Promise<T>,
): Promise<T> {
  const hash = approvalHash(request);
  if (hash !== decision.hash || !session.consumeGrant(decision.grantId, hash)) {
    throw new ScopeError("Approval does not match this client, target, and payload.");
  }
  return write();
}

export async function authorizeWrite<T>(
  ctx: ConfirmContext | undefined,
  request: ApprovalRequest,
  session: ClientSession,
  secrets: readonly string[],
  write: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string; errorCategory: ErrorCategory }> {
  const decision = await confirmWrite(ctx, request, session, secrets);
  if (!decision.ok) return decision;
  try {
    return { ok: true, value: await executeApprovedWrite(session, decision, request, write) };
  } catch (err) {
    return { ok: false, error: sanitizeErrorMessage(err, secrets), errorCategory: "validation" };
  }
}
