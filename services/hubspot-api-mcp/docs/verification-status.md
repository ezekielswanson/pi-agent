# Verification status

Date: 2026-10-15. Environment: local Node test run in this repository. No public host. No live HubSpot app. No live CRM call.

Previously reviewed head: `4397938` (PR #1 before this security pass). This file ships in the security-remediation commit. Mocked PASS is not live PASS.

| Criterion | Result | Evidence |
| --- | --- | --- |
| A. Separate API-backed MCP, connector unchanged, stable HTTPS endpoint | FAIL | Service lives in `services/hubspot-api-mcp`. `.mcp.json` still points at `https://mcp.hubspot.com`. Nothing is deployed on an HTTPS origin that stays up without this machine. |
| B. Identity | PASS for mocked cases. BLOCKED for real clients. | Client `subject` is rejected. Login plus consent sets the subject. Wrong issuer, redirect, and user fail. Revocation hashes reload from `MCP_REVOCATION_FILE`. Auth codes, refresh tokens, and approvals are still process memory, so a second instance would not share them. ChatGPT, Claude, and Pi OAuth were not run. |
| C. HubSpot consent | PASS for mocked state handling. NOT TESTED live. | Forged, expired, replayed, portal-mismatched, and cross-user states fail before token exchange. A matching login can finish once against a mock token endpoint. Tokens in the mock response are not returned to the browser. No live app exists, so granted scopes are not inspected. |
| D. Approval | PASS in mock. NOT TESTED on HubSpot. | Unapproved execute does not call HubSpot. An `Authorization` bearer receives 401 on the approval URL. Query, body, and client changes fail. Expired proposals fail. Replay of an approval is rejected. One mock execute succeeds only with the approval token. |
| E. Exclusions | PASS in register and tool policy. | `files.delete`, `commerce.payment_links.delete`, and `business_units_view.read` are absent from required and optional. Forced implemented records for payment-link and file deletion still throw. |
| F. Data protection | PASS for the classified sample. NOT TESTED against HubSpot property metadata. | `ssn` and `hs_ssn` follow object-specific scopes. Unknown properties are dropped or rejected. Export GET and download paths throw before fetch. Export POST without an integer limit of 1 to 10 throws before fetch. Logs and token files used by tests do not contain the sample secrets. The classifier is a short static map, not the account's property definitions. |
| G. Coverage | PASS for the recounted register. NOT TESTED live. | Recount on 2026-10-15: catalog 163, scope register 290, baseline 226, operations 979, implemented 905, excluded 3, required 95, optional 109, omitted 64. Matrix: 150 current, 34 unverified, 30 endpoint-only, 9 beta, 2 legacy, 1 corrected. Parity matrix is `parity-matrix.md`. Registration is not a grant. |
| H. Reliability | PASS for mocked read retry and single-flight refresh. NOT TESTED under load. | Read 429 retries once and keeps the correlation id. Writes are not retried. Login, token, and MCP routes have in-memory rate limits. Request bodies over 1,000,000 bytes are rejected. The listen timeout is 30 seconds. Limits are per process. |
| I. Client verification | NOT TESTED | ChatGPT, Claude, and Pi have no OAuth, discovery, read, or approval evidence against this service. |
| J. Operations | NOT TESTED | Rollback steps are documented. Audit retention, monitoring, emergency disable, and recovery were not exercised on a host. |

Destructive live operations, including permanent and GDPR deletion, were not run.
