import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ClientProfile } from "../types/index.ts";
import { ScopeError } from "../utils/errors.ts";

function setOf(...groups: Array<Iterable<string>>): Set<string> {
  const values = new Set<string>();
  for (const group of groups) {
    for (const value of group) {
      if (value.trim()) values.add(value);
    }
  }
  return values;
}

export function allowedNotionPages(profile: ClientProfile): Set<string> {
  return setOf(Object.values(profile.notion.pageIds), profile.allowlist.notionPageIds, [
    profile.notion.testPageId ?? "",
    profile.notion.outputParent?.type === "page" ? profile.notion.outputParent.id : "",
  ]);
}

export function allowedNotionDatabases(profile: ClientProfile): Set<string> {
  return setOf(Object.values(profile.notion.databaseIds), profile.allowlist.notionDatabaseIds);
}

export function allowedNotionDataSources(profile: ClientProfile): Set<string> {
  return setOf(profile.allowlist.notionDataSourceIds, [
    profile.notion.outputParent?.type === "data_source" ? profile.notion.outputParent.id : "",
  ]);
}

export function allowedAsanaProjects(profile: ClientProfile): Set<string> {
  return setOf(Object.values(profile.asana.projectGids), profile.allowlist.asanaProjectGids, [
    profile.asana.testProjectGid ?? "",
  ]);
}

export function allowedAsanaTasks(profile: ClientProfile): Set<string> {
  return setOf(profile.allowlist.asanaTaskGids);
}

export function assertAllowedId(allowed: Set<string>, id: string, label: string): void {
  if (!id || !allowed.has(id)) {
    throw new ScopeError(`${label} is outside this client's allowlist.`);
  }
}

export function assertHubspotWrite(
  profile: ClientProfile,
  verified: { slug: string; portalId: string } | null,
): void {
  const expected =
    profile.hubspot.expectedPortalId === null || profile.hubspot.expectedPortalId === undefined
      ? null
      : String(profile.hubspot.expectedPortalId);
  if (!expected || !verified || verified.slug !== profile.slug || verified.portalId !== expected) {
    throw new ScopeError("HubSpot writes are blocked until this session verifies the expected portal.");
  }
  if (profile.allowlist.hubspotPortalIds.length > 0 && !profile.allowlist.hubspotPortalIds.includes(expected)) {
    throw new ScopeError("HubSpot portal is outside this client's allowlist.");
  }
}

export function isLocalPathAllowed(profile: ClientProfile, repoRoot: string, target: string): boolean {
  const roots = [...profile.researchRoots, ...profile.allowlist.localRoots];
  if (roots.length === 0) return false;
  const resolvedTarget = resolve(repoRoot, target);
  return roots.some((root) => {
    const resolvedRoot = resolve(repoRoot, root);
    const fromRoot = relative(resolvedRoot, resolvedTarget);
    return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
  });
}
