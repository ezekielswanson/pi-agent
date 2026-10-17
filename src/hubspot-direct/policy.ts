import { assertActionAllowed, isDeletion, isExportCreation } from "../../services/hubspot-api-mcp/src/policy/actionPolicy.ts";
import { assertOperationAllowed } from "../../services/hubspot-api-mcp/src/policy/exclusions.ts";
import { PolicyError } from "../../services/hubspot-api-mcp/src/policy/errors.ts";
import type { OperationRecord } from "../../services/hubspot-api-mcp/src/registry/types.ts";

const SEPARATE_AUTHORIZATION = new Set(["send", "publish", "merge", "unpublish", "import", "user_remove"]);

export type WriteMode = "deny" | "approval";

export function writeModeFromEnv(env: NodeJS.ProcessEnv = process.env): WriteMode {
  const value = env.HUBSPOT_DIRECT_WRITES ?? "deny";
  if (value === "deny" || value === "approval") return value;
  throw new Error("HUBSPOT_DIRECT_WRITES must be deny or approval.");
}

export function assertDirectAllowed(operation: OperationRecord, phase: "read" | "prepare" | "execute", writes: WriteMode): void {
  assertOperationAllowed(operation);
  if (isDeletion(operation) || isExportCreation(operation) || SEPARATE_AUTHORIZATION.has(operation.destructive)) {
    throw new PolicyError(`${operation.id} stays denied for this MVP.`, "policy");
  }
  if (operation.effect === "read") {
    if (phase !== "read") throw new PolicyError("This operation is a read.", "validation");
    return;
  }
  if (writes !== "approval") {
    throw new PolicyError("Writes are denied. Set HUBSPOT_DIRECT_WRITES=approval and approve the exact payload.", "policy");
  }
  assertActionAllowed(
    { reads: "allow", writes: "approval_required", exportCreation: "deny", deletion: "deny" },
    operation,
    phase === "read" ? "read" : phase,
  );
}
