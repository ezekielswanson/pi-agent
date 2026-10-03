import { errorMessage } from "../utils/errors.ts";
import type { LoadedClient } from "../types/index.ts";
import { readSessionPhase, writeSessionPhase, type ClientSession } from "./clientSession.ts";

export interface ClientSwitchIO {
  repoRoot: string;
  session: ClientSession;
  listSlugs(): string[];
  load(slug: string): LoadedClient;
  getActiveSlug(): string | null;
  setActiveSlug(slug: string): void;
  clearActiveSlug(): void;
  getEnvClient(): string | undefined;
  setEnvClient(slug: string | undefined): void;
  disableTools(): void;
  startFreshSession(): Promise<{ cancelled: boolean }>;
}

export type SwitchResult =
  | { ok: true; slug: string }
  | { ok: false; reason: "busy" | "invalid" | "transition_failed"; error: string; toolsDisabled: boolean };

function restoreActive(
  io: ClientSwitchIO,
  previousSlug: string | null,
  previousEnv: string | undefined,
): void {
  try {
    if (previousSlug) io.setActiveSlug(previousSlug);
    else io.clearActiveSlug();
    io.setEnvClient(previousEnv);
  } catch {
    // Leave tools disabled even if the previous slug cannot be restored.
  }
}

export async function switchClient(slug: string, io: ClientSwitchIO): Promise<SwitchResult> {
  if (io.session.busy) {
    return {
      ok: false,
      reason: "busy",
      error: "Client switch refused while tools or approvals are active.",
      toolsDisabled: false,
    };
  }

  try {
    if (!io.listSlugs().includes(slug)) throw new Error(`Unknown client "${slug}".`);
    const loaded = io.load(slug);
    if (loaded.slug !== slug) throw new Error(`Loaded client "${loaded.slug}" did not match "${slug}".`);
  } catch (err) {
    return { ok: false, reason: "invalid", error: errorMessage(err), toolsDisabled: false };
  }

  const previousSlug = io.getActiveSlug();
  const previousEnv = io.getEnvClient();
  io.session.invalidate();
  io.session.armedSlug = slug;
  io.session.toolsEnabled = false;
  io.disableTools();
  writeSessionPhase(io.repoRoot, { phase: "switching", slug });

  try {
    io.setActiveSlug(slug);
    io.setEnvClient(slug);
    const started = await io.startFreshSession();
    if (started.cancelled) throw new Error("Fresh session was cancelled.");
    const phase = readSessionPhase(io.repoRoot);
    if (phase.phase !== "ready" || phase.slug !== slug) {
      throw new Error("Fresh session did not become ready.");
    }
    return { ok: true, slug };
  } catch (err) {
    io.session.toolsEnabled = false;
    io.session.armedSlug = null;
    writeSessionPhase(io.repoRoot, { phase: "failed", slug: null });
    restoreActive(io, previousSlug, previousEnv);
    return {
      ok: false,
      reason: "transition_failed",
      error: errorMessage(err),
      toolsDisabled: true,
    };
  }
}
