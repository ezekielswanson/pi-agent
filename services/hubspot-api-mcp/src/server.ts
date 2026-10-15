import { createMcpHandler, McpServer, OAuthError, requireBearerAuth } from "@modelcontextprotocol/server";
import { McpAuth, type RegisteredClient, type UserCredential } from "./auth/provider.ts";
import { RevocationLog } from "./auth/revocations.ts";
import { RateLimiter } from "./http/limits.ts";
import { assertSameOrigin } from "./http/origin.ts";
import { releaseActionPolicy, type ActionPolicy } from "./policy/actionPolicy.ts";
import { HubSpotClient } from "./hubspot/client.ts";
import { beginHubSpotInstall, consumeHubSpotInstall, exchangeHubSpotCode, getValidGrant, hubSpotAuthorizeUrl, type HubSpotOAuthConfig } from "./hubspot/oauth.ts";
import { TokenStore } from "./hubspot/tokenStore.ts";
import { approveForActor } from "./tools/service.ts";
import { proposalsForDisplay } from "./policy/approval.ts";
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
  users?: UserCredential[];
  clients: RegisteredClient[];
  hubspot: Omit<HubSpotOAuthConfig, "tokenStore" | "expectedPortalId">;
  tokenKey: string;
  tokenFile?: string;
  revocationFile?: string;
  loginLimit?: number;
  actionPolicy?: ActionPolicy;
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
  const revocations = new RevocationLog(config.revocationFile);
  await revocations.load();
  const limiter = new RateLimiter();
  const loginLimit = config.loginLimit ?? 8;
  const actionPolicy = config.actionPolicy ?? releaseActionPolicy();
  const operations = operationMap(loadOperations());
  const meta = loadMeta();
  const manifest = loadManifest();
  const auth = new McpAuth({
    issuer: config.issuer,
    resource: config.resource,
    secret: config.authSecret,
    clients: config.clients,
    allowedUsers: config.allowedUsers,
    users: config.users ?? [],
    revocations,
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
        actionPolicy,
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
          const requestId = await auth.beginAuthorization(url.searchParams);
          return Response.redirect(`${config.issuer.replace(/\/$/, "")}/login?request=${encodeURIComponent(requestId)}`, 302);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "auth failed" }, 400);
        }
      }
      if (url.pathname === "/login") {
        if (request.method === "GET") return html(loginPage(url.searchParams.get("request") ?? "", ""));
        let form: URLSearchParams;
        try {
          form = new URLSearchParams(await limitedText(request));
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Request rejected." }, 413);
        }
        const username = form.get("username") ?? "";
        try {
          assertSameOrigin(request, config.issuer);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Origin rejected." }, 403);
        }
        if (!limiter.allow(`login:${username}`, loginLimit, 60_000)) return json({ error: "Too many login attempts." }, 429);
        try {
          const session = auth.login(username, form.get("password") ?? "");
          const headers = new Headers({ "content-type": "text/html; charset=utf-8", "set-cookie": sessionCookie(session, config.issuer) });
          return new Response(consentPage(form.get("request") ?? ""), { status: 200, headers });
        } catch (error) {
          return html(loginPage(form.get("request") ?? "", error instanceof Error ? error.message : "Login rejected."), 401);
        }
      }
      if (request.method === "POST" && url.pathname === "/consent") {
        try {
          assertSameOrigin(request, config.issuer);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Origin rejected." }, 403);
        }
        const form = new URLSearchParams(await limitedText(request));
        const session = readCookie(request, "mcp_session");
        if (!session) return json({ error: "login required" }, 401);
        try {
          return Response.redirect(auth.completeAuthorization(form.get("request") ?? "", session), 302);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "consent failed" }, 400);
        }
      }
      if (request.method === "POST" && url.pathname === "/token") {
        let body: URLSearchParams;
        try {
          body = new URLSearchParams(await limitedText(request));
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Request rejected." }, 413);
        }
        if (!limiter.allow(`token:${body.get("client_id") ?? ""}`, 30, 60_000)) return json({ error: "Too many token requests." }, 429);
        try {
          return json(await auth.token(body));
        } catch (error) {
          return json({ error: "invalid_grant", error_description: error instanceof Error ? error.message : "token failed" }, 400);
        }
      }
      if (request.method === "POST" && url.pathname === "/revoke") {
        let body: URLSearchParams;
        try {
          body = new URLSearchParams(await limitedText(request));
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Request rejected." }, 413);
        }
        const token = body.get("token");
        if (token) await auth.revoke(token);
        return new Response(null, { status: 200 });
      }
      if (request.method === "POST" && url.pathname === "/logout") {
        try {
          assertSameOrigin(request, config.issuer);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Origin rejected." }, 403);
        }
        const session = readCookie(request, "mcp_session");
        if (session) await auth.revoke(session);
        return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie("", config.issuer, true) } });
      }
      if (request.method === "GET" && url.pathname === "/hubspot/oauth/start") {
        const subject = sessionSubject(auth, readCookie(request, "mcp_session"));
        if (!subject) return json({ error: "login required" }, 401);
        if (request.headers.get("authorization")) {
          const authInfo = await gate(request);
          if (authInfo instanceof Response) return authInfo;
          if (String(authInfo.extra?.subject ?? "") !== subject) return json({ error: "Session does not match the MCP caller." }, 401);
        }
        const state = beginHubSpotInstall({
          subject,
          portalId: config.portalId,
          redirectUri: hubspotConfig.redirectUri,
        });
        return Response.redirect(hubSpotAuthorizeUrl(hubspotConfig, manifest, state), 302);
      }
      if (request.method === "GET" && url.pathname === "/hubspot/oauth/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? "";
        const subject = sessionSubject(auth, readCookie(request, "mcp_session"));
        if (!code) return json({ error: "missing code" }, 400);
        if (!subject) return json({ error: "login required" }, 401);
        try {
          const install = consumeHubSpotInstall(state, {
            portalId: config.portalId,
            redirectUri: hubspotConfig.redirectUri,
            subject,
          });
          await exchangeHubSpotCode(hubspotConfig, code, installationKey(install.subject, config.portalId));
          return json({ connected: true, portalId: config.portalId, tokens: "stored" });
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "callback rejected" }, 400);
        }
      }
      if (request.method === "POST" && url.pathname === "/hubspot/disconnect") {
        const authInfo = await gate(request);
        if (authInfo instanceof Response) return authInfo;
        await tokenStore.delete(installationKey(String(authInfo.extra?.subject ?? ""), config.portalId));
        return json({ disconnected: true });
      }
      const approvalView = url.pathname.match(/^\/approvals\/([^/]+)$/);
      if (request.method === "GET" && approvalView) {
        const session = sessionSubject(auth, readCookie(request, "mcp_session"));
        if (!session) return json({ error: "login required" }, 401);
        const proposal = proposalsForDisplay(decodeURIComponent(approvalView[1] ?? ""));
        if (!proposal || proposal.actor !== session || proposal.portalId !== config.portalId) return json({ error: "proposal unavailable" }, 404);
        return html(approvalPage(proposal));
      }
      const approval = url.pathname.match(/^\/approvals\/([^/]+)\/approve$/);
      if (request.method === "POST" && approval) {
        try {
          assertSameOrigin(request, config.issuer);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Origin rejected." }, 403);
        }
        if (request.headers.get("authorization")) return json({ error: "MCP access cannot approve a change." }, 401);
        const session = sessionSubject(auth, readCookie(request, "mcp_session"));
        if (!session) return json({ error: "login required" }, 401);
        try {
          const record = approveForActor(
            { actor: session, portalId: config.portalId, approvalSecret: config.approvalSecret },
            decodeURIComponent(approval[1] ?? ""),
          );
          return json({ proposalId: record.proposal.id, approvalToken: record.token, expiresAt: record.proposal.expiresAt });
        } catch (error) {
          const status = error instanceof PolicyError ? 400 : 500;
          return json({ error: error instanceof Error ? error.message : "approval failed" }, status);
        }
      }
      if (url.pathname === "/mcp") {
        const declared = Number(request.headers.get("content-length") ?? 0);
        if (Number.isFinite(declared) && declared > 1_000_000) return json({ error: "Request is too large." }, 413);
        const authInfo = await gate(request);
        if (authInfo instanceof Response) return authInfo;
        const subject = String(authInfo.extra?.subject ?? "");
        if (!limiter.allow(`mcp:${subject}`, 120, 60_000)) return json({ error: "Too many MCP requests." }, 429);
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

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function sessionCookie(session: string, issuer: string, clear = false): string {
  const secure = new URL(issuer).protocol === "https:" ? "; Secure" : "";
  const lifetime = clear ? "; Max-Age=0" : "";
  return `mcp_session=${session}; HttpOnly; SameSite=Lax; Path=/${secure}${lifetime}`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  const found = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

function sessionSubject(auth: McpAuth, session: string | null): string | null {
  if (!session) return null;
  try {
    return auth.subjectFromSession(session);
  } catch {
    return null;
  }
}

async function limitedText(request: Request): Promise<string> {
  const text = await request.text();
  if (text.length > 1_000_000) throw new PolicyError("Request is too large.", "validation");
  return text;
}

function loginPage(requestId: string, error: string): string {
  return `<!doctype html><title>Sign in</title><h1>Sign in</h1><p>${escapeHtml(error)}</p><form method="post" action="/login"><input type="hidden" name="request" value="${escapeHtml(requestId)}"><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label><button>Continue</button></form>`;
}

function consentPage(requestId: string): string {
  return `<!doctype html><title>Consent</title><h1>Connect this client</h1><form method="post" action="/consent"><input type="hidden" name="request" value="${escapeHtml(requestId)}"><button>Allow</button></form>`;
}

function approvalPage(proposal: { id: string; method: string; path: string; query: unknown; body: unknown }): string {
  return `<!doctype html><title>Review change</title><h1>Review HubSpot change</h1><p>${escapeHtml(proposal.method)} ${escapeHtml(proposal.path)}</p><pre>${escapeHtml(JSON.stringify({ query: proposal.query, body: proposal.body }, null, 2))}</pre><form method="post" action="/approvals/${encodeURIComponent(proposal.id)}/approve"><button>Approve</button></form>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
