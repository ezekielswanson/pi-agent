import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SessionPhase = "idle" | "switching" | "ready" | "failed";
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export interface SessionPhaseRecord {
  phase: SessionPhase;
  slug: string | null;
}

export interface VerifiedPortal {
  slug: string;
  portalId: string;
  connectionId: string;
}

const SESSION_FILE = "client-session.json";

export type AgentMode = "review" | "implement";

export class ClientSession {
  private inFlight = new Set<string>();
  pendingApprovals = 0;
  toolsEnabled = false;
  generation = 0;
  armedSlug: string | null = null;
  mode: AgentMode = "review";
  verifiedPortal: VerifiedPortal | null = null;
  hubspotConnectionId: string | null = null;
  private grants = new Map<string, { hash: string; generation: number }>();
  private hubspotGrants: string[] = [];

  get busy(): boolean {
    return this.inFlight.size > 0 || this.pendingApprovals > 0;
  }

  beginTool(id: string): void {
    this.inFlight.add(id);
  }

  endTool(id: string): void {
    this.inFlight.delete(id);
  }

  beginApproval(): void {
    this.pendingApprovals += 1;
  }

  endApproval(): void {
    this.pendingApprovals = Math.max(0, this.pendingApprovals - 1);
  }

  invalidate(): void {
    this.generation += 1;
    this.clearHubspotTrust();
    this.grants.clear();
    this.toolsEnabled = false;
    this.armedSlug = null;
    this.mode = "review";
  }

  clearHubspotTrust(): void {
    this.verifiedPortal = null;
    this.hubspotConnectionId = null;
    this.hubspotGrants = [];
  }

  openHubspotConnection(connectionId: string): void {
    if (this.hubspotConnectionId === connectionId) return;
    this.verifiedPortal = null;
    this.hubspotGrants = [];
    this.hubspotConnectionId = connectionId;
  }

  rememberHubspotGrant(hash: string): void {
    this.hubspotGrants.push(hash);
  }

  hasHubspotGrant(hash: string): boolean {
    return this.hubspotGrants.includes(hash);
  }

  consumeHubspotGrant(hash: string): boolean {
    const index = this.hubspotGrants.indexOf(hash);
    if (index < 0) return false;
    this.hubspotGrants.splice(index, 1);
    return true;
  }

  rememberGrant(hash: string): string {
    const id = randomUUID();
    this.grants.set(id, { hash, generation: this.generation });
    return id;
  }

  consumeGrant(id: string, hash: string): boolean {
    const grant = this.grants.get(id);
    this.grants.delete(id);
    if (!grant || grant.generation !== this.generation) return false;
    return grant.hash === hash;
  }
}

export const clientSession = new ClientSession();

export function sessionPhasePath(repoRoot: string): string {
  return join(repoRoot, ".pi", SESSION_FILE);
}

export function readSessionPhase(repoRoot: string): SessionPhaseRecord {
  const path = sessionPhasePath(repoRoot);
  if (!existsSync(path)) return { phase: "idle", slug: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { phase?: unknown; slug?: unknown };
    const phase = parsed.phase;
    if (phase !== "idle" && phase !== "switching" && phase !== "ready" && phase !== "failed") {
      return { phase: "idle", slug: null };
    }
    const slug = typeof parsed.slug === "string" && parsed.slug.trim() ? parsed.slug.trim() : null;
    return { phase, slug };
  } catch {
    return { phase: "idle", slug: null };
  }
}

export function writeSessionPhase(repoRoot: string, record: SessionPhaseRecord): void {
  mkdirSync(join(repoRoot, ".pi"), { recursive: true });
  writeFileSync(sessionPhasePath(repoRoot), `${JSON.stringify(record, null, 2)}\n`);
}

export function applySessionStart(
  reason: SessionStartReason,
  options: {
    repoRoot: string;
    session: ClientSession;
    activeSlug: string | null;
    setActiveTools: (toolNames: string[]) => void;
  },
): void {
  const record = readSessionPhase(options.repoRoot);
  const fresh =
    reason === "new" &&
    record.phase === "switching" &&
    record.slug !== null &&
    record.slug === options.activeSlug;
  if (fresh && record.slug) {
    writeSessionPhase(options.repoRoot, { phase: "ready", slug: record.slug });
    options.session.toolsEnabled = true;
    options.session.armedSlug = null;
    return;
  }

  options.session.toolsEnabled = false;
  options.session.armedSlug = null;
  options.setActiveTools([]);
  if (record.phase === "switching" || record.phase === "ready") {
    writeSessionPhase(options.repoRoot, { phase: "idle", slug: null });
  }
}
