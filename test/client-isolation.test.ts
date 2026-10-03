import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getActiveClientSlug, setActiveClientSlug } from "../src/config/activeClient.ts";
import { credentialFor } from "../src/config/loadEnv.ts";
import { loadClientProfile } from "../src/config/loadClientProfile.ts";
import { createAsanaConnector } from "../src/connectors/asana/index.ts";
import { createExternalConnector } from "../src/connectors/external/index.ts";
import { createNotionConnector } from "../src/connectors/notion/index.ts";
import { applySessionStart, ClientSession, getClientSession, readSessionPhase } from "../src/runtime/clientSession.ts";
import { removeRepo, runSwitch, tempRepo, withEnv, writeClient } from "./helpers.ts";

function fakeNotion() {
  return {
    users: { me: async () => ({ name: "bot" }) },
    search: async () => ({ results: [] }),
    pages: {
      retrieve: async () => ({}),
      create: async () => ({}),
      update: async () => ({}),
    },
    blocks: { children: { list: async () => ({ results: [] }) } },
  };
}

test("real client profiles keep optidge empty and apartment-life limited to supplied ids", () => {
  const apartment = loadClientProfile("apartment-life");
  assert.equal(apartment.profile.asana.mode, "rest");
  assert.equal(apartment.profile.external.enabled, false);
  assert.equal(apartment.profile.hubspot.expectedPortalId, 5627913);
  assert.equal(apartment.profile.notion.testPageId, "3eebf244-9e83-8009-be9a-ffc30d0f09e9");
  assert.deepEqual(apartment.profile.notion.outputParent, {
    type: "page",
    id: "3eebf244-9e83-80b0-860e-f1c8ce7e6b23",
  });
  assert.deepEqual(apartment.profile.allowlist.notionPageIds, [
    "3eebf244-9e83-8009-be9a-ffc30d0f09e9",
    "3eebf244-9e83-80b0-860e-f1c8ce7e6b23",
  ]);
  assert.equal(apartment.profile.asana.workspaceGid, "4486534842270");
  assert.equal(apartment.profile.asana.testProjectGid, "1202368925633889");
  assert.deepEqual(apartment.profile.allowlist.asanaProjectGids, ["1202368925633889"]);

  const optidge = loadClientProfile("optidge");
  assert.equal(optidge.profile.asana.mode, "rest");
  assert.equal(optidge.profile.external.enabled, false);
  assert.equal(optidge.profile.hubspot.expectedPortalId, null);
  assert.equal(optidge.profile.notion.testPageId, null);
  assert.equal(optidge.profile.notion.outputParent, null);
  assert.equal(optidge.profile.asana.workspaceGid, null);
  assert.equal(optidge.profile.asana.testProjectGid, null);
  assert.equal(optidge.secrets.notionToken, null);
  assert.equal(optidge.secrets.asanaToken, null);
});

test("client A credentials are not visible to client B, including root env", async () => {
  const root = tempRepo();
  await withEnv({ PI_CLIENT: undefined, NOTION_TOKEN: "root-notion-token", ASANA_ACCESS_TOKEN: "root-asana-token" }, async () => {
    writeClient(root, "alpha", { notionToken: "alpha-notion-token", asanaToken: "alpha-asana-token" });
    writeClient(root, "beta");
    writeFileSync(join(root, ".env"), "NOTION_TOKEN=root-file-notion-token\nASANA_ACCESS_TOKEN=root-file-asana-token\n");

    const alpha = loadClientProfile("alpha", root);
    const beta = loadClientProfile("beta", root);
    assert.equal(alpha.secrets.notionToken, "alpha-notion-token");
    assert.equal(alpha.secrets.asanaToken, "alpha-asana-token");
    assert.equal(beta.secrets.notionToken, null);
    assert.equal(beta.secrets.asanaToken, null);
    assert.equal(process.env.NOTION_TOKEN, "root-notion-token");

    const seen: string[] = [];
    createNotionConnector(alpha, (token) => {
      seen.push(token);
      return fakeNotion();
    });
    assert.deepEqual(seen, ["alpha-notion-token"]);
    assert.throws(() => createNotionConnector(beta, () => fakeNotion()), /notion credentials are not set/);
    assert.equal(credentialFor(alpha.secrets, "asana"), "alpha-asana-token");
    assert.throws(() => credentialFor(beta.secrets, "asana"), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message.includes("root-asana-token"), false);
      assert.equal(err.message.includes("alpha-asana-token"), false);
      return true;
    });
  });
  removeRepo(root);
});

test("Asana connector uses the selected client token and ignores process env", async () => {
  const root = tempRepo();
  await withEnv({ ASANA_ACCESS_TOKEN: "env-asana-token" }, async () => {
    writeClient(root, "alpha", { asanaToken: "alpha-asana-token" });
    writeClient(root, "beta", { asanaToken: "beta-asana-token" });
    const headers: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      headers.push(auth);
      return new Response(JSON.stringify({ data: { name: "tester" } }), { status: 200 });
    };
    await createAsanaConnector(loadClientProfile("alpha", root), fetchImpl).health();
    await createAsanaConnector(loadClientProfile("beta", root), fetchImpl).health();
    assert.deepEqual(headers, ["Bearer alpha-asana-token", "Bearer beta-asana-token"]);
  });
  removeRepo(root);
});

