import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { RevocationLog } from "./revocations.ts";
import { PolicyError } from "../policy/errors.ts";

export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  publicClient: boolean;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  subject: string;
  scope: string[];
  resource: string;
  expiresAt: number;
}

interface RefreshRecord {
  clientId: string;
  subject: string;
  scope: string[];
  resource: string;
  expiresAt: number;
}

export interface UserCredential {
  id: string;
  passwordHash: string;
}

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  expiresAt: number;
}

export interface McpAuthConfig {
  issuer: string;
  resource: string;
  secret: string;
  clients: RegisteredClient[];
  allowedUsers: string[];
  users: UserCredential[];
  portalId: string;
  cimdHosts: string[];
  revocations?: RevocationLog;
  fetchImpl?: typeof fetch;
}

const CIMD_HOSTS = new Set(["chatgpt.com", "claude.ai"]);

export class McpAuth {
  private codes = new Map<string, AuthCode>();
  private refresh = new Map<string, RefreshRecord>();
  private pending = new Map<string, PendingAuthorization>();
  private readonly revocations: RevocationLog;

  constructor(private readonly config: McpAuthConfig) {
    this.revocations = config.revocations ?? new RevocationLog();
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.config.resource,
      authorization_servers: [this.config.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    const issuer = this.config.issuer.replace(/\/$/, "");
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ["mcp"],
    };
  }

  async beginAuthorization(query: URLSearchParams): Promise<string> {
    if (query.has("subject")) throw new PolicyError("Client-supplied subject is rejected.", "auth");
    const clientId = requiredParam(query, "client_id");
    const redirectUri = requiredParam(query, "redirect_uri");
    const state = requiredParam(query, "state");
    if (query.get("response_type") !== "code") throw new PolicyError("Only authorization code is supported.", "auth");
    if (query.get("code_challenge_method") !== "S256" || !query.get("code_challenge")) {
      throw new PolicyError("PKCE S256 is required.", "auth");
    }
    if (query.get("resource") && !sameResource(query.get("resource")!, this.config.resource)) {
      throw new PolicyError("Resource does not match this server.", "auth");
    }
    const client = await this.clientFor(clientId);
    if (!client.redirectUris.includes(redirectUri) && !loopbackAllowed(redirectUri, client.redirectUris)) {
      throw new PolicyError("Redirect URI is not allowed.", "auth");
    }
    const requestId = randomBytes(32).toString("base64url");
    this.pending.set(requestId, {
      clientId,
      redirectUri,
      state,
      codeChallenge: query.get("code_challenge")!,
      resource: this.config.resource,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return requestId;
  }

  login(username: string, password: string): string {
    const user = this.config.users.find((item) => item.id === username);
    if (!user || !this.config.allowedUsers.includes(username) || !verifyPassword(password, user.passwordHash)) {
      throw new PolicyError("Login rejected.", "auth");
    }
    return signSession({ sub: username, exp: Date.now() + 10 * 60 * 1000 }, this.config.secret);
  }

  subjectFromSession(sessionToken: string): string {
    return readSession(sessionToken, this.config.secret).sub;
  }

  completeAuthorization(requestId: string, sessionToken: string): string {
    const session = readSession(sessionToken, this.config.secret);
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);
    if (!pending || pending.expiresAt <= Date.now()) throw new PolicyError("Authorization request expired.", "auth");
    if (!this.config.allowedUsers.includes(session.sub)) throw new PolicyError("User is not approved for this portal.", "auth");
    const code = randomUUID();
    this.codes.set(code, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      subject: session.sub,
      scope: ["mcp"],
      resource: pending.resource,
      expiresAt: Date.now() + 60_000,
    });
    const target = new URL(pending.redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", pending.state);
    target.searchParams.set("iss", this.config.issuer.replace(/\/$/, ""));
    return target.toString();
  }

  async token(body: URLSearchParams): Promise<Record<string, unknown>> {
    const clientId = requiredParam(body, "client_id");
    await this.clientFor(clientId);
    if (body.get("resource") && !sameResource(body.get("resource")!, this.config.resource)) {
      throw new PolicyError("Resource does not match this server.", "auth");
    }
    if (body.get("grant_type") === "authorization_code") return this.codeGrant(body, clientId);
    if (body.get("grant_type") === "refresh_token") return this.refreshGrant(body, clientId);
    throw new PolicyError("Unsupported grant type.", "auth");
  }

  async revoke(token: string): Promise<void> {
    this.refresh.delete(token);
    await this.revocations.add(token);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.revocations.has(token)) throw new PolicyError("Token revoked.", "invalid_token");
    const claims = readToken(token, this.config.secret);
    if (claims.iss !== this.config.issuer.replace(/\/$/, "")) throw new PolicyError("Issuer rejected.", "invalid_token");
    if (!sameResource(claims.aud, this.config.resource)) throw new PolicyError("Audience rejected.", "invalid_token");
    if (!this.config.allowedUsers.includes(claims.sub)) throw new PolicyError("User rejected.", "invalid_token");
    const client = this.config.clients.find((item) => item.clientId === claims.client_id);
    if (!client && !(await this.allowCimd(claims.client_id))) throw new PolicyError("Client rejected.", "invalid_token");
    return {
      token,
      clientId: claims.client_id,
      scopes: claims.scope,
      expiresAt: claims.exp,
      resource: new URL(this.config.resource),
      extra: { subject: claims.sub, portalId: claims.portal },
    };
  }

