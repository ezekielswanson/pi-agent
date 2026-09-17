# Pi agent

This repo is a local multi-client Pi project. Pi is the runtime and orchestrator. Do not add a custom workflow engine.

## How to work here

- Select a client with `/client` or `PI_CLIENT` before calling connectors.
- HubSpot CRM goes through the remote MCP server (`/mcp-auth hubspot`). Do not use HubSpot Developer MCP for runtime CRM writes.
- Notion, Asana, and the external stub are Pi tools (`notion_*`, `asana_*`, `external_*`).
- Confirm with the user before creating or updating records. Keep writes small and explicit.
- Load `/skill:cross-system-sync` for the first Notion → Asana → HubSpot workflow.
- Load `/skill:hubspot-crm` before HubSpot MCP writes.
- Never log tokens, client secrets, or full env files.
- Client secrets live in `clients/<slug>/.env`. Profiles in `clients/<slug>/config/profile.json` have no secrets.
- Shared connector code lives in `src/`. Pi extensions in `.pi/extensions/` only register tools and commands.

## Clients

- `apartment-life` is the sample client.
- `optidge` is a second empty profile (existing workstream folder is spelled Optidge).
- Do not copy this agent into a client working folder.
