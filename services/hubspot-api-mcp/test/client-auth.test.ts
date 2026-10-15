import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { hashPassword, McpAuth, type McpAuthConfig } from "../src/auth/provider.ts";
import { RevocationLog } from "../src/auth/revocations.ts";
import { assertProductionSecrets } from "../src/boot.ts";
import { HubSpotClient } from "../src/hubspot/client.ts";
import { exchangeHubSpotCode, getValidGrant, resetRefreshLocks } from "../src/hubspot/oauth.ts";
import { TokenStore } from "../src/hubspot/tokenStore.ts";
import { readFileSync } from "node:fs";
import { loadOperations } from "../src/registry/load.ts";
import { executeOperation, prepareOperation } from "../src/tools/service.ts";

const read = loadOperations().find((operation) => operation.id === "get-crm-objects-2026-09-contacts-contactid");
assert.ok(read);
const password = "correct-horse-battery";
const ada = { id: "ada", passwordHash: hashPassword(password) };

function authConfig(overrides: Partial<McpAuthConfig> = {}): McpAuthConfig {
  return {
    issuer: "http://127.0.0.1:8787",
    resource: "http://127.0.0.1:8787/mcp",
    secret: "auth-secret",
    portalId: "5627913",
    allowedUsers: ["ada"],
    users: [ada],
    cimdHosts: [],
    clients: [{ clientId: "pi", redirectUris: ["http://127.0.0.1/callback"], publicClient: true }],
    ...overrides,
  };
}

async function authorizedRedirect(auth: McpAuth, query: URLSearchParams): Promise<string> {
  const requestId = await auth.beginAuthorization(query);
  const session = auth.login("ada", password);
  return auth.completeAuthorization(requestId, session);
}

test("reads follow pages up to the cap and writes are not retried", async () => {
  let calls = 0;
  const client = new HubSpotClient({
    maxRecords: 1,
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ results: [{ id: "1" }], paging: { next: { after: "next" } } }), {
          status: 429,
          headers: { "retry-after": "0", "x-hubspot-correlation-id": "corr-1" },
        });
      }
      return new Response(JSON.stringify({ results: [{ id: "1" }], paging: { next: { after: "next" } } }), { status: 200 });
    },
  });
  const result = await client.call({
    operation: read,
    params: { pathParams: { contactId: "1" } },
    token: "hubspot-token",
    grantedScopes: read.scopeGroups.flatMap((group) => group.scopes),
    followPages: true,
  });
  assert.equal(result.truncated, true);
  assert.equal(result.correlationId, "corr-1");
  assert.ok(calls >= 2);

  const mutate = loadOperations().find((operation) => operation.id === "delete-crm-objects-2026-09-contacts-contactid");
  assert.ok(mutate);
  let writes = 0;
  const writer = new HubSpotClient({
    sleep: async () => {},
    fetchImpl: async () => {
      writes += 1;
      return new Response("{}", { status: 429 });
    },
  });
  const denied = await writer.call({
    operation: mutate,
    params: { pathParams: { contactId: "1" } },
    token: "hubspot-token",
    grantedScopes: ["crm.objects.contacts.write"],
  });
  assert.equal(writes, 1);
  assert.equal(denied.status, 429);
});

