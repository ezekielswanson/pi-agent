import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot } from "./paths.ts";

const ACTIVE_CLIENT_FILE = "active-client.json";

export function listClientSlugs(repoRoot = getRepoRoot()): string[] {
  const clientsDir = join(repoRoot, "clients");
  if (!existsSync(clientsDir)) return [];

  return readdirSync(clientsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(clientsDir, entry.name, "config", "profile.json")),
    )
    .map((entry) => entry.name)
    .sort();
}

export function getActiveClientSlug(repoRoot = getRepoRoot()): string | null {
  const fromEnv = process.env.PI_CLIENT?.trim();
  if (fromEnv) return fromEnv;

  const activePath = join(repoRoot, ".pi", ACTIVE_CLIENT_FILE);
  if (!existsSync(activePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(activePath, "utf8")) as { slug?: unknown };
    return typeof parsed.slug === "string" && parsed.slug.trim() ? parsed.slug.trim() : null;
  } catch {
    return null;
  }
}

export function setActiveClientSlug(slug: string, repoRoot = getRepoRoot()): void {
  const piDir = join(repoRoot, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, ACTIVE_CLIENT_FILE), `${JSON.stringify({ slug }, null, 2)}\n`);
}
