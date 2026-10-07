import { createHash } from "node:crypto";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { canonicalJson } from "./jobs.ts";
import { harnessContext } from "./session.ts";

export const NOTION_PARENT = "3ddbf244-9e83-8024-a57b-cf18798122b6";
export type WritePlan = {
	jobId: string;
	system: "hubspot" | "notion";
	target: string;
	operation: "create_internal_note" | "append_status";
	args: { body: string };
	connectionId: string;
};
export type WriteProposal = WritePlan & {
	id: string;
	hash: string;
	status: "proposed" | "uncertain" | "succeeded";
	remoteId: string | null;
	receipt: string | null;
};
const ProposalsDoc = defineDoc<{ items: Record<string, WriteProposal> }>({
	kind: "app.write-proposals",
	version: 1,
	scope: "session",
	initial: () => ({ items: {} }),
});
export type RemoteOutcome = { id: string; receipt: string };
/** Backend-only capability: implement with the existing exact Pi approval broker; never expose this callback to a model or socket JSON. */
export type WriteAdapter = {
	consumeBrokerApproval(proposal: Readonly<WriteProposal>): Promise<boolean>;
	write(proposal: Readonly<WriteProposal>): Promise<RemoteOutcome>;
	reconcile(
		proposal: Readonly<WriteProposal>,
	): Promise<
		| { status: "found"; outcome: RemoteOutcome }
		| { status: "absent" }
		| { status: "unknown" }
	>;
};
function validate(plan: WritePlan) {
	if (
		!plan.jobId ||
		!plan.connectionId ||
		Object.keys(plan.args).length !== 1 ||
		typeof plan.args.body !== "string"
	)
		throw new Error(
			"Write proposal lacks exact identity, connection, or payload",
		);
	if (!plan.args.body.includes(`pi-durable-job:${plan.jobId}`))
		throw new Error("Write must contain its reconciliation marker");
	if (
		plan.system === "hubspot" &&
		(plan.target !== "hubspot/5627913/tickets/48489581088" ||
			plan.operation !== "create_internal_note" ||
			!plan.args.body.startsWith("[PI DURABLE TEST]") ||
			plan.args.body.includes("@"))
	)
		throw new Error(
			"Only the fixed ticket's labeled internal test note is allowed",
		);
	if (
		plan.system === "notion" &&
		(plan.target !== NOTION_PARENT ||
			plan.operation !== "append_status" ||
			!plan.args.body.startsWith("Pi Durable pilot status"))
	)
		throw new Error("Only the authorized Notion status append is allowed");
	if (plan.system !== "hubspot" && plan.system !== "notion")
		throw new Error("System is outside the pilot");
}
export async function proposeWrite(
	harness: Harness,
	key: string,
	plan: WritePlan,
): Promise<WriteProposal> {
	validate(plan);
	if (!key || ["__proto__", "constructor", "prototype"].includes(key))
		throw new Error("Invalid proposal key");
	const hash = createHash("sha256").update(canonicalJson(plan)).digest("hex");
	return harness.commit(async (tx) => {
		const store = await tx.doc(ProposalsDoc);
		const existing = store.items[key];
		if (existing) {
			if (existing.hash !== hash)
				throw new Error(
					"Proposal key conflicts with an exact payload or connection",
				);
			return JSON.parse(JSON.stringify(existing)) as WriteProposal;
		}
		const proposal: WriteProposal = {
			...plan,
			id: key,
			hash,
			status: "proposed",
			remoteId: null,
			receipt: null,
		};
		store.items[key] = proposal;
		return proposal;
	}, harnessContext);
}
/** Persist uncertainty before dispatch; replay reads remote state and never blindly repeats a write. */
export async function executeProposal(
	harness: Harness,
	key: string,
	currentConnectionId: string,
	adapter: WriteAdapter,
): Promise<WriteProposal> {
	const snapshot = await harness.snapshot(ProposalsDoc, harnessContext);
	const proposal = snapshot?.items[key];
	if (!proposal) throw new Error("Unknown write proposal");
	validate(proposal);
	if (proposal.connectionId !== currentConnectionId)
		throw new Error("Write approval is stale for this connection");
	if (
		proposal.hash !==
		createHash("sha256")
			.update(
				canonicalJson({
					jobId: proposal.jobId,
					system: proposal.system,
					target: proposal.target,
					operation: proposal.operation,
					args: proposal.args,
					connectionId: proposal.connectionId,
				}),
			)
			.digest("hex")
	)
		throw new Error("Write payload binding changed");
	if (proposal.status === "succeeded")
		return { ...proposal, args: { ...proposal.args } };
	const save = async (outcome: RemoteOutcome) =>
		harness.commit(async (tx) => {
			const store = await tx.doc(ProposalsDoc);
			const saved = store.items[key]!;
			saved.status = "succeeded";
			saved.remoteId = outcome.id;
			saved.receipt = outcome.receipt;
			return JSON.parse(JSON.stringify(saved)) as WriteProposal;
		}, harnessContext);
	if (proposal.status === "uncertain") {
		const remote = await adapter.reconcile(proposal);
		if (remote.status === "found") return save(remote.outcome);
		// Even an absent result may reflect eventual consistency. Do not auto-retry.
		throw new Error(
			`Write outcome requires reconciliation (${remote.status}); no retry dispatched`,
		);
	}
	if (!(await adapter.consumeBrokerApproval(proposal)))
		throw new Error("Trusted exact broker approval missing");
	await harness.commit(async (tx) => {
		const store = await tx.doc(ProposalsDoc);
		if (store.items[key]?.status !== "proposed")
			throw new Error("Proposal already dispatched");
		store.items[key]!.status = "uncertain";
	}, harnessContext);
	return save(await adapter.write(proposal));
}
