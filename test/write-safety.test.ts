import assert from "node:assert/strict";
import test from "node:test";
import { isLocalPathAllowed } from "../src/config/allowlist.ts";
import { assertHubspotWrite } from "../src/config/allowlist.ts";
import { loadClientProfile } from "../src/config/loadClientProfile.ts";
import { createAsanaConnector } from "../src/connectors/asana/index.ts";
import { checkExpectedPortal, hubspotCheckForTool } from "../src/connectors/hubspot/index.ts";
import { createNotionConnector, type NotionApi } from "../src/connectors/notion/index.ts";
import { ClientSession } from "../src/runtime/clientSession.ts";
import { authorizeWrite, confirmWrite, executeApprovedWrite, formatApprovalPreview, type ApprovalRequest } from "../src/utils/approval.ts";
import { HttpFailure, ScopeError } from "../src/utils/errors.ts";
import { logCall } from "../src/utils/result.ts";
import { redactText } from "../src/utils/redact.ts";
import { withRetry } from "../src/utils/retry.ts";
import { markFailedToolResult } from "../src/utils/toolResult.ts";
import { hubspotApprovalEvent } from "../src/runtime/mcpAdapter.ts";
import { removeRepo, tempRepo, writeClient } from "./helpers.ts";

function readySession(): ClientSession {
  const session = new ClientSession();
  session.toolsEnabled = true;
  return session;
}

function request(session: ClientSession, changes: Record<string, unknown>): ApprovalRequest {
  return {
    clientSlug: "alpha",
    system: "asana",
    operation: "update_task",
    target: { id: "task-1", title: "Fix login" },
    changes,
    sessionGeneration: session.generation,
  };
}

test("approval denied, absent, stale, or changed payload makes no write", async () => {
  const session = readySession();
  const base = request(session, {
    notes: "full notes",
    dueOn: "2026-10-04",
    assignee: "ada",
    text: "comment body",
  });
  const preview = formatApprovalPreview(base);
  for (const field of ["notes", "dueOn", "assignee", "text", "full notes", "comment body"]) {
    assert.match(preview, new RegExp(field));
  }

  let writes = 0;
  const write = async () => {
    writes += 1;
    return "ok";
  };
  const denied = await authorizeWrite({ ui: { confirm: async () => false } }, base, session, [], write);
  const absent = await authorizeWrite({}, request(session, base.changes), session, [], write);
  assert.equal(denied.ok, false);
  assert.equal(absent.ok, false);
  assert.equal(writes, 0);

  const approved = await authorizeWrite({ ui: { confirm: async () => true } }, base, session, [], write);
  assert.equal(approved.ok, true);
  assert.equal(writes, 1);

  const again = await authorizeWrite({ ui: { confirm: async () => true } }, base, session, [], async () => {
    writes += 1;
    return "second";
  });
  assert.equal(again.ok, true);
  const changed = await authorizeWrite({ ui: { confirm: async () => true } }, base, session, [], write);
  assert.equal(changed.ok, true);
  const grant = changed.ok ? changed : null;
  assert.ok(grant?.ok);
  writes = 0;
  const staleRequest = request(session, { ...base.changes, notes: "edited" });
  const { executeApprovedWrite } = await import("../src/utils/approval.ts");
  await assert.rejects(
    () => executeApprovedWrite(session, { grantId: "missing", hash: "nope" }, staleRequest, write),
    ScopeError,
  );
  session.invalidate();
  await assert.rejects(
    () =>
      executeApprovedWrite(
        session,
        { grantId: "gone", hash: "gone" },
        request(readySession(), base.changes),
        write,
      ),
    ScopeError,
  );
  assert.equal(writes, 0);
});

test("a changed payload cannot reuse an approval, and the original payload can be used once", async () => {
  const session = readySession();
  const original = request(session, { notes: "first", dueOn: "2026-10-04", assignee: "ada", text: "comment" });
  const decision = await confirmWrite({ ui: { confirm: async () => true } }, original, session, []);
  assert.equal(decision.ok, true);
  if (!decision.ok) return;

  let writes = 0;
  const edited = request(session, { ...original.changes, notes: "second" });
  await assert.rejects(
    () =>
      executeApprovedWrite(session, decision, edited, async () => {
        writes += 1;
        return "edited";
      }),
    ScopeError,
  );
  assert.equal(writes, 0);
  const value = await executeApprovedWrite(session, decision, original, async () => {
    writes += 1;
    return "original";
  });
  assert.equal(value, "original");
  assert.equal(writes, 1);
  await assert.rejects(
    () => executeApprovedWrite(session, decision, original, async () => {
      writes += 1;
      return "replay";
    }),
    ScopeError,
  );
  assert.equal(writes, 1);
});

