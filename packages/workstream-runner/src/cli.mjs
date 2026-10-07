#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const child = spawn(
	process.execPath,
	[
		"--import",
		"tsx",
		fileURLToPath(new URL("./main.ts", import.meta.url)),
		...process.argv.slice(2),
	],
	{ stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => child.kill(signal));
child.on("error", () => {
	console.error("Unable to start runner");
	process.exitCode = 1;
});
child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});