test("external connector does not inherit a root API key", async () => {
  const root = tempRepo();
  await withEnv({ EXTERNAL_API_KEY: "root-external-key" }, async () => {
    writeClient(root, "beta");
    const result = await createExternalConnector(loadClientProfile("beta", root)).read("status");
    assert.equal(JSON.stringify(result).includes("root-external-key"), false);
    assert.equal(result.ok, true);
  });
  removeRepo(root);
});

test("unknown client and invalid profile do not change the active client", async () => {
  const root = tempRepo();
  await withEnv({ PI_CLIENT: undefined }, async () => {
    writeClient(root, "alpha");
    setActiveClientSlug("alpha", root);
    const session = new ClientSession();
    const missing = await runSwitch(root, session, "missing");
    assert.equal(missing.result.ok, false);
    if (!missing.result.ok) assert.equal(missing.result.reason, "invalid");
    assert.equal(missing.result.toolsDisabled, false);
    assert.equal(missing.disabled, 0);
    assert.equal(getActiveClientSlug(root), "alpha");
    assert.equal(readSessionPhase(root).phase, "idle");

    writeClient(root, "broken", { profile: { slug: "broken", asana: { mode: "sometimes" } } });
    const invalid = await runSwitch(root, session, "broken");
    assert.equal(invalid.result.ok, false);
    assert.equal(getActiveClientSlug(root), "alpha");
    assert.equal(session.generation, 0);
  });
  removeRepo(root);
});

test("client switch is transactional and a failed fresh session leaves tools disabled", async () => {
  const root = tempRepo();
  await withEnv({ PI_CLIENT: "alpha" }, async () => {
    writeClient(root, "alpha");
    writeClient(root, "beta");
    setActiveClientSlug("alpha", root);
    const session = new ClientSession();
    session.verifiedPortal = { slug: "alpha", portalId: "1", connectionId: "conn" };
    session.toolsEnabled = true;
    session.rememberGrant("hash");

    const cancelled = await runSwitch(root, session, "beta", "cancel");
    assert.equal(cancelled.result.ok, false);
    if (!cancelled.result.ok) {
      assert.equal(cancelled.result.reason, "transition_failed");
      assert.equal(cancelled.result.toolsDisabled, true);
    }
    assert.equal(cancelled.disabled, 1);
    assert.equal(getActiveClientSlug(root), "alpha");
    assert.equal(session.toolsEnabled, false);
    assert.equal(session.verifiedPortal, null);
    assert.equal(readSessionPhase(root).phase, "failed");

    session.toolsEnabled = true;
    const ready = await runSwitch(root, session, "beta", "ready");
    assert.equal(ready.result.ok, true);
    assert.equal(getActiveClientSlug(root), "beta");
    assert.equal(session.toolsEnabled, true);
    assert.equal(readSessionPhase(root).phase, "ready");
    assert.equal(ready.toolsCleared, 0);
  });
  removeRepo(root);
});

test("in-flight tools and approvals block a client switch", async () => {
  const root = tempRepo();
  await withEnv({ PI_CLIENT: "alpha" }, async () => {
    writeClient(root, "alpha");
    writeClient(root, "beta");
    setActiveClientSlug("alpha", root);
    const session = new ClientSession();
    session.beginTool("tool-1");
    const busy = await runSwitch(root, session, "beta");
    assert.equal(busy.result.ok, false);
    if (!busy.result.ok) assert.equal(busy.result.reason, "busy");
    assert.equal(getActiveClientSlug(root), "alpha");
    session.endTool("tool-1");
    session.beginApproval();
    const pending = await runSwitch(root, session, "beta");
    assert.equal(pending.result.ok, false);
    session.endApproval();
  });
  removeRepo(root);
});

test("startup and resume do not enable tools for a previous ready session", () => {
  const root = tempRepo();
  writeClient(root, "alpha");
  setActiveClientSlug("alpha", root);
  const session = new ClientSession();
  session.toolsEnabled = true;
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "client-session.json"), `${JSON.stringify({ phase: "ready", slug: "alpha" })}\n`);
  applySessionStart("startup", {
    repoRoot: root,
    session,
    activeSlug: "alpha",
    setActiveTools: (names: string[]) => {
      assert.deepEqual(names, []);
    },
  });
  assert.equal(session.toolsEnabled, false);
  assert.equal(readSessionPhase(root).phase, "idle");
  removeRepo(root);
});

test("connector tools and /client share one process session", () => {
  const session = getClientSession();
  session.toolsEnabled = true;
  assert.equal(getClientSession(), session);
  assert.equal(getClientSession().toolsEnabled, true);
  session.toolsEnabled = false;
});
