---
name: hubspot-crm
description: Use HubSpot remote MCP for CRM reads and writes. Use before searching contacts, creating notes, or updating HubSpot records.
---

# HubSpot CRM via remote MCP

Runtime HubSpot access is the remote MCP server at `https://mcp.hubspot.com`, exposed to Pi by `pi-mcp-adapter` 2.34.0.

Do not use HubSpot Developer MCP for CRM actions. Do not add a REST CRM call when a note tool is missing.

## Identity

1. If HubSpot tools are unavailable, ask the user to run `/mcp-auth hubspot`.
2. Call MCP `get_user_details` on that connection. The broker records the portal only from that tool result.
3. `hubspot_check_portal` compares an id and does not verify the account. JSON supplied by the model is not proof.
4. A missing expected portal, a mismatch, a reconnect, a logout, or a client switch clears verification. Reads can continue and are labeled unverified. Writes stay blocked.

## Writes

Protected writes need implementation mode, a verified portal on the current connection, and `hubspot_prepare_write` for the exact tool name and arguments. The approval is allow-once. A cached session grant is not enough. Unknown, unclassified, and delete tools are denied.

Prefer the MCP proxy:

```
mcp({ tool: "get_user_details", args: {} })
```

Call `tool_guidance` through MCP when a write tool's arguments are unclear. If the approval broker does not claim the call, do not retry through another API.

## Client switching

One HubSpot OAuth session maps to one portal. Switching clients that use different portals requires `/mcp logout hubspot` and `/mcp-auth hubspot` again. Verification does not survive that logout.
