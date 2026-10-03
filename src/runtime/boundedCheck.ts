import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ClientProfile } from "../types/index.ts";
import { ScopeError } from "../utils/errors.ts";

export function resolveBoundedTestPath(repoRoot: string, _profile: ClientProfile, requested: string): string {
  if (!requested || requested.includes("\0") || /[\n\r;&|`$<>]/.test(requested)) {
    throw new ScopeError("Bounded check path must be a single test file.");
  }
  const absolute = resolve(repoRoot, requested);
  const fromRoot = relative(repoRoot, absolute);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new ScopeError("Bounded check path escapes the repository.");
  }
  const normalized = fromRoot.split(sep).join("/");
  if (!normalized.startsWith("test/") || !normalized.endsWith(".test.ts")) {
    throw new ScopeError("Bounded checks only run files under test/*.test.ts.");
  }
  if (!existsSync(absolute)) throw new ScopeError("Bounded check file does not exist.");
  return normalized;
}
