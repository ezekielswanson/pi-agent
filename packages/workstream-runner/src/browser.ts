import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { Type } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineTool,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

const BrowserProofDoc = defineDoc<{
	proof: {
		url: string;
		heading: string;
		status: "passed" | "failed";
		httpStatus: number | null;
		body: string;
		error: string | null;
		title: string;
		profile: string;
		screenshot: string;
		conversationId: number;
		taskId: number;
		at: string;
	} | null;
}>({
	kind: "app.public-browser",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ proof: null }),
});
/** No URL parameter, login, normal-profile attachment, or Matrix capability. */
export function publicBrowserTool(
	dataDir: string,
	authorize: (api: ToolExecutionApi, context: Context) => Promise<void>,
) {
	return defineTool({
		name: "public_browser_smoke",
		description:
			"Use Pi's dedicated automation Chrome profile to inspect https://example.com and persist visual proof. No login or Matrix access.",
		parameters: Type.Object({}, { additionalProperties: false }),
		replay: "safe",
		execute: async (_args, api, context) => {
			await authorize(api, context);
			const previous = await api.commit(async (tx) => {
				const doc = await tx.doc(BrowserProofDoc, api.conversationId);
				return doc.proof ? { ...doc.proof } : null;
			}, context);
			if (previous)
				return {
					isError: previous.status !== "passed",
					content: [{ type: "text" as const, text: JSON.stringify(previous) }],
				};
			const profile = join(resolve(dataDir), "public-browser-profile");
			mkdirSync(profile, { recursive: true, mode: 0o700 });
			chmodSync(profile, 0o700);
			const browser = await chromium.launchPersistentContext(profile, {
				channel: "chrome",
				headless: false,
				chromiumSandbox: true,
				timeout: 20000,
				acceptDownloads: false,
				serviceWorkers: "block",
			});
			const abort = () => {
				void browser.close();
			};
			context.abortSignal?.addEventListener("abort", abort, { once: true });
			try {
				if (context.abortSignal?.aborted)
					throw new Error("Browser smoke test cancelled");
				await browser.route("**/*", (route) =>
					new URL(route.request().url()).origin === "https://example.com"
						? route.continue()
						: route.abort(),
				);
				const page = await browser.newPage();
				let httpStatus: number | null = null;
				let error: string | null = null;
				let heading = "";
				try {
					const response = await page.goto("https://example.com", {
						waitUntil: "domcontentloaded",
						timeout: 15000,
					});
					httpStatus = response?.status() ?? null;
					heading = await page
						.getByRole("heading", { name: "Example Domain", exact: true })
						.innerText({ timeout: 5000 });
				} catch (failure) {
					error = failure instanceof Error ? failure.message : String(failure);
				}
				// Preserve the actual page even when validation fails; a finished model
				// response is not proof that the browser smoke test passed.
				const body = (await page.locator("body").innerText({ timeout: 3000 })
					.catch(() => "")).slice(0, 12000);
				const screenshot = join(
					resolve(dataDir),
					`public-browser-${api.conversationId}.png`,
				);
				await page.screenshot({ path: screenshot });
				chmodSync(screenshot, 0o600);
				const proof = {
					url: page.url(),
					heading,
					status: (!error && httpStatus === 200 && page.url() === "https://example.com/" && heading === "Example Domain"
						? "passed" : "failed") as "passed" | "failed",
					httpStatus,
					body,
					error,
					title: await page.title(),
					profile,
					screenshot,
					conversationId: api.conversationId,
					taskId: api.taskId,
					at: new Date().toISOString(),
				};
				await api.commit(async (tx) => {
					const doc = await tx.doc(BrowserProofDoc, api.conversationId);
					doc.proof = proof;
				}, context);
				return {
					isError: proof.status !== "passed",
					content: [{ type: "text" as const, text: JSON.stringify(proof) }],
					details: { origin: "pi-durable-tool", ...proof },
				};
			} finally {
				context.abortSignal?.removeEventListener("abort", abort);
				await browser.close();
			}
		},
	});
}
