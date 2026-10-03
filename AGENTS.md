# Pi agent

This repo is a local multi-client Pi project. Pi is the runtime and orchestrator. Do not add a custom workflow engine.

## How to work here

- Select a client with `/client` or `PI_CLIENT` before calling connectors. `/client` starts a fresh session or leaves tools disabled.
- The session opens in review mode. `/mode implement` enables edit, write, and shell tools, and each write still needs approval. Those restrictions are not an OS sandbox.
- HubSpot CRM goes through the remote MCP server (`/mcp-auth hubspot`) and the approval broker. Do not use HubSpot Developer MCP or a REST CRM bypass for runtime writes.
- Notion and the external stub are Pi tools. Asana REST satisfies v1 when the profile selects `rest` and the workspace check passes. Cursor's Asana MCP is not Pi runtime access.
- Confirm with the user before creating or updating records. Keep writes small and explicit. Reconcile a run receipt before creating the same target again.
- Load `/skill:cross-system-sync` for the two-system proof and the conditional three-system proof.
- Load `/skill:research-review` before research. Load `/skill:hubspot-crm` before HubSpot MCP writes.
- Never log tokens, client secrets, or full env files.
- Client secrets live in `clients/<slug>/.env`. Profiles in `clients/<slug>/config/profile.json` have no secrets.
- Shared connector code lives in `src/`. Pi extensions in `.pi/extensions/` only register tools and commands.

## Clients

- `apartment-life` is the sample client.
- `optidge` is a second empty profile (existing workstream folder is spelled Optidge).
- Do not copy this agent into a client working folder.
