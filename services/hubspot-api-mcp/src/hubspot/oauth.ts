import { randomBytes } from "node:crypto";
import { PolicyError } from "../policy/errors.ts";
import type { HubSpotGrant, TokenStore } from "./tokenStore.ts";

export interface HubSpotOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  expectedPortalId: string;
  tokenStore: TokenStore;
  fetchImpl?: typeof fetch;
}

const refreshLocks = new Map<string, Promise<HubSpotGrant>>();

interface InstallState {
  subject: string;
  portalId: string;
  redirectUri: string;
  expiresAt: number;
  used: boolean;
}

const installStates = new Map<string, InstallState>();

export function beginHubSpotInstall(input: { subject: string; portalId: string; redirectUri: string; ttlMs?: number }): string {
  const state = randomBytes(32).toString("base64url");
  installStates.set(state, {
    subject: input.subject,
    portalId: input.portalId,
    redirectUri: input.redirectUri,
    expiresAt: Date.now() + (input.ttlMs ?? 10 * 60 * 1000),
    used: false,
  });
  return state;
}

export function consumeHubSpotInstall(
  state: string,
  expected: { portalId: string; redirectUri: string; subject: string },
): InstallState {
  const record = installStates.get(state);
  if (!record) throw new PolicyError("HubSpot callback state is missing or forged.", "auth");
  if (record.used) throw new PolicyError("HubSpot callback state was already used.", "auth");
  if (record.expiresAt <= Date.now()) {
    record.used = true;
    throw new PolicyError("HubSpot callback state expired.", "auth");
  }
  record.used = true;
  if (record.portalId !== expected.portalId || record.redirectUri !== expected.redirectUri) {
    throw new PolicyError("HubSpot callback state does not match this installation.", "auth");
  }
  if (record.subject !== expected.subject) throw new PolicyError("HubSpot callback state does not match this user.", "auth");
  return record;
}

export function resetInstallStates(): void {
  installStates.clear();
}

export function hubSpotAuthorizeUrl(config: Pick<HubSpotOAuthConfig, "clientId" | "redirectUri">, scopes: { required: string[]; optional: string[] }, state: string): string {
  const url = new URL("https://app.hubspot.com/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", scopes.required.join(" "));
  if (scopes.optional.length > 0) url.searchParams.set("optional_scope", scopes.optional.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeHubSpotCode(config: HubSpotOAuthConfig, code: string, installationKey: string): Promise<HubSpotGrant> {
  const token = await tokenRequest(config, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri });
  const grant = await describeGrant(config, token);
  await config.tokenStore.put(installationKey, grant);
  return publicGrant(grant);
}

export async function getValidGrant(config: HubSpotOAuthConfig, installationKey: string): Promise<HubSpotGrant> {
  const current = config.tokenStore.get(installationKey);
  if (!current) throw new Error("No HubSpot installation is connected for this user.");
  if (current.portalId !== config.expectedPortalId) throw new Error("Connected portal does not match the approved portal.");
  if (current.expiresAt > Date.now() + 30_000) return current;
  const existing = refreshLocks.get(installationKey);
  if (existing) return existing;
  const pending = refreshGrant(config, installationKey, current).finally(() => refreshLocks.delete(installationKey));
  refreshLocks.set(installationKey, pending);
  return pending;
}

async function refreshGrant(config: HubSpotOAuthConfig, installationKey: string, current: HubSpotGrant): Promise<HubSpotGrant> {
  const latest = config.tokenStore.get(installationKey) ?? current;
  if (latest.expiresAt > Date.now() + 30_000) return latest;
  const token = await tokenRequest(config, { grant_type: "refresh_token", refresh_token: latest.refreshToken });
  const grant = await describeGrant(config, { ...token, refresh_token: token.refresh_token || latest.refreshToken });
  await config.tokenStore.put(installationKey, grant);
  return grant;
}

async function tokenRequest(config: HubSpotOAuthConfig, fields: Record<string, string>): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const body = new URLSearchParams({ ...fields, client_id: config.clientId, client_secret: config.clientSecret });
  const response = await (config.fetchImpl ?? fetch)("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`HubSpot token exchange failed with status ${response.status}.`);
  return (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
}

async function describeGrant(config: HubSpotOAuthConfig, token: { access_token: string; refresh_token: string; expires_in: number }): Promise<HubSpotGrant> {
  const response = await (config.fetchImpl ?? fetch)(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(token.access_token)}`);
  if (!response.ok) throw new Error(`HubSpot token inspection failed with status ${response.status}.`);
  const details = (await response.json()) as { hub_id?: number | string; scopes?: string[]; user_id?: number | string; user?: string };
  const portalId = String(details.hub_id ?? "");
  if (portalId !== config.expectedPortalId) throw new Error("HubSpot token portal does not match the approved portal.");
  return {
    portalId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    scopes: details.scopes ?? [],
    userId: String(details.user_id ?? details.user ?? ""),
  };
}

function publicGrant(grant: HubSpotGrant): HubSpotGrant {
  return { ...grant, accessToken: "", refreshToken: "" };
}

export function resetRefreshLocks(): void {
  refreshLocks.clear();
}
