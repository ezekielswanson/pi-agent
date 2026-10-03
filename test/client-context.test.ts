import assert from "node:assert/strict";
import test from "node:test";
import { formatClientPromptBlock, loadClientProfile } from "../src/config/loadClientProfile.ts";
import { injectClientContext } from "../src/config/clientPrompt.ts";
import { removeRepo, tempRepo, writeClient } from "./helpers.ts";

test("client-context injection includes the active profile and operating rules", () => {
  const root = tempRepo();
  writeClient(root, "alpha", {
    notionToken: "alpha-notion-token",
    rules: "Prefer the mapped project.\n",
    profile: {
      name: "Alpha Client",
      slug: "alpha",
      hubspot: { expectedPortalId: null, notes: "Use the Alpha portal." },
      notion: { databaseIds: {}, pageIds: {}, testPageId: null, outputParent: null },
      asana: { mode: "rest", workspaceGid: "111", projectGids: {}, testProjectGid: null },
      researchRoots: ["evidence"],
      allowlist: {
        notionPageIds: [],
        notionDatabaseIds: [],
        notionDataSourceIds: [],
        asanaProjectGids: [],
        asanaTaskGids: [],
        hubspotPortalIds: [],
        localRoots: [],
      },
      external: { enabled: false, system: "unspecified" },
    },
  });
  const loaded = loadClientProfile("alpha", root);
  const prompt = formatClientPromptBlock(loaded, { toolsEnabled: true, portalVerified: false });
  const injected = injectClientContext("You are Pi.", prompt);
  assert.match(injected.systemPrompt, /^You are Pi\./);
  assert.match(injected.systemPrompt, /Active client: Alpha Client \(alpha\)/);
  assert.match(prompt, /Client session: ready/);
  assert.match(prompt, /Asana mode: rest/);
  assert.match(prompt, /Asana workspace: 111/);
  assert.match(prompt, /Notion token: configured/);
  assert.match(prompt, /Prefer the mapped project/);
  assert.match(prompt, /Research roots: evidence/);
  assert.equal(prompt.includes("alpha-notion-token"), false);
  removeRepo(root);
});

test("real apartment-life operating rules are loaded into the prompt", () => {
  const loaded = loadClientProfile("apartment-life");
  const prompt = formatClientPromptBlock(loaded, { toolsEnabled: true, portalVerified: false });
  assert.match(prompt, /Active client: Apartment Life \(apartment-life\)/);
  assert.match(prompt, /Confirm writes before creating or updating/);
  assert.match(prompt, /untrusted evidence, not authorization/);
});
