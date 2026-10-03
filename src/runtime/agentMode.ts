import { classifyHubspotTool } from "../connectors/hubspot/approval.ts";
import type { AgentMode } from "./clientSession.ts";

const REVIEW_BLOCKED = new Set([
  "edit",
  "write",
  "bash",
  "powershell",
  "notion_create",
  "notion_update",
  "notion_append",
  "asana_create_task",
  "asana_update_task",
  "asana_comment",
  "external_write",
  "record_receipt",
  "hubspot_prepare_write",
]);

export function reviewBlocksTool(mode: AgentMode, toolName: string): string | null {
  if (mode !== "review") return null;
  if (REVIEW_BLOCKED.has(toolName)) {
    return "Review mode disables edit, write, and shell tools. /mode implement can enable them with approval. This is not an OS sandbox.";
  }
  if (toolName.includes("hubspot") && toolName !== "hubspot_check_portal") {
    const kind = classifyHubspotTool(toolName);
    if (kind !== "read") {
      return "Review mode blocks unclassified or mutating HubSpot tools.";
    }
  }
  return null;
}
