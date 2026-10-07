import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";

const attempts: string[] = [];
let installed = false;

function note(detail: string): Error {
	attempts.push(detail);
	return new Error(`offline guard refused network: ${detail}`);
}

function isUnixSocket(target: unknown): boolean {
	// Node 22.23 calls connect() with the already-normalized [options, callback] pair.
	if (Array.isArray(target)) return isUnixSocket(target[0]);
	if (typeof target === "string") return target.startsWith("/") || target.startsWith("\0");
	if (target && typeof target === "object" && "path" in target) {
		const path = (target as { path?: unknown }).path;
		return typeof path === "string" && (path.startsWith("/") || path.startsWith("\0"));
	}
	return false;
}

/** Refuse TCP, DNS, and fetch. Unix-domain sockets stay available for the local CLI. */
export function installOfflineGuard(): void {
	if (installed) return;
	installed = true;

	const originalConnect = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function connected(this: net.Socket, ...args: unknown[]) {
		if (!isUnixSocket(args[0])) throw note(`socket ${JSON.stringify(args[0])}`);
		return originalConnect.apply(this, args as never);
	} as typeof net.Socket.prototype.connect;

	const denyRequest = (kind: string) =>
		(() => {
			throw note(kind);
		}) as typeof http.request;

	http.request = denyRequest("http.request");
	http.get = denyRequest("http.get") as typeof http.get;
	https.request = denyRequest("https.request");
	https.get = denyRequest("https.get") as typeof https.get;

	const denyLookup = (kind: string) =>
		((..._args: unknown[]) => {
			throw note(kind);
		}) as unknown as typeof dns.lookup;
	dns.lookup = denyLookup("dns.lookup");
	dns.promises.lookup = (async () => {
		throw note("dns.promises.lookup");
	}) as typeof dns.promises.lookup;

	globalThis.fetch = (async (input) => {
		throw note(`fetch ${typeof input === "string" ? input : "request"}`);
	}) as typeof fetch;
}

export function networkAttempts(): readonly string[] {
	return attempts;
}
