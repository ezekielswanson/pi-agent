import type { OperationRecord } from "../registry/types.ts";
import { PolicyError } from "./errors.ts";

export interface ActionPolicy {
  reads: "allow";
  writes: "deny" | "approval_required";
  exportCreation: "deny" | "approval_required";
  deletion: "deny";
}

const DELETION = new Set(["archive", "permanent_delete", "schema_delete", "pipeline_delete"]);

export function releaseActionPolicy(input?: { writes?: ActionPolicy["writes"]; exportCreation?: ActionPolicy["exportCreation"] }): ActionPolicy {
  return {
    reads: "allow",
    writes: input?.writes ?? "approval_required",
    exportCreation: input?.exportCreation ?? "deny",
    deletion: "deny",
  };
}

export function actionPolicyFromEnv(env: { action?: string; exports?: string }): ActionPolicy {
  const action = env.action || "read-write";
  if (action !== "read-only" && action !== "read-write" && action !== "writes-with-approval") {
    throw new Error("HUBSPOT_ACTION_POLICY must be read-write, writes-with-approval, or read-only.");
  }
  if (env.exports && env.exports !== "deny" && env.exports !== "approval") {
    throw new Error("HUBSPOT_EXPORT_CREATION must be deny or approval.");
  }
  return releaseActionPolicy({
    writes: action === "read-only" ? "deny" : "approval_required",
    exportCreation: env.exports === "approval" ? "approval_required" : "deny",
  });
}

export function isDeletion(operation: { destructive: string; method: string; path: string }): boolean {
  if (DELETION.has(operation.destructive)) return true;
  if (operation.method === "DELETE") return true;
  return /gdpr-delete|\/purge(?:\/|$)|\/archive(?:\/|$)/i.test(operation.path);
}

export function isExportCreation(operation: Pick<OperationRecord, "effect" | "id" | "path">): boolean {
  const exportCall = operation.path.includes("/export") || operation.id.includes("export");
  return exportCall && operation.effect === "mutate";
}

export function assertActionAllowed(policy: ActionPolicy, operation: OperationRecord, phase: "read" | "prepare" | "execute"): void {
  if (isDeletion(operation)) {
    throw new PolicyError("Delete, archive, and purge operations are denied for this release.", "policy");
  }
  if (isExportCreation(operation)) {
    if (policy.exportCreation !== "approval_required") {
      throw new PolicyError("Export creation is not allowed by the current action policy.", "policy");
    }
    if (phase === "read") throw new PolicyError("Export creation is not a read.", "policy");
    return;
  }
  if (operation.effect === "read") {
    if (phase !== "read") throw new PolicyError("This operation is a read. Call the read tool.", "validation");
    return;
  }
  if (policy.writes !== "approval_required") {
    throw new PolicyError("Writes are denied by the current action policy.", "policy");
  }
  if (phase === "read") throw new PolicyError("This operation is not a read. Prepare it instead.", "validation");
}

export function actionLabel(policy: ActionPolicy, operation: OperationRecord): { action: "allow" | "approval_required" | "deny"; reason: string | null } {
  try {
    assertActionAllowed(policy, operation, operation.effect === "read" ? "read" : "prepare");
  } catch (error) {
    return { action: "deny", reason: error instanceof Error ? error.message : "denied" };
  }
  if (operation.effect === "mutate" || isExportCreation(operation)) return { action: "approval_required", reason: null };
  return { action: "allow", reason: null };
}
