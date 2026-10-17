# Apartment Life direct HubSpot API

Local runner for portal `5627913`. It calls `https://api.hubapi.com` with a static app token. It does not start a server, and it does not connect ChatGPT or Claude.

The hosted MCP connector stays unchanged: https://app.hubspot.com/mcp-connectors/5627913/app/55630741

## App

Project `apartment-life-direct-api`, platform `2026.09`, private distribution, static auth. Config: [hubspot/src/app/app-hsmeta.json](../hubspot/src/app/app-hsmeta.json).

Required scopes started as the audited all-account set, including `oauth` because account details requires it: https://developers.hubspot.com/docs/api-reference/latest/account/account-information/get-account-details.md

On 2026-10-17 the scopes catalog was retrieved again from https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes.md?audit=2026-10-17. The raw page has 163 unique table rows and matches [services/hubspot-api-mcp/registers/catalog-scopes.json](../services/hubspot-api-mcp/registers/catalog-scopes.json). `crm.schemas.custom.write` is still absent from that table and stays in the app because the custom-schema guide accepts it.

Before this expansion the deployed app had 95 required scopes (build 3). After it, the app has 133, with no duplicates. Static auth and private distribution are unchanged. App: https://app.hubspot.com/developer-projects/5627913/project/apartment-life-direct-api/component/apartment_life_direct_api_app/auth

Added and accepted by upload:

- Workflows and sequences: `automation`, `automation.sequences.read`, `automation.sequences.enrollments.write`
- Leads, goals, products: `crm.objects.leads.read`, `crm.objects.leads.write`, `crm.objects.goals.read`, `crm.objects.products.read`, `crm.objects.products.write`
- Forms and content: `forms`, `forms-uploaded-files`, `marketing-email`, `content`
- Campaigns: `marketing.campaigns.read`, `marketing.campaigns.revenue.read`, `marketing.campaigns.write`
- HubDB: `hubdb.rows.read`, `hubdb.rows.write`, `hubdb.tables.read`, `hubdb.tables.write`, `hubdb.tables.publish`
- Meetings, events, conversations, commerce, and CMS extras: `scheduler.meetings.meeting-link.read`, `analytics.behavioral_events.send`, `behavioral_events.event_definitions.read_write`, `cms.knowledge_base.articles.read`, `cms.membership.access_groups.read`, `cms.membership.access_groups.write`, `cms.functions.read`, `cms.functions.write`, `collector.graphql_query.execute`, `collector.graphql_schema.read`, `conversations.custom_channels.read`, `conversations.custom_channels.write`, `conversations.visitor_identification.tokens.create`, `crm.dealsplits.read_write`, `crm.objects.commercepayments.read`, `crm.schemas.commercepayments.read`
- Ticket schemas, from the current tickets guide: `crm.schemas.tickets.read`, `crm.schemas.tickets.write`

Product read and write come from the current products guide required-scopes block. The deprecated `e-commerce` alternative on individual product endpoints was not added. `cms.functions.read` and `cms.functions.write` were a separate upload because they can read Content Hub secrets. They were accepted. Do not read or print function secrets to prove them.

Preserved: every previous scope, including `oauth`, `business-intelligence`, the four custom object record and schema scopes, granular `files.read`, `files.write`, `files.ui_hidden.read`, and `files.ui_hidden.write`, and standard ticket read and write. `business-intelligence` is the legacy reporting read. It is not a saved-report or dashboard write scope, and no production reporting write scope was added.

Not added:

- `files.delete`, `commerce.payment_links.delete`, and `business_units_view.read`
- All 22 sensitive and highly sensitive scopes, including the four ticket ones. Build 1 on 2026-10-17 rejected `crm.objects.tickets.sensitive.read` for this app, and this expansion left that whole set out.
- Legacy `files`, `hubdb`, `tickets`, `tickets.sensitive`, `tickets.highly_sensitive`, and `timeline`. Granular HubDB scopes above replace legacy `hubdb`. `timeline.read` and `timeline.write` were not guessed from the legacy migration note.
- `crm.objects.feedback_submission.read`. Build 4 failed with "could not be recognized." The catalog spelling was removed. The endpoint spelling `crm.objects.feedback_submissions.read` was not substituted.
- `communication_preferences.statuses.batch.read` and `communication_preferences.statuses.batch.write`. Marketing Hub Enterprise batch subscription access was not approved for this pass.
- `external_integrations.forms.access`. That scope is for the WordPress plugin, not the forms API.
- `transactional-email`. No authorized check showed the Transactional Email add-on, so it stays deferred. Do not send a message to test it.
- Deprecated `accounting`, `actions`, `e-commerce`, `integration-sync`, and `social`, and the no-API knowledge-base write, publish, and settings scopes plus `ctas.read`.

The token can do more than this runner allows. Runner denials are not a control on someone using the token outside this command. `automation.sequences.enrollments.write` does not authorize a live enrollment.

## Deploy and install status on 2026-10-17

Configured scopes are the 133 names in `app-hsmeta.json`. Applied grants are separate: after reinstall, `hs project app-install-status --account=5627913` reported `isInstalledWithCurrentScopes: true` and 133 authorized scope groups, with no sensitive scope. API reads are not runtime-verified. The macOS keychain item `pi-agent.apartment-life.hubspot-direct` for account `5627913` is not configured, so no live call was made.

| Milestone | Result |
| --- | --- |
| EDITED | Local config moved from 95 to 133 scopes. Auth stays static. Distribution stays private. UID stays `apartment_life_direct_api_app`. |
| UPLOADED | Build 4 failed on `crm.objects.feedback_submission.read` and was not deployed. Build 5 uploaded the remaining non-sensitive set. Build 6 added the two CMS function scopes. Build 7 added product and ticket-schema scopes. |
| DEPLOYED | Auto-deploy is on. Deployed build is 7 on portal 5627913, project id 104571123, app id 57476153. Build 3 remains the previous successful install baseline. |
| REINSTALLED | Same app, Distribution-tab Reinstall URL `https://app.hubspot.com/static-token/5627913/authorize?appId=57476153`. HubSpot reported the app was successfully installed. The app was not uninstalled or recreated. |
| VERIFIED | BLOCKED for live reads. Credential configured: no. Representative reads for contacts, companies, deals, custom schemas, lists, forms, leads, workflows, campaigns, and HubDB are NOT TESTED. |

`hs project upload` auto-deploys. Do not upload again until a scope change is approved. Project: https://app.hubspot.com/developer-projects/5627913/project/apartment-life-direct-api

## Token

The CLI personal access key is not this token. After a later install, HubSpot shows the static token on the app Distribution tab. Store it in the macOS keychain:

```bash
read -s TOKEN
security add-generic-password -s "pi-agent.apartment-life.hubspot-direct" -a "5627913" -w "$TOKEN"
unset TOKEN
```

Rotate or revoke it from that Distribution tab, then replace or delete the keychain item. HubSpot recommends rotation about every six months. Scope changes need the Reinstall URL on that tab, then a new token in the keychain. A sandbox install needs its own token and is refused here, because this runner only accepts portal `5627913`.

## Use

```bash
npm run hubspot:direct -- list --match contacts
npm run hubspot:direct -- read get-crm-objects-2026-09-contacts-contactid --path '{"contactId":"123"}' --query '{"properties":"email"}'
```

Writes stay off unless the process has `HUBSPOT_DIRECT_WRITES=approval`. Then prepare, approve, and execute that proposal id. A changed payload, an expired proposal, or a second execute is rejected. Delete, archive, purge, file deletion, payment-link deletion, export creation, send, publish, merge, unpublish, import, and user removal stay denied.

List reads stop after the adapter's page budget and set `truncated` when more rows exist. Pass the returned `after` cursor in `--query` to continue. One read does not prove every operation works. `scopeIntrospection` is `unavailable`: this runner does not claim it can list the token's live grants.
