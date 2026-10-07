import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { networkAttempts } from "./offline.ts";
import type { ScriptName } from "./script.ts";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { closeSession, harnessContext, openSession, startConversation } from "./session.ts";

export type RunState = {
	script: ScriptName;
	conversationId: number;
	submissionId: number;
	pid: number;
	startedAt: string;
};

export function runStatePath(dataDir: string): string {
	return join(dataDir, "run.json");
}

export async function runOnce(dataDir: string, script: ScriptName): Promise<void> {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const opened = await openSession(dataDir);
	const started = await startConversation(opened, `run-once-${script}`, script);
	const state: RunState = {
		script,
		conversationId: started.conversation.id,
		submissionId: started.submission.id,
		pid: process.pid,
		startedAt: new Date().toISOString(),
	};
	writeFileSync(runStatePath(dataDir), JSON.stringify(state, null, 2));
	const settled = await started.submission.wait(harnessContext);
	await closeSession(opened);
	writeFileSync(join(dataDir, "network-attempts.json"), JSON.stringify(networkAttempts(), null, 2));
	if (settled.status !== "done") {
		throw new Error(`investigation ${settled.status}${settled.status === "unanswered" ? `: ${settled.reason}` : ""}`);
	}
	console.log(`networkAttempts=${networkAttempts().length}`);
	console.log(`conversationId=${started.conversation.id}`);
}

export async function resumeOnce(dataDir: string): Promise<void> {
	const state = JSON.parse(readFileSync(runStatePath(dataDir), "utf8")) as RunState;
	writeFileSync(join(dataDir, "resume.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
	const opened = await openSession(dataDir);
	opened.harness.resume();
	const submission = await opened.harness.submission(state.submissionId as SubmissionId, harnessContext);
	if (!submission) throw new Error(`missing submission ${state.submissionId}`);
	const settled = await submission.wait(harnessContext);
	await closeSession(opened);
	writeFileSync(join(dataDir, "network-attempts.json"), JSON.stringify(networkAttempts(), null, 2));
	if (settled.status !== "done") {
		throw new Error(`resume ${settled.status}${settled.status === "unanswered" ? `: ${settled.reason}` : ""}`);
	}
	console.log(`resumedPid=${process.pid}`);
	console.log(`conversationId=${state.conversationId}`);
}