test("mcp tokens reject a client-supplied subject, the wrong audience, and a bad login", async () => {
  const auth = new McpAuth(authConfig());
  const verifier = "verifier-value";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: "pi",
    redirect_uri: "http://127.0.0.1:9999/callback",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: "http://127.0.0.1:8787/mcp",
  });
  await assert.rejects(() => auth.beginAuthorization(new URLSearchParams([...query.entries(), ["subject", "ada"]])), /subject/);
  const redirect = await authorizedRedirect(auth, query);
  const code = new URL(redirect).searchParams.get("code");
  assert.equal(new URL(redirect).searchParams.get("iss"), "http://127.0.0.1:8787");
  const token = await auth.token(
    new URLSearchParams({ grant_type: "authorization_code", code: code ?? "", client_id: "pi", redirect_uri: "http://127.0.0.1:9999/callback", code_verifier: verifier }),
  );
  const access = String(token.access_token);
  const info = await auth.verifyAccessToken(access);
  assert.equal(info.extra?.subject, "ada");
  await auth.revoke(access);
  await assert.rejects(() => auth.verifyAccessToken(access), /revoked/);
  await assert.rejects(
    () =>
      auth.beginAuthorization(
        new URLSearchParams({
          response_type: "code",
          client_id: "pi",
          redirect_uri: "https://evil.example/callback",
          state: "xyz",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
      ),
    /Redirect/,
  );
  assert.throws(() => auth.login("mallory", password), /Login rejected/);
  const otherIssuer = new McpAuth(authConfig({ issuer: "http://evil.example" }));
  await assert.rejects(() => otherIssuer.verifyAccessToken(access), /Issuer/);
});

test("sensitive properties are omitted and exports are capped", async () => {
  let requested = "";
  const client = new HubSpotClient({
    fetchImpl: async (input) => {
      requested = String(input);
      if (requested.includes("/exports/")) {
        return new Response(JSON.stringify({ results: Array.from({ length: 12 }, (_, index) => index) }), { status: 200 });
      }
      return new Response(JSON.stringify({ properties: { email: "a@example.com", ssn: "123", firstname: "Ada" } }), { status: 200 });
    },
  });
  const readResult = await client.call({
    operation: read,
    params: { pathParams: { contactId: "1" }, query: { properties: "email,ssn,firstname" } },
    token: "hubspot-token",
    grantedScopes: read.scopeGroups.flatMap((group) => group.scopes),
  });
  const properties = (readResult.body as { properties: Record<string, string> }).properties;
  assert.equal(properties.ssn, undefined);
  assert.equal(properties.email, "a@example.com");
  assert.equal(requested.includes("ssn"), false);
  const granted = read.scopeGroups.flatMap((group) => group.scopes);
  let exportCalls = 0;
  const exportClient = new HubSpotClient({
    fetchImpl: async () => {
      exportCalls += 1;
      return new Response(JSON.stringify({ results: Array.from({ length: 12 }, (_, index) => index) }), { status: 200 });
    },
  });
  const exportOperation = { ...read, id: "get-crm-exports-2026-09", path: "/crm/v3/exports/export" };
  await assert.rejects(
    () => exportClient.call({ operation: exportOperation, params: {}, token: "hubspot-token", grantedScopes: granted, followPages: true }),
    /Unbounded export retrieval is disabled/,
  );
  assert.equal(exportCalls, 0);
  const createExport = { ...exportOperation, method: "POST" as const, id: "post-crm-exports-2026-09", path: "/crm/v3/exports" };
  await assert.rejects(
    () => exportClient.call({ operation: createExport, params: { body: {} }, token: "hubspot-token", grantedScopes: granted }),
    /limit of 1 to 10/,
  );
  assert.equal(exportCalls, 0);
});

