import { config as loadDotenv, parse } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientSecrets } from "../types/index.ts";
import { getRepoRoot } from "./paths.ts";

export function loadRootEnv(repoRoot = getRepoRoot()): void {
  const envPath = join(repoRoot, ".env");
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath, override: false, quiet: true });
  }
}

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parse(readFileSync(path, "utf8"));
}

function nonempty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function loadClientSecrets(slug: string, repoRoot = getRepoRoot()): ClientSecrets {
  const parsed = readEnvFile(join(repoRoot, "clients", slug, ".env"));
  return Object.freeze({
    notionToken: nonempty(parsed.NOTION_TOKEN),
    asanaToken: nonempty(parsed.ASANA_ACCESS_TOKEN),
    externalBaseUrl: nonempty(parsed.EXTERNAL_BASE_URL),
    externalApiKey: nonempty(parsed.EXTERNAL_API_KEY),
  });
}

export function secretValues(secrets: ClientSecrets): string[] {
  return [secrets.notionToken, secrets.asanaToken, secrets.externalApiKey].filter(
    (value): value is string => Boolean(value),
  );
}

export function credentialFor(secrets: ClientSecrets, system: "notion" | "asana"): string {
  const value = system === "notion" ? secrets.notionToken : secrets.asanaToken;
  if (!value) {
    throw new Error(`${system} credentials are not set for this client.`);
  }
  return value;
}
