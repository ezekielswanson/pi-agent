# HubSpot OAuth app proposal

This is a proposal. No HubSpot app has been created, and no OAuth consent has been started.

Create a separate developer-platform public app for this MCP service. Do not add these scopes to the existing MCP connector app `55630741`.

## Install scopes

Required: `oauth`, plus every requested scope whose official catalog row says it is available to all accounts. Those names are `required` in [`../registers/scope-manifest.json`](../registers/scope-manifest.json).

Optional: product-gated scopes and endpoint scopes that were not in the catalog table. A missing product should not block install. If HubSpot rejects an optional string as invalid, stop and remove that string. Do not replace it with a wildcard.

Omitted: the `omitted` array in the same file, including the three mandatory exclusions, deprecated scopes, no-API scopes, beta candidates, and scopes with no implemented operation.

Draft app config: [`../proposed/app-hsmeta.json`](../proposed/app-hsmeta.json). It is not uploaded. Its `requiredScopes` and `optionalScopes` are copied from the manifest. Its only redirect is `http://127.0.0.1:8787/hubspot/oauth/callback`. After a host is approved, replace that redirect with `https://<approved-host>/hubspot/oauth/callback` before creating the app. Do not register `http://127.0.0.1:3118/callback` on this app. That URL belongs to the existing hosted MCP connector.

Install URL, filled in only after the app exists:

`https://app.hubspot.com/oauth/authorize?client_id=<APP_CLIENT_ID>&redirect_uri=<encoded callback>&scope=<required scopes, space separated>&optional_scope=<optional scopes, space separated>`

The client id comes from the new app. Do not reuse the hosted connector client id.

## Layer 1, clients of this MCP service

This service is its own authorization server. It does not forward a client's bearer token to HubSpot.

- Protected resource metadata: `/.well-known/oauth-protected-resource/mcp`
- Authorization server metadata: `/.well-known/oauth-authorization-server`
- PKCE S256, authorization code, refresh tokens, and RFC 9207 `iss`
- Pre-registered public clients
- Client ID metadata documents only for `chatgpt.com` and `claude.ai`
- Dynamic client registration is off
- Approved users are `HUBSPOT_API_MCP_USERS`. Other subjects are rejected.
- Tokens are bound to portal `5627913`

## Layer 2, this service to HubSpot

HubSpot access and refresh tokens are encrypted with `HUBSPOT_TOKEN_KEY` and are not returned by tools. Refresh is single-flight. Disconnect deletes the stored grant. A token whose `hub_id` is not `5627913` is rejected.

## Still needs you

Creating the app, choosing a public host, starting OAuth, and any live read are separate approvals. Browser sign-in is only for read-only inspection of docs or account eligibility, and only if a page asks for it. Do not enter a password into the agent.
