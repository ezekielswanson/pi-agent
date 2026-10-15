# Deployment

No host, domain, or budget is chosen. The service listens on `127.0.0.1` and is not a public MCP endpoint. Do not deploy by editing HubSpot connector `55630741` or `https://mcp.hubspot.com`.

## What a single instance needs

Run `npm start` from `services/hubspot-api-mcp` with the secret names in [`.env.example`](../.env.example). Production boot (`NODE_ENV=production`) rejects the test signer, secrets shorter than 32 characters or with fewer than 10 distinct characters, an issuer that is not `https://`, and a missing `MCP_REVOCATION_FILE`.

Secret names, never values:

- `MCP_AUTH_SECRET`
- `MCP_APPROVAL_SECRET`
- `HUBSPOT_TOKEN_KEY` (32 bytes, base64)
- `HUBSPOT_API_CLIENT_ID`
- `HUBSPOT_API_CLIENT_SECRET`
- `HUBSPOT_API_MCP_USERS_JSON` (ids and scrypt password hashes)

`HUBSPOT_TOKEN_FILE` holds AES-256-GCM HubSpot grants. `MCP_REVOCATION_FILE` holds SHA-256 hashes of revoked MCP access tokens, not the tokens. Both files have to survive restarts on one machine.

One process is enough for the first launch. These stay in process memory and are lost on restart: MCP authorization codes, refresh tokens, login sessions, HubSpot install states, and change proposals. Clients must sign in again after a restart. Revoked access tokens stay revoked because their hashes are in `MCP_REVOCATION_FILE`. HubSpot grants stay encrypted in `HUBSPOT_TOKEN_FILE` and remain bound to the user and portal that created them. A restart does not revive an approval or move one user's installation to another user. This is a single-instance tradeoff, not horizontal scaling.

The default action policy is read and write. Writes require the human approval page. `HUBSPOT_ACTION_POLICY=read-only` denies writes. `HUBSPOT_EXPORT_CREATION=approval` requires that same approval for export creation. Delete, archive, and purge stay denied. See [Action policy](action-policy.md).

The approval page and the HubSpot callback require the login cookie. An MCP access token cannot approve a change. Login is a local username, scrypt password hash, and allowlist. It is not a maintained identity provider.

There is no generic HTTP proxy. Tools call operation ids from the register.

## Gate B, still open

Launch is not approved. Before a live app, a public deploy, a merge, or a live read, the release needs a named choice for each of these:

- Host and domain already available, and its cost. No new account or domain is invented here.
- The separate HubSpot app, created from `proposed/app-hsmeta.json`, with redirect `https://<that-host>/hubspot/oauth/callback`. Local-only work can keep `http://127.0.0.1:8787/hubspot/oauth/callback`. Connector `55630741` stays unchanged.
- Scope manifest: 95 required (`oauth` plus all-account implemented scopes) and 109 optional. The three exclusions stay omitted.
- Identity: keep the local scrypt login for a private single-user deploy, or name an existing identity provider.
- Allowed users and portal `5627913`.
- Deploy actions: one process, secret store, grant file, revocation file, HTTPS in front.
- Live checks, after the host is approved: health and metadata, one read-only grant inspection, then a ChatGPT custom app against the new URL. Claude and Pi stay separate and untested until that ChatGPT read-only pass is done. No send, publish, merge, or delete against Apartment Life data.

ChatGPT, Claude, and Pi connection status: not started.
