import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { readInvestigation } from "../src/session.ts";
import { spawnRunner, tempDir, waitForExit } from "./helpers.ts";

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			readFileSync(path);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error(`timed out waiting for ${path}`);
}

test("kill -9 resumes from the checkpoint and does not replay completed steps", { timeout: 45_000 }, async () => {
	const data = tempDir();
	const first = spawnRunner(["run-once", "--data", data, "--script", "crash"]);
	await waitForFile(join(data, "walk_associations.entered"), 20_000);
	await waitForFile(join(data, "run.json"), 5_000);
	const entered = JSON.parse(readFileSync(join(data, "walk_associations.entered"), "utf8")) as { pid: number; tool: string };
	const run = JSON.parse(readFileSync(join(data, "run.json"), "utf8")) as { pid: number; conversationId: number };
	assert.equal(entered.tool, "walk_associations");
	assert.equal(entered.pid, first.pid);
	assert.equal(run.pid, first.pid);
	assert.notEqual(first.pid, process.pid);
	const command = execFileSync("ps", ["-p", String(first.pid), "-o", "pid=,command="], { encoding: "utf8" });
	assert.match(command, /src\/main\.ts/);
	const killedAt = new Date().toISOString();
	execFileSync("kill", ["-9", String(first.pid)]);
	const firstExit = await waitForExit(first, 10_000);
	assert.equal(firstExit.signal, "SIGKILL");
	assert.equal(firstExit.code, null);
	let stillAlive = true;
	try {
		process.kill(first.pid!, 0);
	} catch (error) {
		assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
		stillAlive = false;
	}
	assert.equal(stillAlive, false);

	const second = spawnRunner(["resume-once", "--data", data]);
	const resumed = await waitForExit(second, 20_000);
	assert.equal(resumed.code, 0, `${resumed.stderr}\n${resumed.stdout}`);
	const resume = JSON.parse(readFileSync(join(data, "resume.json"), "utf8")) as { pid: number; at: string };
	assert.equal(resume.pid, second.pid);
	assert.notEqual(resume.pid, first.pid);

	const saved = await readInvestigation(data, run.conversationId);
	assert.ok(saved.state);
	const fetchExecutions = saved.state.executions.filter((item) => item.tool === "fetch_record");
	const walkExecutions = saved.state.executions.filter((item) => item.tool === "walk_associations");
	assert.equal(fetchExecutions.length, 1);
	assert.equal(walkExecutions.length, 1);
	assert.equal(fetchExecutions[0]?.pid, first.pid);
	assert.equal(walkExecutions[0]?.pid, first.pid);
	assert.deepEqual(
		saved.state.steps.map((step) => step.tool),
		["fetch_record"],
	);
	assert.equal(saved.state.steps[0]?.pid, first.pid);
	const interrupted = toolText(saved.messages, "walk_associations");
	assert.match(interrupted, /interrupted/i);
	const proof = {
		killedPid: first.pid,
		killedAt,
		signal: 9,
		resumePid: second.pid,
		resumedAt: resume.at,
		completedSteps: saved.state.steps,
		executions: saved.state.executions,
	};
	console.log(`PROOF m2 ${JSON.stringify(proof)}`);
});

function toolText(messages: Message[], toolName: string): string {
	const message = messages.find((item) => item.role === "toolResult" && item.toolName === toolName);
	assert.ok(message && message.role === "toolResult");
	assert.equal(message.isError, true);
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}
