import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { rpc } from "../src/client.ts";
import { readJobs } from "../src/jobs.ts";
import { socketPath } from "../src/server.ts";
import { spawnRunner, tempDir, waitForExit } from "./helpers.ts";

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("timed out");
}

test("unix socket start is idempotent and detach survives the parent", { timeout: 40_000 }, async () => {
	const data = tempDir();
	const parent = spawnRunner(["detach", "--data", data]);
	const parentExit = await waitForExit(parent, 10_000);
	assert.equal(parentExit.code, 0, parentExit.stderr);
	const launched = JSON.parse(parentExit.stdout) as { pid: number };
	assert.equal(parentExit.signal, null);
	let parentGone = false;
	try {
		process.kill(parent.pid!, 0);
	} catch {
		parentGone = true;
	}
	assert.equal(parentGone, true);
	await waitFor(() => {
		try {
			return statSync(socketPath(data)).isSocket();
		} catch {
			return false;
		}
	}, 15_000);
	assert.equal(statSync(data).mode & 0o777, 0o700);
	assert.equal(statSync(socketPath(data)).mode & 0o777, 0o600);
	const runnerPid = Number(readFileSync(join(data, "runner.pid"), "utf8"));
	assert.equal(runnerPid, launched.pid);
	assert.notEqual(runnerPid, parent.pid);
	process.kill(runnerPid, 0);
	const command = execFileSync("ps", ["-p", String(runnerPid), "-o", "pid=,command="], { encoding: "utf8" });
	assert.match(command, /src\/main\.ts serve/);

	const payload = { script: "hold", scope: "all", portalId: "1", approve: true };
	const sock = socketPath(data);
	const started = await rpc(sock, { id: "start-1", op: "start", key: "case-1", payload });
	assert.equal(started.ok, true);
	const jobId = started.job?.id;
	assert.ok(jobId);
	const again = await rpc(sock, { id: "start-2", op: "start", key: "case-1", payload });
	assert.equal(again.ok, true);
	assert.equal(again.job?.id, jobId);
	assert.equal(again.job?.dispatchCount, 1);
	const conflict = await rpc(sock, { id: "start-3", op: "start", key: "case-1", payload: { script: "happy" } });
	assert.equal(conflict.ok, false);
	assert.equal(conflict.error?.code, "conflict");
	const status = await rpc(sock, { id: "status-1", op: "status" });
	assert.equal(status.ok, true);
	assert.equal(status.job?.id, jobId);
	const listed = await rpc(sock, { id: "list-1", op: "list" });
	assert.equal(listed.jobs?.length, 1);
	const subscribed = await rpc(sock, { id: "sub-1", op: "subscribe", jobId });
	assert.equal(subscribed.event, "snapshot");
	assert.equal(subscribed.job?.id, jobId);
	const afterReconnect = readJobs(data);
	assert.equal(afterReconnect.length, 1);
	assert.equal(afterReconnect[0]?.dispatchCount, 1);
	const health = await rpc(sock, { id: "health-1", op: "health" });
	assert.equal(health.result?.pid, runnerPid);
	const unsupported = await rpc(sock, { id: "bad", op: "exec", payload: { command: "ls" } });
	assert.equal(unsupported.ok, false);
	assert.equal(unsupported.error?.code, "unsupported");

	const cancelled = await rpc(sock, { id: "cancel-1", op: "cancel", jobId });
	assert.equal(cancelled.ok, true);
	assert.equal(cancelled.job?.status, "cancelled");
	process.kill(runnerPid, "SIGTERM");
	await waitFor(() => {
		try {
			process.kill(runnerPid, 0);
			return false;
		} catch {
			return true;
		}
	}, 10_000);
	const proof = { parentPid: parent.pid, runnerPid, jobId, checkedAt: new Date().toISOString() };
	console.log(`PROOF m4 ${JSON.stringify(proof)}`);
});
