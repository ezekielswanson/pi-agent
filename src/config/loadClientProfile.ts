import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientProfile, LoadedClient } from "../types/index.ts";
import { getActiveClientSlug, listClientSlugs } from "./activeClient.ts";
import { loadClientEnv, loadRootEnv } from "./loadEnv.ts";
import { getRepoRoot } from "./paths.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.trim()) result[key] = entry;
  }
  return result;
}

function parseProfile(raw: unknown, slug: string): ClientProfile {
  if (!isRecord(raw)) {
    throw new Error(`Client profile for "${slug}" is not a JSON object.`);
  }

  const hubspot = isRecord(raw.hubspot) ? raw.hubspot : {};
  const notion = isRecord(raw.notion) ? raw.notion : {};
  const asana = isRecord(raw.asana) ? raw.asana : {};
  const external = isRecord(raw.external) ? raw.external : {};

  return {
    name: typeof raw.name === "string" ? raw.name : slug,
    slug,
    hubspot: {
      expectedPortalId:
        typeof hubspot.expectedPortalId === "string" || typeof hubspot.expectedPortalId === "number"
          ? hubspot.expectedPortalId
          : null,
      notes: typeof hubspot.notes === "string" ? hubspot.notes : undefined,
    },
    notion: {
      databaseIds: asStringRecord(notion.databaseIds),
      pageIds: asStringRecord(notion.pageIds),
    },
    asana: {
      workspaceGid: typeof asana.workspaceGid === "string" ? asana.workspaceGid : null,
      projectGids: asStringRecord(asana.projectGids),
    },
    external: {
      enabled: external.enabled === true,
      system: typeof external.system === "string" ? external.system : "unspecified",
    },
  };
}

export function formatClientPromptBlock(profile: ClientProfile): string {
  const lines = [
    `Active client: ${profile.name} (${profile.slug})`,
    `HubSpot expected portal: ${profile.hubspot.expectedPortalId ?? "not set"}`,
    profile.hubspot.notes ? `HubSpot notes: ${profile.hubspot.notes}` : "",
    `Notion databases: ${JSON.stringify(profile.notion.databaseIds)}`,
    `Notion pages: ${JSON.stringify(profile.notion.pageIds)}`,
    `Asana workspace: ${profile.asana.workspaceGid ?? "not set"}`,
    `Asana projects: ${JSON.stringify(profile.asana.projectGids)}`,
    `External system: ${profile.external.enabled ? profile.external.system : "disabled (stub)"}`,
    "Write safety: confirm with the user before creating or updating records. Keep writes small and explicit.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function loadClientProfile(slug?: string, repoRoot = getRepoRoot()): LoadedClient {
  loadRootEnv(repoRoot);
  const available = listClientSlugs(repoRoot);
  const resolved = slug ?? getActiveClientSlug(repoRoot);

  if (!resolved) {
    throw new Error(
      `No client selected. Set PI_CLIENT or run /client. Available: ${available.join(", ") || "(none)"}`,
    );
  }

  if (!available.includes(resolved)) {
    throw new Error(`Unknown client "${resolved}". Available: ${available.join(", ") || "(none)"}`);
  }

  loadClientEnv(resolved, repoRoot);
  const clientDir = join(repoRoot, "clients", resolved);
  const raw = JSON.parse(readFileSync(join(clientDir, "config", "profile.json"), "utf8")) as unknown;
  const profile = parseProfile(raw, resolved);

  return { profile, slug: resolved, clientDir };
}
