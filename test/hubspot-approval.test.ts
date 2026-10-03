import assert from "node:assert/strict";
import test from "node:test";
import type { McpToolApprovalOrigin, McpToolApprovalRequest } from "pi-mcp-adapter/types";
import type { ClientProfile } from "../src/types/index.ts";
import { ClientSession } from "../src/runtime/clientSession.ts";
import {
  claimHubspotApproval,
  classifyHubspotTool,
  decideHubspotApproval,
  hubspotWriteHash,
} from "../src/connectors/hubspot/approval.ts";
import { applyHubspotStatus, observeHubspotToolResult } from "../src/connectors/hubspot/connection.ts";
import { hubspotCheckForTool, checkExpectedPortal } from "../src/connectors/hubspot/index.ts";

const profile: ClientProfile = {
  name: "Alpha",
  slug: "alpha",
  hubspot: { expectedPortalId: "42" },
  notion: { databaseIds: {}, pageIds: {}, testPageId: null, outputParent: null },
  asana: { mode: "rest", workspaceGid: null, projectGids: {}, testProjectGid: null },
  researchRoots: [],
  allowlist: {
    notionPageIds: [],
    notionDatabaseIds: [],
    notionDataSourceIds: [],
    asanaProjectGids: [],
    asanaTaskGids: [],
    hubspotPortalIds: [],
    localRoots: [],
  },
  external: { enabled: false, system: "unspecified" },
};

function verifiedSession(): ClientSession {
  const session = new ClientSession();
  session.toolsEnabled = true;
  session.mode = "implement";
  session.openHubspotConnection("conn-1");
  session.verifiedPortal = { slug: "alpha", portalId: "42", connectionId: "conn-1" };
  return session;
}

test("HubSpot approval covers direct, proxy, scripted, and cached-grant paths", () => {
  const origins: McpToolApprovalOrigin[] = ["direct", "proxy", "script"];
  for (const origin of origins) {
    assert.equal(
      decideHubspotApproval({
        serverName: "hubspot",
        toolName: "create_note",
        origin,
        mode: "implement",
        verified: true,
        exactGrant: true,
        sessionCached: false,
      }),
      "allow_once",
    );
    assert.equal(
      decideHubspotApproval({
        serverName: "hubspot",
        toolName: "create_note",
        origin,
        mode: "implement",
        verified: true,
        exactGrant: false,
        sessionCached: true,
      }),
      "deny",
    );
  }
  assert.equal(classifyHubspotTool("get_user_details"), "read");
  assert.equal(
    decideHubspotApproval({
      serverName: "hubspot",
      toolName: "mystery_tool",
      origin: "direct",
      mode: "implement",
      verified: true,
      exactGrant: true,
      sessionCached: false,
    }),
    "deny",
  );
  assert.equal(
    decideHubspotApproval({
      serverName: "hubspot",
      toolName: "delete_contact",
      origin: "direct",
      mode: "implement",
      verified: true,
      exactGrant: true,
      sessionCached: false,
    }),
    "deny",
  );
  assert.equal(
    decideHubspotApproval({
      serverName: "hubspot",
      toolName: "get_contact",
      origin: "proxy",
      mode: "review",
      verified: false,
      exactGrant: false,
      sessionCached: false,
    }),
    "allow_once",
  );
});

test("a claimed HubSpot write requires the same connection and is single use", () => {
  const session = verifiedSession();
  const args = { note: "hello" };
  session.rememberHubspotGrant(hubspotWriteHash({ clientSlug: "alpha", toolName: "create_note", args, connectionId: "conn-1" }));
  const decisions: string[] = [];
  const request = {
    requestId: "1",
    serverName: "hubspot",
    originalToolName: "create_note",
    prefixedToolName: "hubspot_create_note",
    args,
    origin: "direct" as const,
    claim(handler: () => string) {
      decisions.push(handler());
      return true;
    },
  } as McpToolApprovalRequest;
  assert.equal(claimHubspotApproval(request, session, profile), true);
  assert.deepEqual(decisions, ["allow_once"]);
  decisions.length = 0;
  assert.equal(claimHubspotApproval(request, session, profile), true);
  assert.deepEqual(decisions, ["deny"]);

  const missed = verifiedSession();
  const unclaimed = {
    ...request,
    claim() {
      return false;
    },
  } as McpToolApprovalRequest;
  missed.verifiedPortal = { slug: "alpha", portalId: "42", connectionId: "conn-1" };
  assert.equal(claimHubspotApproval(unclaimed, missed, profile), false);
  assert.equal(missed.verifiedPortal, null);
});

test("HubSpot identity comes from an MCP tool result and dies with the connection", () => {
  const session = new ClientSession();
  applyHubspotStatus(session, [{ name: "hubspot", status: "connected", listenState: "active" }]);
  assert.equal(typeof session.hubspotConnectionId, "string");
  const modelJson = checkExpectedPortal("42", "42");
  assert.equal(hubspotCheckForTool(modelJson).writesAllowed, false);
  assert.equal(session.verifiedPortal === null ? "missing" : "set", "missing");

  assert.equal(
    observeHubspotToolResult(session, profile, {
      toolName: "hubspot_get_user_details",
      content: [{ type: "text", text: JSON.stringify({ portalId: 42 }) }],
    }),
    true,
  );
  assert.equal(session.verifiedPortal && session.verifiedPortal.portalId, "42");

  applyHubspotStatus(session, [{ name: "hubspot", status: "connected", listenState: "re-establishing" }]);
  assert.equal(session.verifiedPortal, null);
  assert.equal(session.hubspotConnectionId, null);
});
