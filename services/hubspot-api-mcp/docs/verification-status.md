# Verification status

Date: 2026-10-15. Environment: local Node test run in this repository. No public host. No live HubSpot app. No live CRM call.

Previously reviewed head: `6885bed`. This file covers the action-policy change after that commit. Mocked PASS is not live PASS.

| Criterion | Result | Evidence |
| --- | --- | --- |
| A. Property behavior | PASS in mock. NOT TESTED live. | A custom property name is sent and returned. The static classifier is gone. A missing HubSpot scope still fails before the call. `access_token` values in results are redacted. |
| B. Export behavior | PASS in mock. NOT TESTED live. | Export retrieval is no longer rejected by a 1-to-10 cap. Off-host download links are withheld. Redirects off the API host are refused. Read-only policy rejects export creation before a call. |
| C. Action policy | PASS in mock. | Read-only allows a read and rejects writes, export creation, and archive before any HubSpot call. `approved=true` fails schema validation. Deletion stays denied when writes are set to approval-required. An approval token matches one payload, and query or client changes fail. |
| D. Authentication | PASS in mock. BLOCKED for real clients. | A supplied subject is rejected. Forged, replayed, and cross-user HubSpot state fails before token exchange. HTTPS login requires a matching `Origin`, sets `Secure` and `HttpOnly`, and sign-out revokes that session. Wrong issuer and revoked tokens fail. |
| E. Restart | PASS for the modeled cases. | Clearing in-memory approvals makes an old approval token fail with no HubSpot call. Revocation hashes reload. Another user's installation key is empty. |
| F. ChatGPT, Claude, Pi | NOT TESTED | No HTTPS deployment and no live OAuth. |
| Architecture | FAIL for launch. PASS for separation. | The service is separate from `https://mcp.hubspot.com`. `.mcp.json` is unchanged. There is no HTTPS endpoint that stays up without this machine. |
| Exclusions | PASS in register and tool policy. | `files.delete`, `commerce.payment_links.delete`, and `business_units_view.read` are absent from required and optional. Forced implemented records for payment-link and file deletion still throw. |
| Coverage | PASS for the recounted register. NOT TESTED live. | Recount on 2026-10-15: catalog 163, scope register 290, baseline 226, operations 979, implemented 905, excluded 3, required 95, optional 109, omitted 64. Matrix: 150 current, 34 unverified, 30 endpoint-only, 9 beta, 2 legacy, 1 corrected. Parity matrix is `parity-matrix.md`. Registration is not a grant. |
| Reliability | PASS for mocked read retry and single-flight refresh. NOT TESTED under load. | Read 429 retries once and keeps the correlation id. Writes are not retried. Login, token, and MCP routes have in-memory rate limits. Request bodies over 1,000,000 bytes are rejected. The listen timeout is 30 seconds. Limits are per process. |
| Operations | NOT TESTED on a host. | Rollback steps are documented. Audit retention, monitoring, emergency disable, and recovery were not exercised on a host. |

Destructive live operations, including permanent and GDPR deletion, were not run.
