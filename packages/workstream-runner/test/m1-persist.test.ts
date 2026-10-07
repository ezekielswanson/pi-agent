import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readInvestigation } from "../src/session.ts";
import { DURABLE_EXPORTS } from "../src/tools.ts";
import { spawnRunner, tempDir, waitForExit } from "./helpers.ts";

test("scripted investigation persists one sqlite record and stays offline", async () => {
	const data = tempDir();
	const child = spawnRunner(["run-once", "--data", data, "--script", "happy"]);
	const exited = await waitForExit(child, 30_000);
	assert.equal(exited.code, 0, exited.stderr);
	assert.match(exited.stdout, /networkAttempts=0/);
	const attempts = JSON.parse(readFileSync(join(data, "network-attempts.json"), "utf8")) as string[];
	assert.deepEqual(attempts, []);
	const run = JSON.parse(readFileSync(join(data, "run.json"), "utf8")) as { conversationId: number };
	const saved = await readInvestigation(data, run.conversationId);
	assert.ok(saved.state);
	assert.equal(saved.state.steps.length, 3);
	assert.deepEqual(
		saved.state.steps.map((step) => step.tool),
		["fetch_record", "search_records", "walk_associations"],
	);
	const database = statSync(join(data, "investigation.sqlite"));
	assert.ok(database.size > 0);
	console.log(`durable exports: ${DURABLE_EXPORTS.join(", ")}`);
	console.log(`investigation conversation ${run.conversationId} steps=${saved.state.steps.length} sqliteBytes=${database.size}`);
});
