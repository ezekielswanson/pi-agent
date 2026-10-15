import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/auth/provider.ts";
import { RevocationLog } from "../src/auth/revocations.ts";
import { McpAuth } from "../src/auth/provider.ts";
import { HubSpotClient } from "../src/hubspot/client.ts";
import { beginHubSpotInstall, consumeHubSpotInstall, resetInstallStates } from "../src/hubspot/oauth.ts";
import { loadOperations, operationMap } from "../src/registry/load.ts";
import { createApp } from "../src/server.ts";
import { resetApprovals } from "../src/policy/approval.ts";
import { capabilityReport, executeOperation, listOperations, prepareOperation } from "../src/tools/service.ts";

const password = "correct-horse-battery";
const users = [
  { id: "ada", passwordHash: hashPassword(password) },
  { id: "bea", passwordHash: hashPassword(password) },
];
const redirectUri = "http://127.0.0.1:8787/hubspot/oauth/callback";

async function appWith(fetchImpl?: typeof fetch, loginLimit = 8) {
  return createApp({
    issuer: "http://127.0.0.1:8787",
    resource: "http://127.0.0.1:8787/mcp",
    authSecret: "auth-secret",
    approvalSecret: "approval-secret",
    portalId: "5627913",
    allowedUsers: ["ada", "bea"],
    users,
    clients: [{ clientId: "pi", redirectUris: ["http://127.0.0.1:8788/callback"], publicClient: true }],
    tokenKey: randomBytes(32).toString("base64"),
    hubspot: { clientId: "hubspot-app", clientSecret: "not-used", redirectUri },
    fetchImpl,
    loginLimit,
  });
}

async function sessionCookie(app: Awaited<ReturnType<typeof appWith>>, username: string): Promise<string> {
  const response = await app.handle(
    new Request("http://127.0.0.1:8787/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password, request: "unused" }),
    }),
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie;
}

test("hubspot install state is one-time and rejects forged, expired, and cross-user callbacks", () => {
  resetInstallStates();
  assert.throws(
    () => consumeHubSpotInstall("forged", { portalId: "5627913", redirectUri, subject: "ada" }),
    /missing or forged/,
  );
  const expired = beginHubSpotInstall({ subject: "ada", portalId: "5627913", redirectUri, ttlMs: -1 });
  assert.throws(() => consumeHubSpotInstall(expired, { portalId: "5627913", redirectUri, subject: "ada" }), /expired/);
  const state = beginHubSpotInstall({ subject: "ada", portalId: "5627913", redirectUri });
  assert.equal(state.includes("ada"), false);
  assert.throws(() => consumeHubSpotInstall(state, { portalId: "999", redirectUri, subject: "ada" }), /installation/);
  const crossUser = beginHubSpotInstall({ subject: "ada", portalId: "5627913", redirectUri });
  assert.throws(() => consumeHubSpotInstall(crossUser, { portalId: "5627913", redirectUri, subject: "bea" }), /this user/);
  const once = beginHubSpotInstall({ subject: "ada", portalId: "5627913", redirectUri });
  consumeHubSpotInstall(once, { portalId: "5627913", redirectUri, subject: "ada" });
  assert.throws(() => consumeHubSpotInstall(once, { portalId: "5627913", redirectUri, subject: "ada" }), /already used/);
});

test("a forged hubspot callback does not exchange a token", async () => {
  let fetches = 0;
  const app = await appWith(async () => {
    fetches += 1;
    return new Response("{}", { status: 200 });
  });
  const cookie = await sessionCookie(app, "ada");
  const response = await app.handle(
    new Request("http://127.0.0.1:8787/hubspot/oauth/callback?code=abc&state=forged", { headers: { cookie } }),
  );
  assert.equal(response.status, 400);
  assert.equal(fetches, 0);
});

