import assert from "node:assert/strict";
import test from "node:test";
import { reviewBlocksTool } from "../src/runtime/agentMode.ts";
import { resolveBoundedTestPath } from "../src/runtime/boundedCheck.ts";
import { planWrites, readReceipt, writeReceipt } from "../src/runtime/receipts.ts";
import { removeRepo, tempRepo } from "./helpers.ts";

test("receipt replay skips succeeded targets and uncertain targets", () => {
  const root = tempRepo();
  const stored = writeReceipt(root, {
    client: "alpha",
    sourceSystem: "notion",
    sourceId: "page-1",
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    targets: [
      { system: "asana", operation: "create_task", id: "task-1", status: "succeeded" },
      { system: "hubspot", operation: "create_note", status: "uncertain" },
    ],
    uncertainty: "HubSpot note outcome was not confirmed.",
  });
  const plan = planWrites(readReceipt(root, "alpha", "notion", "page-1"), [
    { system: "asana", operation: "create_task" },
    { system: "hubspot", operation: "create_note" },
    { system: "hubspot", operation: "create_task" },
  ]);
  assert.equal(plan[0]?.action, "skip");
  assert.equal(plan[1]?.action, "skip");
  assert.match(plan[1]?.reason ?? "", /uncertain/);
  assert.equal(plan[2]?.action, "create");
  assert.equal(stored.targets.length, 2);

  const replayed = writeReceipt(root, {
    ...stored,
    updatedAt: "2026-10-03T01:00:00.000Z",
    targets: [{ system: "asana", operation: "create_task", id: "task-1", status: "failed" }],
  });
  assert.equal(replayed.createdAt, stored.createdAt);
  assert.equal(replayed.targets.find((target) => target.system === "asana")?.status, "failed");
  assert.equal(replayed.targets.find((target) => target.system === "hubspot")?.status, "uncertain");
  removeRepo(root);
});

test("review mode blocks edit, write, and shell, and bounded checks stay inside test files", () => {
  assert.match(reviewBlocksTool("review", "bash") ?? "", /shell/);
  assert.match(reviewBlocksTool("review", "edit") ?? "", /Review mode/);
  assert.equal(reviewBlocksTool("review", "notion_read"), null);
  assert.equal(reviewBlocksTool("review", "hubspot_get_user_details"), null);
  assert.ok(reviewBlocksTool("review", "hubspot_create_note"));
  assert.equal(reviewBlocksTool("implement", "bash"), null);

  const root = tempRepo();
  const profile = {
    name: "Alpha",
    slug: "alpha",
    hubspot: { expectedPortalId: null },
    notion: { databaseIds: {}, pageIds: {}, testPageId: null, outputParent: null },
    asana: { mode: "rest" as const, workspaceGid: null, projectGids: {}, testProjectGid: null },
    researchRoots: [],
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
  };
  assert.throws(() => resolveBoundedTestPath(root, profile, "../outside.test.ts"), /escapes/);
  assert.throws(() => resolveBoundedTestPath(root, profile, "src/index.ts"), /test/);
  removeRepo(root);
});
