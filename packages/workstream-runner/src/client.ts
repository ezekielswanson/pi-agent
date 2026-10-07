import net from "node:net";
import type { ClientRequest } from "./server.ts";

export type RpcResponse = {
	id: string;
	ok: boolean;
	result?: {
		pid: number;
		status: string;
		durable: string;
		mode?: string;
		target?: string;
		model?: { provider: string; modelId: string };
		connectionId?: string | null;
	};
	job?: {
		id: string;
		key: string;
		status: string;
		dispatchCount: number;
		payload?: unknown;
	};
	jobs?: { id: string; key: string; status: string; dispatchCount: number }[];
	event?: string;
	error?: { code: string; message: string };
};

export function rpc(
	socketPath: string,
	request: ClientRequest,
	timeoutMs = 10_000,
): Promise<RpcResponse> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`timed out waiting for ${request.op}`));
		}, timeoutMs);
		let buffer = "";
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timer);
			socket.end();
			resolve(JSON.parse(buffer.slice(0, newline)) as RpcResponse);
		});
		socket.write(`${JSON.stringify(request)}\n`);
	});
}

/** Continuing NDJSON updates. Each reconnect begins with the current persisted snapshot. */
export async function* subscribe(
	socketPath: string,
	jobId: string,
	options: { signal?: AbortSignal; reconnectMs?: number } = {},
): AsyncGenerator<RpcResponse> {
	while (!options.signal?.aborted) {
		const socket = net.createConnection(socketPath);
		const abort = () => socket.destroy();
		options.signal?.addEventListener("abort", abort, { once: true });
		let ended = false;
		let buffer = "";
		try {
			socket.write(
				`${JSON.stringify({ id: "subscription", op: "subscribe", jobId })}\n`,
			);
			for await (const chunk of socket) {
				buffer += chunk.toString();
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const response = JSON.parse(buffer.slice(0, newline)) as RpcResponse;
					buffer = buffer.slice(newline + 1);
					yield response;
					if (response.event === "end" || !response.ok) {
						ended = true;
						return;
					}
				}
			}
		} catch {
			if (options.signal?.aborted) return;
		} finally {
			options.signal?.removeEventListener("abort", abort);
			socket.destroy();
		}
		if (ended || options.signal?.aborted) return;
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, options.reconnectMs ?? 250);
			options.signal?.addEventListener("abort", done, { once: true });
		});
	}
}
