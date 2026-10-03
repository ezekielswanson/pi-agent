---
name: cross-system-sync
description: Prove a Notion source against HubSpot, and against Asana only when that client's Asana connection is selected and verified.
---

# Cross-system sync

Load the active client first (`/client` or `PI_CLIENT`). Writes stay in implementation mode and each one needs an exact approval. Review mode cannot create records.

Return one plain-English summary. Asana is either included or reported as skipped. Do not describe a skipped Asana step as success.

## Two-system proof

Use this when `asana.mode` is `disabled`, or the Asana token, workspace, or membership check is missing.

1. Confirm the active client and the connection identities in the prompt.
2. Read the Notion source with `notion_read`. A `partial` result is incomplete. Title search via `notion_find` is not full-text search.
3. Call `reconcile_receipt` for that Notion page before creating anything. Skip targets already recorded as succeeded or uncertain. Reconcile an uncertain target by reading it. Do not create a second copy and do not roll back automatically.
4. Write the HubSpot note or record update through remote MCP, following `/skill:hubspot-crm`.
5. Record a gitignored receipt with the Notion source, the HubSpot target, and status `skipped` for Asana.

## Three-system proof

Use this only when Asana is explicitly selected, authenticated, and the workspace membership check succeeds. `mode: "rest"` can satisfy this. Cursor's Asana connection does not. `mode: "mcp"` stays unavailable until a Pi runtime check exists.

1. Do the two-system proof through the receipt reconciliation step.
2. Create or update the Asana task in the verified workspace and allowlisted project. Include the notes, dates, and assignee that the approval preview showed.
3. Then write HubSpot.
4. Record the receipt with the Notion source and each target's status. If one target fails, record that failure and stop. Do not invent success for the remaining system.

## Rules

- If a mapping id is missing, ask for it. Do not guess.
- If any included step fails, stop and report the failure.
- An uncertain write stays uncertain until a read or the receipt confirms the target.
