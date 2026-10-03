import assert from "node:assert/strict";
import test from "node:test";
import { createAsanaConnector } from "../src/connectors/asana/index.ts";
import { collectBlockText, paragraphBlocks } from "../src/connectors/notion/blocks.ts";
import { createNotionConnector, type NotionApi } from "../src/connectors/notion/index.ts";
import { loadClientProfile } from "../src/config/loadClientProfile.ts";
import { removeRepo, tempRepo, writeClient } from "./helpers.ts";

function notionProfile(root: string) {
  writeClient(root, "alpha", {
    notionToken: "notion-token",
    asanaToken: "asana-token",
    profile: {
      name: "Alpha",
      slug: "alpha",
      hubspot: { expectedPortalId: null },
      notion: { databaseIds: {}, pageIds: { notes: "page-1" }, testPageId: null, outputParent: null },
      asana: { mode: "rest", workspaceGid: "ws-1", projectGids: {}, testProjectGid: "project-1" },
      researchRoots: [],
      allowlist: {
        notionPageIds: [],
        notionDatabaseIds: ["db-1"],
        notionDataSourceIds: [],
        asanaProjectGids: ["other"],
        asanaTaskGids: ["task-1"],
        hubspotPortalIds: [],
        localRoots: [],
      },
      external: { enabled: false, system: "unspecified" },
    },
  });
  return loadClientProfile("alpha", root);
}

test("Notion pagination stays partial when a page is truncated and complete when cursors finish", async () => {
  const truncated = await collectBlockText(
    async () => ({
      results: [{ id: "b1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "one" }] }, has_children: false }],
      has_more: true,
      next_cursor: "cursor-2",
    }),
    "page-1",
    undefined,
    { maxDepth: 3, maxBlocks: 1, maxChars: 100, pageSize: 1 },
  );
  assert.equal(truncated.completeness, "partial");
  assert.equal(truncated.continuation?.cursor, "cursor-2");
  assert.notEqual(truncated.completeness, "complete");

  const controller = new AbortController();
  await assert.rejects(
    () =>
      collectBlockText(
        async () => {
          controller.abort();
          return { results: [], has_more: true, next_cursor: "more" };
        },
        "page-1",
        controller.signal,
      ),
    /cancelled|Abort/i,
  );

  const nested = await collectBlockText(async (blockId) => {
    if (blockId === "page-1") {
      return {
        results: [
          { id: "child", type: "paragraph", paragraph: { rich_text: [{ plain_text: "child" }] }, has_children: true },
        ],
        has_more: false,
      };
    }
    return {
      results: [{ id: "leaf", type: "paragraph", paragraph: { rich_text: [{ plain_text: "leaf" }] }, has_children: false }],
      has_more: false,
    };
  }, "page-1", undefined, { maxDepth: 0, maxBlocks: 10, maxChars: 100, pageSize: 50 });
  assert.equal(nested.completeness, "partial");
  assert.match(nested.reason ?? "", /depth/);
});

test("Notion create discovers the title property and sends a body", async () => {
  const root = tempRepo();
  const loaded = notionProfile(root);
  let created: Record<string, unknown> | undefined;
  const api: NotionApi = {
    users: { me: async () => ({ name: "bot" }) },
    search: async () => ({ results: [] }),
    databases: {
      retrieve: async () => ({ properties: { Status: { type: "select" }, Task: { type: "title" } } }),
    },
    pages: {
      retrieve: async () => ({ id: "page-1", url: "https://notion.test/page-1", properties: {} }),
      create: async (args) => {
        created = args as Record<string, unknown>;
        return { id: "created", url: "https://notion.test/created", properties: { Task: { type: "title" } } };
      },
      update: async (args) => args,
    },
    blocks: { children: { list: async () => ({ results: [], has_more: false }) } },
  };
  const result = await createNotionConnector(loaded, () => api).create({
    title: "Hello",
    body: "Body text",
    parentDatabaseId: "db-1",
  });
  assert.equal(result.ok, true);
  const properties = created?.properties as Record<string, unknown>;
  assert.ok(properties.Task);
  assert.equal(properties.Name, undefined);
  const children = created?.children as unknown[];
  assert.equal(children.length, 1);
  assert.throws(() => paragraphBlocks("x".repeat(2000 * 21)), /block cap/);
  removeRepo(root);
});

test("Notion read follows cursors and does not mark a short page partial", async () => {
  const root = tempRepo();
  const loaded = notionProfile(root);
  const cursors: Array<string | undefined> = [];
  const api: NotionApi = {
    users: { me: async () => ({}) },
    search: async () => ({ results: [] }),
    pages: {
      retrieve: async () => ({
        id: "page-1",
        url: "https://notion.test/page-1",
        properties: { Name: { type: "title", title: [{ plain_text: "Notes" }] } },
      }),
      create: async () => ({}),
      update: async () => ({}),
    },
    blocks: {
      children: {
        list: async (args) => {
          cursors.push(args.start_cursor);
          if (!args.start_cursor) {
            return {
              results: [{ id: "a", type: "paragraph", paragraph: { rich_text: [{ plain_text: "first" }] } }],
              has_more: true,
              next_cursor: "next",
            };
          }
          return {
            results: [{ id: "b", type: "paragraph", paragraph: { rich_text: [{ plain_text: "second" }] } }],
            has_more: false,
          };
        },
      },
    },
  };
  const result = await createNotionConnector(loaded, () => api).read("page-1");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.completeness, "complete");
    assert.equal(result.data.text, "first\nsecond");
    assert.equal(result.data.page.title, "Notes");
    assert.equal(typeof result.data.page.retrievedAt, "string");
    assert.deepEqual(result.links, ["https://notion.test/page-1"]);
  }
  assert.deepEqual(cursors, [undefined, "next"]);
  removeRepo(root);
});

test("Asana REST checks workspace membership and serializes task fields", async () => {
  const root = tempRepo();
  const loaded = notionProfile(root);
  const calls: Array<{ url: string; body?: { data?: Record<string, string> } }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as { data?: Record<string, string> }) : undefined;
    calls.push({ url, body });
    if (url.includes("/projects/other")) {
      return new Response(JSON.stringify({ data: { gid: "other", workspace: { gid: "elsewhere" } } }), { status: 200 });
    }
    if (url.includes("/projects/")) {
      return new Response(JSON.stringify({ data: { gid: "project-1", workspace: { gid: "ws-1" } } }), { status: 200 });
    }
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ data: { gid: "task-new", name: "Task" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const asana = createAsanaConnector(loaded, fetchImpl);
  const blocked = await asana.createTask({ name: "Nope", projectGid: "other" });
  assert.equal(blocked.ok, false);
  assert.equal(calls.some((call) => call.body), false);

  const created = await asana.createTask({
    name: "Task",
    notes: "details",
    projectGid: "project-1",
    assignee: "ada",
    dueOn: "2026-10-04",
  });
  assert.equal(created.ok, true);
  const data = calls.find((call) => call.body)?.body?.data;
  assert.ok(data);
  assert.equal(data.name, "Task");
  assert.equal(data.notes, "details");
  assert.equal(data.assignee, "ada");
  assert.equal(data.due_on, "2026-10-04");

  const found = await asana.find({ query: "budget" });
  assert.equal(found.ok, true);
  if (found.ok) assert.equal(found.data.truncated, false);
  assert.equal(createAsanaConnector.length > 0, true);
  await assert.rejects(() => Promise.resolve().then(() => createAsanaConnector({ ...loaded, profile: { ...loaded.profile, asana: { ...loaded.profile.asana, mode: "mcp" } } })), /not enabled/);
  removeRepo(root);
});
