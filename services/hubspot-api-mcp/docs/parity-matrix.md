# Hosted MCP parity

Comparison date: 2026-10-15. Source: the public tool list on [Integrate AI tools with the HubSpot MCP server](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server). Live account tool discovery is BLOCKED. No one signed the agent browser into portal `5627913`, and this pass does not call `https://mcp.hubspot.com`.

The public page says tool availability depends on subscription, user permissions, and account configuration, and that `get_user_details` is how a connected account sees its real list. The 32 names below are the public catalog only. They are not a claim that Apartment Life's connector `55630741` currently exposes each one.

This service is not Breeze and it is not the hosted connector. It exposes allowlisted `2026-09` API operations through domain read tools plus `hubspot_prepare_change` and `hubspot_execute_change`. An operation id is allowlisted. The caller does not supply the URL or HTTP method.

| Hosted tool | Public API equivalent in this service | Grant | Status |
| --- | --- | --- | --- |
| `get_user_details` | `hubspot_capabilities` reports the stored grant after OAuth. It does not return HubSpot's per-object permission payload. | HubSpot access-token inspection | Partial. Live result NOT TESTED. |
| `get_organization_details` | Account-info reads behind `hubspot_account-info_read`. | Account-info scopes on the operation | Partial. Live NOT TESTED. |
| `discover_hubspot_schema` | CRM schema reads. | Schema scopes on the operation | Partial. Live NOT TESTED. |
| `search_crm_objects` | CRM search operation ids. Property names are passed through when the grant allows the call. | Object read scope on the operation | Implemented in the register. Live NOT TESTED. Behavior differs: no five-group cap is enforced in the tool layer. |
| `get_crm_objects` | CRM batch and single-record reads. | Object read scope | Implemented. Live NOT TESTED. |
| `manage_crm_objects` | Prepare then execute. Archive uses the write scope where the 2026-09 page says so. | Object write scope | Different confirmation: a login-cookie approval page, not an in-tool confirm. Live NOT TESTED. |
| `manage_segment` | List operation ids where the reference documents them. | List scopes | Partial. Segment membership writes are not a dedicated guided tool. |
| `query_crm_data` | None. This service does not offer a SQL surface. |  | Gap. No public operation was mapped to that SQL dialect. |
| `search_properties` | Property search reads. | Schema read scope | Partial. The five-keyword cap is not reimplemented. |
| `get_properties` | Property definition reads. | Schema read scope | Partial. Live NOT TESTED. |
| `manage_custom_properties` | Property create and update operation ids. | Schema write scope | Approval required. Live NOT TESTED. |
| `manage_custom_pipelines` | Pipeline operation ids. | Pipeline scopes | Partial. Free-account pipeline limits are not rechecked live. |
| `search_owners` | Owner reads. | Owner scopes | Implemented. Live NOT TESTED. |
| `get_campaign_attribution_reports` | Campaign analytics reads where a 2026-09 page exists. | Campaign scopes | Partial. Polling behavior is not reproduced. |
| `read_campaign_data` | Campaign read operation ids. | Campaign scopes | Partial. |
| `manage_campaign_objects` | Campaign mutations through prepare and execute. | Campaign write scopes | Approval required. Live NOT TESTED. |
| `search_conversations` | Conversation read operation ids. | Conversation scopes | Partial. Hosted inbox restrictions are not reimplemented. |
| `get_conversation_channel_metadata` | Conversation channel reads where documented. | Conversation scopes | Partial. |
| `search_intent_signals` | No verified 2026-09 operation was bound to this hosted tool. |  | Gap until an endpoint page is mapped. |
| `get_marketing_email_analytics` | Marketing email analytics reads where documented. | Email scopes | Partial. |
| `manage_marketing_email` | Email draft operation ids where documented. | Email write scopes | Approval required. Send and publish stay unapproved. |
| `get_content_analytics_report` | CMS analytics reads where documented. | CMS scopes | Partial. |
| `manage_landing_page` | CMS page operation ids. Not the hosted guided editor or `render_asset` preview. | CMS write scopes | Partial. Publish is a mutation and needs approval. Live NOT TESTED. |
| `manage_website_page` | CMS site-page operation ids. Navigation edits are not a separate guided tool. | CMS write scopes | Partial. |
| `get_aeo_metrics` | Not implemented. Catalog marks AEO beta or product-gated. |  | Gap. Beta left out of the required manifest. |
| `manage_aeo_prompts` | Not implemented. |  | Gap. |
| `manage_aeo_recommendations` | Not implemented. |  | Gap. |
| `render_asset` | None. Preview cards are a hosted MCP behavior. |  | Gap. No public API equivalent is claimed. |
| `manage_blog_post` | Blog operation ids where the 2026-09 reference documents them. | CMS scopes | Partial. Client-specific availability is a hosted-MCP limit, not ours. |
| `manage_onboarding` | None. |  | Gap. This is hosted onboarding guidance, not an API operation. |
| `tool_guidance` | `hubspot_list_operations` returns paginated operation metadata and source URLs. | None beyond MCP login | Different content. It does not return HubSpot's hosted guidance text. |
| `submit_feedback` | None. |  | Gap. Feedback is sent to HubSpot by their MCP server. |

Hosted write tools confirm inside the MCP session. This service rejects an MCP bearer that posts to the approval URL. A separate login cookie has to approve the displayed method, path, query, and body. The default action policy allows reads and approval-required writes. Delete, archive, and purge stay denied for this release.

Archive and delete stay available only when a 2026-09 operation is implemented and not excluded. `files.delete`, `commerce.payment_links.delete`, and `business_units_view.read` stay omitted. File deletion and payment-link deletion are rejected in the tool layer.

Sensitive Data can block activities and conversations on the hosted MCP while the standard APIs still allow them. This service returns the properties the grant and endpoint allow, including custom properties. Broad read access can include sensitive values. The capability report shows the stored grant so it can be reviewed. That is a behavioral difference, not an extra permission.
