// Reuse the pinned Pi MCP adapter transport, protected OAuth store, and repository broker.
import { McpServerManager } from "../../../node_modules/pi-mcp-adapter/server-manager.ts";
import { loadMcpConfig } from "pi-mcp-adapter/config";
import { loadClientProfile } from "../../../src/config/loadClientProfile.ts";
import { ClientSession } from "../../../src/runtime/clientSession.ts";
import { observeHubspotToolResult } from "../../../src/connectors/hubspot/connection.ts";
import { claimHubspotApproval } from "../../../src/connectors/hubspot/approval.ts";
import { randomUUID } from "node:crypto";

export async function openPilotMcp(clientRoot, signal) {
	const loaded = loadClientProfile("apartment-life", clientRoot);
	if (String(loaded.profile.hubspot.expectedPortalId) !== "5627913")
		throw new Error("Client portal mismatch");
	const config = loadMcpConfig(undefined, clientRoot);
	const definition = config.mcpServers?.hubspot;
	if (
		!definition ||
		definition.url !== "https://mcp.hubspot.com" ||
		definition.auth !== "oauth"
	)
		throw new Error("Existing remote HubSpot OAuth connector missing");
	const manager = new McpServerManager(clientRoot);
	manager.setDefaultRequestTimeoutMs(15000);
	manager.setRuntimeSignal(signal);
	const connection = await manager.connect("hubspot", definition, signal);
	if (connection.status !== "connected") {
		await manager.close("hubspot");
		throw new Error("HubSpot requires /mcp-auth hubspot in Pi");
	}
	const session = new ClientSession();
	session.toolsEnabled = true;
	session.openHubspotConnection(randomUUID());
	const call = async (toolName, args) => {
		if (
			manager.getConnection("hubspot") !== connection ||
			connection.status !== "connected"
		) {
			session.clearHubspotTrust();
			throw new Error("HubSpot connection changed");
		}
		let handler;
		const claimed = claimHubspotApproval(
			{
				serverName: "hubspot",
				originalToolName: toolName,
				prefixedToolName: `hubspot_${toolName}`,
				origin: "proxy",
				args,
				claim: (h) => {
					handler = h;
					return true;
				},
			},
			session,
			loaded.profile,
		);
		if (!claimed || (await handler()) !== "allow_once")
			throw new Error("Existing HubSpot approval broker denied operation");
		return connection.client.callTool(
			{ name: toolName, arguments: args },
			manager.getRequestOptions("hubspot", signal),
		);
	};
	try {
		const identity = await call("get_user_details", {});
		if (
			!observeHubspotToolResult(session, loaded.profile, {
				toolName: "hubspot_get_user_details",
				...identity,
			})
		)
			throw new Error(
				"Current HubSpot connection portal is unverified or mismatched",
			);
	} catch (error) {
		await manager.close("hubspot");
		throw error;
	}
	return {
		session,
		loaded,
		connectionId: session.hubspotConnectionId,
		tools: connection.tools,
		call,
		close: () => manager.close("hubspot"),
	};
}
