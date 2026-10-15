# Scope audit

Retrieval date: 2026-10-12. HubSpot API version: `2026-09`.

Sources:

- Scopes catalog, parsed from the HTML table rather than a shortened markdown conversion: https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes
- Current API index: https://developers.hubspot.com/docs/_llms/apis/2026-09.txt
- Each operation's Required Scopes block on its API reference page. The OpenAPI security-scheme enum is not treated as the endpoint requirement, because those pages list a large shared scope set there.
- Versioning: https://developers.hubspot.com/docs/developer-tooling/platform/versioning
- Docs index, including `2027-03-beta` specs that were not implemented: https://developers.hubspot.com/docs/llms.txt

The guessed absolute URL `https://developers.hubspot.com/docs/specs/2026-09/...json` returned 404. Operations were taken from the rendered API reference pages, which embed the `2026-09` spec path and the Required Scopes block. Account login was not required for this public-doc pass and was not performed. Installer acceptance is unverified.

## Counts

From [`../registers/discovery-meta.json`](../registers/discovery-meta.json):

- Catalog table rows: 163
- Scope register rows, catalog plus endpoint-only discoveries: 290
- Baseline rows: 226, matching [`../registers/baseline-scopes.txt`](../registers/baseline-scopes.txt)
- API pages discovered: 1,178, with no page-fetch failures
- Operations after method-and-path dedupe: 979
- Implemented: 905
- Excluded: 3
- Scope-documentation conflicts left unimplemented: see `scopeConflicts` in the meta file

Baseline matrix statuses recounted from `baseline-matrix.json` on 2026-10-15: 150 current, 30 endpoint-only, 34 unverified, 9 beta, 2 legacy, and 1 corrected (`automation.sequences.write`). Re-count from the matrix after the next register build rather than treating this paragraph as a second source of truth.

## Exclusions

These are omitted from `required` and `optional` in [`../registers/scope-manifest.json`](../registers/scope-manifest.json):

- `files.delete`
- `commerce.payment_links.delete`
- `business_units_view.read`

Payment-link DELETE `/commerce/payment-links/2026-09/payment-links/{paymentLinkId}` requires `commerce.payment_links.delete` and is not implemented. Its source is https://developers.hubspot.com/docs/api-reference/latest/revenue/payment-links/delete-payment-link.md. Read and write payment-link operations stay available and use `commerce.payment_links.read` and `commerce.payment_links.write`, which are endpoint-documented scopes missing from the main catalog table.

File-manager DELETE was not present in the crawled `2026-09` files reference. The tool layer still rejects a DELETE under `/files/` and any operation titled "Delete a file", including CMS source-code file delete, even when the required scope is the broader `content` scope. `files.read` and `files.write` stay available.

`business_units_view.read` is a real catalog scope for brand data. The business-units read operation is excluded and has no tool.

## Name corrections

- Baseline `automation.sequences.write` is not a catalog row. Sequence mutations in the 2026-09 reference require `automation.sequences.create`, `automation.sequences.edit`, or `automation.sequences.delete` for the matching call. They are alternatives. `automation.sequences.read` remains the read scope. Delete example: https://developers.hubspot.com/docs/api-reference/latest/automation/sequences/delete-sequence.md
- Baseline `crm.objects.feedback_submissions.read` matches the endpoint Required Scopes spelling. The catalog table uses the singular `crm.objects.feedback_submission.read`, which no crawled operation requires. The plural form is the one requested.
- Contact archive `DELETE /crm/objects/2026-09/contacts/{contactId}` requires `crm.objects.contacts.write`, not a separate delete scope. Deleted contacts are restorable for 90 days: https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/delete-contact.md
- Several sensitive properties are required by endpoint pages with a `.v2` suffix that is absent from the catalog table. Those strings are optional in the manifest and marked `endpoint_only`. The installer has not accepted them. If an install rejects one, remove that string instead of inventing a replacement.
- Legacy `tickets.sensitive` and `tickets.highly_sensitive` stay in the baseline matrix. The catalog points at `crm.objects.tickets.sensitive.read` and `crm.objects.tickets.highly_sensitive.read`.

## Not requested

Deprecated, from the scopes page: `accounting`, `actions`, `e-commerce`, `integration-sync`, `social`.

No corresponding API, from the scopes page: `cms.knowledge_base.articles.write`, `cms.knowledge_base.articles.publish`, `cms.knowledge_base.settings.read`, `cms.knowledge_base.settings.write`, `ctas.read`.

Beta candidates left out of the install proposal because the docs index only shows `2027-03-beta` specs: `marketing.aeo.read`, `marketing.lead_scoring.read`, `marketing.lead_scoring.write`, `revenue.contracts.read`, `revenue.contracts.write`, `crm.auto.associations.settings.public.api.read`, `crm.auto.associations.settings.public.api.write`, and the `reporting.full.*` scopes. A non-beta replacement was not verified, so these wait for approval.

Other baseline rows whose status is `unverified` had neither a catalog row nor a 2026-09 Required Scopes match. They remain in the matrix and are not requested.

## Grants versus tools

Nothing is granted. `granted` is `not_granted`. A scope in the optional list is not an MCP tool by itself. Tools dispatch only operation ids present in [`../registers/operations.json`](../registers/operations.json) with `implemented: true`. The tool list is [`../registers/tool-inventory.json`](../registers/tool-inventory.json).

Mocked tests are not live execution. Destructive live execution remains untested.
