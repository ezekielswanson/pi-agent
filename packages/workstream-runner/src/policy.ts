import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ObjectType = "deals" | "tickets";

export type Identity = {
	system: "hubspot";
	portalId: string;
	objectType: ObjectType;
	objectId: string;
};

export type Policy = {
	system: "hubspot";
	portalId: string;
	excluded: readonly { objectType: ObjectType; objectId: string }[];
};

export type DecisionReason = "wrong_portal" | "excluded" | "unprovable";

export type Decision =
	| { allow: true; identities: Identity[] }
	| { allow: false; reason: DecisionReason; identities: Identity[] };

type FetchRequest = {
	op: "fetch";
	target: string;
	/** Ignored. A request cannot declare its own scope. */
	declaredScope?: unknown;
	note?: unknown;
};

type SearchRequest = {
	op: "search";
	portalId: string;
	objectType: string;
	objectIds?: readonly string[];
	query?: unknown;
	declaredScope?: unknown;
};

type AssociateRequest = {
	op: "associate";
	portalId: string;
	from: string;
	to?: string;
	declaredScope?: unknown;
};

type TraverseRequest = {
	op: "traverse";
	portalId: string;
	path: readonly string[];
	declaredScope?: unknown;
};

export type AccessRequest = FetchRequest | SearchRequest | AssociateRequest | TraverseRequest;

const TYPE_ALIASES: Record<string, ObjectType> = {
	"0-3": "deals",
	deal: "deals",
	deals: "deals",
	"0-5": "tickets",
	ticket: "tickets",
	tickets: "tickets",
};

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function trustedPolicyPath(): string {
	return join(packageRoot, "config", "policy.json");
}

export function loadTrustedPolicy(path = trustedPolicyPath()): Policy {
	const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
	return parseTrustedPolicy(raw);
}

/** Local file only. Request JSON, model output, and tool text are not sources. */
export function loadPolicyFrom(source: string, json: unknown): Policy {
	if (source !== "local-file") {
		throw new Error(`policy source "${source}" is not trusted`);
	}
	return parseTrustedPolicy(json);
}

export function parseTrustedPolicy(raw: unknown): Policy {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("trusted policy must be an object");
	}
	const record = raw as Record<string, unknown>;
	const allowed = new Set(["system", "portalId", "excluded"]);
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new Error(`trusted policy rejects field "${key}"`);
	}
	if (record.system !== "hubspot") throw new Error("trusted policy system must be hubspot");
	if (typeof record.portalId !== "string" || !/^\d+$/.test(record.portalId)) {
		throw new Error("trusted policy portalId must be digits");
	}
	if (!Array.isArray(record.excluded)) throw new Error("trusted policy excluded must be a list");
	const excluded = record.excluded.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("excluded entry must be an object");
		}
		const entry = item as Record<string, unknown>;
		const objectType = normalizeObjectType(typeof entry.objectType === "string" ? entry.objectType : "");
		if (!objectType || typeof entry.objectId !== "string" || !/^\d+$/.test(entry.objectId)) {
			throw new Error("excluded entry needs a known object type and numeric id");
		}
		return { objectType, objectId: entry.objectId };
	});
	return { system: "hubspot", portalId: record.portalId, excluded };
}

export function normalizeObjectType(raw: string): ObjectType | undefined {
	return TYPE_ALIASES[raw.trim().toLowerCase()];
}

export function canonical(identity: Identity): string {
	return `hubspot/${identity.portalId}/${identity.objectType}/${identity.objectId}`;
}

export function isExcluded(policy: Policy, identity: Identity): boolean {
	return (
		identity.system === policy.system &&
		identity.portalId === policy.portalId &&
		policy.excluded.some((item) => item.objectType === identity.objectType && item.objectId === identity.objectId)
	);
}

/** Retrieved tool text is evidence. It is never parsed into a policy. */
export function absorbEvidence(policy: Policy, _text: string): Policy {
	return policy;
}

