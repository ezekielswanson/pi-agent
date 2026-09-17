---
name: hubspot-crm
description: Use HubSpot remote MCP for CRM reads and writes. Use before searching contacts, creating notes, or updating HubSpot records.
---

# HubSpot CRM via remote MCP

Runtime HubSpot access is the **remote MCP server** at `https://mcp.hubspot.com`, exposed to Pi by `pi-mcp-adapter`.

Do **not** use HubSpot Developer MCP for CRM actions. Developer MCP is optional build-time tooling only.

## Auth

- If HubSpot tools are unavailable, tell the user to run `/mcp-auth hubspot`.
- After auth, call MCP `get_user_details`.
- Pass that payload to `hubspot_check_portal` when the client profile has `hubspot.expectedPortalId`.
- If the portal does not match, stop and tell the user to `/mcp logout hubspot` and re-auth to the correct account.

## How to call tools

Prefer the `mcp` proxy:

```
mcp({ search: "get_user_details" })
mcp({ tool: "get_user_details", args: {} })
```

For CRM work, search/fetch records, then create or update a note. Confirm writes. Keep field updates small.

Useful tool names (availability depends on the account):

- `get_user_details`
- CRM search / fetch by id
- create or update records and notes

Call `tool_guidance` through MCP when you are unsure of a write tool's arguments.

## Client switching

One HubSpot OAuth session maps to one portal. Switching clients that use different portals requires logout and re-auth.
