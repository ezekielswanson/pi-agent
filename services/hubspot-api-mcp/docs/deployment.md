# Deployment proposal

No host, domain, or budget is chosen. The service runs locally with `npm start` and listens on `127.0.0.1`.

When a public deployment is approved, run one HTTPS origin. Put `HUBSPOT_API_CLIENT_SECRET`, `MCP_AUTH_SECRET`, `MCP_APPROVAL_SECRET`, and `HUBSPOT_TOKEN_KEY` in the host secret store. Keep the encrypted grant file, or a managed encrypted database, private to that service. Set `MCP_ISSUER` and `MCP_RESOURCE_URL` to the public HTTPS URLs. Register the exact ChatGPT and Claude redirect URIs before users connect.

Retention for audit lines is not turned on in this build. Before production, choose a retention period, who can read the log, and where it lives. The local log is an append-only JSON file and is not a production control.

Do not deploy by changing the existing HubSpot MCP connector.

ChatGPT, Claude, and Pi connection status: not started.
