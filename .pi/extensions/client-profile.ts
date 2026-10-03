import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearActiveClientSlug, getActiveClientSlug, listClientSlugs, setActiveClientSlug } from "../../src/config/activeClient.ts";
import { formatClientPromptBlock, loadClientProfile } from "../../src/config/loadClientProfile.ts";
import { reviewBlocksTool } from "../../src/runtime/agentMode.ts";
import { applySessionStart, clientSession } from "../../src/runtime/clientSession.ts";
import { switchClient } from "../../src/runtime/switchClient.ts";
import { getRepoRoot } from "../../src/config/paths.ts";
import { sanitizeErrorMessage } from "../../src/utils/errors.ts";
import { injectClientContext } from "../../src/config/clientPrompt.ts";

function setEnvClient(slug: string | undefined): void {
  if (slug) process.env.PI_CLIENT = slug;
  else delete process.env.PI_CLIENT;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    applySessionStart(event.reason, {
      repoRoot: getRepoRoot(),
      session: clientSession,
      activeSlug: getActiveClientSlug(),
      setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
    });
    if (!clientSession.toolsEnabled) {
      ctx.ui.notify("Run /client <slug> to start a fresh client session. Tools stay disabled until then.", "warning");
      return;
    }
    try {
      const loaded = loadClientProfile();
      ctx.ui.notify(`Client session: ${loaded.profile.name} (${loaded.slug})`, "info");
    } catch (err) {
      clientSession.toolsEnabled = false;
      pi.setActiveTools([]);
      ctx.ui.notify(sanitizeErrorMessage(err), "error");
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!clientSession.toolsEnabled) {
      return injectClientContext(
        event.systemPrompt,
        "No client session is active. Run /client <slug> to validate a profile and start a fresh session before tools are enabled.",
      );
    }
    try {
      const loaded = loadClientProfile();
      return injectClientContext(
        event.systemPrompt,
        formatClientPromptBlock(loaded, {
          toolsEnabled: true,
          portalVerified:
            clientSession.verifiedPortal?.slug === loaded.slug &&
            String(loaded.profile.hubspot.expectedPortalId ?? "") === clientSession.verifiedPortal.portalId,
          mode: clientSession.mode,
        }),
      );
    } catch (err) {
      clientSession.toolsEnabled = false;
      return injectClientContext(event.systemPrompt, `Client session disabled. ${sanitizeErrorMessage(err)}`);
    }
  });

  pi.on("tool_call", (event) => {
    const reason = reviewBlocksTool(clientSession.mode, event.toolName);
    if (reason) return { block: true, reason };
  });

  pi.on("user_bash", () => {
    if (clientSession.mode !== "review") return;
    return {
      result: {
        output: "Review mode blocks shell execution. This is not an OS sandbox.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.on("tool_execution_start", (event) => {
    clientSession.beginTool(event.toolCallId);
  });

  pi.on("tool_execution_end", (event) => {
    clientSession.endTool(event.toolCallId);
  });

  pi.registerCommand("client", {
    description: "Validate a client profile and start a fresh session before enabling its tools",
    getArgumentCompletions: (prefix: string) => {
      const items = listClientSlugs().map((slug) => ({ value: slug, label: slug }));
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : items;
    },
    handler: async (args, ctx) => {
      const available = listClientSlugs();
      if (available.length === 0) {
        ctx.ui.notify("No client profiles found under clients/.", "error");
        return;
      }

      const requested = args.trim();
      let slug = requested;
      if (!slug) {
        const choice = await ctx.ui.select("Select client:", available);
        if (!choice) return;
        slug = choice;
      }

      if (clientSession.busy) {
        ctx.ui.notify("Client switch refused while tools or approvals are active.", "error");
        return;
      }

      ctx.ui.notify(`Starting a fresh session for ${slug}. Tools stay disabled if it fails.`, "info");
      const result = await switchClient(slug, {
        repoRoot: getRepoRoot(),
        session: clientSession,
        listSlugs: () => listClientSlugs(),
        load: (next) => loadClientProfile(next),
        getActiveSlug: () => getActiveClientSlug(),
        setActiveSlug: (next) => setActiveClientSlug(next),
        clearActiveSlug: () => clearActiveClientSlug(),
        getEnvClient: () => process.env.PI_CLIENT,
        setEnvClient,
        disableTools: () => pi.setActiveTools([]),
        startFreshSession: () => {
          if (typeof ctx.newSession !== "function") return Promise.resolve({ cancelled: true });
          return ctx.newSession({});
        },
      });

      if (!result.ok && result.reason !== "transition_failed") {
        ctx.ui.notify(result.error, "error");
      }
    },
  });

  pi.registerCommand("mode", {
    description: "Switch between review mode and implementation mode",
    handler: async (args, ctx) => {
      const requested = args.trim() || "review";
      if (requested === "review") {
        clientSession.mode = "review";
        ctx.ui.notify("Review mode. Edit, write, and shell tools are disabled. This is not an OS sandbox.", "info");
        return;
      }
      if (requested !== "implement") {
        ctx.ui.notify("Use /mode review or /mode implement.", "error");
        return;
      }
      if (!clientSession.toolsEnabled) {
        ctx.ui.notify("Run /client before implementation mode.", "error");
        return;
      }
      if (typeof ctx.ui.confirm !== "function") {
        ctx.ui.notify("Approval UI is unavailable. Staying in review mode.", "error");
        return;
      }
      const allowed = await ctx.ui.confirm(
        "implement",
        "Enable edit, write, and shell tools for this session? Each write still needs its own approval. This is not an OS sandbox.",
      );
      if (!allowed) {
        clientSession.mode = "review";
        ctx.ui.notify("Staying in review mode.", "info");
        return;
      }
      clientSession.mode = "implement";
      ctx.ui.notify("Implementation mode. Writes and shell still require their own approvals.", "info");
    },
  });
}
