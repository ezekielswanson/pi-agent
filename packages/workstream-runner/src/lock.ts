import {
	openSync,
	writeFileSync,
	fsyncSync,
	closeSync,
	readFileSync,
	unlinkSync,
	mkdirSync,
	rmdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** One local process owns the data directory, before opening SQLite or removing a socket. */
export function acquireWriter(dataDir: string): () => void {
	const path = join(dataDir, "runner.lock");
	const token = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
	const create = () => {
		const fd = openSync(path, "wx", 0o600);
		try {
			writeFileSync(fd, token);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	};
	try {
		create();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const reclaim = join(dataDir, "runner.reclaim");
		// Serialize stale-owner reclamation. An incomplete lock fails closed.
		try {
			mkdirSync(reclaim, { mode: 0o700 });
		} catch {
			throw new Error("Runner ownership is being recovered");
		}
		try {
			const owner = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
			if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
				throw new Error("Invalid runner lock; manual recovery required");
			let alive = true;
			try {
				process.kill(owner.pid, 0);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
				else throw e;
			}
			if (alive)
				throw new Error(
					`Runner already owns this directory (pid ${owner.pid})`,
				);
			unlinkSync(path);
			create();
		} finally {
			rmdirSync(reclaim);
		}
	}
	return () => {
		if (readFileSync(path, "utf8") === token) unlinkSync(path);
	};
}