export function parseIdentity(input: string): Identity | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	const collapsed = trimmed.replace(/\s+/g, "");
	const pathIdentity = identityFromParts(collapsed.split("/").filter(Boolean));
	if (pathIdentity) return pathIdentity;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
		try {
			return identityFromUrl(new URL(trimmed));
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export function decide(policy: Policy, request: AccessRequest): Decision {
	if (request.op === "fetch") return decideIdentities(policy, [request.target]);
	if (request.op === "search") return decideSearch(policy, request);
	if (request.op === "associate") {
		const from = decideIdentities(policy, [request.from], request.portalId);
		if (!from.allow) return from;
		if (request.to === undefined) return { allow: false, reason: "unprovable", identities: from.identities };
		return decideIdentities(policy, [request.from, request.to], request.portalId);
	}
	if (request.path.length === 0 || request.path.some((segment) => !parseIdentity(segment))) {
		const identities = request.path.flatMap((segment) => {
			const identity = parseIdentity(segment);
			return identity ? [identity] : [];
		});
		return { allow: false, reason: "unprovable", identities };
	}
	return decideIdentities(policy, request.path, request.portalId);
}

function decideSearch(policy: Policy, request: SearchRequest): Decision {
	const objectType = normalizeObjectType(request.objectType);
	if (!objectType || request.query !== undefined || !request.objectIds || request.objectIds.length === 0) {
		return { allow: false, reason: "unprovable", identities: [] };
	}
	const identities: Identity[] = [];
	for (const objectId of request.objectIds) {
		const parsed = parseIdentity(objectId) ?? identityFromParts(["hubspot", request.portalId, objectType, objectId]);
		if (!parsed) return { allow: false, reason: "unprovable", identities };
		identities.push(parsed);
	}
	return decideParsed(policy, identities, request.portalId);
}

function decideIdentities(policy: Policy, targets: readonly string[], portalId?: string): Decision {
	const identities: Identity[] = [];
	for (const target of targets) {
		const parsed = parseIdentity(target);
		if (!parsed) return { allow: false, reason: "unprovable", identities };
		identities.push(parsed);
	}
	return decideParsed(policy, identities, portalId);
}

function decideParsed(policy: Policy, identities: Identity[], expectedPortal?: string): Decision {
	if (expectedPortal !== undefined && expectedPortal !== policy.portalId) {
		return { allow: false, reason: "wrong_portal", identities };
	}
	for (const identity of identities) {
		if (identity.portalId !== policy.portalId) return { allow: false, reason: "wrong_portal", identities };
		if (isExcluded(policy, identity)) return { allow: false, reason: "excluded", identities };
	}
	return { allow: true, identities };
}

function identityFromUrl(url: URL): Identity | undefined {
	if (url.protocol === "hubspot:") {
		const portalId = url.hostname;
		const [objectType, objectId] = url.pathname.split("/").filter(Boolean);
		return buildIdentity(portalId, objectType ?? "", objectId ?? "");
	}
	const fromQuery = identityFromQuery(url);
	if (fromQuery) return fromQuery;
	const parts = url.pathname.split("/").filter(Boolean);
	const fromPath = identityFromParts(parts);
	if (fromPath) return fromPath;
	const portalId = portalFromPath(parts);
	const objectType = url.searchParams.get("objectType") ?? url.searchParams.get("objectTypeId");
	const objectId = url.searchParams.get("objectId") ?? url.searchParams.get("id");
	if (!portalId || !objectType || !objectId) return undefined;
	return buildIdentity(portalId, objectType, objectId);
}

function portalFromPath(parts: string[]): string | undefined {
	const contacts = parts[0] === "contacts" ? parts.slice(1) : parts;
	const portalId = contacts[0];
	return portalId && /^\d+$/.test(portalId) ? portalId : undefined;
}

function identityFromQuery(url: URL): Identity | undefined {
	const portalId = url.searchParams.get("portalId") ?? url.searchParams.get("portal");
	const objectType = url.searchParams.get("objectType") ?? url.searchParams.get("objectTypeId");
	const objectId = url.searchParams.get("objectId") ?? url.searchParams.get("id");
	if (!portalId || !objectType || !objectId) return undefined;
	return buildIdentity(portalId, objectType, objectId);
}

function identityFromParts(parts: string[]): Identity | undefined {
	const hubspot = parts[0] === "hubspot" ? parts.slice(1) : parts;
	const contacts = hubspot[0] === "contacts" ? hubspot.slice(1) : hubspot;
	const record = contacts[1] === "record" ? [contacts[0], contacts[2], contacts[3]] : contacts;
	if (!record || record.length < 3) return undefined;
	const [portalId, objectType, objectId] = record;
	if (!portalId || !objectType || !objectId) return undefined;
	return buildIdentity(portalId, objectType, objectId);
}

function buildIdentity(portalId: string, objectTypeRaw: string, objectId: string): Identity | undefined {
	const objectType = normalizeObjectType(objectTypeRaw);
	if (!objectType || !/^\d+$/.test(portalId) || !/^\d+$/.test(objectId)) return undefined;
	return { system: "hubspot", portalId, objectType, objectId };
}
