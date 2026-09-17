import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot } from "./paths.ts";

export function loadRootEnv(repoRoot = getRepoRoot()): void {
  const envPath = join(repoRoot, ".env");
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath, override: false });
  }
}

export function loadClientEnv(slug: string, repoRoot = getRepoRoot()): void {
  const envPath = join(repoRoot, "clients", slug, ".env");
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath, override: true });
  }
}
