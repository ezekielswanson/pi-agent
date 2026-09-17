# Setup

## 1. Install Pi

Pi 0.85+ needs **Node 22.19 or newer**. Then install the CLI globally:

```bash
sudo npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

This repo lists `pi-mcp-adapter` in `.pi/settings.json`. After the CLI is on your PATH, install the project MCP adapter once:

```bash
cd /Users/zeke/Desktop/projects/client_projects/ai-agents/pi-agent
pi install -l --approve npm:pi-mcp-adapter
```

On first interactive `pi` run, trust this project so `.pi/extensions`, `.pi/skills`, and project packages load.

## 2. Authenticate Pi

Either export an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

or start Pi and run `/login`.

## 3. Project env

```bash
cp .env.example .env
cp clients/apartment-life/.env.example clients/apartment-life/.env
```

Root `.env` holds HubSpot MCP connector credentials and `PI_CLIENT`.
Client `.env` holds Notion and Asana tokens.

## 4. Run Pi from this directory

```bash
cd /Users/zeke/Desktop/projects/client_projects/ai-agents/pi-agent
pi
```

Trust the project when prompted so `.pi/extensions`, `.pi/skills`, and project packages load.

Then:

```
/client apartment-life
/mcp-auth hubspot
/skill:cross-system-sync
```

## 5. Smoke tests

```bash
npm install
PI_CLIENT=apartment-life npm run smoke:client
PI_CLIENT=apartment-life npm run smoke:external
PI_CLIENT=apartment-life npm run smoke:hubspot
```

Notion and Asana health checks need tokens in `clients/apartment-life/.env`.

## Client selection

Resolver order:

1. `PI_CLIENT`
2. `.pi/active-client.json` (written by `/client`, gitignored)

## Writes

Pi tools prompt for confirmation before Notion, Asana, or external writes. Smoke scripts only write if you pass `--write`.
