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

1. Install Pi globally (needs Node **22.19+**): `sudo npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
2. From this directory: `pi install -l --approve npm:pi-mcp-adapter`
3. Fill `.env` and the selected client `.env`
4. Create a HubSpot MCP connector and add its credentials (see [docs/hubspot-mcp.md](docs/hubspot-mcp.md))
5. Run `pi` here, trust the project, then `/login` if you are not using an API key
6. `/client apartment-life`
7. `/mcp-auth hubspot`

## Commands

| Command | What it does |
| --- | --- |
| `/client` | List or select a client profile |
| `/skill:cross-system-sync` | Notion → Asana → HubSpot workflow |
| `/skill:hubspot-crm` | How to use HubSpot remote MCP |
| `/mcp-auth hubspot` | OAuth for HubSpot CRM |

## Smoke tests

```bash
npm run smoke:client
npm run smoke:notion
npm run smoke:asana
npm run smoke:external
npm run smoke:hubspot
```

Notion and Asana smokes need tokens in the active client's `.env`. Writes are opt-in with `--write`.

## Layout

- `.pi/extensions/` — Pi tools and `/client`
- `.pi/skills/` — workflow instructions
- `src/` — config loader and connectors
- `clients/` — per-client profiles, mappings, prompts, env examples
- `.mcp.json` — HubSpot remote MCP

Details: [docs/setup.md](docs/setup.md)
