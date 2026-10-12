# Claude

Status: not started.

This guide is the Claude web custom connector, not the Messages API and not a local stdio server. Sources retrieved 2026-10-12:

- https://claude.com/docs/connectors/custom/remote-mcp
- https://claude.com/docs/connectors/custom/add-unlisted
- https://claude.com/docs/connectors/building
- https://claude.com/docs/connectors/building/authentication

Claude documents authorization specs 2025-03-26, 2025-06-18, and 2025-11-25. This server also implements the 2026-07-28 resource metadata and PKCE behavior those clients use to discover an authorization server. That does not prove Claude implements every newer MCP feature.

1. Organization settings, Connectors, Add, Custom, Web. Or Customize, Connectors, Add custom connector. The dialog varies by plan.
2. MCP server URL: the new HTTPS or local URL ending in `/mcp`.
3. Choose sign-in. For the OAuth client, choose "use your own OAuth client" and enter the pre-registered client id. Leave the secret blank. This server does not offer open dynamic registration. CIMD is accepted only for a `claude.ai` metadata URL.
4. Allow redirects `https://claude.ai/api/mcp/auth_callback` and loopback `http://127.0.0.1/callback` or `http://localhost/callback` with the port ignored for those loopback hosts.
5. Authorize, then list tools. Read-only discovery is the first test. Do not mutate HubSpot data.

Claude Code is a different local setup and is not configured here.
