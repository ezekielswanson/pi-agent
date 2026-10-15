# ChatGPT

Status: not started. Developer mode eligibility for this account was not opened in a browser.

Documented path, from https://developers.openai.com/api/docs/guides/developer-mode and https://developers.openai.com/api/docs/guides/custom-mcp-server as retrieved 2026-10-12:

1. On ChatGPT web, Settings, Security and login, turn on Developer mode. This is documented for Pro, Plus, Business, Enterprise, and Education accounts. Confirm the menu on the actual account. Workspace controls can still block custom apps.
2. Open ChatGPT Plugins, choose the plus button, and add a custom MCP server. Use the new service URL, ending in `/mcp`. Do not use `https://app.hubspot.com/mcp-connectors/5627913/app/55630741` or `https://mcp.hubspot.com`.
3. Choose OAuth. This server advertises protected-resource metadata, authorization-server metadata, PKCE, and RFC 9207 `iss`, so ChatGPT can use the stable redirect `https://chatgpt.com/connector_platform_oauth_redirect` when the management page shows that URI. If the page shows `https://chatgpt.com/connector/oauth/{callback_id}` instead, allowlist that exact URI and do not invent the callback id.
4. Static client credentials can be the pre-registered `clientId`. CIMD is limited to `chatgpt.com` metadata URLs. Dynamic client registration is off.
5. Authorize as an approved user. Scan tools. Read-only checks use `hubspot_capabilities` and a read tool. Do not send, publish, or delete data to prove the connection.

Publishing the app to a workspace still needs the workspace's own approval. That has not been requested.