test("hubspot callback state cannot be replayed or finished by another user", async () => {
  let fetches = 0;
  const app = await appWith(async (input) => {
    fetches += 1;
    const url = String(input);
    if (url.endsWith("/oauth/v1/token")) {
      return new Response(JSON.stringify({ access_token: "hs-access", refresh_token: "hs-refresh", expires_in: 1800 }), { status: 200 });
    }
    return new Response(JSON.stringify({ hub_id: 5627913, scopes: ["oauth"], user_id: 9 }), { status: 200 });
  });
  const ada = await sessionCookie(app, "ada");
  const bea = await sessionCookie(app, "bea");
  const started = await app.handle(new Request("http://127.0.0.1:8787/hubspot/oauth/start", { headers: { cookie: ada } }));
  assert.equal(started.status, 302);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state");
  assert.ok(state);
  const stolen = await app.handle(
    new Request(`http://127.0.0.1:8787/hubspot/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: bea } }),
  );
  assert.equal(stolen.status, 400);
  assert.equal(fetches, 0);
  const finished = await app.handle(
    new Request(`http://127.0.0.1:8787/hubspot/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: ada } }),
  );
  assert.equal(finished.status, 400);
  assert.equal(fetches, 0);
  const again = await app.handle(new Request("http://127.0.0.1:8787/hubspot/oauth/start", { headers: { cookie: ada } }));
  const nextState = new URL(again.headers.get("location") ?? "").searchParams.get("state");
  assert.ok(nextState);
  const connected = await app.handle(
    new Request(`http://127.0.0.1:8787/hubspot/oauth/callback?code=abc&state=${encodeURIComponent(nextState)}`, { headers: { cookie: ada } }),
  );
  assert.equal(connected.status, 200);
  assert.equal(fetches, 2);
  const replay = await app.handle(
    new Request(`http://127.0.0.1:8787/hubspot/oauth/callback?code=abc&state=${encodeURIComponent(nextState)}`, { headers: { cookie: ada } }),
  );
  assert.equal(replay.status, 400);
  assert.equal(fetches, 2);
  const stored = JSON.stringify(await connected.json());
  assert.equal(stored.includes("hs-access"), false);
  assert.equal(stored.includes("hs-refresh"), false);
});

test("an MCP bearer token cannot approve its own proposal", async () => {
  resetApprovals();
  const mutate = loadOperations().find((operation) => operation.id === "delete-crm-objects-2026-09-contacts-contactid");
  assert.ok(mutate);
  const app = await appWith();
  const prepared = await prepareOperation(
    {
      actor: "ada",
      clientId: "pi",
      portalId: "5627913",
      operations: new Map([[mutate.id, mutate]]),
      client: new HubSpotClient(),
      grant: async () => {
        throw new Error("no grant");
      },
      approvalSecret: "approval-secret",
    },
    mutate.id,
    { pathParams: { contactId: "42" } },
  );
  const proposalId = (prepared as { proposalId: string }).proposalId;
  const bearer = await app.handle(
    new Request(`http://127.0.0.1:8787/approvals/${proposalId}/approve`, {
      method: "POST",
      headers: { authorization: "Bearer mcp-access" },
    }),
  );
  assert.equal(bearer.status, 401);
  const anonymous = await app.handle(new Request(`http://127.0.0.1:8787/approvals/${proposalId}/approve`, { method: "POST" }));
  assert.equal(anonymous.status, 401);
  const cookie = await sessionCookie(app, "ada");
  const approved = await app.handle(
    new Request(`http://127.0.0.1:8787/approvals/${proposalId}/approve`, { method: "POST", headers: { cookie } }),
  );
  assert.equal(approved.status, 200);
  const body = (await approved.json()) as { approvalToken: string };
  assert.equal(body.approvalToken.length > 10, true);
  const replay = await app.handle(
    new Request(`http://127.0.0.1:8787/approvals/${proposalId}/approve`, { method: "POST", headers: { cookie } }),
  );
  assert.equal(replay.status, 400);
  let calls = 0;
  await executeOperation(
    {
      actor: "ada",
      clientId: "pi",
      portalId: "5627913",
      operations: new Map([[mutate.id, mutate]]),
      client: new HubSpotClient({
        fetchImpl: async () => {
          calls += 1;
          return new Response("{}", { status: 200 });
        },
      }),
      grant: async () => ({
        portalId: "5627913",
        accessToken: "token",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
        scopes: ["crm.objects.contacts.write"],
        userId: "1",
      }),
      approvalSecret: "approval-secret",
    },
    mutate.id,
    { pathParams: { contactId: "42" } },
    body.approvalToken,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      executeOperation(
        {
          actor: "ada",
          clientId: "pi",
          portalId: "5627913",
          operations: new Map([[mutate.id, mutate]]),
          client: new HubSpotClient(),
          grant: async () => {
            throw new Error("should not refresh");
          },
          approvalSecret: "approval-secret",
        },
        mutate.id,
        { pathParams: { contactId: "42" } },
        body.approvalToken,
      ),
    /not active/,
  );
});

test("sensitive grants are object-specific and unknown properties fail closed", async () => {
  const read = loadOperations().find((operation) => operation.id === "get-crm-objects-2026-09-contacts-contactid");
  const update = loadOperations().find((operation) => operation.id === "patch-crm-objects-2026-09-contacts-contactid");
  const search = loadOperations().find((operation) => operation.id === "post-crm-objects-2026-09-contacts-search");
  assert.ok(read && update && search);
  let calls = 0;
  const client = new HubSpotClient({
    fetchImpl: async (input) => {
      calls += 1;
      return new Response(JSON.stringify({ properties: { email: "a@example.com", hs_ssn: "999", secret_note: "no" } }), {
        status: 200,
        headers: { "x-request": String(input) },
      });
    },
  });
  const base = read.scopeGroups.flatMap((group) => group.scopes);
  const hidden = await client.call({
    operation: read,
    params: { pathParams: { contactId: "1" }, query: { properties: "email,hs_ssn,secret_note" } },
    token: "hubspot-token",
    grantedScopes: [...base, "crm.objects.contacts.sensitive.read"],
  });
  const hiddenProperties = (hidden.body as { properties: Record<string, string> }).properties;
  assert.equal(hiddenProperties.email, "a@example.com");
  assert.equal(hiddenProperties.hs_ssn, undefined);
  assert.equal(hiddenProperties.secret_note, undefined);
  const shown = await client.call({
    operation: read,
    params: { pathParams: { contactId: "1" }, query: { properties: "hs_ssn" } },
    token: "hubspot-token",
    grantedScopes: [...base, "crm.objects.contacts.highly_sensitive.read"],
  });
  assert.equal((shown.body as { properties: Record<string, string> }).properties.hs_ssn, "999");
  const company = {
    ...read,
    id: "company-read",
    path: "/crm/objects/2026-09/companies/{companyId}",
    scopeGroups: [{ mode: "any" as const, scopes: ["crm.objects.companies.read"] }],
  };
  let requested = "";
  const companyClient = new HubSpotClient({
    fetchImpl: async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({ properties: { ssn: "1", name: "North" } }), { status: 200 });
    },
  });
  const companyResult = await companyClient.call({
    operation: company,
    params: { pathParams: { companyId: "9" }, query: { properties: "ssn,name" } },
    token: "hubspot-token",
    grantedScopes: ["crm.objects.companies.read", "crm.objects.contacts.sensitive.read"],
  });
  assert.equal((companyResult.body as { properties: Record<string, string> }).properties.ssn, undefined);
  assert.equal(requested.includes("ssn"), false);
  const before = calls;
  await assert.rejects(
    () =>
      client.call({
        operation: search,
        params: { body: { filterGroups: [{ filters: [{ propertyName: "ssn", operator: "EQ", value: "1" }] }] } },
        token: "hubspot-token",
        grantedScopes: search.scopeGroups.flatMap((group) => group.scopes),
      }),
    /not granted/,
  );
  assert.equal(calls, before);
  await assert.rejects(
    () =>
      client.call({
        operation: update,
        params: { pathParams: { contactId: "1" }, body: { properties: { ssn: "1" } } },
        token: "hubspot-token",
        grantedScopes: update.scopeGroups.flatMap((group) => group.scopes),
      }),
    /not granted/,
  );
});

