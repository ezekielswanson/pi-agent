import { createHash, randomUUID } from "node:crypto";
import type { ScriptName } from "./script.ts";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
	openSync,
	fsyncSync,
	closeSync,
} from "node:fs";
import { join } from "node:path";

export type JobStatus =
	"accepted" | "running" | "done" | "failed" | "cancelled";

export type Job = {
	id: string;
	key: string;
	payload: unknown;
	payloadHash: string;
	status: JobStatus;
	conversationId?: number;
	submissionId?: number;
	dispatchCount: number;
	script?: ScriptName;
	createdAt: string;
	dispatchedAt?: string;
	finishedAt?: string;
	error?: string;
};

type Store = { jobs: Job[] };

function storePath(dataDir: string): string {
	return join(dataDir, "jobs.json");
}

export function payloadHash(payload: unknown): string {
	return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function readJobs(dataDir: string): Job[] {
	try {
		const parsed = JSON.parse(
			readFileSync(storePath(dataDir), "utf8"),
		) as Store;
		return parsed.jobs ?? [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** Atomic replace plus fsync of the directory entry's file. */
export function writeJobs(dataDir: string, jobs: Job[]): void {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const path = storePath(dataDir);
	const tmp = `${path}.${process.pid}.tmp`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeFileSync(fd, JSON.stringify({ jobs }, null, 2));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	const directory = openSync(dataDir, "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

export function acceptJob(
	dataDir: string,
	key: string,
	payload: unknown,
): { job: Job; created: boolean; conflict: boolean } {
	const jobs = readJobs(dataDir);
	const hash = payloadHash(payload);
	const existing = jobs.find((job) => job.key === key);
	if (existing) {
		if (existing.payloadHash !== hash)
			return { job: existing, created: false, conflict: true };
		return { job: existing, created: false, conflict: false };
	}
	const job: Job = {
		id: randomUUID(),
		key,
		payload,
		payloadHash: hash,
		status: "accepted",
		dispatchCount: 0,
		createdAt: new Date().toISOString(),
	};
	jobs.push(job);
	writeJobs(dataDir, jobs);
	return { job, created: true, conflict: false };
}

export function saveJob(dataDir: string, job: Job): Job {
	const jobs = readJobs(dataDir);
	const index = jobs.findIndex((item) => item.id === job.id);
	if (index === -1) jobs.push(job);
	else jobs[index] = job;
	writeJobs(dataDir, jobs);
	return job;
}