test("production boot refuses weak secrets and a non-HTTPS issuer", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const strong = "production-auth-secret-with-variety-19";
  const other = "production-approval-secret-variety-28";
  try {
    assert.throws(() => assertProductionSecrets({ authSecret: "auth-secret", approvalSecret: other }), /test signer/);
    assert.throws(() => assertProductionSecrets({ authSecret: "production-auth-secret", approvalSecret: other }), /too weak/);
    assert.throws(
      () => assertProductionSecrets({ authSecret: strong, approvalSecret: other, issuer: "http://127.0.0.1:8787", revocationFile: "data/revocations.json" }),
      /HTTPS/,
    );
    assert.throws(
      () => assertProductionSecrets({ authSecret: strong, approvalSecret: other, issuer: "https://mcp.example" }),
      /revocation file/,
    );
    assert.doesNotThrow(() =>
      assertProductionSecrets({ authSecret: strong, approvalSecret: other, issuer: "https://mcp.example", revocationFile: "data/revocations.json" }),
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("hubspot refresh is single flight and portal mismatches are rejected", async () => {
  resetRefreshLocks();
  let refreshes = 0;
  const store = new TokenStore(randomBytes(32).toString("base64"));
  await store.put("ada:5627913", {
    portalId: "5627913",
    accessToken: "old",
    refreshToken: "refresh-1",
    expiresAt: Date.now() - 1000,
    scopes: ["oauth"],
    userId: "1",
  });
  const config = {
    clientId: "app",
    clientSecret: "secret",
    redirectUri: "http://127.0.0.1/hubspot/oauth/callback",
    expectedPortalId: "5627913",
    tokenStore: store,
    fetchImpl: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/oauth/v1/token")) {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ access_token: "new", refresh_token: "refresh-2", expires_in: 1800 }), { status: 200 });
      }
      return new Response(JSON.stringify({ hub_id: 5627913, scopes: ["oauth", "crm.objects.contacts.read"], user_id: 9 }), { status: 200 });
    },
  };
  const [first, second] = await Promise.all([getValidGrant(config, "ada:5627913"), getValidGrant(config, "ada:5627913")]);
  assert.equal(first.accessToken, "new");
  assert.equal(second.accessToken, "new");
  assert.equal(refreshes, 1);
  await assert.rejects(
    () =>
      exchangeHubSpotCode(
        {
          ...config,
          fetchImpl: async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith("/oauth/v1/token")) return new Response(JSON.stringify({ access_token: "x", refresh_token: "y", expires_in: 10 }), { status: 200 });
            return new Response(JSON.stringify({ hub_id: 1, scopes: [] }), { status: 200 });
          },
        },
        "code",
        "ada:5627913",
      ),
    /portal/,
  );
});

test("token files do not store plaintext HubSpot tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-tokens-"));
  const file = join(dir, "tokens.json");
  const key = randomBytes(32).toString("base64");
  const store = new TokenStore(key, file);
  await store.put("ada:5627913", {
    portalId: "5627913",
    accessToken: "super-secret-access",
    refreshToken: "super-secret-refresh",
    expiresAt: Date.now() + 1000,
    scopes: ["oauth"],
    userId: "1",
  });
  const raw = readFileSync(file, "utf8");
  assert.equal(raw.includes("super-secret-access"), false);
  assert.equal(raw.includes("super-secret-refresh"), false);
  const loaded = new TokenStore(key, file);
  await loaded.load();
  assert.equal(loaded.get("ada:5627913")?.accessToken, "super-secret-access");
});

test("prepare does not call HubSpot and execute requires approval", async () => {
  let calls = 0;
  const mutate = loadOperations().find((operation) => operation.id === "delete-crm-objects-2026-09-contacts-contactid");
  assert.ok(mutate);
  const ctx = {
    actor: "ada",
    clientId: "pi",
    portalId: "5627913",
    operations: new Map([[mutate.id, mutate]]),
    client: new HubSpotClient({
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 200, headers: { "x-hubspot-correlation-id": "corr" } });
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
    approvalSecret: "approval",
  };
  const proposal = await prepareOperation(ctx, mutate.id, { pathParams: { contactId: "42" } });
  assert.equal(calls, 0);
  await assert.rejects(() => executeOperation(ctx, mutate.id, { pathParams: { contactId: "42" } }, "approved-true-is-not-approval"), /approval/i);
  const { approveProposal, resetApprovals } = await import("../src/policy/approval.ts");
  resetApprovals();
  const prepared = await prepareOperation(ctx, mutate.id, { pathParams: { contactId: "42" } });
  const proposalId = (prepared as { proposalId: string }).proposalId;
  const approved = approveProposal({ proposalId, actor: "ada", portalId: "5627913", secret: "approval" });
  const result = await executeOperation(ctx, mutate.id, { pathParams: { contactId: "42" } }, approved.token);
  assert.equal(calls, 1);
  assert.equal((result as { correlationId: string }).correlationId, "corr");
  assert.equal((proposal as { proposalId?: string }).proposalId === undefined, false);
});