test("discovery pages report the total and capabilities follow the live grant", async () => {
  const operations = operationMap(loadOperations());
  const first = listOperations(operations, { limit: 1 });
  assert.equal(first.operations.length, 1);
  assert.equal(first.total > 50, true);
  assert.equal(first.truncated, true);
  assert.equal(first.nextCursor, 1);
  const second = listOperations(operations, { limit: 1, cursor: first.nextCursor ?? 0 });
  assert.notEqual(second.operations[0]?.id, first.operations[0]?.id);
  const read = loadOperations().find((operation) => operation.id === "get-crm-objects-2026-09-contacts-contactid");
  assert.ok(read);
  const ctx = {
    actor: "ada",
    clientId: "pi",
    portalId: "5627913",
    operations: new Map([[read.id, read]]),
    client: new HubSpotClient(),
    grant: async () => {
      throw new Error("not connected");
    },
    approvalSecret: "approval-secret",
  };
  const disconnected = await capabilityReport(ctx, { retrievedAt: "2026-10-15", apiVersion: "2026-09" });
  assert.equal(disconnected.grantState, "not_connected");
  assert.equal(disconnected.executableOperations, 0);
  const connected = await capabilityReport(
    {
      ...ctx,
      grant: async () => ({
        portalId: "5627913",
        accessToken: "token",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
        scopes: read.scopeGroups.flatMap((group) => group.scopes),
        userId: "1",
      }),
    },
    { retrievedAt: "2026-10-15", apiVersion: "2026-09" },
  );
  assert.equal(connected.grantState, "connected");
  assert.equal(connected.executableOperations, 1);
  assert.deepEqual(connected.grantedScopes, read.scopeGroups.flatMap((group) => group.scopes));
});

