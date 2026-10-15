# Pi

Status: not started.

This repo already has `pi-mcp-adapter` 2.34.0 and Pi package `@earendil-works/pi-coding-agent` 0.85.1. The existing server entry `hubspot` in [`.mcp.json`](../../../.mcp.json) points at `https://mcp.hubspot.com` with redirect `http://127.0.0.1:3118/callback`. Leave that entry as it is. `/mcp-auth hubspot` stays the login for the hosted connector.

The new service is a second server. An example entry is [`../examples/pi-mcp-server.example.json`](../examples/pi-mcp-server.example.json). It is not installed. Its redirect is `http://127.0.0.1:8788/callback`, which is not port 3118. Add that redirect to `MCP_CLIENTS_JSON` before testing. Do not assume a new slash command exists. The adapter's existing OAuth flow for a URL server is the one to use, after you approve adding the entry.

The Pi approval broker in [`.pi/extensions/hubspot-broker.ts`](../../../.pi/extensions/hubspot-broker.ts) still denies delete and unknown tools for the server named `hubspot`. It does not claim `hubspot-api`. Mutations on this service are approved by `POST /approvals/{proposalId}/approve`, not by that broker and not by an `approved=true` argument.

Read-only tool discovery is the first Pi test. No live call has been made.
