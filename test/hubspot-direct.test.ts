import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PolicyError } from "../services/hubspot-api-mcp/src/policy/errors.ts";
import { PORTAL_ID } from "../src/hubspot-direct/constants.ts";
import { DirectRunner } from "../src/hubspot-direct/runner.ts";
import { loadDirectApp } from "../src/hubspot-direct/scopes.ts";

const TOKEN = "test-token-should-not-leak";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(handlers: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const handler = Object.entries(handlers).find(([path]) => url.includes(path))?.[1];
    if (!handler) throw new Error(`Unexpected URL ${url}`);
    return handler();
  }) as typeof fetch;
}

function runner(fetchImpl: typeof fetch, writes: "deny" | "approval" = "deny", now = () => Date.now()): DirectRunner {
  return new DirectRunner({
    token: TOKEN,
    writes,
    fetchImpl,
    approvalFile: join(mkdtempSync(join(tmpdir(), "hubspot-direct-")), "approvals.json"),
    now,
  });
}

test("app config is private static auth without excluded scopes", () => {
  const app = loadDirectApp();
  assert.equal(app.distribution, "private");
  assert.equal(app.authType, "static");
  assert.equal(app.requiredScopes.length, 133);
  assert.equal(new Set(app.requiredScopes).size, 133);
  for (const scope of [
    "crm.objects.custom.read",
    "crm.objects.custom.write",
    "crm.schemas.custom.read",
    "crm.schemas.custom.write",
    "automation",
    "crm.objects.leads.read",
    "crm.objects.leads.write",
    "forms",
    "cms.functions.read",
    "cms.functions.write",
    "crm.objects.products.read",
    "crm.objects.products.write",
    "crm.schemas.tickets.read",
    "crm.schemas.tickets.write",
  ]) {
    assert.equal(app.requiredScopes.includes(scope), true);
  }
  assert.equal(app.requiredScopes.includes("oauth"), true);
  assert.equal(app.requiredScopes.includes("crm.objects.tickets.read"), true);
  assert.equal(app.requiredScopes.includes("crm.objects.tickets.write"), true);
  assert.equal(app.requiredScopes.includes("files.delete"), false);
  assert.equal(app.requiredScopes.includes("commerce.payment_links.delete"), false);
  assert.equal(app.requiredScopes.includes("business_units_view.read"), false);
  assert.equal(app.requiredScopes.includes("crm.objects.feedback_submission.read"), false);
  assert.equal(app.requiredScopes.includes("transactional-email"), false);
  assert.equal(app.requiredScopes.includes("external_integrations.forms.access"), false);
  for (const scope of app.requiredScopes) {
    assert.equal(scope.includes("sensitive"), false);
  }
  const raw = readFileSync(new URL("../hubspot/src/app/app-hsmeta.json", import.meta.url), "utf8");
  assert.equal(raw.includes("redirectUrls"), false);
  assert.equal(raw.includes("support@example.com"), false);
});

test("read-only mode rejects a mutation before HubSpot is called", async () => {
  let called = false;
  const fetchImpl = mockFetch({
    "/": () => {
      called = true;
      return jsonResponse({});
    },
  });
  await assert.rejects(
    () => runner(fetchImpl).prepare("patch-crm-objects-2026-09-contacts-contactid", {
      pathParams: { contactId: "1" },
      body: { properties: { firstname: "Ada" } },
    }),
    (error: unknown) => error instanceof PolicyError && error.code === "policy",
  );
  assert.equal(called, false);
});

test("delete, export, and archive are denied", async () => {
  const fetchImpl = mockFetch({ "/": () => jsonResponse({}) });
  const client = runner(fetchImpl, "approval");
  for (const operationId of [
    "delete-crm-objects-2026-09-contacts-contactid",
    "post-crm-exports-2026-09-export-async",
    "post-cms-blogs-2026-09-authors-batch-archive",
  ]) {
    await assert.rejects(() => client.prepare(operationId, { pathParams: { contactId: "1" }, body: {} }), PolicyError);
  }
});

test("a contact read checks the portal and does not echo the token", async () => {
  const urls: string[] = [];
  const fetchImpl = mockFetch({
    "/account-info/2026-09/details": () => jsonResponse({ portalId: Number(PORTAL_ID) }),
    "/crm/objects/2026-09/contacts/42": () => jsonResponse({ id: "42", properties: { email: "ada@example.com", custom_field: "kept" } }),
  });
  const wrapped: typeof fetch = (async (input, init) => {
    urls.push(String(input));
    const header = new Headers(init?.headers).get("authorization");
    assert.equal(header, `Bearer ${TOKEN}`);
    return fetchImpl(input, init);
  }) as typeof fetch;
  const result = await runner(wrapped).read("get-crm-objects-2026-09-contacts-contactid", {
    pathParams: { contactId: "42" },
    query: { properties: "email,custom_field" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recordUrl, `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-1/42`);
  assert.equal(result.scopeIntrospection, "unavailable");
  assert.deepEqual((result.body as { properties: { custom_field: string } }).properties.custom_field, "kept");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(urls.length, 2);
});

test("a mismatched portal is rejected before the requested read", async () => {
  let contactCalls = 0;
  const fetchImpl = mockFetch({
    "/account-info/2026-09/details": () => jsonResponse({ portalId: 1 }),
    "/crm/objects/2026-09/contacts/42": () => {
      contactCalls += 1;
      return jsonResponse({ id: "42" });
    },
  });
  await assert.rejects(
    () => runner(fetchImpl).read("get-crm-objects-2026-09-contacts-contactid", { pathParams: { contactId: "42" } }),
    /not 5627913/,
  );
  assert.equal(contactCalls, 0);
});

test("writes require the stored proposal and reject replay or a changed payload", async () => {
  let now = 1_000;
  const calls: string[] = [];
  const fetchImpl = mockFetch({
    "/account-info/2026-09/details": () => jsonResponse({ portalId: Number(PORTAL_ID) }),
    "/crm/objects/2026-09/contacts/42": () => {
      calls.push("patch");
      return jsonResponse({ id: "42", properties: { firstname: "Ada" } });
    },
  });
  const client = runner(fetchImpl, "approval", () => now);
  const params = { pathParams: { contactId: "42" }, body: { properties: { firstname: "Ada" } } };
  const proposal = await client.prepare("patch-crm-objects-2026-09-contacts-contactid", params);
  await assert.rejects(() => client.execute(proposal.id), /not active/);
  client.approve(proposal.id);
  const executed = await client.execute(proposal.id);
  assert.equal(executed.ok, true);
  assert.equal(calls.length, 1);
  await assert.rejects(() => client.execute(proposal.id), PolicyError);

  const second = await client.prepare("patch-crm-objects-2026-09-contacts-contactid", params);
  const file = (client as unknown as { store: { file: string } }).store["file"] as string;
  const stored = JSON.parse(readFileSync(file, "utf8")) as { id: string; body: unknown }[];
  const row = stored.find((item) => item.id === second.id);
  assert.ok(row);
  row.body = { properties: { firstname: "Changed" } };
  writeFileSync(file, JSON.stringify(stored));
  client.approve(second.id);
  await assert.rejects(() => client.execute(second.id), /payload/);

  now = 1_000 + 11 * 60 * 1000;
  const stale = await client.prepare("patch-crm-objects-2026-09-contacts-contactid", params);
  now = stale.expiresAt + 1;
  assert.throws(() => client.approve(stale.id), /expired/);
});
