# HubSpot API MCP

Separate MCP service that calls standard HubSpot APIs. It does not replace the hosted connector at `https://mcp.hubspot.com` and it does not change [`.mcp.json`](../../.mcp.json).

Retrieved 2026-10-12. API version pinned to HubSpot `2026-09`, the current generally available version described on the [versioning page](https://developers.hubspot.com/docs/developer-tooling/platform/versioning).

Counts below come from [`registers/discovery-meta.json`](registers/discovery-meta.json):

- 163 scopes in the official scopes-page table
- 226 baseline audit rows, one per supplied scope
- 979 operations parsed from 1,178 current API reference pages
- 905 operations implemented behind allowlisted tools
- 3 operations excluded by policy
- 0 live HubSpot calls, 0 granted installs

The existing HubSpot connector is app `55630741` on portal `5627913`: `https://app.hubspot.com/mcp-connectors/5627913/app/55630741`. HubSpot does not provide a scope field on that connector. Its scopes come from the tools on `https://mcp.hubspot.com` and from the permissions granted at install. A newer tool set requires disconnect and reconnect. This register is the standard-API scope list and is not pasted into that app.

Required install scopes are `oauth` plus every implemented scope the catalog marks available to all accounts. Product-gated scopes are optional. `files.delete`, `commerce.payment_links.delete`, and `business_units_view.read` are omitted.

## Run locally

```bash
cd services/hubspot-api-mcp
npm install
cp .env.example .env
npm test
npm start
```

The process listens on `127.0.0.1`. ChatGPT, Claude, and Pi are not connected yet.

## Documents

- [Business charter](docs/business-charter.md)
- [Scope audit](docs/scope-audit.md)
- [OAuth app proposal](docs/oauth-app-proposal.md)
- [Deployment](docs/deployment.md)
- [Parity matrix](docs/parity-matrix.md)
- [Verification status](docs/verification-status.md)
- [Rollback](docs/rollback.md)
- [ChatGPT](docs/chatgpt.md)
- [Claude](docs/claude.md)
- [Pi](docs/pi.md)
