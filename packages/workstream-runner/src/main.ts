import "./offline.ts";
import { installOfflineGuard, networkAttempts } from "./offline.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { rpc } from "./client.ts";
import { detachServe } from "./detach.ts";
import { NODE_BIN } from "./node-bin.ts";
import { resumeOnce, runOnce } from "./runner.ts";
import type { ScriptName } from "./script.ts";
import { serve, socketPath } from "./server.ts";
import { DURABLE_EXPORTS } from "./tools.ts";

installOfflineGuard();

const args = process.argv.slice(2);
const command = args[0] ?? "help";

function flag(name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function dataDir(): string {
	return flag("--data") ?? join(homedir(), ".workstream-runner");
}

function scriptFlag(): ScriptName {
	const script = flag("--script");
	if (script === "happy" || script === "crash" || script === "hold") return script;
	return "happy";
}

async function main(): Promise<void> {
	if (command === "serve") {
		await serve(dataDir());
		return;
	}
	if (command === "detach") {
		const pid = detachServe(dataDir());
		console.log(JSON.stringify({ pid, node: NODE_BIN, data: dataDir() }));
		return;
	}
	if (command === "run-once") {
		await runOnce(dataDir(), scriptFlag());
		return;
	}
	if (command === "resume-once") {
		await resumeOnce(dataDir());
		return;
	}
	if (command === "exports") {
		console.log(DURABLE_EXPORTS.join("\n"));
		console.log(`networkAttempts=${networkAttempts().length}`);
		return;
	}
	const sock = socketPath(dataDir());
	const id = `${command}-${Date.now()}`;
	if (command === "health") {
		console.log(JSON.stringify(await rpc(sock, { id, op: "health" })));
		return;
	}
	if (command === "start") {
		const key = flag("--key");
		if (!key) throw new Error("start requires --key");
		const payload = JSON.parse(flag("--payload") ?? "{}") as unknown;
		const response = await rpc(sock, { id, op: "start", key, payload });
		console.log(JSON.stringify(response));
		if (!response.ok) process.exitCode = 1;
		return;
	}
	if (command === "list" || command === "status") {
		console.log(JSON.stringify(await rpc(sock, { id, op: command === "status" ? "status" : "list", jobId: flag("--job") })));
		return;
	}
	if (command === "get" || command === "cancel") {
		console.log(JSON.stringify(await rpc(sock, { id, op: command, jobId: flag("--job") })));
		return;
	}
	if (command === "subscribe") {
		console.log(JSON.stringify(await rpc(sock, { id, op: "subscribe", jobId: flag("--job") })));
		return;
	}
	console.log(`usage: ${NODE_BIN} --import tsx src/main.ts <serve|detach|health|start|list|status|get|cancel|subscribe|run-once|resume-once>`);
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exitCode = 1;
});
