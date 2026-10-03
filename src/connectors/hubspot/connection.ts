import { randomUUID } from "node:crypto";
import type { ClientProfile } from "../../types/index.ts";
import type { ClientSession } from "../../runtime/clientSession.ts";
import { bareHubspotToolName } from "./approval.ts";
import { extractPortalId } from "./index.ts";

export interface HubspotStatusServer {
  name: string;
  status: string;
  listenState: string;
}

const LIVE_LISTEN = new Set(["active", "legacy"]);

export function applyHubspotStatus(session: ClientSession, servers: readonly HubspotStatusServer[]): void {
  const hubspot = servers.find((server) => server.name === "hubspot");
  const live = hubspot?.status === "connected" && LIVE_LISTEN.has(hubspot.listenState);
  if (!live) {
    session.clearHubspotTrust();
    return;
  }
  if (!session.hubspotConnectionId) session.openHubspotConnection(randomUUID());
}

export function observeHubspotToolResult(
  session: ClientSession,
  profile: ClientProfile,
  event: { toolName: string; isError?: boolean; content?: unknown; details?: unknown },
): boolean {
  if (event.isError) return false;
  if (!isGetUserDetailsResult(event)) return false;
  if (!session.hubspotConnectionId) return false;
  const portalId = extractPortalId(event.details) ?? extractPortalId(parseContent(event.content));
  const expected = profile.hubspot.expectedPortalId;
  if (!portalId || expected == null || portalId !== String(expected)) {
    session.verifiedPortal = null;
    return false;
  }
  if (profile.allowlist.hubspotPortalIds.length > 0 && !profile.allowlist.hubspotPortalIds.includes(portalId)) {
    session.verifiedPortal = null;
    return false;
  }
  session.verifiedPortal = {
    slug: profile.slug,
    portalId,
    connectionId: session.hubspotConnectionId,
  };
  return true;
}

function isGetUserDetailsResult(event: { toolName: string; details?: unknown }): boolean {
  if (event.toolName.includes("hubspot") && event.toolName.endsWith("get_user_details")) return true;
  if (event.toolName !== "mcp") return false;
  if (typeof event.details !== "object" || event.details === null) return false;
  const details = event.details as { server?: unknown; tool?: unknown };
  return details.server === "hubspot" && bareHubspotToolName(String(details.tool ?? "")) === "get_user_details";
}

function parseContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return content;
}
