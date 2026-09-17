import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listClientSlugs, setActiveClientSlug } from "../../src/config/activeClient.ts";
import { formatClientPromptBlock, loadClientProfile } from "../../src/config/loadClientProfile.ts";
import { errorMessage } from "../../src/utils/index.ts";

function ensureSections(event: {
  systemPromptOptions?: { sections?: Record<string, string> };
}): Record<string, string> {
  const options = event.systemPromptOptions ?? (event.systemPromptOptions = {});
  if (!options.sections) options.sections = {};
  return options.sections;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const loaded = loadClientProfile();
      ctx.ui.notify(`Client: ${loaded.profile.name}`, "info");
    } catch (err) {
      ctx.ui.notify(errorMessage(err), "warning");
    }
  });

  pi.on("before_agent_start", async (event) => {
    const sections = ensureSections(event);
    try {
      const loaded = loadClientProfile();
      sections.client_profile = formatClientPromptBlock(loaded.profile);
    } catch (err) {
      sections.client_profile = `No client loaded. ${errorMessage(err)}`;
    }
  });

  pi.registerCommand("client", {
    description: "List or select the active client profile",
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

      if (!available.includes(slug)) {
        ctx.ui.notify(`Unknown client "${slug}". Available: ${available.join(", ")}`, "error");
        return;
      }

      setActiveClientSlug(slug);
      process.env.PI_CLIENT = slug;
      const loaded = loadClientProfile(slug);
      ctx.ui.notify(`Active client: ${loaded.profile.name}`, "info");
    },
  });
}
