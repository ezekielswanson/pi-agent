import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";

export type ScriptName = "happy" | "crash" | "hold";

const SAFE_TICKET = "hubspot/5627913/tickets/10000000001";
const SAFE_DEAL = "hubspot/5627913/deals/10000000002";

function toolResultCount(context: TranscriptContext): number {
	return context.messages.filter((message) => message.role === "toolResult").length;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
		.join("");
}

function scriptOf(context: TranscriptContext): ScriptName {
	const text = context.messages
		.filter((message) => message.role === "user")
		.map((message) => textOf(message.content))
		.join("\n");
	if (text.includes("script=hold")) return "hold";
	if (text.includes("script=crash")) return "crash";
	return "happy";
}

function call(name: string, args: Record<string, string | number | string[]>): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

/** Canned replies chosen from the committed transcript, so a restarted process continues the same script. */
export function scriptedResponse(context: TranscriptContext): AssistantMessage {
	const script = scriptOf(context);
	const seen = toolResultCount(context);
	if (script === "happy") {
		if (seen === 0) return call("fetch_record", { target: SAFE_TICKET });
		if (seen === 1) return call("search_records", { portalId: "5627913", objectType: "deals", objectIds: ["10000000002"] });
		if (seen === 2) return call("walk_associations", { portalId: "5627913", from: SAFE_TICKET, to: SAFE_DEAL });
		return fauxAssistantMessage("Scripted investigation finished. Retrieved text was kept as evidence.");
	}
	const holdMs = script === "hold" ? 600_000 : 120_000;
	if (seen === 0) return call("fetch_record", { target: SAFE_TICKET });
	if (seen === 1) {
		return call("walk_associations", { portalId: "5627913", from: SAFE_TICKET, to: SAFE_DEAL, holdMs });
	}
	return fauxAssistantMessage("Resumed after interruption. Completed steps were not replayed.");
}