test("revoked access tokens stay revoked after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-revoke-"));
  const file = join(dir, "revocations.json");
  const log = new RevocationLog(file);
  await log.load();
  const auth = new McpAuth({
    issuer: "http://127.0.0.1:8787",
    resource: "http://127.0.0.1:8787/mcp",
    secret: "auth-secret",
    portalId: "5627913",
    allowedUsers: ["ada"],
    users: [{ id: "ada", passwordHash: hashPassword(password) }],
    cimdHosts: [],
    clients: [{ clientId: "pi", redirectUris: ["http://127.0.0.1/callback"], publicClient: true }],
    revocations: log,
  });
  const verifier = "verifier-value";
  const { createHash } = await import("node:crypto");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const requestId = await auth.beginAuthorization(
    new URLSearchParams({
      response_type: "code",
      client_id: "pi",
      redirect_uri: "http://127.0.0.1:9999/callback",
      state: "xyz",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  );
  const redirect = auth.completeAuthorization(requestId, auth.login("ada", password));
  const code = new URL(redirect).searchParams.get("code") ?? "";
  const token = await auth.token(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "pi",
      redirect_uri: "http://127.0.0.1:9999/callback",
      code_verifier: verifier,
    }),
  );
  const access = String(token.access_token);
  await auth.revoke(access);
  const reloaded = new RevocationLog(file);
  await reloaded.load();
  const restarted = new McpAuth({
    issuer: "http://127.0.0.1:8787",
    resource: "http://127.0.0.1:8787/mcp",
    secret: "auth-secret",
    portalId: "5627913",
    allowedUsers: ["ada"],
    users: [{ id: "ada", passwordHash: hashPassword(password) }],
    cimdHosts: [],
    clients: [{ clientId: "pi", redirectUris: ["http://127.0.0.1/callback"], publicClient: true }],
    revocations: reloaded,
  });
  await assert.rejects(() => restarted.verifyAccessToken(access), /revoked/);
  assert.equal(readFileSync(file, "utf8").includes(access), false);
});

test("login attempts are rate limited", async () => {
  const app = await appWith(undefined, 2);
  const body = new URLSearchParams({ username: "ada", password: "wrong", request: "unused" });
  const first = await app.handle(
    new Request("http://127.0.0.1:8787/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }),
  );
  const second = await app.handle(
    new Request("http://127.0.0.1:8787/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }),
  );
  const third = await app.handle(
    new Request("http://127.0.0.1:8787/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }),
  );
  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  assert.equal(third.status, 429);
});

test("hubspot redirects to another host are not followed", async () => {
  const read = loadOperations().find((operation) => operation.id === "get-crm-objects-2026-09-contacts-contactid");
  assert.ok(read);
  let calls = 0;
  const client = new HubSpotClient({
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "https://evil.example/token" } });
    },
  });
  await assert.rejects(
    () =>
      client.call({
        operation: read,
        params: { pathParams: { contactId: "1" } },
        token: "hubspot-token",
        grantedScopes: read.scopeGroups.flatMap((group) => group.scopes),
      }),
    /redirect is not followed/,
  );
  assert.equal(calls, 1);
});
