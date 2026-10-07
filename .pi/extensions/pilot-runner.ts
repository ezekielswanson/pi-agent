import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { rpc } from "../../packages/workstream-runner/src/client.ts";
import { detachServe } from "../../packages/workstream-runner/src/detach.ts";

// Desktop view registration protocol verified in installed pi-gui 1.0.1.
// No application-bundle changes and no new model-accessible tool surface.
const service = { id: "pi.durable.pilot", local: false } as const;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = "hubspot/5627913/tickets/48489581088";
const data = (mode: string) => {
	if (mode !== "offline" && mode !== "live")
		throw new Error("Unknown runner mode");
	return join(
		"/private/tmp",
		`pi-durable-pilot-${process.getuid?.() ?? "local"}-${mode}`,
	);
};
const sock = (mode: string) => join(data(mode), "runner.sock");
const request = (
	mode: string,
	op: string,
	extra: Record<string, unknown> = {},
) => rpc(sock(mode), { id: randomUUID(), op, ...extra });
export default function (pi: ExtensionAPI) {
	const declaration = {
		id: "durable-pilot",
		title: "Pi Durable",
		source: fileURLToPath(import.meta.url),
		frontend: new URL(
			"./pilot-runner-ui/view.js",
			import.meta.url,
		),
		backend: () => ({
			id: "pi.durable.pilot.backend",
			setup(env: {
				provide(token: typeof service, implementation: unknown): void;
			}) {
				env.provide(service, {
					async inspect(mode: string, _context: unknown) {
						try {
							return JSON.stringify({
								mode,
								target,
								connected: true,
								health: await request(mode, "health"),
								jobs: await request(mode, "list"),
								approvals:
									"Writes deferred until authenticated broker preflight",
							});
						} catch {
							return JSON.stringify({
								mode,
								target,
								connected: false,
								approvals: "No write authorization pending",
								message: "Runner disconnected. Start a scoped job to connect.",
							});
						}
					},
					async start(mode: "offline" | "live", _context: unknown) {
						try {
							await request(mode, "health");
						} catch {
							detachServe(
								data(mode),
								mode,
								mode === "live"
									? join(
											root,
											"packages/workstream-runner/config/live.example.json",
										)
									: undefined,
							);
							let ready = false;
							for (let i = 0; i < 50; i++) {
								try {
									await request(mode, "health");
									ready = true;
									break;
								} catch {
									await new Promise((resolve) => setTimeout(resolve, 100));
								}
							}
							if (!ready)
								return JSON.stringify({
									ok: false,
									error: {
										code: "preflight_blocked",
										message:
											mode === "live"
												? "Live preflight blocked. Check protected runner.log; Pi HubSpot auth is required."
												: "Runner failed to start",
									},
								});
						}
						return JSON.stringify(
							await request(mode, "start", {
								key: `pilot-48489581088-${mode}-v1`,
								payload: mode === "live" ? { target } : { script: "hold" },
							}),
						);
					},
					async cancel(mode: string, jobId: string, _context: unknown) {
						return JSON.stringify(await request(mode, "cancel", { jobId }));
					},
				});
			},
		}),
	};
	const publish = () =>
		pi.events.emit("pi-gui:desktop-view:register", { declaration });
	const stop = pi.events.on("pi-gui:desktop-view:discover", publish);
	pi.on("session_shutdown", () => {
		stop();
		pi.events.emit("pi-gui:desktop-view:unregister", declaration);
	});
	publish();
}