  private codeGrant(body: URLSearchParams, clientId: string): Record<string, unknown> {
    const code = requiredParam(body, "code");
    const record = this.codes.get(code);
    this.codes.delete(code);
    if (!record || record.expiresAt <= Date.now() || record.clientId !== clientId) {
      throw new PolicyError("Authorization code rejected.", "invalid_grant");
    }
    if (record.redirectUri !== body.get("redirect_uri")) throw new PolicyError("Redirect URI rejected.", "invalid_grant");
    const verifier = requiredParam(body, "code_verifier");
    const hashed = createHash("sha256").update(verifier).digest("base64url");
    if (!safeEqual(hashed, record.codeChallenge)) throw new PolicyError("PKCE rejected.", "invalid_grant");
    return this.issue(record.clientId, record.subject, record.scope, record.resource);
  }

  private refreshGrant(body: URLSearchParams, clientId: string): Record<string, unknown> {
    const token = requiredParam(body, "refresh_token");
    const record = this.refresh.get(token);
    this.refresh.delete(token);
    if (!record || record.clientId !== clientId || record.expiresAt <= Date.now()) {
      throw new PolicyError("Refresh token rejected.", "invalid_grant");
    }
    return this.issue(record.clientId, record.subject, record.scope, record.resource);
  }

  private issue(clientId: string, subject: string, scope: string[], resource: string): Record<string, unknown> {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = signToken({ iss: this.config.issuer.replace(/\/$/, ""), aud: resource, sub: subject, client_id: clientId, scope, exp, portal: this.config.portalId }, this.config.secret);
    const refresh = randomBytes(32).toString("base64url");
    this.refresh.set(refresh, { clientId, subject, scope, resource, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: scope.join(" ") };
  }

  private async clientFor(clientId: string): Promise<RegisteredClient> {
    const existing = this.config.clients.find((client) => client.clientId === clientId);
    if (existing) return existing;
    if (!(await this.allowCimd(clientId))) throw new PolicyError("Client is not registered.", "auth");
    const response = await (this.config.fetchImpl ?? fetch)(clientId, { redirect: "manual" });
    if (response.status >= 300) throw new PolicyError("Client metadata redirect rejected.", "auth");
    const text = await response.text();
    if (text.length > 20_000) throw new PolicyError("Client metadata is too large.", "auth");
    const document = JSON.parse(text) as { client_id?: string; redirect_uris?: string[] };
    if (document.client_id !== clientId || !document.redirect_uris?.length) {
      throw new PolicyError("Client metadata rejected.", "auth");
    }
    return { clientId, redirectUris: document.redirect_uris, publicClient: true };
  }

  private async allowCimd(clientId: string): Promise<boolean> {
    if (!clientId.startsWith("https://")) return false;
    const url = new URL(clientId);
    const hosts = new Set([...CIMD_HOSTS, ...this.config.cimdHosts]);
    return hosts.has(url.hostname);
  }
}

interface Claims {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string[];
  exp: number;
  portal: string;
}

function signToken(claims: Claims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function readToken(token: string, secret: string): Claims {
  const [body, mac] = token.split(".");
  if (!body || !mac) throw new PolicyError("Malformed token.", "invalid_token");
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(mac, expected)) throw new PolicyError("Token signature rejected.", "invalid_token");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Claims;
  if (!claims.exp || claims.exp <= Math.floor(Date.now() / 1000)) throw new PolicyError("Token expired.", "invalid_token");
  return claims;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `${salt.toString("base64url")}.${hash.toString("base64url")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(".");
  if (!salt || !hash) return false;
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), 32);
  const expected = Buffer.from(hash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function signSession(claims: { sub: string; exp: number }, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", secret).update(`session.${body}`).digest("base64url");
  return `${body}.${mac}`;
}

function readSession(token: string, secret: string): { sub: string; exp: number } {
  const [body, mac] = token.split(".");
  if (!body || !mac) throw new PolicyError("Login session rejected.", "auth");
  const expected = createHmac("sha256", secret).update(`session.${body}`).digest("base64url");
  if (!safeEqual(mac, expected)) throw new PolicyError("Login session rejected.", "auth");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as { sub?: string; exp?: number };
  if (!claims.sub || !claims.exp || claims.exp <= Date.now()) throw new PolicyError("Login session expired.", "auth");
  return { sub: claims.sub, exp: claims.exp };
}

function requiredParam(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (!value) throw new PolicyError(`Missing ${name}.`, "auth");
  return value;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameResource(left: string, right: string): boolean {
  return left.replace(/\/$/, "") === right.replace(/\/$/, "");
}

function loopbackAllowed(redirectUri: string, allowed: string[]): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false;
  return allowed.some((item) => {
    try {
      const candidate = new URL(item);
      return candidate.protocol === url.protocol && candidate.hostname === url.hostname && candidate.pathname === url.pathname;
    } catch {
      return false;
    }
  });
}
