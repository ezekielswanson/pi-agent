import type { RunnerMode } from "./mode.ts";
import { spawn } from "node:child_process";
import { closeSync, chmodSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_BIN } from "./node-bin.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function safeEnv(): NodeJS.ProcessEnv {
	return {
		HOME: process.env.HOME,
		TMPDIR: process.env.TMPDIR,
		PATH: `${dirname(NODE_BIN)}:/usr/bin:/bin`,
		LANG: process.env.LANG,
	};
}

/** New session via detached spawn (setsid) and a log file so the parent terminal can exit. */
export function detachServe(
	dataDir: string,
	mode: RunnerMode = "offline",
	configPath?: string,
): number {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	chmodSync(dataDir, 0o700);
	const log = openSync(join(dataDir, "runner.log"), "a", 0o600);
	const child = spawn(
		NODE_BIN,
		[
			"--import",
			"tsx",
			join(packageRoot, "src", "main.ts"),
			"serve",
			"--data",
			dataDir,
			"--mode",
			mode,
			...(configPath ? ["--config", configPath] : []),
		],
		{
			cwd: packageRoot,
			detached: true,
			stdio: ["ignore", log, log],
			env: safeEnv(),
		},
	);
	closeSync(log);
	child.unref();
	if (!child.pid) throw new Error("detached serve did not return a pid");
	return child.pid;
}
