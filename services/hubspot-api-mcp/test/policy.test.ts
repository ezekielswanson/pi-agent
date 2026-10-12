import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { approveProposal, consumeApproval, prepareChange, resetApprovals } from "../src/policy/approval.ts";
import { assertBatchBound, assertOperationAllowed, buildPath, exclusionReason, scopesSatisfied } from "../src/policy/exclusions.ts";
import { PolicyError } from "../src/policy/errors.ts";
import { redact, redactText } from "../src/policy/redact.ts";
import { loadBaseline, loadManifest, loadMatrix, loadOperations } from "../src/registry/load.ts";
import type { OperationRecord } from "../src/registry/types.ts";

const operations = loadOperations();

function operation(id: string): OperationRecord {
  const found = operations.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

test("baseline matrix keeps every supplied scope", () => {
  const baseline = loadBaseline();
  const matrix = loadMatrix();
  assert.equal(matrix.length, baseline.length);
  assert.deepEqual(matrix.map((row) => row.baselineScope), baseline);
  assert.equal(new Set(baseline).size, baseline.length);
});

test("mandatory exclusions stay out of the install manifest and out of tools", () => {
  const manifest = loadManifest();
  const banned = ["files.delete", "commerce.payment_links.delete", "business_units_view.read"];
  for (const scope of banned) {
    assert.equal(manifest.required.includes(scope), false);
    assert.equal(manifest.optional.includes(scope), false);
    assert.ok(manifest.omitted.some((item) => item.scope === scope));
  }
  const paymentDelete = operation("delete-commerce-payment-links-2026-09-payment-links-paymentlinkid");
  assert.equal(paymentDelete.implemented, false);
  assert.equal(paymentDelete.tool, null);
  assert.throws(() => assertOperationAllowed(paymentDelete), PolicyError);
  const fileDelete = operation("delete-cms-source-code-2026-09-environment-content-path");
  assert.equal(fileDelete.implemented, false);
  assert.match(exclusionReason(fileDelete) ?? "", /File deletion/);
  const brands = operations.find((item) => item.scopeGroups.some((group) => group.scopes.includes("business_units_view.read")));
  assert.ok(brands);
  assert.equal(brands.implemented, false);
});

test("file and payment-link deletes are rejected even if a record is marked implemented", () => {
  const forced: OperationRecord = {
    ...operation("delete-commerce-payment-links-2026-09-payment-links-paymentlinkid"),
    implemented: true,
    excluded: false,
    exclusionReason: null,
    tool: "hubspot_prepare_change",
  };
  assert.throws(() => assertOperationAllowed(forced), /Payment-link/);
  const file: OperationRecord = {
    ...forced,
    id: "delete-files-forced",
    title: "Delete a file",
    method: "DELETE",
    path: "/files/2026-09/files/{fileId}",
    scopeGroups: [{ mode: "any", scopes: ["files.write"] }],
  };
  assert.throws(() => assertOperationAllowed(file), /File deletion/);
});

test("scope groups honor any and all", () => {
  const anyOp = operation("delete-crm-objects-2026-09-contacts-contactid");
  assert.equal(scopesSatisfied(anyOp, ["crm.objects.contacts.write"]), true);
  assert.equal(scopesSatisfied(anyOp, ["crm.objects.contacts.read"]), false);
  const allOp: OperationRecord = { ...anyOp, scopeGroups: [{ mode: "all", scopes: ["oauth", "crm.objects.contacts.write"] }] };
  assert.equal(scopesSatisfied(allOp, ["crm.objects.contacts.write"]), false);
  assert.equal(scopesSatisfied(allOp, ["oauth", "crm.objects.contacts.write"]), true);
});

test("path parameters cannot change the endpoint", () => {
  assert.equal(buildPath("/crm/objects/2026-09/contacts/{contactId}", { contactId: "123" }), "/crm/objects/2026-09/contacts/123");
  assert.throws(() => buildPath("/crm/objects/2026-09/contacts/{contactId}", { contactId: "../files" }), PolicyError);
  assert.throws(() => assertBatchBound({ inputs: new Array(101).fill({ id: "1" }) }, true), /100/);
});

test("contact deletion is an archive covered by the write scope", () => {
  const matrix = loadMatrix();
  const row = matrix.find((item) => item.baselineScope === "crm.objects.contacts.write") as unknown as {
    relatedDeleteOrArchive: { status: string; requiredScopes: string[]; covered: string };
  };
  assert.equal(row.relatedDeleteOrArchive.status, "archive");
  assert.deepEqual(row.relatedDeleteOrArchive.requiredScopes, ["crm.objects.contacts.write"]);
  assert.match(row.relatedDeleteOrArchive.covered, /covered/);
});

test("approvals are single use and bound to the payload", () => {
  resetApprovals();
  const op = operation("delete-crm-objects-2026-09-contacts-contactid");
  const params = { pathParams: { contactId: "42" }, body: { note: "no" } };
  const proposal = prepareChange({
    actor: "ada",
    clientId: "pi",
    portalId: "5627913",
    operation: op,
    params,
    resolvedPath: "/crm/objects/2026-09/contacts/42",
  });
  assert.equal(proposal.approved, false);
  const approved = approveProposal({ proposalId: proposal.id, actor: "ada", portalId: "5627913", secret: "test-secret" });
  consumeApproval({
    token: approved.token,
    secret: "test-secret",
    actor: "ada",
    clientId: "pi",
    portalId: "5627913",
    operation: op,
    params,
    resolvedPath: "/crm/objects/2026-09/contacts/42",
  });
  assert.throws(
    () =>
      consumeApproval({
        token: approved.token,
        secret: "test-secret",
        actor: "ada",
        clientId: "pi",
        portalId: "5627913",
        operation: op,
        params,
        resolvedPath: "/crm/objects/2026-09/contacts/42",
      }),
    /not active/,
  );
  const again = prepareChange({
    actor: "ada",
    clientId: "pi",
    portalId: "5627913",
    operation: op,
    params,
    resolvedPath: "/crm/objects/2026-09/contacts/42",
  });
  const second = approveProposal({ proposalId: again.id, actor: "ada", portalId: "5627913", secret: "test-secret" });
  assert.throws(
    () =>
      consumeApproval({
        token: second.token,
        secret: "test-secret",
        actor: "ada",
        clientId: "pi",
        portalId: "5627913",
        operation: op,
        params: { pathParams: { contactId: "42" }, body: { note: "changed" } },
        resolvedPath: "/crm/objects/2026-09/contacts/42",
      }),
    /payload/,
  );
  assert.throws(
    () => approveProposal({ proposalId: again.id, actor: "other", portalId: "5627913", secret: "test-secret" }),
    /actor/,
  );
});

test("redaction removes secrets", () => {
  assert.equal((redact({ access_token: "secret", id: "1" }) as { access_token: string }).access_token, "[redacted]");
  assert.match(redactText("Authorization: Bearer abc.def refresh_token=zzz"), /redacted/);
  assert.equal(readFileSync(new URL("../registers/scope-manifest.json", import.meta.url), "utf8").includes("pat-"), false);
});
