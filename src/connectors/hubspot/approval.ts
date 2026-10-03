import type { McpToolApprovalDecision, McpToolApprovalOrigin, McpToolApprovalRequest } from "pi-mcp-adapter/types";
import type { ClientProfile } from "../../types/index.ts";
import { approvalHash } from "../../utils/approval.ts";
import type { ClientSession } from "../../runtime/clientSession.ts";

export type HubspotToolClass = "read" | "write" | "delete" | "unknown";

const READ_PREFIX = /^(get|search|list|retrieve|fetch|query)_/;
const WRITE_PREFIX = /^(create|update|patch|merge|associate|batch)_/;
const DELETE_PREFIX = /^(delete|archive|remove|destroy)_/;

export function bareHubspotToolName(toolName: string): string {
  return toolName.replace(/^(mcp_)?hubspot_/, "");
}

export function classifyHubspotTool(toolName: string): HubspotToolClass {
  const bare = bareHubspotToolName(toolName);
  if (DELETE_PREFIX.test(bare) || bare.endsWith("_delete")) return "delete";
  if (WRITE_PREFIX.test(bare)) return "write";
  if (READ_PREFIX.test(bare)) return "read";
  return "unknown";
}

export function hubspotWriteHash(input: {
  clientSlug: string;
  toolName: string;
  args: Record<string, unknown>;
  connectionId: string;
}): string {
  return approvalHash({
    clientSlug: input.clientSlug,
    system: "hubspot",
    operation: bareHubspotToolName(input.toolName),
    target: { id: input.connectionId },
    changes: input.args,
    sessionGeneration: 0,
  });
}

export function portalVerifiedFor(session: ClientSession, profile: ClientProfile): boolean {
  const expected = profile.hubspot.expectedPortalId;
  const verified = session.verifiedPortal;
  if (expected == null || !verified || !session.hubspotConnectionId) return false;
  if (verified.slug !== profile.slug) return false;
  if (verified.portalId !== String(expected)) return false;
  if (verified.connectionId !== session.hubspotConnectionId) return false;
  if (profile.allowlist.hubspotPortalIds.length > 0 && !profile.allowlist.hubspotPortalIds.includes(verified.portalId)) {
    return false;
  }
  return true;
}

export interface HubspotDecisionInput {
  serverName: string;
  toolName: string;
  origin: McpToolApprovalOrigin;
  mode: "review" | "implement";
  verified: boolean;
  exactGrant: boolean;
  /** A restored adapter session grant. It never authorizes a protected write. */
  sessionCached: boolean;
}

export function decideHubspotApproval(input: HubspotDecisionInput): Exclude<McpToolApprovalDecision, "abstain" | "allow_for_session"> {
  if (input.serverName !== "hubspot") return "deny";
  const kind = classifyHubspotTool(input.toolName);
  if (kind === "read") return "allow_once";
  if (kind !== "write") return "deny";
  if (input.mode === "review") return "deny";
  if (!input.verified || !input.exactGrant || input.sessionCached) return "deny";
  return "allow_once";
}

export function isHubspotApprovalRequest(value: unknown): value is McpToolApprovalRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<McpToolApprovalRequest>;
  return (
    request.serverName === "hubspot" &&
    typeof request.originalToolName === "string" &&
    typeof request.claim === "function"
  );
}

export function claimHubspotApproval(
  request: McpToolApprovalRequest,
  session: ClientSession,
  profile: ClientProfile | null,
): boolean {
  const claimed = request.claim(() => {
    try {
      if (!profile) return "deny";
      const toolName = request.originalToolName || request.prefixedToolName;
      const args = request.args ?? {};
      const hash =
        session.hubspotConnectionId === null
          ? ""
          : hubspotWriteHash({
              clientSlug: profile.slug,
              toolName,
              args,
              connectionId: session.hubspotConnectionId,
            });
      const exactGrant = hash !== "" && session.hasHubspotGrant(hash);
      const decision = decideHubspotApproval({
        serverName: request.serverName,
        toolName,
        origin: request.origin,
        mode: session.mode,
        verified: portalVerifiedFor(session, profile),
        exactGrant,
        sessionCached: false,
      });
      if (decision === "allow_once" && classifyHubspotTool(toolName) === "write" && !session.consumeHubspotGrant(hash)) {
        return "deny";
      }
      return decision;
    } catch {
      return "deny";
    }
  });
  if (!claimed) session.clearHubspotTrust();
  return claimed;
}
