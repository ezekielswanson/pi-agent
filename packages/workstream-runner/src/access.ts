import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonical, decide, isExcluded, type AccessRequest, type Decision, type Identity, type Policy } from "./policy.ts";

const FIXTURES: Record<string, { title: string }> = {
	"hubspot/5627913/tickets/10000000001": { title: "Fixture ticket" },
	"hubspot/5627913/deals/10000000002": { title: "Fixture deal" },
};

export type AccessOutcome = {
	decision: Decision;
	records: { identity: string; title: string }[];
};

/** Evaluate policy, then fetch. A denial returns before the fetcher runs. */
export async function runAccess(
	policy: Policy,
	request: AccessRequest,
	fetchIdentity: (identity: Identity) => Promise<{ title: string }>,
): Promise<AccessOutcome> {
	const decision = decide(policy, request);
	if (!decision.allow) return { decision, records: [] };
	const records = [];
	for (const identity of decision.identities) {
		const record = await fetchIdentity(identity);
		records.push({ identity: canonical(identity), title: record.title });
	}
	return { decision, records };
}

export async function fetchLocalFixture(policy: Policy, identity: Identity, dataDir?: string): Promise<{ title: string }> {
	if (isExcluded(policy, identity)) {
		throw new Error(`refusing excluded record ${canonical(identity)}`);
	}
	if (dataDir) {
		mkdirSync(dataDir, { recursive: true });
		appendFileSync(join(dataDir, "fetch-log.jsonl"), `${JSON.stringify({ identity: canonical(identity), at: new Date().toISOString() })}\n`);
	}
	return FIXTURES[canonical(identity)] ?? { title: "absent from local fixtures" };
}
