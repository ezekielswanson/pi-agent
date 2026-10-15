# Rollback and disconnect

This service has not been deployed and has not stored a live HubSpot grant.

To disconnect a local or future installation:

1. Call `POST /hubspot/disconnect` with the MCP user's bearer token. That deletes the encrypted HubSpot grant for that user and portal `5627913`.
2. Revoke the MCP refresh token with `POST /revoke`.
3. In the future HubSpot app, uninstall the app from portal `5627913` so HubSpot revokes its refresh token. That app does not exist yet.
4. Remove the `hubspot-api` server entry from the client. Leave the existing `hubspot` entry pointed at `https://mcp.hubspot.com`.

Rollback does not include editing app `55630741` or the redirect `http://127.0.0.1:3118/callback`.
