---
name: cross-system-sync
description: Sync a Notion item to Asana and HubSpot for the active client. Use when the user wants the first end-to-end workflow.
---

# Cross-system sync

Load the active client first (`/client` or `PI_CLIENT`). Then run this sequence and return one plain-English summary.

## Steps

1. Confirm the active client profile. If none is loaded, stop and ask the user to run `/client`.
2. Read a Notion item:
   - Use a mapped page id from the client profile when the user did not specify one.
   - Call `notion_read`. If you only have a name, call `notion_find` first.
3. Create or update an Asana task from that Notion item:
   - Prefer a mapped project GID from the client profile.
   - If a matching task already exists, use `asana_update_task` or `asana_comment`.
   - Otherwise use `asana_create_task`.
   - Confirm the write with the user.
4. Write a HubSpot note or record update:
   - Follow `/skill:hubspot-crm`.
   - Use HubSpot remote MCP tools, not Developer MCP.
   - Call `get_user_details`, then `hubspot_check_portal` if the client has an expected portal id.
   - Search or fetch the matching contact/company/deal, then create or update a note.
5. Skip the external system unless `external.enabled` is true in the client profile. If enabled, call `external_read` or `external_write` only as needed.
6. Summarize what was read, created, updated, or skipped. Include ids and titles. Do not dump raw JSON.

## Rules

- Keep writes small and explicit.
- If a mapping id is missing, ask for it instead of guessing.
- If any step fails, stop and report the failure clearly. Do not invent success.
