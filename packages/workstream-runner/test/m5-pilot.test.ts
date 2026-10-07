import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { rpc, subscribe } from "../src/client.ts";
import { readJobs } from "../src/jobs.ts";
import { bindMode } from "../src/mode.ts";
import { loadLiveConfig } from "../src/live.ts";
import { loadTrustedPolicy, decide } from "../src/policy.ts";
import { runAccess } from "../src/access.ts";
import {
	openSession,
	closeSession,
	harnessContext,
	DispatchDoc,
} from "../src/session.ts";
import { socketPath } from "../src/server.ts";
import { spawnRunner, tempDir, waitForExit } from "./helpers.ts";

async function ready(data: string) {
	for (let i = 0; i < 100; i++) {
		try {
			const h = await rpc(
				socketPath(data),
				{ id: "health", op: "health" },
				300,
			);
			if (h.ok) return h;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Runner did not become ready");
}

test("exact pilot policy rejects nonexcluded records, hostile URLs and nested paths before outbound access", async () => {
	const p = loadTrustedPolicy();
	const target = "hubspot/5627913/tickets/48489581088";
	assert.equal(decide(p, { op: "fetch", target }).allow, true);
	for (const bad of [
		"hubspot/5627913/tickets/10000000001",
		"hubspot/5627913/deals/10000000002",
		"https://evil.example/contacts/5627913/record/0-5/48489581088",
		`${target}/associations/deals/61112026744`,
		"https://app.hubspot.com/contacts/5627913/record/0-5/48489581088/associations",
		"http://app.hubspot.com/contacts/5627913/record/0-5/48489581088",
	]) {
		let calls = 0;
		const outcome = await runAccess(
			p,
			{ op: "fetch", target: bad },
			async () => {
				calls++;
				return { title: "forbidden" };
			},
		);
		assert.equal(outcome.decision.allow, false, bad);
		assert.equal(calls, 0);
	}
	for (const request of [
		{ op: "search" as const, portalId: "5627913", objectType: "tickets" },
		{
			op: "search" as const,
			portalId: "5627913",
			objectType: "tickets",
			objectIds: ["48489581088", "48952350095"],
		},
		{
			op: "traverse" as const,
			portalId: "5627913",
			path: [target, "hubspot/5627913/deals/65056178321"],
		},
	])
		assert.equal(decide(p, request).allow, false);
});

test("mode directories cannot switch; absent live configuration fails closed", () => {
	const data = tempDir();
	bindMode(data, "offline");
	bindMode(data, "offline");
	assert.throws(() => bindMode(data, "live"), /different mode/);
	assert.equal(statSync(join(data, "mode.json")).mode & 0o777, 0o600);
	assert.throws(() => loadLiveConfig(undefined), /requires --config/);
});

for (const boundary of [
	"acceptance",
	"conversation",
	"submission",
	"projection",
]) {
	test(
		`crash at ${boundary} recovers one native conversation and one job`,
		{ timeout: 30000 },
		async () => {
			const data = tempDir();
			const key = `crash-${boundary}`;
			const payload = { script: "happy" };
			const first = spawnRunner(["serve", "--data", data], {
				WSR_TEST_CRASH: boundary,
			});
			await ready(data);
			const firstExit = waitForExit(first, 10000);
			await assert.rejects(
				rpc(socketPath(data), { id: "start", op: "start", key, payload }, 1500),
			);
			assert.equal((await firstExit).signal, "SIGKILL");
			const original = readJobs(data)[0]!;
			const restarted = spawnRunner(["serve", "--data", data]);
			try {
				await ready(data);
				const again = await rpc(socketPath(data), {
					id: "again",
					op: "start",
					key,
					payload,
				});
				assert.equal(again.job?.id, original.id);
				assert.equal(again.job?.dispatchCount, 1);
				const conflict = await rpc(socketPath(data), {
					id: "changed",
					op: "start",
					key,
					payload: { script: "hold" },
				});
				assert.equal(conflict.error?.code, "conflict");
			} finally {
				const exited = waitForExit(restarted, 10000);
				restarted.kill("SIGTERM");
				await exited;
			}
			const opened = await openSession(data);
			try {
				const map = await opened.harness.snapshot(DispatchDoc, harnessContext);
				assert.equal(Object.keys(map!.conversations).length, 1);
				const conversations = await opened.harness.commit(
					(tx) => tx.scanConversations({}, 100),
					harnessContext,
				);
				assert.equal(conversations.items.length, 1);
				assert.equal(
					map!.conversations[original.id],
					conversations.items[0]!.id,
				);
			} finally {
				await closeSession(opened);
			}
			console.log(
				`PROOF ${boundary} job=${original.id} conversations=1 dispatches=1`,
			);
		},
	);
}

test(
	"second writer is refused; concurrent starts and continuing subscriptions retain one identity",
	{ timeout: 30000 },
	async () => {
		const data = tempDir();
		const first = spawnRunner(["serve", "--data", data]);
		try {
			const health = await ready(data);
			const second = spawnRunner(["serve", "--data", data]);
			const refused = await waitForExit(second, 5000);
			assert.equal(refused.code, 1);
			assert.match(refused.stderr, /already owns/);
			assert.equal((await ready(data)).result?.pid, health.result?.pid);
			const payload = { script: "hold" };
			const jobs = await Promise.all(
				Array.from({ length: 8 }, (_, i) =>
					rpc(socketPath(data), {
						id: String(i),
						op: "start",
						key: "one",
						payload,
					}),
				),
			);
			assert.equal(new Set(jobs.map((j) => j.job?.id)).size, 1);
			const id = jobs[0]!.job!.id;
			const events: string[] = [];
			const controller = new AbortController();
			const consume = (async () => {
				for await (const event of subscribe(socketPath(data), id, {
					signal: controller.signal,
				})) {
					events.push(event.event!);
					if (events.length === 2)
						await rpc(socketPath(data), {
							id: "cancel",
							op: "cancel",
							jobId: id,
						});
				}
			})();
			const timeout = setTimeout(() => controller.abort(), 10000);
			try {
				await consume;
			} finally {
				clearTimeout(timeout);
				controller.abort();
			}
			assert.equal(events[0], "snapshot");
			assert.ok(events.includes("update"));
			assert.equal(events.at(-1), "end");
			const reconnect = [];
			for await (const event of subscribe(socketPath(data), id))
				reconnect.push(event);
			assert.equal(reconnect[0]?.job?.id, id);
			assert.equal(reconnect.at(-1)?.event, "end");
			assert.equal(readJobs(data).length, 1);
			for (const file of [
				"jobs.json",
				"runner.lock",
				"investigation.sqlite",
				"fetch_record.entered",
			])
				assert.equal(statSync(join(data, file)).mode & 0o777, 0o600, file);
		} finally {
			const exited = waitForExit(first, 10000);
			first.kill("SIGTERM");
			await exited;
		}
	},
);
