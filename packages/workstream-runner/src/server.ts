import net from "node:net";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationId, Harness, SubmissionId } from "@earendil-works/pi-durable";
import { acceptJob, readJobs, saveJob, type Job } from "./jobs.ts";
import { type ScriptName } from "./script.ts";
import { closeSession, harnessContext, openSession, startConversation, type OpenedSession } from "./session.ts";

export type ClientRequest = {
	id: string;
	op: string;
	key?: string;
	payload?: unknown;
	jobId?: string;
};

type ServerState = {
	dataDir: string;
	opened: OpenedSession;
	inflight: Set<string>;
};

export function socketPath(dataDir: string): string {
	return join(dataDir, "runner.sock");
}

export async function serve(dataDir: string): Promise<void> {
	process.on("SIGHUP", () => {});
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	chmodSync(dataDir, 0o700);
	const opened = await openSession(dataDir);
	opened.harness.resume();
	const state: ServerState = { dataDir, opened, inflight: new Set() };
	await recover(state);

	const server = net.createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				void handleLine(state, socket, line);
				newline = buffer.indexOf("\n");
			}
		});
	});

	const sock = socketPath(dataDir);
	try {
		unlinkSync(sock);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(sock, () => resolve());
	});
	chmodSync(sock, 0o600);
	writeFileSync(join(dataDir, "runner.pid"), `${process.pid}\n`, { mode: 0o600 });
	writeFileSync(
		join(dataDir, "runner.json"),
		JSON.stringify({ pid: process.pid, socket: sock, node: process.execPath, startedAt: new Date().toISOString() }, null, 2),
		{ mode: 0o600 },
	);

	await new Promise<void>((resolve) => {
		const shutdown = () => {
			server.close();
			void closeSession(opened).finally(() => resolve());
		};
		process.once("SIGTERM", shutdown);
		process.once("SIGINT", shutdown);
	});
}

async function recover(state: ServerState): Promise<void> {
	for (const job of readJobs(state.dataDir)) {
		if (job.submissionId && (job.status === "running" || job.status === "accepted")) {
			watch(state, job);
			continue;
		}
		if (job.status === "accepted" && job.dispatchCount === 0) await dispatch(state, job);
	}
}

async function handleLine(state: ServerState, socket: net.Socket, line: string): Promise<void> {
	let request: ClientRequest;
	try {
		request = JSON.parse(line) as ClientRequest;
	} catch {
		write(socket, { id: "?", ok: false, error: { code: "bad_json", message: "expected one JSON object" } });
		return;
	}
	try {
		if (request.op === "health") {
			write(socket, { id: request.id, ok: true, result: { pid: process.pid, status: "ok", durable: "1.0.4" } });
			return;
		}
		if (request.op === "start") {
			if (!request.key) throw coded("bad_request", "start requires a key");
			const accepted = acceptJob(state.dataDir, request.key, request.payload ?? null);
			if (accepted.conflict) {
				write(socket, {
					id: request.id,
					ok: false,
					error: { code: "conflict", message: `key ${request.key} is already bound to a different payload` },
					job: accepted.job,
				});
				return;
			}
			const job = accepted.job.dispatchCount === 0 && accepted.job.status === "accepted"
				? await dispatch(state, accepted.job)
				: accepted.job;
			write(socket, { id: request.id, ok: true, job });
			return;
		}
		if (request.op === "list") {
			write(socket, { id: request.id, ok: true, jobs: readJobs(state.dataDir) });
			return;
		}
		if (request.op === "get" || request.op === "status") {
			const job = findJob(state, request.jobId);
			write(socket, { id: request.id, ok: true, job, jobs: readJobs(state.dataDir) });
			return;
		}
		if (request.op === "cancel") {
			const job = findJob(state, request.jobId);
			if (!job) throw coded("not_found", "unknown job");
			await cancel(state, job);
			write(socket, { id: request.id, ok: true, job: readJobs(state.dataDir).find((item) => item.id === job.id) });
			return;
		}
		if (request.op === "subscribe") {
			const job = findJob(state, request.jobId);
			if (!job) throw coded("not_found", "unknown job");
			subscribe(state, socket, request.id, job.id);
			return;
		}
		write(socket, { id: request.id, ok: false, error: { code: "unsupported", message: `unsupported op ${request.op}` } });
	} catch (error) {
		const codedError = error as { code?: string; message?: string };
		write(socket, {
			id: request.id,
			ok: false,
			error: { code: codedError.code ?? "error", message: codedError.message ?? String(error) },
		});
	}
}

function subscribe(state: ServerState, socket: net.Socket, id: string, jobId: string): void {
	const send = () => readJobs(state.dataDir).find((job) => job.id === jobId);
	const first = send();
	write(socket, { id, ok: true, event: "snapshot", job: first });
	const timer = setInterval(() => {
		const job = send();
		write(socket, { id, ok: true, event: "update", job });
		if (!job || job.status === "done" || job.status === "failed" || job.status === "cancelled") {
			write(socket, { id, ok: true, event: "end", job });
			clearInterval(timer);
			socket.end();
		}
	}, 200);
	socket.on("close", () => clearInterval(timer));
}

async function dispatch(state: ServerState, job: Job): Promise<Job> {
	if (state.inflight.has(job.id) || job.dispatchCount > 0 || job.submissionId) return job;
	state.inflight.add(job.id);
	try {
		const script = scriptFromPayload(job.payload);
		const started = await startConversation(state.opened, job.id, script);
		const dispatched: Job = {
			...job,
			status: "running",
			script,
			conversationId: started.conversation.id,
			submissionId: started.submission.id,
			dispatchCount: 1,
			dispatchedAt: new Date().toISOString(),
		};
		saveJob(state.dataDir, dispatched);
		watch(state, dispatched);
		return dispatched;
	} finally {
		state.inflight.delete(job.id);
	}
}

function watch(state: ServerState, job: Job): void {
	if (!job.submissionId) return;
	void state.opened.harness.submission(job.submissionId as SubmissionId, harnessContext).then(async (submission) => {
		if (!submission) return;
		const settled = await submission.wait(harnessContext);
		const current = readJobs(state.dataDir).find((item) => item.id === job.id) ?? job;
		if (current.status === "cancelled") return;
		saveJob(state.dataDir, {
			...current,
			status: settled.status === "done" ? "done" : "failed",
			finishedAt: new Date().toISOString(),
			...(settled.status === "unanswered" ? { error: settled.reason } : {}),
		});
	});
}

async function cancel(state: ServerState, job: Job): Promise<void> {
	if (job.conversationId) {
		const conversation = await state.opened.harness.conversation(job.conversationId as ConversationId, harnessContext);
		if (conversation) await conversation.abort(harnessContext);
	}
	saveJob(state.dataDir, { ...job, status: "cancelled", finishedAt: new Date().toISOString() });
}

function scriptFromPayload(payload: unknown): ScriptName {
	if (!payload || typeof payload !== "object") return "happy";
	const script = (payload as { script?: unknown }).script;
	if (script === "happy" || script === "crash" || script === "hold") return script;
	return "happy";
}

function findJob(state: ServerState, jobId: string | undefined): Job | undefined {
	const jobs = readJobs(state.dataDir);
	if (!jobId) return jobs.at(-1);
	return jobs.find((job) => job.id === jobId);
}

function write(socket: net.Socket, message: unknown): void {
	socket.write(`${JSON.stringify(message)}\n`);
}

function coded(code: string, message: string): Error {
	const error = new Error(message) as Error & { code: string };
	error.code = code;
	return error;
}

export type { Harness };
