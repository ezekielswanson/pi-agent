import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function looksLikeRepoRoot(dir: string): boolean {
  return existsSync(join(dir, "clients")) && existsSync(join(dir, "package.json"));
}

function walkForRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (looksLikeRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function getRepoRoot(start?: string): string {
  const candidates = [start, process.env.PI_AGENT_ROOT, process.cwd()].filter(
    (value): value is string => Boolean(value),
  );

  for (const candidate of candidates) {
    const found = walkForRoot(candidate);
    if (found) return found;
  }

  const fromModule = walkForRoot(dirname(fileURLToPath(import.meta.url)));
  if (fromModule) return fromModule;

  throw new Error("Could not find the pi-agent repo root (expected clients/ and package.json).");
}
