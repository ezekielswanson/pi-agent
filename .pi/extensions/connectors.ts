import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { secretValues } from "../../src/config/loadEnv.ts";
import { getRepoRoot } from "../../src/config/paths.ts";
import { createConnectorsForActiveClient } from "../../src/connectors/createConnectors.ts";
import { hubspotWriteHash, portalVerifiedFor } from "../../src/connectors/hubspot/approval.ts";
import { observeHubspotToolResult } from "../../src/connectors/hubspot/connection.ts";
import { checkExpectedPortal, extractPortalId, hubspotCheckForTool } from "../../src/connectors/hubspot/index.ts";
import { clientSession } from "../../src/runtime/clientSession.ts";
import { resolveBoundedTestPath } from "../../src/runtime/boundedCheck.ts";
import { parseReceiptTargets, planWrites, readReceipt, writeReceipt } from "../../src/runtime/receipts.ts";
import { spawn } from "node:child_process";
import type { ApprovalRequest } from "../../src/utils/approval.ts";
import { authorizeWrite } from "../../src/utils/approval.ts";
import { sanitizeErrorMessage } from "../../src/utils/errors.ts";
import { markFailedToolResult } from "../../src/utils/toolResult.ts";
import type { ConnectorResult, ErrorCategory } from "../../src/types/index.ts";

