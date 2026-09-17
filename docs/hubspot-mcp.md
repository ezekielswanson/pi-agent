# HubSpot remote MCP

Runtime CRM access uses HubSpot's **remote MCP server**, not the Developer MCP server.

- Endpoint: `https://mcp.hubspot.com`
- Transport: Streamable HTTP
- Auth: OAuth 2.1 with PKCE
- Pi package: `pi-mcp-adapter`
- Project config: [`.mcp.json`](../.mcp.json)

Developer MCP stays optional Cursor build-time tooling. Do not use it for contacts, deals, notes, or other CRM writes from this agent.

## Create the connector in HubSpot

1. In HubSpot, open **Development → MCP Connectors**.
2. Create an MCP connector.
3. Set the redirect URL to exactly:

   `http://127.0.0.1:3118/callback`

4. Copy the client id and client secret into this repo's `.env`:

   ```bash
   HUBSPOT_MCP_CLIENT_ID=...
   HUBSPOT_MCP_CLIENT_SECRET=...
   ```

HubSpot does not let you pick scopes by hand. Available tools follow the installing user's HubSpot permissions.

## Authenticate from Pi

```bash
cd /Users/zeke/Desktop/projects/client_projects/ai-agents/pi-agent
pi
```

Then run `/mcp-auth hubspot`. Pi opens a browser, stores tokens in the OS credential store, and retries the connection.

Verify with MCP `get_user_details`, then `hubspot_check_portal` if the client profile has `expectedPortalId`.

## Multi-client portals

One OAuth login is one HubSpot portal. If Apartment Life and Optidge use different portals:

1. `/mcp logout hubspot`
2. `/client` the other profile
3. `/mcp-auth hubspot` and pick that portal

## Troubleshooting

- PKCE errors: the Pi adapter handles PKCE. Recreate the connector if the redirect URL does not match `http://127.0.0.1:3118/callback`.
- Empty env interpolation: Pi fails closed if `HUBSPOT_MCP_CLIENT_ID` or `HUBSPOT_MCP_CLIENT_SECRET` is missing.
- Sensitive Data accounts: HubSpot may block notes, calls, and conversations on the MCP server even when CRM APIs work.
