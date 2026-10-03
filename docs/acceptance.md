# Acceptance

These gates are for a later run with local credentials. They are not done by the offline suite.

| Gate | Ready when | Current offline stand-in |
| --- | --- | --- |
| Client session | `/client` validates the profile, starts a fresh session, and review mode is active | Session switch tests |
| Notion | One invited test page and one output parent can be read completely or marked partial, then a body can be created after approval | Fake Notion client |
| Asana | `asana.mode` is `rest`, the token is present, and the workspace membership check passes. Otherwise the three-system proof reports Asana as skipped | Fake Asana HTTP |
| HubSpot | Expected portal id is set and `/mcp-auth hubspot` verified `get_user_details` on that connection | Approval fixtures. Live script prints SKIPPED |
| Research | Review mode cites allowlisted evidence and does not edit or run an unrestricted shell | Tool-block test |
| Receipt | A retry reconciles the recorded targets before creating | Receipt replay test |

The October 2 research task is a live scenario. It waits until the Notion page and the question are supplied for that run.

Missing live prerequisites stay `SKIPPED` or blocked. They are not a pass.
