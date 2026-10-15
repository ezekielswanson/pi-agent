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
import { approveProposal, resetApprovals } from "../src/policy/approval.ts";
import { actionPolicyFromEnv, releaseActionPolicy } from "../src/policy/actionPolicy.ts";
import { changeArguments } from "../src/tools/register.ts";
import { capabilityReport, executeOperation, listOperations, prepareOperation, readOperation } from "../src/tools/service.ts";

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
  const mutate = loadOperations().find((operation) => operation.id === "patch-crm-objects-2026-09-contacts-contactid");
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
      actionPolicy: releaseActionPolicy({ writes: "approval_required" }),
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
      actionPolicy: releaseActionPolicy({ writes: "approval_required" }),
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
          actionPolicy: releaseActionPolicy({ writes: "approval_required" }),
        },
        mutate.id,
        { pathParams: { contactId: "42" } },
        body.approvalToken,
      ),
    /not active/,
  );
});

test("read-only policy allows custom properties and denies writes, exports, and deletion", async () => {
  const read = loadOperations().find((operation) => operation.id === "get-crm-objects-2026-09-contacts-contactid");
  const update = loadOperations().find((operation) => operation.id === "patch-crm-objects-2026-09-contacts-contactid");
  const archive = loadOperations().find((operation) => operation.id === "delete-crm-objects-2026-09-contacts-contactid");
  const createExport = loadOperations().find((operation) => operation.id === "post-crm-exports-2026-09-export-async");
  assert.ok(read && update && archive && createExport);
  let calls = 0;
  const ctx = {
    actor: "ada",
    clientId: "pi",
    portalId: "5627913",
    operations: new Map([
      [read.id, read],
      [update.id, update],
      [archive.id, archive],
      [createExport.id, createExport],
    ]),
    client: new HubSpotClient({
      fetchImpl: async (input) => {
        calls += 1;
        assert.equal(String(input).includes("custom_apartment_code"), true);
        return new Response(JSON.stringify({ properties: { custom_apartment_code: "B2", access_token: "nope" } }), { status: 200 });
      },
    }),
    grant: async () => ({
      portalId: "5627913",
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
      scopes: read.scopeGroups.flatMap((group) => group.scopes),
      userId: "1",
    }),
    approvalSecret: "approval-secret",
    actionPolicy: releaseActionPolicy({ writes: "deny" }),
  };
  const result = await readOperation(ctx, read.id, { pathParams: { contactId: "1" }, query: { properties: "custom_apartment_code" } });
  assert.equal(calls, 1);
  const properties = (result as { body: { properties: Record<string, string> } }).body.properties;
  assert.equal(properties.custom_apartment_code, "B2");
  assert.equal(properties.access_token, "[redacted]");
  await assert.rejects(() => prepareOperation(ctx, update.id, { pathParams: { contactId: "1" }, body: { properties: { custom_apartment_code: "B2" } } }), /Writes are denied/);
  await assert.rejects(() => prepareOperation(ctx, archive.id, { pathParams: { contactId: "1" } }), /denied for this release/);
  await assert.rejects(() => prepareOperation(ctx, createExport.id, { body: { exportType: "VIEW" } }), /Export creation is not allowed/);
  assert.equal(calls, 1);
  const writing = { ...ctx, actionPolicy: releaseActionPolicy({ writes: "approval_required", exportCreation: "approval_required" }) };
  await assert.rejects(() => prepareOperation(writing, archive.id, { pathParams: { contactId: "1" } }), /denied for this release/);
  const proposal = await prepareOperation(writing, update.id, { pathParams: { contactId: "1" }, body: { properties: { custom_apartment_code: "B2" } } });
  assert.equal(typeof (proposal as { proposalId: string }).proposalId, "string");
  assert.equal(calls, 1);
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
    actionPolicy: releaseActionPolicy(),
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
  assert.equal(connected.actionPolicy.deletion, "deny");
  assert.equal(connected.actionPolicy.writes, "approval_required");
  assert.equal(connected.actionPolicy.reads, "allow");
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

test("https login requires a matching origin, and sign-out revokes the session", async () => {
  const app = await createApp({
    issuer: "https://mcp.example",
    resource: "https://mcp.example/mcp",
    authSecret: "auth-secret",
    approvalSecret: "approval-secret",
    portalId: "5627913",
    allowedUsers: ["ada"],
    users,
    clients: [{ clientId: "pi", redirectUris: ["http://127.0.0.1:8788/callback"], publicClient: true }],
    tokenKey: randomBytes(32).toString("base64"),
    hubspot: { clientId: "hubspot-app", clientSecret: "not-used", redirectUri: "https://mcp.example/hubspot/oauth/callback" },
  });
  const body = new URLSearchParams({ username: "ada", password, request: "unused" });
  const missing = await app.handle(new Request("https://mcp.example/login", { method: "POST", body }));
  assert.equal(missing.status, 403);
  const foreign = await app.handle(
    new Request("https://mcp.example/login", { method: "POST", headers: { origin: "https://evil.example" }, body }),
  );
  assert.equal(foreign.status, 403);
  const login = await app.handle(
    new Request("https://mcp.example/login", { method: "POST", headers: { origin: "https://mcp.example" }, body }),
  );
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie") ?? "", /Secure/);
  assert.match(login.headers.get("set-cookie") ?? "", /HttpOnly/);
  const cookie = login.headers.get("set-cookie") ?? "";
  const goodbye = await app.handle(
    new Request("https://mcp.example/logout", { method: "POST", headers: { origin: "https://mcp.example", cookie } }),
  );
  assert.equal(goodbye.status, 204);
  const after = await app.handle(new Request("https://mcp.example/hubspot/oauth/start", { headers: { cookie } }));
  assert.equal(after.status, 401);
});

test("restart drops approvals and keeps revocation and portal isolation", async () => {
  resetApprovals();
  const update = loadOperations().find((operation) => operation.id === "patch-crm-objects-2026-09-contacts-contactid");
  assert.ok(update);
  const prepared = await prepareOperation(
    {
      actor: "ada",
      clientId: "pi",
      portalId: "5627913",
      operations: new Map([[update.id, update]]),
      client: new HubSpotClient(),
      grant: async () => {
        throw new Error("no");
      },
      approvalSecret: "approval-secret",
      actionPolicy: releaseActionPolicy({ writes: "approval_required" }),
    },
    update.id,
    { pathParams: { contactId: "7" }, body: { properties: { firstname: "Ada" } } },
  );
  const proposalId = (prepared as { proposalId: string }).proposalId;
  const approved = approveProposal({ proposalId, actor: "ada", portalId: "5627913", secret: "approval-secret" });
  resetApprovals();
  await assert.rejects(
    () =>
      executeOperation(
        {
          actor: "ada",
          clientId: "pi",
          portalId: "5627913",
          operations: new Map([[update.id, update]]),
          client: new HubSpotClient({
            fetchImpl: async () => {
              throw new Error("restarted approval must not call HubSpot");
            },
          }),
          grant: async () => {
            throw new Error("no");
          },
          approvalSecret: "approval-secret",
          actionPolicy: releaseActionPolicy({ writes: "approval_required" }),
        },
        update.id,
        { pathParams: { contactId: "7" }, body: { properties: { firstname: "Ada" } } },
        approved.token,
      ),
    /Unknown proposal/,
  );
  assert.equal(proposalId.length > 0, true);
  const { TokenStore } = await import("../src/hubspot/tokenStore.ts");
  const store = new TokenStore(randomBytes(32).toString("base64"));
  await store.put("ada:5627913", {
    portalId: "5627913",
    accessToken: "ada-token",
    refreshToken: "ada-refresh",
    expiresAt: Date.now() + 60_000,
    scopes: ["oauth"],
    userId: "1",
  });
  assert.equal(store.get("bea:5627913"), undefined);
  assert.throws(() => actionPolicyFromEnv({ action: "allow-delete" }), /HUBSPOT_ACTION_POLICY/);
  assert.equal(actionPolicyFromEnv({}).writes, "approval_required");
  assert.equal(actionPolicyFromEnv({}).reads, "allow");
  assert.equal(actionPolicyFromEnv({ action: "read-write" }).deletion, "deny");
  assert.equal(actionPolicyFromEnv({ action: "read-only" }).writes, "deny");
  assert.equal(changeArguments.safeParse({ operationId: "x", approved: true }).success, false);
});
