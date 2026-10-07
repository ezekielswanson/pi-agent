import assert from "node:assert/strict";
import test from "node:test";
import { openSession, closeSession } from "../src/session.ts";
import {
	proposeWrite,
	executeProposal,
	NOTION_PARENT,
	type WritePlan,
	type WriteAdapter,
} from "../src/write-proposals.ts";
import { tempDir } from "./helpers.ts";
const plan: WritePlan = {
	jobId: "test-job",
	system: "hubspot",
	target: "hubspot/5627913/tickets/48489581088",
	operation: "create_internal_note",
	args: {
		body: "[PI DURABLE TEST] pi-durable-job:test-job Validation passed.",
	},
	connectionId: "connection-1",
};
test("exact write proposal survives reopening; missing or stale approval cannot dispatch", async () => {
	const data = tempDir();
	let opened = await openSession(data);
	const p = await proposeWrite(opened.harness, "note", plan);
	await closeSession(opened);
	opened = await openSession(data);
	try {
		assert.equal(
			(await proposeWrite(opened.harness, "note", plan)).hash,
			p.hash,
		);
		await assert.rejects(
			proposeWrite(opened.harness, "note", {
				...plan,
				args: { body: plan.args.body + " changed" },
			}),
			/conflicts/,
		);
		let calls = 0;
		const denied: WriteAdapter = {
			consumeBrokerApproval: async () => false,
			write: async () => {
				calls++;
				return { id: "x", receipt: "x" };
			},
			reconcile: async () => ({ status: "unknown" }),
		};
		await assert.rejects(
			executeProposal(opened.harness, "note", "other-connection", denied),
			/stale/,
		);
		await assert.rejects(
			executeProposal(opened.harness, "note", "connection-1", denied),
			/approval missing/,
		);
		assert.equal(calls, 0);
		await assert.rejects(
			proposeWrite(opened.harness, "outside", {
				...plan,
				target: "hubspot/5627913/tickets/48952350095",
			}),
			/fixed ticket/,
		);
	} finally {
		await closeSession(opened);
	}
});
for (const system of ["hubspot", "notion"] as const)
	test(`${system} uncertain outcome reconciles after crash without repeating the write`, async () => {
		const data = tempDir();
		let opened = await openSession(data);
		const scoped: WritePlan =
			system === "hubspot"
				? plan
				: {
						...plan,
						system: "notion",
						target: NOTION_PARENT,
						operation: "append_status",
						args: {
							body: "Pi Durable pilot status pi-durable-job:test-job tests verified.",
						},
					};
		await proposeWrite(opened.harness, "write", scoped);
		let calls = 0;
		let remote = false;
		const adapter: WriteAdapter = {
			consumeBrokerApproval: async () => true,
			write: async () => {
				calls++;
				remote = true;
				throw new Error("remote committed; reply lost");
			},
			reconcile: async () =>
				remote
					? {
							status: "found",
							outcome: { id: "returned-id", receipt: "verified readback" },
						}
					: { status: "unknown" },
		};
		await assert.rejects(
			executeProposal(opened.harness, "write", "connection-1", adapter),
			/reply lost/,
		);
		await closeSession(opened);
		opened = await openSession(data);
		try {
			const replay = await executeProposal(
				opened.harness,
				"write",
				"connection-1",
				adapter,
			);
			assert.equal(replay.status, "succeeded");
			assert.equal(replay.remoteId, "returned-id");
			assert.equal(calls, 1);
			await executeProposal(opened.harness, "write", "connection-1", adapter);
			assert.equal(calls, 1);
		} finally {
			await closeSession(opened);
		}
	});
test("unknown remote state blocks retries even with another approval", async () => {
	const opened = await openSession(tempDir());
	try {
		await proposeWrite(opened.harness, "write", plan);
		let calls = 0;
		const adapter: WriteAdapter = {
			consumeBrokerApproval: async () => true,
			write: async () => {
				calls++;
				throw new Error("timeout");
			},
			reconcile: async () => ({ status: "unknown" }),
		};
		await assert.rejects(
			executeProposal(opened.harness, "write", "connection-1", adapter),
			/timeout/,
		);
		await assert.rejects(
			executeProposal(opened.harness, "write", "connection-1", adapter),
			/no retry/,
		);
		assert.equal(calls, 1);
	} finally {
		await closeSession(opened);
	}
});