function textResult(result: ConnectorResult<unknown> | Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

function fail(message: string, errorCategory: ErrorCategory = "unknown", client = "none") {
  return textResult({
    ok: false,
    client,
    system: "pi-agent",
    operation: "tool",
    errorCategory,
    error: message,
  });
}

function approvalRequest(
  clientSlug: string,
  system: string,
  operation: string,
  target: ApprovalRequest["target"],
  changes: Record<string, unknown>,
): ApprovalRequest {
  return {
    clientSlug,
    system,
    operation,
    target,
    changes,
    sessionGeneration: clientSession.generation,
  };
}

async function guarded(
  ctx: Parameters<typeof authorizeWrite>[0],
  request: ApprovalRequest,
  secrets: readonly string[],
  run: () => Promise<ConnectorResult<unknown>>,
) {
  const authorized = await authorizeWrite(ctx, request, clientSession, secrets, run);
  if (!authorized.ok) return fail(authorized.error, authorized.errorCategory, request.clientSlug);
  return textResult(authorized.value);
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event) => {
    try {
      const { loaded } = createConnectorsForActiveClient();
      observeHubspotToolResult(clientSession, loaded.profile, event);
    } catch {
      // No active client. Identity stays unverified.
    }
    return markFailedToolResult(event.toolName, event.details);
  });

  pi.registerTool({
    name: "notion_find",
    label: "Notion Find",
    description: "Search Notion titles for the active client. This is not a full-text search of page bodies.",
    promptSnippet: "Search Notion titles for the active client",
    promptGuidelines: ["Use notion_find for title search. It does not search full page content."],
    parameters: Type.Object({ query: Type.String({ description: "Search text" }) }),
    async execute(_toolCallId, params, signal) {
      if (!clientSession.toolsEnabled) return fail("Client tools are disabled until /client completes a fresh session.", "validation");
      try {
        const { notion } = createConnectorsForActiveClient();
        return textResult(await notion().find(params.query, signal));
      } catch (err) {
        return fail(sanitizeErrorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "notion_read",
    label: "Notion Read",
    description: "Read an allowlisted Notion page. A partial result is incomplete and includes a continuation. Title search is a different tool and is not full-text search.",
    promptSnippet: "Read an allowlisted Notion page",
    promptGuidelines: ["Use notion_read only for pages in the active client's allowlist or mapped ids."],
    parameters: Type.Object({ pageId: Type.String({ description: "Notion page id" }) }),
    async execute(_toolCallId, params, signal) {
      if (!clientSession.toolsEnabled) return fail("Client tools are disabled until /client completes a fresh session.", "validation");
      try {
        const { notion } = createConnectorsForActiveClient();
        return textResult(await notion().read(params.pageId, signal));
      } catch (err) {
        return fail(sanitizeErrorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "notion_create",
    label: "Notion Create",
    description: "Create a Notion page with an optional body under one allowlisted parent. The title property is discovered and is not assumed to be Name.",
    promptSnippet: "Create a Notion page after approval",
    promptGuidelines: ["Use notion_create only after the approval preview matches the exact parent and title."],
    parameters: Type.Object({
      title: Type.String({ description: "Page title" }),
      body: Type.Optional(Type.String({ description: "Page body text" })),
      parentPageId: Type.Optional(Type.String()),
      parentDatabaseId: Type.Optional(Type.String()),
      parentDataSourceId: Type.Optional(Type.String()),
      titlePropertyName: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const { loaded, notion } = createConnectorsForActiveClient();
        return guarded(
          ctx,
          approvalRequest(loaded.slug, "notion", "create", {
            id: params.parentPageId ?? params.parentDatabaseId,
            title: params.title,
          }, {
            title: params.title,
            body: params.body ?? null,
            parentPageId: params.parentPageId ?? null,
            parentDatabaseId: params.parentDatabaseId ?? null,
            parentDataSourceId: params.parentDataSourceId ?? null,
            titlePropertyName: params.titlePropertyName ?? null,
          }),
          secretValues(loaded.secrets),
          () =>
            notion().create(
              {
                title: params.title,
                body: params.body,
                parentPageId: params.parentPageId,
                parentDatabaseId: params.parentDatabaseId,
                parentDataSourceId: params.parentDataSourceId,
                titlePropertyName: params.titlePropertyName,
              },
              signal,
            ),
        );
      } catch (err) {
        return fail(sanitizeErrorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "notion_update",
    label: "Notion Update",
    description: "Patch only the named properties on an allowlisted Notion page.",
    promptSnippet: "Update Notion page properties after approval",
    promptGuidelines: ["Use notion_update for explicit property changes on an allowlisted page."],
    parameters: Type.Object({
      pageId: Type.String(),
      propertiesJson: Type.String({ description: "JSON object of Notion properties to update" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let properties: Record<string, unknown>;
      try {
        const parsed = JSON.parse(params.propertiesJson) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return fail("propertiesJson must be a JSON object.", "validation");
        }
        properties = parsed as Record<string, unknown>;
      } catch {
        return fail("propertiesJson is not valid JSON.", "validation");
      }
      try {
        const { loaded, notion } = createConnectorsForActiveClient();
        return guarded(
          ctx,
          approvalRequest(loaded.slug, "notion", "update", { id: params.pageId }, { pageId: params.pageId, ...properties }),
          secretValues(loaded.secrets),
          () => notion().update({ pageId: params.pageId, properties }, signal),
        );
      } catch (err) {
        return fail(sanitizeErrorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "asana_find",
    label: "Asana Find",
    description: "Find an Asana task or project in the active client's workspace.",
    promptSnippet: "Search Asana tasks or projects",
    promptGuidelines: ["Use asana_find only when asana.mode is rest and the workspace belongs to the active client."],
    parameters: Type.Object({
      query: Type.String(),
      resourceType: Type.Optional(Type.String({ description: "task or project" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (!clientSession.toolsEnabled) return fail("Client tools are disabled until /client completes a fresh session.", "validation");
      const resourceType = params.resourceType === "project" ? "project" : "task";
      try {
        const { asana } = createConnectorsForActiveClient();
        return textResult(await asana().find({ query: params.query, resourceType }, signal));
      } catch (err) {
        return fail(sanitizeErrorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "asana_create_task",
    label: "Asana Create Task",
    description: "Create an Asana task in an allowlisted project.",
    promptSnippet: "Create an Asana task after approval",
    promptGuidelines: ["Preview includes name, notes, project, assignee, and due date before any create."],
    parameters: Type.Object({
      name: Type.String(),
      notes: Type.Optional(Type.String()),
      projectGid: Type.Optional(Type.String()),
      assignee: Type.Optional(Type.String()),
      dueOn: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const { loaded, asana } = createConnectorsForActiveClient();
        return guarded(
          ctx,
          approvalRequest(loaded.slug, "asana", "create_task", { id: params.projectGid, title: params.name }, {
            name: params.name,
            notes: params.notes ?? null,
            projectGid: params.projectGid ?? null,
            assignee: params.assignee ?? null,
            dueOn: params.dueOn ?? null,
          }),
          secretValues(loaded.secrets),
          () => asana().createTask(params, signal),
        );
      } catch (err) {
        return fail(sanitizeErrorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "asana_update_task",
    label: "Asana Update Task",
    description: "Update an allowlisted Asana task.",
    promptSnippet: "Update an Asana task after approval",
    promptGuidelines: ["Preview includes name, notes, completed, assignee, and due date."],
    parameters: Type.Object({
      taskGid: Type.String(),
      name: Type.Optional(Type.String()),
      notes: Type.Optional(Type.String()),
      completed: Type.Optional(Type.Boolean()),
      assignee: Type.Optional(Type.String()),
      dueOn: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const { loaded, asana } = createConnectorsForActiveClient();
        return guarded(
          ctx,
          approvalRequest(loaded.slug, "asana", "update_task", { id: params.taskGid, title: params.name }, {
            taskGid: params.taskGid,
            name: params.name ?? null,
            notes: params.notes ?? null,
            completed: params.completed ?? null,
            assignee: params.assignee ?? null,
            dueOn: params.dueOn ?? null,
          }),
          secretValues(loaded.secrets),
          () => asana().updateTask(params, signal),
        );
      } catch (err) {
        return fail(sanitizeErrorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "asana_comment",
    label: "Asana Comment",
    description: "Add a comment to an allowlisted Asana task.",
    promptSnippet: "Comment on an Asana task after approval",
    promptGuidelines: ["The approval preview includes the full comment text."],
    parameters: Type.Object({ taskGid: Type.String(), text: Type.String() }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const { loaded, asana } = createConnectorsForActiveClient();
        return guarded(
          ctx,
          approvalRequest(loaded.slug, "asana", "comment", { id: params.taskGid }, {
            taskGid: params.taskGid,
            text: params.text,
          }),
          secretValues(loaded.secrets),
          () => asana().addComment(params.taskGid, params.text, signal),
        );
      } catch (err) {
        return fail(sanitizeErrorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "external_read",
    label: "External Read",
    description: "Read from the stubbed external system. v1 makes no remote call.",
    promptSnippet: "Read the stubbed external system",
    promptGuidelines: ["external_read does not contact a remote system in v1."],
    parameters: Type.Object({ query: Type.String() }),
    async execute(_toolCallId, params) {
      if (!clientSession.toolsEnabled) return fail("Client tools are disabled until /client completes a fresh session.", "validation");
      try {
        const { external } = createConnectorsForActiveClient();
        return textResult(await external().read(params.query));
      } catch (err) {
        return fail(sanitizeErrorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "external_write",
    label: "External Write",
    description: "External writes are stubbed and blocked in v1.",
    promptSnippet: "Blocked external stub write",
    promptGuidelines: ["Do not use external_write for a real integration. v1 keeps it disabled."],
    parameters: Type.Object({ payloadJson: Type.String({ description: "JSON payload" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { loaded, external } = createConnectorsForActiveClient();
        return guarded(
          ctx,
          approvalRequest(loaded.slug, "external", "write", {}, { payloadJson: params.payloadJson }),
          secretValues(loaded.secrets),
          () => external().write(params.payloadJson),
        );
      } catch (err) {
        return fail(sanitizeErrorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "hubspot_check_portal",
    label: "HubSpot Check Portal",
    description: "Compare a portal id with the client profile. This does not verify the live MCP connection and cannot authorize writes.",
    promptSnippet: "Check a HubSpot portal id without authorizing a write",
    promptGuidelines: [
      "hubspot_check_portal never authorizes a write. Model-supplied JSON is not account verification.",
    ],
    parameters: Type.Object({
      userDetailsJson: Type.String({ description: "JSON that may contain a portal id. This is not trusted verification." }),
    }),
    async execute(_toolCallId, params) {
      if (!clientSession.toolsEnabled) return fail("Client tools are disabled until /client completes a fresh session.", "validation");
      try {
        const { loaded } = createConnectorsForActiveClient();
        const parsed = JSON.parse(params.userDetailsJson) as unknown;
        const assessment = checkExpectedPortal(extractPortalId(parsed), loaded.profile.hubspot.expectedPortalId);
        return textResult({
          client: loaded.slug,
          system: "hubspot",
          operation: "check_portal",
          ...hubspotCheckForTool(assessment),
        });
      } catch (err) {
        return fail(sanitizeErrorMessage(err), "validation");
      }
    },
  });

  pi.registerTool({
    name: "notion_append",
    label: "Notion Append",
    description: "Append a bounded body to an allowlisted Notion page.",
    promptSnippet: "Append text to a Notion page after approval",
    promptGuidelines: ["Use notion_append for a short body on an allowlisted page."],
    parameters: Type.Object({
      pageId: Type.String(),
      body: Type.String(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const { loaded, notion } = createConnectorsForActiveClient();
        return guarded(
          ctx,
          approvalRequest(loaded.slug, "notion", "append", { id: params.pageId }, { pageId: params.pageId, body: params.body }),
          secretValues(loaded.secrets),
          () => notion().append({ pageId: params.pageId, body: params.body }, signal),
        );
      } catch (err) {
        return fail(sanitizeErrorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "hubspot_prepare_write",
    label: "HubSpot Prepare Write",
    description: "Store a one-time approval for the exact HubSpot MCP tool and payload. A session-wide grant is not enough.",
    promptSnippet: "Approve one exact HubSpot write",
    promptGuidelines: [
      "Call hubspot_prepare_write only after the live MCP get_user_details result verified the portal.",
      "Then call that same MCP tool with the same arguments. The grant is consumed once.",
    ],
    parameters: Type.Object({
      toolName: Type.String({ description: "Original HubSpot MCP tool name" }),
      argsJson: Type.String({ description: "Exact JSON arguments" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (clientSession.mode === "review") return fail("Review mode blocks HubSpot writes.", "validation");
      let args: Record<string, unknown>;
      try {
        const parsed = JSON.parse(params.argsJson) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return fail("argsJson must be a JSON object.", "validation");
        }
        args = parsed as Record<string, unknown>;
      } catch {
        return fail("argsJson is not valid JSON.", "validation");
      }
      try {
        const { loaded } = createConnectorsForActiveClient();
        if (!portalVerifiedFor(clientSession, loaded.profile) || !clientSession.hubspotConnectionId) {
          return fail("HubSpot portal is not verified on this connection. Writes stay blocked.", "validation", loaded.slug);
        }
        const connectionId = clientSession.hubspotConnectionId;
        return guarded(
          ctx,
          approvalRequest(loaded.slug, "hubspot", params.toolName, { id: connectionId }, { toolName: params.toolName, ...args }),
          secretValues(loaded.secrets),
          async () => {
            clientSession.rememberHubspotGrant(
              hubspotWriteHash({
                clientSlug: loaded.slug,
                toolName: params.toolName,
                args,
                connectionId,
              }),
            );
            return {
              ok: true as const,
              client: loaded.slug,
              system: "hubspot",
              operation: "prepare_write",
              data: { prepared: true },
            };
          },
        );
      } catch (err) {
        return fail(sanitizeErrorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "reconcile_receipt",
    label: "Reconcile Receipt",
    description: "Read a gitignored run receipt and say which targets must be skipped before another create.",
    promptSnippet: "Reconcile a previous run before creating records",
    promptGuidelines: ["Call reconcile_receipt before creating a target that might already exist."],
    parameters: Type.Object({
      sourceSystem: Type.String(),
      sourceId: Type.String(),
      targetsJson: Type.String({ description: "JSON array of {system, operation}" }),
    }),
    async execute(_toolCallId, params) {
      if (!clientSession.toolsEnabled) return fail("Client tools are disabled until /client completes a fresh session.", "validation");
      try {
        const { loaded } = createConnectorsForActiveClient();
        const wanted = JSON.parse(params.targetsJson) as Array<{ system: string; operation: string }>;
        if (!Array.isArray(wanted)) return fail("targetsJson must be an array.", "validation", loaded.slug);
        const receipt = readReceipt(getRepoRoot(), loaded.slug, params.sourceSystem, params.sourceId);
        return textResult({
          ok: true,
          client: loaded.slug,
          system: "receipt",
          operation: "reconcile",
          data: { receipt, plan: planWrites(receipt, wanted) },
        });
      } catch (err) {
        return fail(sanitizeErrorMessage(err), "validation");
      }
    },
  });

  pi.registerTool({
    name: "record_receipt",
    label: "Record Receipt",
    description: "Write a gitignored per-client receipt. This does not roll back remote records.",
    promptSnippet: "Record a run receipt after approval",
    promptGuidelines: ["Record source, targets, status, and uncertainty. Do not invent a rollback."],
    parameters: Type.Object({
      sourceSystem: Type.String(),
      sourceId: Type.String(),
      targetsJson: Type.String(),
      uncertainty: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { loaded } = createConnectorsForActiveClient();
        const targets = parseReceiptTargets(JSON.parse(params.targetsJson) as unknown);
        const now = new Date().toISOString();
        return guarded(
          ctx,
          approvalRequest(
            loaded.slug,
            "receipt",
            "record",
            { id: params.sourceId, title: params.sourceSystem },
            { targets, uncertainty: params.uncertainty ?? null },
          ),
          secretValues(loaded.secrets),
          async () => ({
            ok: true as const,
            client: loaded.slug,
            system: "receipt",
            operation: "record",
            data: writeReceipt(getRepoRoot(), {
              client: loaded.slug,
              sourceSystem: params.sourceSystem,
              sourceId: params.sourceId,
              targets,
              createdAt: now,
              updatedAt: now,
              uncertainty: params.uncertainty,
            }),
          }),
        );
      } catch (err) {
        return fail(sanitizeErrorMessage(err), "validation");
      }
    },
  });

  pi.registerTool({
    name: "run_bounded_check",
    label: "Bounded Check",
    description: "Run one approved file under test/*.test.ts. This does not enable a general shell.",
    promptSnippet: "Run one approved test file",
    promptGuidelines: ["Use run_bounded_check only for a file under test/. Do not use bash for this in review mode."],
    parameters: Type.Object({ path: Type.String({ description: "Repository path under test/*.test.ts" }) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const { loaded } = createConnectorsForActiveClient();
        const file = resolveBoundedTestPath(getRepoRoot(), loaded.profile, params.path);
        return guarded(
          ctx,
          approvalRequest(loaded.slug, "local", "bounded_check", { id: file }, { path: file }),
          secretValues(loaded.secrets),
          async () => {
            const output = await runBoundedNpmTest(getRepoRoot(), file, signal);
            if (output.exitCode !== 0) {
              throw new Error(output.output.slice(-500) || "Bounded check failed.");
            }
            return {
              ok: true as const,
              client: loaded.slug,
              system: "local",
              operation: "bounded_check",
              data: output,
            };
          },
        );
      } catch (err) {
        return fail(sanitizeErrorMessage(err), "validation");
      }
    },
  });
}

function runBoundedNpmTest(
  repoRoot: string,
  file: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npm", ["test", "--", file], { cwd: repoRoot, shell: false });
    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-4000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      signal?.removeEventListener("abort", abort);
      resolvePromise({ exitCode, output });
    });
  });
}
