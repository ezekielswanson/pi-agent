import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export type RunnerMode = "offline" | "live";
export function parseMode(value: string | undefined): RunnerMode {
	if (value === undefined || value === "offline") return "offline";
	if (value === "live") return "live";
	throw new Error("--mode must be offline or live");
}
/** Mode identity is persisted before any session opens. A directory cannot change modes. */
export function bindMode(dataDir: string, mode: RunnerMode): void {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const path = join(dataDir, "mode.json");
	if (
		mode === "live" &&
		!existsSync(path) &&
		["investigation.sqlite", "jobs.json", "run.json"].some((file) =>
			existsSync(join(dataDir, file)),
		)
	)
		throw new Error(
			"Existing data has no live mode identity; use a separate directory",
		);
	try {
		writeFileSync(path, JSON.stringify({ mode }), { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const saved = JSON.parse(readFileSync(path, "utf8"));
		if (saved.mode !== mode)
			throw new Error(
				"Data directory belongs to a different mode; use a separate directory",
			);
	}
}
