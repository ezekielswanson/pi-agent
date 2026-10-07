import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { NODE_BIN } from "../src/node-bin.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function tempDir(): string {
	return mkdtempSync(join("/tmp", "wsr-"));
}

export function spawnRunner(args: string[], extraEnv: {WSR_TEST_CRASH?: string} = {}): ChildProcess {
	return spawn(NODE_BIN, ["--import", "tsx", join(packageRoot, "src", "main.ts"), ...args], {
		cwd: packageRoot,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			HOME: process.env.HOME,
			TMPDIR: "/tmp",
			PATH: `${dirname(NODE_BIN)}:/usr/bin:/bin`,
			LANG: process.env.LANG,
 ...extraEnv,
		},
	});
}

export async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out\n${stderr}\n${stdout}`)), timeoutMs);
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
	return { ...result, stdout, stderr };
}
