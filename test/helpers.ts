import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearActiveClientSlug, getActiveClientSlug, listClientSlugs, setActiveClientSlug } from "../src/config/activeClient.ts";
import { loadClientProfile } from "../src/config/loadClientProfile.ts";
import { applySessionStart, type ClientSession } from "../src/runtime/clientSession.ts";
import { switchClient, type SwitchResult } from "../src/runtime/switchClient.ts";

export function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-"));
  mkdirSync(join(root, "clients"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}\n");
  return root;
}

export function removeRepo(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function writeClient(
  root: string,
  slug: string,
  options: {
    notionToken?: string;
    asanaToken?: string;
    externalApiKey?: string;
    rules?: string;
    profile?: Record<string, unknown>;
  } = {},
): void {
  const dir = join(root, "clients", slug);
  mkdirSync(join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "prompts"), { recursive: true });
  const profile = options.profile ?? {
    name: slug,
    slug,
    hubspot: { expectedPortalId: null },
    notion: { databaseIds: {}, pageIds: {}, testPageId: null, outputParent: null },
    asana: { mode: "rest", workspaceGid: null, projectGids: {}, testProjectGid: null },
    researchRoots: [],
    allowlist: {
      notionPageIds: [],
      notionDatabaseIds: [],
      notionDataSourceIds: [],
      asanaProjectGids: [],
      asanaTaskGids: [],
      hubspotPortalIds: [],
      localRoots: [],
    },
    external: { enabled: false, system: "unspecified" },
  };
  writeFileSync(join(dir, "config", "profile.json"), `${JSON.stringify(profile, null, 2)}\n`);
  if (options.rules !== undefined) {
    writeFileSync(join(dir, "prompts", "operating-rules.md"), options.rules);
  }
  const lines = [
    options.notionToken ? `NOTION_TOKEN=${options.notionToken}` : "",
    options.asanaToken ? `ASANA_ACCESS_TOKEN=${options.asanaToken}` : "",
    options.externalApiKey ? `EXTERNAL_API_KEY=${options.externalApiKey}` : "",
  ].filter(Boolean);
  if (lines.length > 0) writeFileSync(join(dir, ".env"), `${lines.join("\n")}\n`);
}

export async function withEnv<T>(updates: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function runSwitch(
  root: string,
  session: ClientSession,
  slug: string,
  mode: "ready" | "cancel" | "throw" = "ready",
): Promise<{ result: SwitchResult; disabled: number; toolsCleared: number }> {
  let disabled = 0;
  let toolsCleared = 0;
  const result = await switchClient(slug, {
    repoRoot: root,
    session,
    listSlugs: () => listClientSlugs(root),
    load: (next) => loadClientProfile(next, root),
    getActiveSlug: () => getActiveClientSlug(root),
    setActiveSlug: (next) => setActiveClientSlug(next, root),
    clearActiveSlug: () => clearActiveClientSlug(root),
    getEnvClient: () => process.env.PI_CLIENT,
    setEnvClient: (next) => {
      if (next) process.env.PI_CLIENT = next;
      else delete process.env.PI_CLIENT;
    },
    disableTools: () => {
      disabled += 1;
    },
    startFreshSession: async () => {
      if (mode === "cancel") return { cancelled: true };
      if (mode === "throw") throw new Error("session failed");
      applySessionStart("new", {
        repoRoot: root,
        session,
        activeSlug: getActiveClientSlug(root),
        setActiveTools: () => {
          toolsCleared += 1;
        },
      });
      return { cancelled: false };
    },
  });
  return { result, disabled, toolsCleared };
}
