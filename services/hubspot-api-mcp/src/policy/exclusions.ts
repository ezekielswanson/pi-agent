import { EXCLUDED_SCOPES, type OperationRecord } from "../registry/types.ts";
import { PolicyError } from "./errors.ts";

const FILE_DELETE = /(?:^|\/)files(?:\/|$)|file-manager/i;
const PAYMENT_LINK = /payment[-_]links?/i;

export function pathDeletesFile(method: string, path: string): boolean {
  const destructive = method === "DELETE" || /gdpr-delete|\/purge|permanent/i.test(path);
  return destructive && FILE_DELETE.test(path);
}

export function pathDeletesPaymentLink(method: string, path: string): boolean {
  const destructive = method === "DELETE" || /gdpr-delete|\/purge|permanent/i.test(path);
  return destructive && PAYMENT_LINK.test(path);
}

export function exclusionReason(operation: OperationRecord): string | null {
  if (operation.excluded && operation.exclusionReason) return operation.exclusionReason;
  if (pathDeletesFile(operation.method, operation.path) || /delete a file/i.test(operation.title)) {
    return "File deletion is blocked, including batch and permanent paths.";
  }
  if (pathDeletesPaymentLink(operation.method, operation.path)) {
    return "Payment-link deletion is blocked, including batch and permanent paths.";
  }
  const names = operation.scopeGroups.flatMap((group) => group.scopes);
  if (names.length > 0 && names.every((scope) => (EXCLUDED_SCOPES as readonly string[]).includes(scope))) {
    return `Excluded scope: ${names.join(", ")}`;
  }
  if (names.includes("business_units_view.read") && names.length === 1) {
    return "business_units_view.read is excluded.";
  }
  return null;
}

export function assertOperationAllowed(operation: OperationRecord): void {
  const reason = exclusionReason(operation);
  if (reason) throw new PolicyError(reason, "excluded");
  if (!operation.implemented) {
    throw new PolicyError(`Operation ${operation.id} is not implemented.`, "not_implemented");
  }
  if (operation.scopeConflict) {
    throw new PolicyError(`Operation ${operation.id} has conflicting scope documentation.`, "scope_conflict");
  }
}

export function scopesSatisfied(operation: OperationRecord, granted: readonly string[]): boolean {
  if (operation.scopeGroups.length === 0) return false;
  const have = new Set(granted);
  return operation.scopeGroups.every((group) =>
    group.mode === "all" ? group.scopes.every((scope) => have.has(scope)) : group.scopes.some((scope) => have.has(scope)),
  );
}

const PATH_PARAM = /^[A-Za-z0-9_.:@-]{1,200}$/;

export function buildPath(template: string, pathParams: Record<string, string> | undefined): string {
  const values = pathParams ?? {};
  const missing: string[] = [];
  const path = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (!value || !PATH_PARAM.test(value)) missing.push(name);
    return encodeURIComponent(value ?? "");
  });
  if (missing.length > 0) {
    throw new PolicyError(`Invalid or missing path parameters: ${missing.join(", ")}`, "validation");
  }
  if (path.includes("://") || path.includes("..")) {
    throw new PolicyError("Path is not allowlisted.", "validation");
  }
  return path;
}

export function assertBatchBound(body: unknown, batch: boolean): void {
  if (!batch || body === undefined || body === null) return;
  if (typeof body !== "object") throw new PolicyError("Batch body must be an object.", "validation");
  const record = body as Record<string, unknown>;
  const inputs = record.inputs ?? record.properties;
  if (Array.isArray(inputs) && inputs.length > 100) {
    throw new PolicyError("Batch size is capped at 100.", "validation");
  }
}
