# pi-agent

Shared local [Pi](https://pi.dev/) agent for HubSpot, Notion, Asana, and one external system. One codebase, multiple client profiles under `clients/`.

Pi is the runtime. This repo does not ship a custom orchestration engine.

## Quick start

```bash
cd /Users/zeke/Desktop/projects/client_projects/ai-agents/pi-agent
cp .env.example .env
cp clients/apartment-life/.env.example clients/apartment-life/.env
npm install
```

1. Install Pi **0.85.1** globally on Node **22.23.2**: `sudo npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.85.1`
2. From this directory: `pi install -l --approve npm:pi-mcp-adapter`
3. Fill `.env` and the selected client `.env`
4. Create a HubSpot MCP connector and add its credentials (see [docs/hubspot-mcp.md](docs/hubspot-mcp.md))
5. Run `pi` here, trust the project, then `/login` if you are not using an API key
6. `/client apartment-life`
7. `/mcp-auth hubspot`

## Commands

| Command | What it does |
| --- | --- |
| `/client` | Validate a profile and start a fresh session |
| `/mode` | `review` (default) or `implement` |
| `/skill:cross-system-sync` | Two-system proof, plus Asana when that connection is verified |
| `/skill:research-review` | Read-only research and a proposed fix |
| `/skill:hubspot-crm` | HubSpot remote MCP reads and gated writes |
| `/mcp-auth hubspot` | Browser OAuth for HubSpot CRM |

`pi --version` only checks that the CLI starts. Extension and adapter compatibility are `npm run check`. Config smokes and a Cursor MCP connection are not live Pi access.

## Checks

```bash
npm test
npm run check
npm run smoke:client
npm run smoke:external
npm run smoke:hubspot
npm run smoke:hubspot:live
```

`smoke:hubspot` is a preflight. `smoke:hubspot:live` prints `SKIPPED` until browser auth exists, and skipped is not a pass. Notion and Asana health checks need tokens in the active client's `.env`.

## Layout

- `.pi/extensions/` — Pi tools and `/client`
- `.pi/skills/` — workflow instructions
- `src/` — config loader and connectors
- `clients/` — per-client profiles, mappings, prompts, env examples
- `.mcp.json` — HubSpot remote MCP

Details: [docs/setup.md](docs/setup.md), [docs/testing.md](docs/testing.md), and [docs/acceptance.md](docs/acceptance.md).
