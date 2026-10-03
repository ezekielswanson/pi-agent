import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MCP_STATUS_EVENT } from "pi-mcp-adapter/types";
import { loadClientProfile } from "../../src/config/loadClientProfile.ts";
import { claimHubspotApproval, isHubspotApprovalRequest } from "../../src/connectors/hubspot/approval.ts";
import { applyHubspotStatus, type HubspotStatusServer } from "../../src/connectors/hubspot/connection.ts";
import { hubspotApprovalEvent } from "../../src/runtime/mcpAdapter.ts";
import { clientSession } from "../../src/runtime/clientSession.ts";

export default function (pi: ExtensionAPI) {
  pi.events.on(hubspotApprovalEvent, (data) => {
    if (!isHubspotApprovalRequest(data)) return;
    let profile = null;
    try {
      profile = loadClientProfile().profile;
    } catch {
      profile = null;
    }
    const claimed = claimHubspotApproval(data, clientSession, profile);
    if (!claimed) clientSession.clearHubspotTrust();
  });

  pi.events.on(MCP_STATUS_EVENT, (data) => {
    if (typeof data !== "object" || data === null || !("servers" in data)) return;
    const servers = (data as { servers?: HubspotStatusServer[] }).servers;
    if (!servers) return;
    applyHubspotStatus(clientSession, servers);
  });
}
