# Pi Durable pilot checkpoint — 2026-10-07

This branch is an incomplete supervised prototype, based on
`2bec26751dac1bf75363cf6ee036d9a5b25cfb88`. The user paused implementation and
requested this GitHub checkpoint. It is not a production-readiness or full
milestone acceptance claim. The original checkout and signed pi-gui application
bundle were preserved.

## Code included

- Exact HubSpot pilot allowlist: portal `5627913`, ticket `48489581088`.
  Other records, broad searches, unsupported URLs, and unprovable association
  paths are rejected. The three baseline exclusions remain blocked.
- Explicit offline/live modes with separate persisted data directories;
  missing live configuration fails closed. Offline fixture policy remains separate.
- Real-model runtime using protected local Pi credentials and the existing
  remote HubSpot MCP adapter and broker. No runtime coding or unrestricted shell
  tools are registered. Public-browser runs have a separate capability without CRM tools.
- Native Pi Durable dispatch reconciliation at acceptance, conversation,
  submission, and projection boundaries; a single-writer lock; continuing and
  reconnecting subscriptions; private persisted evidence; corrected CLI entry point.
- A Pi GUI extension tab with start, inspect, cancel, and reattach controls.
  Actual GUI acceptance remains unverified.
- A Pi-origin public-browser tool using a dedicated Chrome automation profile.
  Validation status and page evidence are captured where available. The smoke
  test has not passed; a closed browser can still prevent screenshot capture.
- Durable exact-payload write proposals and receipts with mock-adapter tests.
  Trusted human broker integration and real external writes are unfinished.

## Fresh checks before this checkpoint

Node: `/Users/zeke/.nvm/versions/node/v22.23.2/bin/node`.

- Root TypeScript check: exit 0.
- Workstream-runner TypeScript check: exit 0.
- Root tests: **29 passed, 0 failed, 0 skipped**.
- Workstream-runner tests: **18 passed, 0 failed, 0 skipped**, approximately 18.42 seconds.
- `git diff --check`: passed.

The runner suite covers the original offline and zero-network checks, exact
scope rejection before outbound access, mode separation, dispatch crash
recovery, key/payload conflicts, competing writers, concurrent starts,
continuing subscriptions, permissions, and mocked write reconciliation.
It does not establish GUI recovery, real browser success, or external write replay.

Latest crash-boundary proofs each recovered one job and one native conversation
with one dispatch:

| Boundary | Job ID |
| --- | --- |
| Acceptance | `e432c29b-1dbf-4308-ab1c-6ad1144cf99f` |
| Conversation | `445cccab-49bd-4c64-bd1c-11200d48bdd7` |
| Submission | `e8820497-66d1-45e1-81f4-e64f4a1c216b` |
| Projection | `9b6253bc-1188-4c05-8f06-78b6041c447d` |

Terminal-parent detach proof job: `432a3b03-3c26-47b7-be99-baf8c53ca98f`.
This is distinct from the required GUI quit/reopen proof.

## Live observations

- Pi GUI reported successful HubSpot OAuth authentication. The runtime's
  `get_user_details` preflight verified portal `5627913` on its current connection.
- Real Claude Sonnet 4.6 job `32e98dc6-a2a8-4055-9745-3a5db8859a07`
  ran from `2026-10-07T09:29:08.238Z` to `2026-10-07T09:29:43.499Z`, with
  one dispatch and one exact-ticket MCP read. Native conversation ID `2`,
  submission ID `11`; configured limits were three tool calls and 90 seconds.
- That report is **not accepted as a completed investigation**: it omitted
  `resolution_details`, did not receive the resolution display-label metadata,
  and overstated hypotheses as findings. Reporting instructions were tightened
  afterward but have not been rerun. The read tool still needs resolution details
  and verified property metadata added to its evidence.
- Browser inspection and a subsequent Pi MCP property-metadata read confirmed
  that raw `hs_resolution` value `Issue Resolved` displays as
  `Issue Resolved (Manually)`. `resolution_details` contains recorded remediation
  evidence. A missing requested property is not proof that the entire record
  lacks that evidence. `hs_pipeline_stage` value `3580760` maps to `Closed`.
- Public-browser job `851cc950-6103-487a-858f-3b0bcb20ba11` finished its
  model response, but the tool failed waiting for the expected heading.
  Follow-up job `7e4b6bdc-af72-4924-8dc1-74e24073617a` also finished its
  model response, but screenshot capture failed because the browser/page was
  closed. **Neither is a passing smoke test.**
- The pilot folder was opened in the installed Pi GUI. Control/capture issues
  and multiple Pi windows prevented reliable extension start/quit/reopen/reattach
  evidence. No GUI acceptance claim is made.
- The existing Pi Notion connector previously returned `not_found` for the
  authorized parent, indicating missing integration access. Browser access alone
  does not establish access for that connector. This prerequisite needs rechecking.

Protected SQLite/model evidence remains local in `/private/tmp/pi-durable-investigation-501`
and the separate public-browser data directories. Credentials, raw CRM content,
browser profiles, and authentication stores are not included in GitHub. Local
temporary evidence paths are machine-specific and may not survive cleanup.

## Remaining acceptance work

1. Add resolution details and verified labels to the scoped MCP tool evidence,
   then run and assess a corrected bounded historical-ticket investigation.
2. Verify actual extension start, evidence display, cancellation, GUI quit,
   detached survival, reopen, and same-job reattachment without duplicate dispatch.
3. Diagnose and pass the Pi-origin public-browser smoke test on its dedicated profile.
4. Complete trusted human approval-broker wiring, exact internal ticket-note and
   Notion-status payloads, external writes, readbacks, browser inspection, and replay
   reconciliation without duplicates. Mock tests do not prove these requirements.
5. Recheck Notion connector access and consolidate verified status on
   [Building with Pi (Parent)](https://app.notion.com/p/Building-with-Pi-Parent-3ddbf2449e838024a57bcf18798122b6),
   including the eventual implementation commit and receipts.

No HubSpot, Notion, or Asana content was changed by the pilot. Existing ticket
properties and activities were preserved. Matrix and Asana writes remain deferred.
Launchd remains uninstalled; GUI detach verification and the user's acceptance of
that process are prerequisites to preparing/enabling persistence. No merge to main.
