import { createMcpHandler, McpServer, OAuthError, requireBearerAuth } from "@modelcontextprotocol/server";
import { McpAuth, type RegisteredClient } from "./auth/provider.ts";
import { HubSpotClient } from "./hubspot/client.ts";
import { hubSpotAuthorizeUrl, exchangeHubSpotCode, getValidGrant, type HubSpotOAuthConfig } from "./hubspot/oauth.ts";
import { TokenStore } from "./hubspot/tokenStore.ts";
import { approveForActor } from "./tools/service.ts";
import { registerHubSpotTools } from "./tools/register.ts";
import { loadManifest, loadMeta, loadOperations, operationMap } from "./registry/load.ts";
import { PolicyError } from "./policy/errors.ts";

export interface AppConfig {
  issuer: string;
  resource: string;
  authSecret: string;
  approvalSecret: string;
  portalId: string;
  allowedUsers: string[];
  clients: RegisteredClient[];
  hubspot: Omit<HubSpotOAuthConfig, "tokenStore" | "expectedPortalId">;
  tokenKey: string;
  tokenFile?: string;
  fetchImpl?: typeof fetch;
  hubspotBaseUrl?: string;
}

export interface App {
  handle(request: Request): Promise<Response>;
  auth: McpAuth;
  tokenStore: TokenStore;
}

export async function createApp(config: AppConfig): Promise<App> {
  const tokenStore = new TokenStore(config.tokenKey, config.tokenFile);
  await tokenStore.load();
  const operations = operationMap(loadOperations());
  const meta = loadMeta();
  const manifest = loadManifest();
  const auth = new McpAuth({
    issuer: config.issuer,
    resource: config.resource,
    secret: config.authSecret,
    clients: config.clients,
    allowedUsers: config.allowedUsers,
    portalId: config.portalId,
    cimdHosts: [],
    fetchImpl: config.fetchImpl,
  });
  const hubspotConfig: HubSpotOAuthConfig = {
    ...config.hubspot,
    expectedPortalId: config.portalId,
    tokenStore,
    fetchImpl: config.fetchImpl,
  };
  const client = new HubSpotClient({ fetchImpl: config.fetchImpl, baseUrl: config.hubspotBaseUrl });
  const metadataUrl = `${config.issuer.replace(/\/$/, "")}/.well-known/oauth-protected-resource/mcp`;
  const gate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token: string) {
        try {
          return await auth.verifyAccessToken(token);
        } catch (error) {
          throw new OAuthError("invalid_token", error instanceof Error ? error.message : "invalid token");
        }
      },
    },
    expectedResource: new URL(config.resource),
    resourceMetadataUrl: metadataUrl,
  });
  const mcp = createMcpHandler((ctx) => {
    const server = new McpServer({ name: "hubspot-api-mcp", version: "0.1.0" });
    const subject = String(ctx.authInfo?.extra?.subject ?? "");
    registerHubSpotTools(
      server,
      {
        actor: subject,
        clientId: ctx.authInfo?.clientId ?? "",
        portalId: config.portalId,
        operations,
        client,
        approvalSecret: config.approvalSecret,
        grant: () => getValidGrant(hubspotConfig, installationKey(subject, config.portalId)),
      },
      meta,
    );
    return server;
  });

  return {
    auth,
    tokenStore,
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")) {
        return json(auth.protectedResourceMetadata());
      }
      if (request.method === "GET" && (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")) {
        return json(auth.authorizationServerMetadata());
      }
      if (request.method === "GET" && url.pathname === "/authorize") {
        try {
          return Response.redirect(await auth.authorize(url.searchParams), 302);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "auth failed" }, 400);
        }
      }
      if (request.method === "POST" && url.pathname === "/token") {
        try {
          return json(await auth.token(new URLSearchParams(await request.text())));
        } catch (error) {
          return json({ error: "invalid_grant", error_description: error instanceof Error ? error.message : "token failed" }, 400);
        }
      }
      if (request.method === "POST" && url.pathname === "/revoke") {
        const body = new URLSearchParams(await request.text());
        const token = body.get("token");
        if (token) auth.revoke(token);
        return new Response(null, { status: 200 });
      }
      if (request.method === "GET" && url.pathname === "/hubspot/oauth/start") {
        const authInfo = await gate(request);
        if (authInfo instanceof Response) return authInfo;
        const state = `${authInfo.extra?.subject ?? ""}:${config.portalId}`;
        return Response.redirect(hubSpotAuthorizeUrl(hubspotConfig, manifest, state), 302);
      }
      if (request.method === "GET" && url.pathname === "/hubspot/oauth/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? "";
        if (!code) return json({ error: "missing code" }, 400);
        const subject = state.split(":")[0] ?? "";
        if (!config.allowedUsers.includes(subject)) return json({ error: "user is not approved" }, 403);
        await exchangeHubSpotCode(hubspotConfig, code, installationKey(subject, config.portalId));
        return json({ connected: true, portalId: config.portalId, tokens: "stored" });
      }
      if (request.method === "POST" && url.pathname === "/hubspot/disconnect") {
        const authInfo = await gate(request);
        if (authInfo instanceof Response) return authInfo;
        await tokenStore.delete(installationKey(String(authInfo.extra?.subject ?? ""), config.portalId));
        return json({ disconnected: true });
      }
      const approval = url.pathname.match(/^\/approvals\/([^/]+)\/approve$/);
      if (request.method === "POST" && approval) {
        const authInfo = await gate(request);
        if (authInfo instanceof Response) return authInfo;
        try {
          const record = approveForActor(
            { actor: String(authInfo.extra?.subject ?? ""), portalId: config.portalId, approvalSecret: config.approvalSecret },
            decodeURIComponent(approval[1] ?? ""),
          );
          return json({ proposalId: record.proposal.id, approvalToken: record.token, expiresAt: record.proposal.expiresAt });
        } catch (error) {
          const status = error instanceof PolicyError ? 400 : 500;
          return json({ error: error instanceof Error ? error.message : "approval failed" }, status);
        }
      }
      if (url.pathname === "/mcp") {
        const authInfo = await gate(request);
        if (authInfo instanceof Response) return authInfo;
        return mcp.fetch(request, { authInfo });
      }
      return json({ error: "not found" }, 404);
    },
  };
}

function installationKey(subject: string, portalId: string): string {
  return `${subject}:${portalId}`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
