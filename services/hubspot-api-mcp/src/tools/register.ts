import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PolicyError } from "../policy/errors.ts";
import type { OperationRecord } from "../registry/types.ts";
import { capabilityReport, executeOperation, listOperations, prepareOperation, readOperation, type ToolContext } from "./service.ts";

const params = {
  operationId: z.string().min(1).max(200),
  pathParams: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
};

export const changeArguments = z.object({ ...params, body: z.unknown().optional() }).strict();

export function registerHubSpotTools(server: McpServer, ctx: ToolContext, meta: { retrievedAt: string; apiVersion: string }): void {
  const readTools = new Map<string, OperationRecord[]>();
  for (const operation of ctx.operations.values()) {
    if (!operation.implemented || operation.effect !== "read" || !operation.tool) continue;
    const list = readTools.get(operation.tool) ?? [];
    list.push(operation);
    readTools.set(operation.tool, list);
  }

  server.registerTool(
    "hubspot_capabilities",
    {
      title: "HubSpot capability summary",
      description: "Report documented scope coverage, implemented operations, and that live grants are separate from mocked tests.",
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => guard(async () => json(await capabilityReport(ctx, meta))),
  );

  server.registerTool(
    "hubspot_list_operations",
    {
      title: "List allowlisted HubSpot operations",
      description: "Search implemented operation ids. Paths are not caller-supplied.",
      inputSchema: z.object({
        domain: z.string().optional(),
        effect: z.enum(["read", "mutate"]).optional(),
        query: z.string().max(200).optional(),
        cursor: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(100).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => guard(async () => json(listOperations(ctx.operations, { ...args, policy: ctx.actionPolicy }))),
  );

  for (const [name, operations] of readTools) {
    server.registerTool(
      name,
      {
        title: `HubSpot ${operations[0]?.domain ?? "api"} reads`,
        description: `Read an allowlisted ${operations[0]?.domain ?? "api"} operation. ${operations.length} operations. Use hubspot_list_operations to choose an operationId.`,
        inputSchema: z.object({ ...params, followPages: z.boolean().optional() }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async (args) => guard(async () => {
        const operation = ctx.operations.get(args.operationId);
        if (!operation || operation.tool !== name) throw new PolicyError("Operation is not available on this tool.", "validation");
        return json(await readOperation(ctx, args.operationId, args, args.followPages));
      }),
    );
  }

  server.registerTool(
    "hubspot_prepare_change",
    {
      title: "Prepare a HubSpot change",
      description: "Resolve an allowlisted mutation and return a proposal. This does not change HubSpot data.",
      inputSchema: changeArguments,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => guard(async () => json(await prepareOperation(ctx, args.operationId, args))),
  );

  server.registerTool(
    "hubspot_execute_change",
    {
      title: "Execute an approved HubSpot change",
      description: "Execute a proposal only with the approval token from the human approval endpoint. approved=true is not accepted.",
      inputSchema: z.object({ ...params, body: z.unknown().optional(), approvalToken: z.string().min(10) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => guard(async () => json(await executeOperation(ctx, args.operationId, args, args.approvalToken))),
  );
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function guard(fn: () => Promise<{ content: { type: "text"; text: string }[] }>) {
  try {
    return await fn();
  } catch (error) {
    return toolError(error);
  }
}

export function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Tool failed.";
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}