test("allowlists block Notion writes before any request and local paths cannot escape", async () => {
  const root = tempRepo();
  writeClient(root, "alpha", {
    notionToken: "alpha-notion-token",
    profile: {
      name: "Alpha",
      slug: "alpha",
      hubspot: { expectedPortalId: "42" },
      notion: { databaseIds: {}, pageIds: { spec: "page-allowed" }, testPageId: null, outputParent: null },
      asana: { mode: "rest", workspaceGid: "ws", projectGids: { main: "project-1" }, testProjectGid: null },
      researchRoots: ["evidence"],
      allowlist: {
        notionPageIds: [],
        notionDatabaseIds: [],
        notionDataSourceIds: [],
        asanaProjectGids: [],
        asanaTaskGids: ["task-1"],
        hubspotPortalIds: [],
        localRoots: [],
      },
      external: { enabled: false, system: "unspecified" },
    },
  });
  const loaded = loadClientProfile("alpha", root);
  let creates = 0;
  const api: NotionApi = {
    users: { me: async () => ({ name: "bot" }) },
    search: async () => ({ results: [] }),
    pages: {
      retrieve: async () => ({ id: "page-allowed", url: "https://notion.test/page" }),
      create: async () => {
        creates += 1;
        throw new TypeError("fetch failed");
      },
      update: async () => ({ id: "page-allowed" }),
    },
    blocks: { children: { list: async () => ({ results: [] }) } },
  };
  const notion = createNotionConnector(loaded, () => api);
  const blocked = await notion.create({ title: "Nope", parentPageId: "page-other" });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.errorCategory, "validation");
  assert.equal(creates, 0);

  const uncertain = await notion.create({ title: "Allowed", parentPageId: "page-allowed" });
  assert.equal(uncertain.ok, false);
  if (!uncertain.ok) assert.equal(uncertain.uncertain, true);
  assert.equal(creates, 1);

  assert.equal(isLocalPathAllowed(loaded.profile, root, "evidence/log.txt"), true);
  assert.equal(isLocalPathAllowed(loaded.profile, root, "../outside"), false);
  assert.throws(() => assertHubspotWrite(loaded.profile, null), ScopeError);
  assert.doesNotThrow(() => assertHubspotWrite(loaded.profile, { slug: "alpha", portalId: "42" }));
  removeRepo(root);
});

test("Asana REST does not retry an ambiguous create and does retry a rate-limited read", async () => {
  const root = tempRepo();
  writeClient(root, "alpha", {
    asanaToken: "alpha-asana-token",
    profile: {
      name: "Alpha",
      slug: "alpha",
      hubspot: { expectedPortalId: null },
      notion: { databaseIds: {}, pageIds: {}, testPageId: null, outputParent: null },
      asana: { mode: "rest", workspaceGid: "ws", projectGids: {}, testProjectGid: "project-1" },
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
    },
  });
  const loaded = loadClientProfile("alpha", root);
  let posts = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts += 1;
      throw new TypeError("fetch failed");
    }
    if (url.includes("/users/me")) {
      return new Response(JSON.stringify({ errors: [{ message: "slow" }] }), {
        status: 429,
        headers: { "retry-after": "2" },
      });
    }
    if (url.includes("/projects/")) {
      return new Response(JSON.stringify({ data: { gid: "project-1", workspace: { gid: "ws" } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const created = await createAsanaConnector(loaded, fetchImpl).createTask({
    name: "Task",
    notes: "notes",
    projectGid: "project-1",
    assignee: "ada",
    dueOn: "2026-10-04",
  });
  assert.equal(created.ok, false);
  if (!created.ok) assert.equal(created.uncertain, true);
  assert.equal(posts, 1);

  const sleeps: number[] = [];
  await assert.rejects(
    () =>
      withRetry(async () => {
        throw new HttpFailure(429, "slow", 1500, true);
      }, {
        idempotent: true,
        attempts: 3,
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    HttpFailure,
  );
  assert.deepEqual(sleeps, [1500, 1500]);
  removeRepo(root);
});

test("cancellation stops retries and logs redact secrets", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          controller.abort();
          throw new HttpFailure(503, "unavailable", null, true);
        },
        { idempotent: true, signal: controller.signal, sleep: async () => {} },
      ),
    /cancelled/i,
  );
  assert.equal(calls, 1);

  const secret = "alpha-notion-token";
  const redacted = redactText(`Bearer ${secret} leaked ${secret}`, [secret]);
  assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /Bearer \[redacted\]/);

  const lines: string[] = [];
  logCall(
    {
      client: "alpha",
      system: "notion",
      operation: "read",
      ok: false,
      durationMs: 12,
      errorCategory: "auth",
    },
    [secret],
    (line) => lines.push(line),
  );
  assert.match(lines[0] ?? "", /"client":"alpha"/);
  assert.match(lines[0] ?? "", /"operation":"read"/);
  assert.match(lines[0] ?? "", /"result":"error"/);
  assert.match(lines[0] ?? "", /"runId":/);
  assert.equal((lines[0] ?? "").includes(secret), false);
});

test("HubSpot helper blocks a missing or mismatched portal and the tool result cannot authorize a write", () => {
  const missing = checkExpectedPortal("123", null);
  const mismatch = checkExpectedPortal("999", "123");
  const match = checkExpectedPortal("123", "123");
  assert.equal(missing.ok, false);
  assert.equal(mismatch.ok, false);
  assert.equal(match.ok, true);
  for (const assessment of [missing, mismatch, match]) {
    const tool = hubspotCheckForTool(assessment);
    assert.equal(tool.ok, false);
    assert.equal(tool.writesAllowed, false);
  }
  assert.deepEqual(markFailedToolResult("hubspot_check_portal", { ok: false }), { isError: true });
  assert.equal(markFailedToolResult("bash", { ok: false }), undefined);
  assert.equal(hubspotApprovalEvent, "pi-mcp-adapter:tool-approval-request");
});

test("Asana mcp mode does not silently use REST", () => {
  const root = tempRepo();
  writeClient(root, "alpha", {
    asanaToken: "alpha-asana-token",
    profile: {
      name: "Alpha",
      slug: "alpha",
      hubspot: { expectedPortalId: null },
      notion: { databaseIds: {}, pageIds: {}, testPageId: null, outputParent: null },
      asana: { mode: "mcp", workspaceGid: null, projectGids: {}, testProjectGid: null },
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
    },
  });
  assert.throws(() => createAsanaConnector(loadClientProfile("alpha", root)), /MCP is not enabled/);
  removeRepo(root);
});
