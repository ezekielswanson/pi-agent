import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createConnectorsForActiveClient } from "../../src/connectors/createConnectors.ts";
import { checkExpectedPortal, extractPortalId } from "../../src/connectors/hubspot/index.ts";
import type { ConnectorResult } from "../../src/types/index.ts";
import { confirmWrite, errorMessage } from "../../src/utils/index.ts";

function textResult(result: ConnectorResult<unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

function fail(message: string) {
  return textResult({ ok: false, error: message });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "notion_find",
    label: "Notion Find",
    description: "Search Notion pages and databases for the active client.",
    promptSnippet: "Search Notion for a page or database item",
    promptGuidelines: ["Use notion_find to search the active client's Notion workspace."],
    parameters: Type.Object({
      query: Type.String({ description: "Search text" }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const { notion } = createConnectorsForActiveClient();
        return textResult(await notion().find(params.query, signal));
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "notion_read",
    label: "Notion Read",
    description: "Read a Notion page's properties and text content.",
    promptSnippet: "Read a Notion page by id",
    promptGuidelines: ["Use notion_read after notion_find or when the client profile has a mapped page id."],
    parameters: Type.Object({
      pageId: Type.String({ description: "Notion page id" }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const { notion } = createConnectorsForActiveClient();
        return textResult(await notion().read(params.pageId, signal));
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "notion_create",
    label: "Notion Create",
    description: "Create a Notion page under a parent page or database.",
    promptSnippet: "Create a Notion page",
    promptGuidelines: ["Use notion_create only after confirming the parent and title with the user."],
    parameters: Type.Object({
      title: Type.String({ description: "Page title" }),
      parentPageId: Type.Optional(Type.String()),
      parentDatabaseId: Type.Optional(Type.String()),
      titlePropertyName: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const ok = await confirmWrite(
        ctx,
        "Create Notion page?",
        `Title: ${params.title}\nParent page: ${params.parentPageId ?? "none"}\nParent database: ${params.parentDatabaseId ?? "none"}`,
      );
      if (!ok) return fail("Write cancelled by user.");
      try {
        const { notion } = createConnectorsForActiveClient();
        return textResult(
          await notion().create(
            {
              title: params.title,
              parentPageId: params.parentPageId,
              parentDatabaseId: params.parentDatabaseId,
              titlePropertyName: params.titlePropertyName,
            },
            signal,
          ),
        );
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "notion_update",
    label: "Notion Update",
    description: "Update properties on an existing Notion page.",
    promptSnippet: "Update Notion page properties",
    promptGuidelines: ["Use notion_update for small, explicit property changes only."],
    parameters: Type.Object({
      pageId: Type.String(),
      propertiesJson: Type.String({ description: "JSON object of Notion properties to update" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let properties: Record<string, unknown>;
      try {
        const parsed = JSON.parse(params.propertiesJson) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return fail("propertiesJson must be a JSON object.");
        }
        properties = parsed as Record<string, unknown>;
      } catch {
        return fail("propertiesJson is not valid JSON.");
      }

      const ok = await confirmWrite(
        ctx,
        "Update Notion page?",
        `Page: ${params.pageId}\nProperties: ${params.propertiesJson}`,
      );
      if (!ok) return fail("Write cancelled by user.");

      try {
        const { notion } = createConnectorsForActiveClient();
        return textResult(await notion().update({ pageId: params.pageId, properties }, signal));
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "asana_find",
    label: "Asana Find",
    description: "Find an Asana task or project by name or GID.",
    promptSnippet: "Search Asana tasks or projects",
    promptGuidelines: ["Use asana_find against the active client's Asana workspace."],
    parameters: Type.Object({
      query: Type.String(),
      resourceType: Type.Optional(Type.String({ description: "task or project" })),
    }),
    async execute(_toolCallId, params, signal) {
      const resourceType = params.resourceType === "project" ? "project" : "task";
      try {
        const { asana } = createConnectorsForActiveClient();
        return textResult(await asana().find({ query: params.query, resourceType }, signal));
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "asana_create_task",
    label: "Asana Create Task",
    description: "Create an Asana task in a mapped project or workspace.",
    promptSnippet: "Create an Asana task",
    promptGuidelines: ["Use asana_create_task only after confirming the project and task name."],
    parameters: Type.Object({
      name: Type.String(),
      notes: Type.Optional(Type.String()),
      projectGid: Type.Optional(Type.String()),
      assignee: Type.Optional(Type.String()),
      dueOn: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const ok = await confirmWrite(
        ctx,
        "Create Asana task?",
        `Name: ${params.name}\nProject: ${params.projectGid ?? "workspace default"}`,
      );
      if (!ok) return fail("Write cancelled by user.");
      try {
        const { asana } = createConnectorsForActiveClient();
        return textResult(await asana().createTask(params, signal));
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "asana_update_task",
    label: "Asana Update Task",
    description: "Update an Asana task's name, status, assignee, or due date.",
    promptSnippet: "Update an Asana task",
    promptGuidelines: ["Use asana_update_task for small, explicit field changes."],
    parameters: Type.Object({
      taskGid: Type.String(),
      name: Type.Optional(Type.String()),
      notes: Type.Optional(Type.String()),
      completed: Type.Optional(Type.Boolean()),
      assignee: Type.Optional(Type.String()),
      dueOn: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const ok = await confirmWrite(
        ctx,
        "Update Asana task?",
        `Task: ${params.taskGid}\nCompleted: ${params.completed ?? "unchanged"}`,
      );
      if (!ok) return fail("Write cancelled by user.");
      try {
        const { asana } = createConnectorsForActiveClient();
        return textResult(await asana().updateTask(params, signal));
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "asana_comment",
    label: "Asana Comment",
    description: "Add a comment to an Asana task.",
    promptSnippet: "Comment on an Asana task",
    promptGuidelines: ["Use asana_comment to attach a short note to an existing task."],
    parameters: Type.Object({
      taskGid: Type.String(),
      text: Type.String(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const ok = await confirmWrite(ctx, "Add Asana comment?", `Task: ${params.taskGid}\n${params.text}`);
      if (!ok) return fail("Write cancelled by user.");
      try {
        const { asana } = createConnectorsForActiveClient();
        return textResult(await asana().addComment(params.taskGid, params.text, signal));
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "external_read",
    label: "External Read",
    description: "Read from the active client's external system. v1 is a stub.",
    promptSnippet: "Read from the stubbed external system",
    promptGuidelines: ["Use external_read only when the client profile enables the external system, or to inspect the stub."],
    parameters: Type.Object({
      query: Type.String(),
    }),
    async execute(_toolCallId, params) {
      try {
        const { external } = createConnectorsForActiveClient();
        return textResult(await external().read(params.query));
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "external_write",
    label: "External Write",
    description: "Create or update in the external system. v1 echoes the payload and does not call a remote API.",
    promptSnippet: "Write to the stubbed external system",
    promptGuidelines: ["Use external_write only if the client profile has external.enabled set to true, unless the user is testing the stub."],
    parameters: Type.Object({
      payloadJson: Type.String({ description: "JSON payload to echo" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let payload: unknown = params.payloadJson;
      try {
        payload = JSON.parse(params.payloadJson);
      } catch {
        // keep raw string
      }
      const ok = await confirmWrite(ctx, "Write to external stub?", params.payloadJson);
      if (!ok) return fail("Write cancelled by user.");
      try {
        const { external } = createConnectorsForActiveClient();
        return textResult(await external().write(payload));
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  });

  pi.registerTool({
    name: "hubspot_check_portal",
    label: "HubSpot Check Portal",
    description: "Compare a HubSpot get_user_details payload to the active client's expected portal id.",
    promptSnippet: "Verify the HubSpot MCP portal matches the client profile",
    promptGuidelines: [
      "Use hubspot_check_portal after calling HubSpot MCP get_user_details. Do not use HubSpot Developer MCP for CRM actions.",
    ],
    parameters: Type.Object({
      userDetailsJson: Type.String({ description: "JSON from HubSpot MCP get_user_details" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const { loaded } = createConnectorsForActiveClient();
        const parsed = JSON.parse(params.userDetailsJson) as unknown;
        const actual = extractPortalId(parsed);
        return textResult(checkExpectedPortal(actual, loaded.profile.hubspot.expectedPortalId));
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  });
}
