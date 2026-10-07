import net from "node:net";
import type { ClientRequest } from "./server.ts";

export type RpcResponse = {
	id: string;
	ok: boolean;
	result?: { pid: number; status: string; durable: string };
	job?: { id: string; key: string; status: string; dispatchCount: number; payload?: unknown };
	jobs?: { id: string; key: string; status: string; dispatchCount: number }[];
	event?: string;
	error?: { code: string; message: string };
};

export function rpc(socketPath: string, request: ClientRequest, timeoutMs = 10_000): Promise<RpcResponse> {
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
