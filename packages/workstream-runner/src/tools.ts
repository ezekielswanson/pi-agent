import { openSync, writeSync, fsyncSync, closeSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import {
	defineExtension,
	defineTool,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import {
	absorbEvidence,
	decide,
	loadTrustedPolicy,
	type AccessRequest,
	type Policy,
	trustedPolicyPath,
} from "./policy.ts";
import { fetchLocalFixture, runAccess } from "./access.ts";
import { InvestigationDoc, type TraceRecord } from "./investigation-doc.ts";

export const DURABLE_EXPORTS = [
	"Harness",
	"createRegistry",
	"defineExtension",
	"defineTool",
	"defineDoc",
	"openNodeSqliteStorage",
] as const;

async function trace(
	api: ToolExecutionApi,
	context: Context,
	dataDir: string,
	field: "executions" | "steps",
	tool: string,
): Promise<TraceRecord> {
	const record: TraceRecord = {
		tool,
		pid: process.pid,
		at: new Date().toISOString(),
	};
	await api.commit(async (tx) => {
		const doc = await tx.doc(InvestigationDoc, api.conversationId);
		const next = [...doc[field], record];
		if (field === "executions") doc.executions = next;
		else doc.steps = next;
	}, context);
	if (field === "executions") {
		mkdirSync(dataDir, { recursive: true });
		const path = join(dataDir, `${tool}.entered`);
		const fd = openSync(path, "w", 0o600);
		try {
			writeSync(fd, JSON.stringify(record));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
	return record;
}

async function sleepHold(
	ms: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (signal?.aborted) throw signal.reason ?? new Error("aborted");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function blockedText(reason: string): { type: "text"; text: string }[] {
	return [{ type: "text", text: `blocked before fetch: ${reason}` }];
}

export function investigationExtension(
	dataDir: string,
	policy: Policy = loadTrustedPolicy(
		join(trustedPolicyPath(), "..", "offline-policy.json"),
	),
) {
	const fetchRecord = defineTool({
		name: "fetch_record",
		description:
			"Fetch one HubSpot record by stable identity. Local fixtures only.",
		parameters: Type.Object({
			target: Type.String(),
		}),
		replay: "unsafe",
		execute: async (args, api, context) => {
			await trace(api, context, dataDir, "executions", "fetch_record");
			const request: AccessRequest = { op: "fetch", target: args.target };
			const outcome = await runAccess(policy, request, (identity) =>
				fetchLocalFixture(policy, identity, dataDir),
			);
			if (!outcome.decision.allow) {
				return {
					isError: true,
					content: blockedText(outcome.decision.reason),
					details: { fetched: false },
				};
			}
			const text = JSON.stringify(outcome.records);
			absorbEvidence(policy, text);
			await trace(api, context, dataDir, "steps", "fetch_record");
			return { content: [{ type: "text", text }], details: { fetched: true } };
		},
	});

	const searchRecords = defineTool({
		name: "search_records",
		description:
			"Search HubSpot records only when every id is pinned and allowed.",
		parameters: Type.Object({
			portalId: Type.String(),
			objectType: Type.String(),
			objectIds: Type.Optional(Type.Array(Type.String())),
		}),
		replay: "unsafe",
		execute: async (args, api, context) => {
			await trace(api, context, dataDir, "executions", "search_records");
			const request: AccessRequest = {
				op: "search",
				portalId: args.portalId,
				objectType: args.objectType,
				...(args.objectIds ? { objectIds: args.objectIds } : {}),
			};
			const outcome = await runAccess(policy, request, (identity) =>
				fetchLocalFixture(policy, identity, dataDir),
			);
			if (!outcome.decision.allow) {
				return {
					isError: true,
					content: blockedText(outcome.decision.reason),
					details: { fetched: false },
				};
			}
			const text = JSON.stringify(outcome.records);
			absorbEvidence(policy, text);
			await trace(api, context, dataDir, "steps", "search_records");
			return { content: [{ type: "text", text }], details: { fetched: true } };
		},
	});

	const walkAssociations = defineTool({
		name: "walk_associations",
		description:
			"Walk a concrete association path. Unbounded walks are refused.",
		parameters: Type.Object({
			portalId: Type.String(),
			from: Type.String(),
			to: Type.Optional(Type.String()),
			path: Type.Optional(Type.Array(Type.String())),
			holdMs: Type.Optional(Type.Number()),
		}),
		replay: "unsafe",
		execute: async (args, api, context) => {
			await trace(api, context, dataDir, "executions", "walk_associations");
			const request: AccessRequest = args.path
				? { op: "traverse", portalId: args.portalId, path: args.path }
				: {
						op: "associate",
						portalId: args.portalId,
						from: args.from,
						...(args.to ? { to: args.to } : {}),
					};
			const decision = decide(policy, request);
			if (!decision.allow) {
				return {
					isError: true,
					content: blockedText(decision.reason),
					details: { fetched: false },
				};
			}
			if (args.holdMs && args.holdMs > 0)
				await sleepHold(args.holdMs, context.abortSignal);
			const outcome = await runAccess(policy, request, (identity) =>
				fetchLocalFixture(policy, identity, dataDir),
			);
			const text = JSON.stringify(outcome.records);
			absorbEvidence(policy, text);
			await trace(api, context, dataDir, "steps", "walk_associations");
			return { content: [{ type: "text", text }], details: { fetched: true } };
		},
	});

	return defineExtension({
		name: "investigation",
		tools: [fetchRecord, searchRecords, walkAssociations],
	});
}
